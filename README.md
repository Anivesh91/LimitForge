# LimitForge

[![npm version](https://img.shields.io/npm/v/limitforge.svg)](https://www.npmjs.com/package/limitforge)
[![CI Status](https://github.com/Anivesh91/LimitForge/actions/workflows/ci.yml/badge.svg)](https://github.com/Anivesh91/LimitForge/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](index.d.ts)
[![Security Policy](https://img.shields.io/badge/Security-Policy-brightgreen.svg)](SECURITY.md)

Distributed rate-limiting and resilience middleware for Express.js with atomic Redis Lua scripts, in-memory fallback, circuit breaking, and Prometheus/OpenTelemetry instrumentation.

## Features

- **Algorithms**: Fixed Window, Rolling Sliding Window (atomic Redis `ZSET`), and continuous-refill Token Bucket.
- **Pluggable Stores**: Zero-dependency `MemoryStore` for single-node apps or atomic Lua-backed `RedisStore` for clusters.
- **Fault Tolerance**: Store timeout guards, circuit breaker (`CLOSED`, `OPEN`, `HALF_OPEN`), dual-store failover (`ResilientStore`), and configurable error policies (`fail-open`, `fail-closed`, `next(err)`).
- **Observability**: Built-in Prometheus `/metrics` text exporter (`v0.0.4`), cardinality-bounded route sanitization, OpenTelemetry span enrichment, and sample Grafana/Alertmanager configs in `assets/`.
- **Dynamic Quotas & Keys**: Composite or async `keyGenerator`, optional SHA-256 key hashing, per-request policy functions, and weighted token `cost`.
- **Standard Headers**: Emits `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `Retry-After`, and `RateLimit-Degraded`.

## Installation

Requires **Node.js `>= 18.0.0`** and ES Modules (`"type": "module"`).

```bash
# In-memory only (zero runtime dependencies)
npm install limitforge express

# Distributed with Redis
npm install limitforge express redis
```

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
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  disableOfflineQueue: true,
  socket: { connectTimeout: 1000 }
});
redisClient.on('error', (err) => console.warn('Redis error:', err.message));
redisClient.connect().catch((err) => console.warn('Redis connection stopped:', err.message));

// 2. Configure Store (ResilientStore falls back to MemoryStore if Redis fails)
const store = new ResilientStore({
  primaryStore: new RedisStore({ client: redisClient }),
  fallbackStore: new MemoryStore(),
  timeoutMs: 150
});

// 3. Apply Rate Limiting Middleware
app.use(
  rateLimiter({
    store,
    limit: 100,             // 100 requests
    windowMs: 60 * 1000,    // per 1 minute
    metrics: true
  })
);

// 4. Endpoint with Token Bucket (burst capacity: 10, refill: 1 token/sec)
app.post(
  '/api/checkout',
  rateLimiter({
    algorithm: 'token-bucket',
    capacity: 10,
    refillRate: 1,
    refillIntervalMs: 1000,
    metrics: true
  }),
  (req, res) => res.json({ success: true })
);

// 5. Native Prometheus Metrics Endpoint
app.get('/metrics', createPrometheusExporter());

app.listen(3000, () => console.log('Server running on http://localhost:3000'));
```

With `disableOfflineQueue: true` and `ResilientStore`, Express starts immediately while Redis connects. Outages fail over to the local `MemoryStore` (quotas become per-instance and do not sync back to Redis when recovery probes succeed). Already in-flight Redis commands may still settle after a timeout expires; use `onStoreError: 'fail-closed'` where strict global enforcement is required.

## Algorithms

| Algorithm | Rolling Precision | Burst Tolerant | Memory | Typical Use Case |
| :--- | :---: | :---: | :---: | :--- |
| `fixed-window` | Low (window boundary) | No | `O(1)` | General API throttling, low memory overhead |
| `sliding-window` | High (continuous roll) | No | `O(N)` | Sensitive auth, payments, strict rolling caps |
| `token-bucket` | Continuous refill | Yes (up to `capacity`) | `O(1)` | Bursty APIs with steady sustained rate |

## Resilience & Observability

- **Timeout & Failover**: Bounds store calls with `timeoutMs`, protects failing primaries with `CircuitBreaker`, and falls back to memory via `ResilientStore` while setting `RateLimit-Degraded: true`. See [docs/resilience.md](docs/resilience.md).
- **Metrics & Tracing**: Exposes `/metrics` via `createPrometheusExporter()`, collapses dynamic URL parameters (`/users/42` -> `/users/:id`) to bound Prometheus series cardinality, and enriches active OpenTelemetry spans with `ratelimit.*` and `limitforge.*` attributes. See [docs/observability.md](docs/observability.md).

## Configuration Reference

```typescript
const limiter = rateLimiter(options);
```

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `limit` | `number \| ((req) => number)` | `60` | Max requests per `windowMs` (or fallback burst cap for token bucket) |
| `windowMs` | `number \| ((req) => number)` | `60000` | Quota window duration in milliseconds |
| `algorithm` | `'fixed-window' \| 'sliding-window' \| 'token-bucket'` | `'fixed-window'` | Rate-limiting algorithm |
| `capacity` | `number \| ((req) => number)` | — | Token bucket max capacity (falls back to `limit`) |
| `refillRate` | `number \| ((req) => number)` | — | Tokens added per `refillIntervalMs` |
| `refillIntervalMs` | `number \| ((req) => number)` | `1000` | Token bucket refill interval in milliseconds |
| `cost` | `number \| ((req) => number)` | `1` | Token cost deducted per request |
| `store` | `IRateLimitStore` | Isolated `MemoryStore` | Backing store (`MemoryStore`, `RedisStore`, `ResilientStore`, or custom) |
| `prefix` | `string` | `'limitforge'` | Key namespace prefix (falls back to `store.prefix` if omitted) |
| `keyGenerator` | `(req) => string \| Promise<string>` | `(req) => req.ip` | Client identifier extractor |
| `hashClientIdentifier` | `boolean \| ((id) => string)` | `false` | Hashes client IDs before storage (`true` uses SHA-256) |
| `includeRoute` | `boolean` | Auto | Scopes quota by route (`false` for `app.use()`, `true` on direct routes) |
| `routeNormalizer` | `(req) => string` | Pattern / path sanitizer | Custom route grouping for keys and telemetry labels |
| `fallbackStore` | `boolean \| IRateLimitStore` | `false` | Wraps `store` in a `ResilientStore` using memory or custom fallback |
| `timeoutMs` | `number` | `250` | Store timeout in ms before raising `StoreTimeoutError` |
| `circuitBreaker` | `boolean \| CircuitBreakerOptions \| CircuitBreaker` | `false` | Enables or supplies a `CircuitBreaker` instance |
| `failureThreshold` | `number` | `5` | Consecutive store failures before tripping the breaker to `OPEN` |
| `resetTimeoutMs` | `number` | `10000` | Cooldown in ms before transitioning `OPEN` -> `HALF_OPEN` |
| `successThreshold` | `number` | `1` | Successful probes required in `HALF_OPEN` to reset to `CLOSED` |
| `breakerId` | `string` | — | Explicit `breaker` label exported to Prometheus gauges |
| `onStoreError` | `'fail-open' \| 'fail-closed' \| 'error' \| Function` | `'error'` (`next(err)`) | Strategy when a store call fails or times out (alias: `failStrategy`) |
| `metrics` | `boolean \| MetricsCollector` | `false` | Enables default collector (`true`) or passes a custom collector |
| `metricsCollector` | `MetricsCollector` | — | Explicit collector instance (takes precedence over `metrics`) |
| `openTelemetry` | `boolean \| OpenTelemetryBridge \| object` | `false` | Enables active span enrichment or child span creation |
| `skip` | `(req) => boolean \| Promise<boolean>` | — | Bypass rate limiting cleanly when returning truthy |
| `statusCode` | `number` | `429` | HTTP status code returned when blocked |
| `message` | `string \| object \| Function` | `{ success: false, message: 'Too many requests', retryAfter }` | Response body returned when blocked |
| `standardHeaders` | `boolean` | `true` | Sends `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` |

### Key Configuration Notes

- **Store isolation**: Calling `rateLimiter()` without `store` creates a separate `MemoryStore` per middleware instance. Share a store explicitly if multiple limiters should share counters, and set distinct `prefix` values to isolate separate policies sharing one `RedisStore`.
- **Route quota scope**: Global middleware (`app.use()`) shares quotas across paths per client and HTTP method by default, while route-attached middleware (`app.get('/path', limiter, ...)`) uses the matched Express route pattern. Set `includeRoute` explicitly when wrapping limiters in helper functions; explicit `includeRoute: false` still preserves `routeNormalizer` for telemetry labels.
- **Token bucket defaults**: Fixed and sliding windows default omitted `limit` and `windowMs` to `60` and `60000`. Token bucket requires `capacity` (or `limit`) and either `refillRate` or both `limit` and `windowMs` (derived as `limit * refillIntervalMs / windowMs`).
- **Timeouts on `ResilientStore`**: When passing a `ResilientStore`, configure `timeoutMs` on `ResilientStore` itself rather than on `rateLimiter()`. The timeout applies separately to primary and fallback calls and stops awaiting without cancelling underlying async operations.
- **Redis clock, precision & key encoding**: Sliding-window and token-bucket Lua scripts read Redis `TIME` by default (Redis ACL must permit `TIME`, `GET`, `PTTL`, `SET`), and fractional millisecond windows round up cleanly. Delimiters (`:`, `%`) and invalid lone UTF-16 surrogates are escaped across segments; custom `keyGenerator` implementations should return unambiguously formatted identifiers.
- **Header suppression**: `standardHeaders: false` suppresses `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset`, while keeping `Retry-After` and `RateLimit-Degraded`.

## Examples & Demos

| Command | Entry Point | Description |
| :--- | :--- | :--- |
| `npm run dev` | `examples/express-demo/server.js` | Multi-route Express demo with watch reload |
| `npm run demo:multi` | `examples/express-demo/multi-instance.js` | Two Express instances sharing Redis state |
| `npm run demo:sliding` | `examples/express-demo/sliding-demo.js` | Fixed vs Sliding Window boundary burst comparison |
| `npm run demo:burst` | `examples/express-demo/burst-demo.js` | Token Bucket burst capacity & continuous refill |
| `npm run demo:saas` | `examples/express-demo/saas-demo.js` | Multi-tier SaaS (Free, Pro, Enterprise) quotas |
| `npm run demo:resilience` | `examples/express-demo/resilience-demo.js` | Fault injection, circuit breaker trip, and recovery |
| `npm run demo:observability` | `examples/express-demo/observability-demo.js` | Standalone Prometheus `/metrics` & OTel span trace demo |
| `npm run demo:stack` | `examples/observability-stack/server.js` | Express + Redis + Prometheus + Grafana stack |
| `npm run demo:simulate` | `examples/observability-stack/simulate-traffic.js` | Traffic & chaos simulator for the observability stack |

## Testing & Benchmarks

Run the test suite (set `REDIS_URL`, e.g. `redis://localhost:6379`, to include live Redis integration tests; otherwise Redis tests are skipped):

```bash
npm test
```

Verify ambient TypeScript definitions (`index.d.ts`):

```bash
npm run typecheck
```

Run nanosecond-resolution overhead benchmarks (`process.hrtime.bigint()`):

```bash
npm run benchmark
```

`MemoryStore` evaluation adds roughly **+2.4 µs to +2.5 µs** p50 latency over a no-op middleware (`2.8 µs to 2.9 µs` scenario p50). See [docs/PERFORMANCE_REPORT.md](docs/PERFORMANCE_REPORT.md) for full results.

## Documentation

- [Architecture & Storage Internals](docs/architecture.md)
- [Resilience & Failure Handling](docs/resilience.md)
- [Observability, Prometheus & OpenTelemetry](docs/observability.md)
- [Performance & Overhead Report](docs/PERFORMANCE_REPORT.md)
- [Changelog](CHANGELOG.md)
- [Contributing Guidelines](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)

## License

MIT © [Anivesh Sikarwar](https://github.com/Anivesh91)
