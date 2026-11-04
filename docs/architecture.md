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
<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:29f6954756b9b2bf792edae317277766cfdd2329328146a1185484aeffeae8b4 -->

- Stores the counter and its window start together in a versioned Redis string. Each update uses one atomic Lua script and `SET ... PX`, with the Redis server clock.
- When an active window changes duration, expiration is recalculated from its original start. A policy change cannot recover a window that has already expired.
- Legacy numeric counters are migrated on access without losing their count. Their original start time is unavailable, so migration conservatively retains the counter for at least its remaining TTL and one current window. This can extend that window.
- Old versions use `INCR` on these keys and cannot read the new format. Stop old instances before migrating keys; a rollback requires waiting for migrated keys to expire or accepting quota resets. Redis ACLs must allow `GET`, `PTTL`, `TIME`, and `SET` from the script.
- Fixed and sliding windows accept fractional milliseconds; Redis rounds the window duration and expiry up to whole milliseconds. Existing fixed-window keys without an expiry still raise an error and need operator review. Previously orphaned sliding-window keys also need review if they are not accessed again.

<!-- /coderabbit-ai-generated:v1 -->

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
