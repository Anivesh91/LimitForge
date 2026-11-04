# Resilience & Failure Handling

In distributed systems, the central rate-limiting store (such as Redis) can become slow, partitioned, or completely unavailable. Without defensive resilience guards, a Redis outage cascades into application-wide HTTP 504 gateway timeouts or total service disruption.

**LimitForge** provides production-grade fault tolerance through four interlocking resilience layers:
1. **Store Timeout Guard**
2. **Configurable Failure Policies**
3. **Circuit Breaker Engine**
4. **Dual-Store Automatic Failover (`ResilientStore`)**

---

## 1. Resilience Architecture Overview

```mermaid
flowchart TD
    Req([Incoming HTTP Request]) --> Limiter[LimitForge Middleware]
    Limiter --> BreakerCheck{Circuit Breaker State?}

    BreakerCheck -->|"CLOSED (Normal)"| RunPrimary[Call primaryStore with timeoutMs Guard]
    RunPrimary --> PrimarySuccess{Success?}
    PrimarySuccess -->|"Yes"| NormalResp[Set RateLimit-* Headers<br/>degraded: false]
    NormalResp --> NextHandler[Allow Request<br/>Continue to Route Handler]

    PrimarySuccess -->|"Timeout / Error"| RecordFail[Record Failure in Circuit Breaker]
    RecordFail --> FallbackHop[Failover to fallbackStore]

    BreakerCheck -->|"OPEN (Tripped)"| SkipPrimary[Bypass primaryStore<br/>Zero Network Hammering]
    SkipPrimary --> FallbackHop

    BreakerCheck -->|"HALF_OPEN (Probing)"| CanaryCheck{Canary Probe In-Flight?}
    CanaryCheck -->|"No (This request is canary)"| ProbePrimary[Execute Probe on primaryStore]
    ProbePrimary --> ProbeSuccess{Probe Succeeded?}
    ProbeSuccess -->|"Yes"| ResetBreaker[Trip to CLOSED<br/>Resume Normal Traffic]
    ResetBreaker --> NormalResp
    ProbeSuccess -->|"No"| ReTripBreaker[Trip to OPEN<br/>Restart Cooldown Timer]
    ReTripBreaker --> FallbackHop
    CanaryCheck -->|"Yes (Another request probing)"| DivertToFallback[Divert to fallbackStore]
    DivertToFallback --> FallbackHop

    FallbackHop --> LocalEval[Evaluate fallbackStore Quota]
    LocalEval --> LocalAllowed{Local Quota Available?}
    LocalAllowed -->|"Yes"| DegradedResp[Set RateLimit-* Headers<br/>RateLimit-Degraded: true]
    DegradedResp --> NextHandler
    LocalAllowed -->|"No"| Reject429[Set RateLimit-Degraded: true<br/>HTTP 429 Too Many Requests]
```

---

## 2. Store Timeout Guard (`timeoutMs`)

If Redis experiences high CPU load, network latency, or an unreachable socket, queries can stall indefinitely.

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:c25772edb918a0fec1531921df5269774fa153d1229a2a07a83fafa14049eeeb -->

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:00122c954c70c2c3d13e0d018b229ad2b3f7621f750c6e6c52323165b67b4fd0 -->

- Standalone store operations have a 250 ms default timeout. For a `ResilientStore`, configure `timeoutMs` on the store itself; it defaults to 250 ms and applies separately to the primary and the fallback. This changes the previous behavior, where the fallback had no timeout. If both stages are slow, the total wait may approach twice the timeout, plus scheduling delays. Synchronous code that blocks the event loop cannot be interrupted by this timer.
- A timeout raises `StoreTimeoutError` and stops waiting. It does not cancel a running operation: either store can still execute and change quota state after the timeout. Redis commands may also run after reconnect, depending on client configuration. Configure client queueing and connection timeouts for your deployment.

<!-- /coderabbit-ai-generated:v1 -->
- When strict global enforcement is required, use `onStoreError: 'fail-closed'`. During timeout or outage, it returns 503 rather than using the local fallback. A timed-out command may still affect future quota decisions.
- Active timers are cleared when operations resolve within the threshold.

<!-- /coderabbit-ai-generated:v1 -->

```javascript
import { rateLimiter, RedisStore } from 'limitforge';

const limiter = rateLimiter({
  store: new RedisStore({ client: redisClient }),
  timeoutMs: 100, // Bound store latency to 100ms
  limit: 100,
  windowMs: 60000
});
```

