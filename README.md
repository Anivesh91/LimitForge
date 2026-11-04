# LimitForge

[![npm version](https://img.shields.io/npm/v/limitforge.svg)](https://www.npmjs.com/package/limitforge)
[![CI Status](https://github.com/Anivesh91/LimitForge/actions/workflows/ci.yml/badge.svg)](https://github.com/Anivesh91/LimitForge/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](index.d.ts)
[![Security Policy](https://img.shields.io/badge/Security-Policy-brightgreen.svg)](SECURITY.md)

A distributed rate-limiting and resilience middleware for Express.js, supporting Redis-backed storage, multiple rate-limiting algorithms, automatic fallback, circuit breaking, and built-in observability through Prometheus and OpenTelemetry.

---

## Key Features

- **Multiple Rate Limiting Algorithms**: Fixed Window, Rolling Sliding Window (atomic Redis ZSET), and Token Bucket with continuous sub-second refill.
- **Distributed & In-Memory**: Standalone in-process `MemoryStore` or distributed `RedisStore` powered by atomic Lua scripts.
- **Production Resilience**: Circuit breaker (`CLOSED`, `OPEN`, `HALF_OPEN`), store timeout guards, and dual-store failover (`ResilientStore`).
- **Zero-Dependency Observability**: Native `/metrics` exporter in standard Prometheus text format, pre-built Grafana dashboards, and OpenTelemetry tracing.
- **Flexible Identity & Dynamic Policies**: Composite keys (API key, user ID, tenant), dynamic quota tiers, and weighted request costs.
- **Standard HTTP Headers**: Emits standard IETF `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `Retry-After`, and `RateLimit-Degraded`.
- **Lightweight**: Zero runtime dependencies for in-memory deployments.

---

## Installation & Requirements

### Requirements
- **Node.js**: `>= 18.0.0`
- **Module System**: ES Modules (`"type": "module"` in your `package.json`)

### Installation

For basic in-memory rate limiting:
```bash
npm install limitforge express
```

For distributed Redis rate limiting:
```bash
npm install limitforge express redis
```

---

## Quick Start

```javascript
import express from 'express';
import { createClient } from 'redis';
import {
  rateLimiter,
  RedisStore,
  MemoryStore,
  ResilientStore,
  createPrometheusExporter
} from 'limitforge';

const app = express();

// 1. Connect Redis Client (Optional for distributed setups)
const redisClient = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redisClient.on('error', (err) => console.warn('Redis error:', err.message));
await redisClient.connect().catch(() => {});

// 2. Configure Store (ResilientStore falls back to MemoryStore if Redis fails)
const store = redisClient.isOpen
  ? new ResilientStore({
      primaryStore: new RedisStore({ client: redisClient }),
      fallbackStore: new MemoryStore(),
      timeoutMs: 150
    })
  : new MemoryStore();

// 3. Apply Rate Limiting Middleware
app.use(
  rateLimiter({
    store,
    limit: 100,             // 100 requests
    windowMs: 60 * 1000     // per 1 minute
  })
);

// 4. Endpoint with Token Bucket (burst capacity: 10, refill: 1 token/sec)
app.post(
  '/api/checkout',
  rateLimiter({
    algorithm: 'token-bucket',
    capacity: 10,
    refillRate: 1,
    refillIntervalMs: 1000
  }),
  (req, res) => res.json({ success: true })
);

// 5. Native Prometheus Metrics Endpoint
app.get('/metrics', createPrometheusExporter());

app.listen(3000, () => console.log('Server running on http://localhost:3000'));
```

---

## Rate Limiting Algorithms

| Algorithm | Rolling Precision | Burst Tolerant | Memory Footprint | Recommended Use Case |
| :--- | :---: | :---: | :---: | :--- |
| **`fixed-window`** | Low *(boundary reset)* | No | Minimal ($O(1)$) | Basic API request throttling, low-memory footprints. |
| **`sliding-window`** | High *(continuous roll)* | No | Moderate ($O(N)$) | Strict sliding quotas (e.g. payment endpoints, sensitive auth). |
| **`token-bucket`** | Continuous Refill | **Yes** *(up to capacity)* | Minimal ($O(1)$) | APIs requiring burst tolerance with sustained steady refill rates. |

---

## Resilience & Store Fault Tolerance

When central stores (Redis) fail, slow down, or become network-partitioned, LimitForge prevents cascading API outages:

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:d1c5eb220eeefb60cbce0f571a673e57619f9b7f1ec110cda2bed8cf6cefb2f8 -->

The timeout bounds how long middleware waits for a store. A timed-out operation may still finish and change store state.

<!-- /coderabbit-ai-generated:v1 -->

- **Circuit Breaker Engine (`CircuitBreaker`)**: Automatically trips to `OPEN` after repeated store failures, short-circuiting network traffic to protect failing infrastructure.
- **Dual-Store Failover (`ResilientStore`)**: Transparently diverts traffic to a local `MemoryStore` during Redis outages, tagging responses with `RateLimit-Degraded: true`.
- **Store Failure Policies (`onStoreError`)**: Choose between `next(err)` (default), `'fail-open'` (bypass quota), or `'fail-closed'` (HTTP 503).

> 📖 **Deep Dive**: See [docs/resilience.md](docs/resilience.md) for finite state machine diagrams, canary probes, and recovery mechanics.

---

## Observability & Monitoring

LimitForge comes with zero-dependency native observability:

- **Prometheus Text Exporter**: Expose `/metrics` directly using `createPrometheusExporter()`.
- **Metrics Catalog**: Tracks request outcomes (`smartrate_requests_total`), store latency histograms (`smartrate_store_duration_seconds`), and circuit breaker states (`smartrate_circuit_breaker_state`).
- **Cardinality Guard**: Automatically collapses dynamic route parameters (`/users/42` $\to$ `/users/:id`) to protect Prometheus TSDB from label explosion.
- **OpenTelemetry Bridge**: Dual-emits standard `ratelimit.*` attributes and backwards-compatible telemetry spans on active HTTP traces.
- **Pre-Built Dashboards**: Ready-to-import Grafana dashboard and Alertmanager rules in `assets/`.

> 📖 **Deep Dive**: See [docs/observability.md](docs/observability.md) for metric schemas, OpenTelemetry conventions, and Grafana setup.

---

## Configuration Reference

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:8ce4fc1b13112faa4078e72aac9ec870a3b9991ba07ea529e576a3d6e07fa9ed -->

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:2122a8260ab4b1648fb8225c924687203ab11f055c97d339db65044a61e2d217 -->

For `ResilientStore`, configure `timeoutMs` on the store itself; the middleware option applies to standalone stores. The timeout applies separately to primary and fallback operations. If both are slow, total wait can approach twice the timeout, plus scheduling delays. Timed-out operations are not canceled and may still change quota state.

<!-- /coderabbit-ai-generated:v1 -->

**Route quota scope:** By default, middleware registered with `app.use()` shares a quota across paths for each client and HTTP method. Middleware attached directly to a matched route uses that route's pattern, so parameter values in the route share a quota. Different HTTP methods remain separate. Set `includeRoute: false` to share a quota across route-level handlers too.

Set `includeRoute: true` to use per-path quotas in global middleware, or supply `routeNormalizer` to group paths explicitly. Before Express matches a route, unrecognized dynamic values can produce separate quotas when `includeRoute` is enabled. A parameterized router mount can also put dynamic values in `req.baseUrl`; use a normalizer to group them. Ensure the custom normalizer returns a stable group and handles errors. Explicit `includeRoute: false` takes precedence over a custom normalizer for the quota key; the normalizer still affects telemetry labels.

Automatic route-level detection works for limiters attached directly to Express routes. When wrapping a limiter in another handler, set `includeRoute` explicitly to choose the intended scope.

This changes the default keys for global middleware. Existing per-path Redis counters are not migrated into the new shared quota. Plan for a quota reset and avoid mixing old and new versions when strict quotas are required; alternatively, use `includeRoute: true` to retain prior keying behavior.

**Redis clock:** Sliding-window and token-bucket operations use the Redis server clock by default; the Redis user must have permission to run `TIME` in the scripts. Direct `RedisStore.consume()` calls may still supply `now` for deterministic testing; overriding it requires all callers to use a consistent clock. Redis server clock adjustments or failover to a server with a different clock can still affect quota timing. Avoid mixing old and new application versions while existing quotas are active, since older versions write application timestamps into the same keys.

**Dynamic fixed windows:** MemoryStore and RedisStore use the latest observed duration for an active window. Redis fixed-window counters use a versioned string: legacy numeric counters migrate on access and may be retained longer because their original start is unknown. The Redis ACL must allow `GET`, `PTTL`, `TIME`, and `SET` in scripts. Stop old instances before migrating; old and new versions cannot share migrated keys. Expired counters cannot be recovered when a later request increases the duration.

**Fractional Redis windows:** Redis uses whole milliseconds, so fractional fixed and sliding window durations and their key TTLs round up. Durations too large for safe millisecond arithmetic are rejected before changing the quota state. Existing fixed-window keys without an expiry still produce an error and need operator review. Previously orphaned sliding-window keys also need review if they are not accessed again.

**Key encoding and upgrade:** Key components escape delimiters and percent signs, and hashed identifiers have distinct markers. Simple unambiguous raw keys remain unchanged, but routes, prefixes or identifiers containing escaped characters and hashed identifiers produce different keys. `RedisStore` prefixes containing delimiters are encoded too. Existing affected counters are not migrated: legacy keys can combine multiple identities, so their counts cannot be split safely. During deployment, stop or drain old instances and let affected old quotas expire, or use an external protection mechanism if strict quota continuity is required. Avoid mixing old and new versions against the same store.

A custom `keyGenerator` must uniquely encode its own components (for example, use `JSON.stringify([tenantId, userId])` for string identifiers). Custom hash functions must also avoid mapping different clients to the same output. For direct `RedisStore.consume()` calls, raw and encoded forms of an already-prefixed key are treated as equivalent; use one form consistently and supply unique keys.

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:4c8a295c15ae41ba9141cd81c5bbaa6d84a6447984cd71ee0402580f8a8a0214 -->

**Default store isolation:** Each call to `rateLimiter()` without a `store` creates an independent `MemoryStore`. Reusing the same middleware instance reuses its store. This replaces the previous implicit shared default: applications that relied on separate default limiters sharing a quota must now pass the same store explicitly. Limiters using an explicitly shared store and the same key still share a counter. To isolate different policies on the same shared Redis store, set distinct `prefix` values and use the same prefix for each policy across all application replicas.

**Inferred token refill:** When a direct store call omits `refillRate` and supplies `limit` and `windowMs`, the rate is `limit * refillIntervalMs / windowMs` tokens per interval. Redis now follows this calculation for custom intervals, matching MemoryStore. An existing Redis bucket uses the corrected rate for time elapsed since its last update; expired buckets cannot be recovered. Avoid mixing versions for affected buckets.

<!-- /coderabbit-ai-generated:v1 -->

<!-- /coderabbit-ai-generated:v1 -->

```typescript
const limiter = rateLimiter(options);
```

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `limit` | `number \| ((req) => number)` | `60` | Max requests allowed within `windowMs` (Fixed/Sliding Window). |
| `windowMs` | `number \| ((req) => number)` | `60000` | Rate limit window in milliseconds (1 minute). |
| `algorithm` | `'fixed-window' \| 'sliding-window' \| 'token-bucket'` | `'fixed-window'` | Rate limiting algorithm to enforce. |
| `capacity` | `number \| ((req) => number)` | — | Maximum burst capacity for Token Bucket. |
| `refillRate` | `number \| ((req) => number)` | — | Continuous refill rate (tokens added per interval). |
| `refillIntervalMs` | `number \| ((req) => number)` | `1000` | Token Bucket refill interval in milliseconds. |
| `cost` | `number \| ((req) => number)` | `1` | Token cost consumed per request. |
| `store` | `RateLimitStore` | `new MemoryStore()` | Backing storage instance (`MemoryStore`, `RedisStore`, or `ResilientStore`). |
| `keyGenerator` | `(req) => string \| Promise<string>` | `(req) => req.ip` | Identifier function (IP, API key, JWT claim, or multi-tenant string). |
| `hashClientIdentifier`| `boolean` | `false` | When true, cryptographically hashes client identifiers with SHA-256 before storage. |
| `timeoutMs` | `number` | `250` | Maximum timeout in ms for store execution before raising `StoreTimeoutError`. |
| `onStoreError` | `'fail-open' \| 'fail-closed' \| Function` | `next(err)` | Store error strategy if an unhandled store failure occurs. |
| `skip` | `(req) => boolean \| Promise<boolean>` | `() => false` | Condition under which rate limiting should be skipped entirely. |
| `message` | `string \| object` | `{ error: 'Too many requests...' }` | Response payload sent on HTTP 429 quota exhaustion. |
| `statusCode` | `number` | `429` | HTTP status code returned when rate limit is exceeded. |
| `standardHeaders` | `boolean` | `true` | When true, attaches `RateLimit-*` response headers. |

---

## Examples & Demos

Runnable examples located in the `examples/` directory:

| Command | Demo | Focus |
| :--- | :--- | :--- |
| `npm run dev` | `examples/express-demo/` | Basic multi-route rate limiting demo. |
| `npm run demo:sliding` | `examples/express-demo/sliding-demo.js` | Fixed vs Sliding Window boundary burst comparison. |
| `npm run demo:burst` | `examples/express-demo/burst-demo.js` | Token Bucket burst capacity & continuous refill. |
| `npm run demo:saas` | `examples/express-demo/saas-demo.js` | Multi-tier SaaS (Free, Pro, Enterprise) dynamic quotas. |
| `npm run demo:resilience`| `examples/express-demo/resilience-demo.js` | Chaos fault injection, circuit breaker trip, and store recovery. |
| `npm run demo:observability`| `examples/express-demo/observability-demo.js` | Standalone Prometheus metrics scrape and trace demo. |
| `npm run demo:stack` | `examples/observability-stack/` | Full Docker Compose stack: Express + Redis + Prometheus + Grafana. |

---

## Testing & Benchmarks

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:30064d66b61646e928a5d2c861ef056b2e80b09c6fe5a0a41a095a77fc1b30dd -->

Run the automated test suite. To include tests against a real Redis instance, set `REDIS_URL` (for example, `redis://localhost:6379`); those tests are skipped when it is unset.

<!-- /coderabbit-ai-generated:v1 -->

```bash
npm test
```

Run high-precision monotonic overhead benchmarks:

```bash
npm run benchmark
```

Benchmark results show `MemoryStore` evaluation overhead bounded within **2.3 µs to 3.7 µs** (p50). See [docs/PERFORMANCE_REPORT.md](docs/PERFORMANCE_REPORT.md) for methodology and results.

---

## Documentation Index

- [Architecture & Storage Internals](docs/architecture.md)
- [Resilience & Failure Handling](docs/resilience.md)
- [Observability, Prometheus & OpenTelemetry](docs/observability.md)
- [Performance & Latency Benchmark Report](docs/PERFORMANCE_REPORT.md)
- [Changelog & Release History](CHANGELOG.md)
- [Contributing Guidelines](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)

---

## License

MIT © [Anivesh Sikarwar](https://github.com/Anivesh91)
