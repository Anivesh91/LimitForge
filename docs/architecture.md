# LimitForge Architecture

Internal evaluation pipeline, pluggable storage contract, Redis Lua semantics, and key-encoding design of LimitForge.

## 1. Request Evaluation Pipeline

LimitForge intercepts incoming Express HTTP requests before downstream route handlers run:

```mermaid
flowchart TD
    Req([Incoming HTTP Request]) --> ExtractKey[1. Key Generation<br/>IP / API Key / Multi-Tenant]
    ExtractKey --> ResolvePolicy[2. Policy Resolution<br/>Dynamic limit, windowMs, cost]
    ResolvePolicy --> StoreCheck{3. Store Type}

    StoreCheck -->|"MemoryStore"| EvalMemory[Evaluate In-Memory Quota]
    StoreCheck -->|"RedisStore"| EvalRedis[Evaluate Atomic Lua Script]
    StoreCheck -->|"ResilientStore"| EvalResilient[Evaluate Primary with<br/>Circuit Breaker & Fallback]

    EvalMemory --> AllowedCheck{Quota Available?}
    EvalRedis --> AllowedCheck
    EvalResilient --> AllowedCheck

    AllowedCheck -->|"Yes (Allowed)"| HeadersAllowed[Attach RateLimit-* Headers<br/>Record Telemetry]
    HeadersAllowed --> NextHandler[Continue to Route Handler<br/>next()]

    AllowedCheck -->|"No (Exhausted)"| HeadersBlocked[Attach RateLimit-* & Retry-After<br/>Record Telemetry]
    HeadersBlocked --> Reject429[HTTP 429 Too Many Requests]
```

## 2. Pluggable Storage Layer

Algorithms and backing storage are decoupled behind `.consume(params)`:

```typescript
interface IRateLimitStore {
  consume(params: StoreConsumeParams): Promise<StoreConsumeResult> | StoreConsumeResult;
}
```

### Store Implementations

| Store | Backing Engine | Clock & Atomicity | Typical Use Case |
| :--- | :--- | :--- | :--- |
| `MemoryStore` | JavaScript `Map` + unref'd cleanup timer | In-process system clock (`Date.now()`) | Single-node services, local dev, zero external dependencies |
| `RedisStore` | Redis (`node-redis` v4/v5/v6) | Atomic Lua scripts using Redis server `TIME` | Multi-instance distributed APIs |
| `ResilientStore` | Primary + fallback store | Circuit breaker guarded by `withTimeout()` | High-availability setups avoiding Redis SPOF |

## 3. Atomic Redis Lua Scripts

To eliminate read-modify-write race conditions across application replicas, `RedisStore` runs rate-limit evaluation atomically inside Redis Lua scripts.

### A. Fixed Window (`src/scripts/fixedWindow.lua`)

- Persists counter and window start together in a versioned string (`lf1|<count>|<startMs>|<legacyUntilMs>`) updated atomically via `SET ... PX` against Redis `TIME`.
- Recalculates remaining expiry from the active window start when dynamic `windowMs` policies change (already-expired windows are never resurrected).
- Rounds fractional durations up (`Math.ceil`) to whole milliseconds so sub-millisecond inputs never drop key TTLs, rejecting non-positive or overflow-unsafe windows and keys missing a TTL (`PTTL == -1`).
- Migrates legacy plain numeric keys (created by older `INCR`-based schemas) on access by retaining them until `max(start + windowMs, legacyUntil)`. Old `INCR`-based instances cannot parse the versioned format, so mixed deployments should be avoided during upgrades; Redis ACLs must permit `GET`, `PTTL`, `TIME`, and `SET`.

### B. Sliding Window (`src/scripts/slidingWindow.lua`)

- Uses a Redis Sorted Set (`ZSET`) keyed by unique request members and millisecond timestamp scores (Redis `TIME` unless overridden via `now`).
- Evicts expired timestamps via `ZREMRANGEBYSCORE key -inf cutoff`, counts active members via `ZCARD`, conditionally records allowed requests with `ZADD`, and refreshes `PEXPIRE` using `Math.ceil(windowMs)`.

### C. Token Bucket (`src/scripts/tokenBucket.lua`)

- Stores `tokens` and `lastRefill` inside a Redis Hash (`HMGET`/`HSET`) using the Redis server clock.
- Replenishes continuously at sub-second granularity:
  $$\text{refilledTokens} = \min(\text{capacity}, \text{currentTokens} + \text{elapsedMs} \times \text{refillRatePerMs})$$
- Deducts request `cost` atomically when balance is sufficient and computes exact `Retry-After` and `RateLimit-Reset` values in seconds.

## 4. Key Encoding & Cardinality Protection

1. **Structured Key Format**: Keys follow `<prefix>:[<algorithm>:]<METHOD>:<routeScope>:<identifier>` (omitting the algorithm segment for `fixed-window`).
2. **Route Scoping & Normalization**: Middleware mounted globally with `app.use()` shares `__limitforge_global__` per client and method unless `includeRoute: true` or a `routeNormalizer` is set; direct route handlers use Express matched patterns (`req.baseUrl + req.route.path`). Telemetry always normalizes dynamic path segments (integers, UUIDs, ULIDs, CUIDs, long hex strings) into `:id`.
3. **Delimiter & UTF-16 Escaping**: Segment builders escape `:`, `%`, and unpaired UTF-16 surrogates (`%uXXXX`) to eliminate cross-segment collisions and Redis UTF-8 replacement ambiguity.
4. **Length Bounding & Hashing**: Client identifiers exceeding `MAX_IDENTIFIER_LENGTH` (`256`) are SHA-256 hashed (`~h~...`) automatically; setting `hashClientIdentifier: true` (or supplying a custom hash function) ensures raw tokens are never stored in Redis keys.