---

## 3. Store Failure Policies (`onStoreError`)

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:35b4559f02f6b293fe39fed5b349cd7a19560e7e5aa74eb750c509a56f29d021 -->

When a standalone store fails or times out, `onStoreError` dictates recovery. With `ResilientStore`, `fail-closed` rejects primary failures before using the fallback; other policies apply if the fallback also fails:

<!-- /coderabbit-ai-generated:v1 -->

| Policy | Behavior | HTTP Status | Response Header | Use Case |
| :--- | :--- | :---: | :--- | :--- |
| **`next(err)`** *(default)* | Error is forwarded to Express error pipeline (`next(storeError)`). | Application-defined | None | Strict environments requiring upstream alert handling. |
| **`'fail-open'`** | Rate limiting is bypassed cleanly for this request (`next()`). | Downstream route | `RateLimit-Degraded: true` | Maximum service availability (prioritize uptime over strict quota). |
| **`'fail-closed'`** | Rejects the request with dynamic `Retry-After`. | `HTTP 503 Service Unavailable` | `RateLimit-Degraded: true`<br/>`Retry-After: <cooldown>` | High-value or resource-intensive services where backend must be shielded. |
| **Custom function** | `(err, req, res, next) => { ... }` | Custom | Custom | Custom error logging, Sentry/Datadog reporting, or fallback routing. |

---

## 4. Circuit Breaker Engine (`CircuitBreaker`)

The `CircuitBreaker` implements a 3-state finite state machine protecting upstream stores from repeated hammering during persistent outages:

### State Transitions

```text
    ┌──────────────────────────────────────────────┐
    │                                              │
    ▼                                              │
┌────────┐   consecutive failures >= threshold   ┌──────┐
│ CLOSED │ ────────────────────────────────────> │ OPEN │
└────────┘                                       └──────┘
    ▲                                               │
    │ probe successful                              │ cooldown elapsed
    │                                               ▼
    │                                       ┌───────────┐
    └────────────────────────────────────── │ HALF_OPEN │
              probe failed                  └───────────┘
```

1. **`CLOSED` (Normal Operation):** All requests route directly to the primary store.
2. **`OPEN` (Tripped Outage):** If failures reach `failureThreshold` (default: 5), the breaker trips to `OPEN`. Primary store calls are immediately short-circuited without network overhead for `resetTimeoutMs` (default: 30,000ms).
3. **`HALF_OPEN` (Canary Recovery):** Once the reset cooldown elapses, the breaker enters `HALF_OPEN`. It dispatches exactly **one single-flight canary probe** to the primary store:
   - If the canary succeeds, the breaker resets to `CLOSED`.
   - If the canary fails, the breaker re-trips to `OPEN` and restarts the cooldown timer.
   - Any concurrent requests arriving while the canary probe is in-flight are diverted safely to the fallback store.

### Lazy Cooldown Evaluation
Unlike naive circuit breakers that maintain persistent `setInterval` background timers, LimitForge evaluates state transitions lazily on-demand upon incoming requests. This ensures zero idle event-loop overhead and zero timer retention.

---

## 5. Dual-Store Fallback (`ResilientStore`)

`ResilientStore` wraps a primary store (`RedisStore`) and a secondary fallback store (`MemoryStore`):

```javascript
import { createClient } from 'redis';
import { rateLimiter, RedisStore, MemoryStore, ResilientStore } from 'limitforge';

const redisClient = createClient({ url: 'redis://localhost:6379' });
await redisClient.connect();

const resilientStore = new ResilientStore({
  primaryStore: new RedisStore({ client: redisClient }),
  fallbackStore: new MemoryStore(),
  timeoutMs: 150,
  failureThreshold: 3,
  resetTimeoutMs: 15000
});

app.use(rateLimiter({
  store: resilientStore,
  limit: 100,
  windowMs: 60000
}));
```

### Observability During Degradation
Whenever `ResilientStore` falls back to the secondary store:
- HTTP response header `RateLimit-Degraded: true` is automatically attached.
- `req.rateLimit` metadata object is exposed to downstream handlers:
  ```javascript
  app.get('/api/resource', (req, res) => {
    if (req.rateLimit.degraded) {
      console.warn(`Serving degraded request: primary failed with ${req.rateLimit.primaryError.message}`);
    }
    res.json({ data: 'resource' });
  });
  ```
- Prometheus metric `smartrate_degraded_requests_total` is incremented.
