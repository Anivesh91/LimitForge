# LimitForge Architecture

This document describes the internal architecture, evaluation pipeline, and storage layer design of **LimitForge**.

---

## 1. Request Pipeline & Evaluation Flow

LimitForge acts as an Express.js middleware intercepting incoming HTTP requests before they reach downstream route handlers.

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

---

## 2. Pluggable Storage Layer

LimitForge decouples rate limiting algorithms from storage mechanisms through a unified store interface:

```typescript
interface RateLimitStore {
  consume(key: string, options: ConsumeOptions): Promise<RateLimitResult>;
}
```

### Store Implementations

| Store | Backing Engine | Concurrency & Atomicity | Typical Use Case |
| :--- | :--- | :--- | :--- |
| **`MemoryStore`** | JavaScript `Map` + sweeping timers | In-process monotonic clock (`Date.now()`) | Single-instance apps, development, zero external dependencies |
| **`RedisStore`** | Redis server (v4/v5/v6 client) | Atomic Lua scripts executed on Redis engine | Multi-instance distributed APIs, Kubernetes, microservices |
| **`ResilientStore`** | Primary (`RedisStore`) + Fallback (`MemoryStore`) | Circuit Breaker guarded with timeout wrapper | High-availability production APIs with zero store single-point-of-failure |

---

## 3. Atomic Redis Lua Scripts

To prevent distributed race conditions (TOCTOU: Time-of-Check to Time-of-Use), `RedisStore` evaluates rate limiting logic entirely inside Redis using atomic Lua scripts:

### A. Fixed Window (`src/scripts/fixedWindow.lua`)
- Atomically executes `INCR` and conditionally sets expiration via `PEXPIRE` on first touch.
- Reads `PTTL` to calculate accurate remaining window duration.

### B. Sliding Window (`src/scripts/slidingWindow.lua`)
- Uses a Redis **Sorted Set (ZSET)** where scores represent microsecond/millisecond timestamps.
- Trims expired timestamps via `ZREMRANGEBYSCORE key -inf cutoff`.
- Counts active requests within rolling window via `ZCARD`.
- Conditionally adds current request via `ZADD` and renews key TTL.

### C. Token Bucket (`src/scripts/tokenBucket.lua`)
- Stores state in a Redis **Hash (`HMGET`/`HSET`)**: `tokens` (floating-point balance) and `lastRefill` (timestamp).
- Calculates continuous sub-second token replenishment:
  $$\text{refilledTokens} = \min(\text{capacity}, \text{currentTokens} + \text{elapsedMs} \times \text{refillRatePerMs})$$
- Atomically deducts request `cost` if $\text{refilledTokens} \ge \text{cost}$.
- Calculates exact fractional `Retry-After` seconds when tokens are insufficient.

---

## 4. Key Building & Cardinality Guard

To prevent denial-of-wallet attacks and Redis memory bloat:
1. **Route Normalization**: Paths are collapsed (e.g., `/users/123` $\to$ `/users/:id`) to prevent unbounded key explosions.
2. **Identifier Clamping**: Client identifiers (`req.ip`, API keys) are strictly clamped to a maximum length of 256 characters (`MAX_IDENTIFIER_LENGTH = 256`).
3. **Identifier Masking**: When `hashClientIdentifier: true` is configured, raw tokens are hashed with SHA-256 before storage so raw API keys never appear in Redis keys or monitor logs.
