# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [8.0.1] - 2026-10-19

### Changed
- **Repository URL Synchronization**: Updated `package.json`, documentation, and CI workflows to point to the official `LimitForge` repository on GitHub.
- **Brand Alignment**: Unified all example demos, chaos test scripts, observability stacks, and benchmark CLI banners under the `LimitForge` identity.
- **Dependency Optimization**: Explicitly separated `redis` into optional `peerDependencies` (`>=4.0.0`) and `devDependencies` to ensure zero runtime dependency bloat for in-memory users.

---

## [8.0.0] - 2026-10-18

### Added
- **Official NPM Release**: Published as `limitforge` on npm with zero runtime dependencies.
- **TypeScript Declarations**: Comprehensive TypeScript definitions (`index.d.ts`) covering all options, stores, circuit breakers, and telemetry exports.
- **CI/CD Pipeline**: GitHub Actions test matrix across Node.js 18, 20, and 22 with live Redis service containers.
- **Tarball Whitelist (`files`)**: Clean packaging including only runtime code (`src/`, `index.d.ts`, `README.md`, `LICENSE`), excluding internal test fixtures.
- **MIT License**: Formal open-source legal clearance added via root `LICENSE`.

### Security
- Added `engines` field enforcing Node.js `>=18.0.0`.
- Bound demo Redis containers to `127.0.0.1:6379`.
- Parameterized Grafana admin credentials and authenticated chaos injection endpoints.

---

## [7.0.0] - 2026-10-10

### Added
- **Zero-Dependency Native Prometheus Exposition (`/metrics`)**:
  - Implemented `createPrometheusExporter()` Express middleware and `formatPrometheusMetrics()` serializer adhering strictly to Prometheus v0.0.4 text exposition format without external dependencies.
- **In-Memory Metrics Engine (`MetricsCollector`)**:
  - Thread-safe tracking of throughput outcomes (`smartrate_requests_total`), store latencies (`smartrate_store_duration_seconds`), and circuit breaker states.
- **Cardinality Guard & Dynamic Route Normalizer**:
  - Automated collapsing of dynamic entity IDs (UUID, ULID, CUID, numeric, hex) to `:id` segments. Strictly excludes client IPs and tokens from metric labels.
  - Hard series limit (`maxSeries`) collapsing excess routes into a safe `_overflow` metric bucket.
- **OpenTelemetry Bridge (`OpenTelemetryBridge`)**:
  - Duck-typed enrichment of active request spans with standard `ratelimit.*` attributes and exception recording without requiring mandatory `@opentelemetry/api`.
- **Production Observability Stack**:
  - Ready-to-deploy Docker Compose stack with Prometheus, Grafana, Redis, Alertmanager rules, and an automated traffic simulation generator.
- **High-Precision Benchmarks CLI**:
  - Monotonic nanosecond timer benchmarks (`npm run benchmark`) verifying in-memory overhead bounded at ~2.3–3.7 µs (p50).

---

## [6.0.0] - 2026-10-02

### Added
- **Store Timeout Guard**:
  - Enforced bounded store execution via `timeoutMs` (default 250ms) to prevent slow Redis or network partitions from stalling Express event loops.
- **Configurable Failure Policies (`onStoreError`)**:
  - Supported `next(err)` (default), `'fail-open'` (bypass rate limiting gracefully), and `'fail-closed'` (HTTP 503 rejection with dynamic `Retry-After`).
- **Store Circuit Breaker Engine (`CircuitBreaker`)**:
  - Finite State Machine (`CLOSED`, `OPEN`, `HALF_OPEN`) with lazy cooldown evaluation, single-flight canary probes, and store health probing.
- **Dual-Store Resilience Wrapper (`ResilientStore`)**:
  - Transparent primary/fallback store orchestration (e.g., Redis primary with MemoryStore fallback) setting `RateLimit-Degraded: true` and attaching `req.rateLimit` metadata.

---

## [5.0.0] - 2026-09-27

### Added
- **Token Bucket Algorithm (`algorithm: 'token-bucket'`)**:
  - Sub-second continuous token refill math allowing controlled traffic bursts up to maximum configured `capacity`.
- **Option C `RateLimit-Reset` Semantics**:
  - Synchronized header parity across MemoryStore and RedisStore: allowed requests display seconds until the next token refills; blocked requests display exact seconds until sufficient tokens replenish.
- **Distributed Shared Token Bucket**:
  - High-concurrency Redis Lua script executing atomic continuous refill and token consumption across multiple Node.js instances with zero race conditions.

---

## [4.0.0] - 2026-09-20

### Added
- **Custom Client Identity (`keyGenerator`)**:
  - Support for API Key, Authenticated User ID, and Multi-Tenant composite rate limiting keys.
  - Safe defensive clamping of client identifiers to 256 characters (`MAX_IDENTIFIER_LENGTH = 256`) and optional cryptographic SHA-256 hashing (`hashClientIdentifier: true`).
- **Dynamic Tier-Based Policies**:
  - Support for request-time dynamic resolution of `capacity`, `refillRate`, `limit`, and `windowMs` based on request attributes or subscription tiers.
- **Weighted Request Costs (`cost`)**:
  - Dynamic consumption weights for resource-intensive endpoints (e.g., file exports, heavy queries).

---

## [3.0.0] - 2026-09-15

### Added
- **Rolling Sliding Window Rate Limiting (`algorithm: 'sliding-window'`)**:
  - Accurate rolling-window protection strictly preventing boundary bursts.
  - MemoryStore sliding queue with automatic periodic idle bucket eviction.
  - Distributed atomic Redis implementation using Sorted Sets (ZSET) and microsecond Lua operations.

---

## [2.0.0] - 2026-09-08

### Added
- **Pluggable Storage Engine Architecture**:
  - Decoupled storage interface implementing `.consume(key, options)`.
- **Distributed RedisStore**:
  - Redis-backed rate limiting using atomic Lua scripts supporting both `node-redis` v4/v5/v6 and compatible clients.

---

## [1.0.0] - 2026-09-01

### Added
- **Initial Release**:
  - In-memory Fixed Window rate limiting middleware for Express.js.
  - Standard headers: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`.
  - HTTP 429 Too Many Requests response with `Retry-After` header.

[8.0.1]: https://github.com/Anivesh91/LimitForge/compare/v8.0.0...v8.0.1
[8.0.0]: https://github.com/Anivesh91/LimitForge/compare/v7.0.0...v8.0.0
[7.0.0]: https://github.com/Anivesh91/LimitForge/compare/v6.0.0...v7.0.0
[6.0.0]: https://github.com/Anivesh91/LimitForge/compare/v5.0.0...v6.0.0
[5.0.0]: https://github.com/Anivesh91/LimitForge/compare/v4.0.0...v5.0.0
[4.0.0]: https://github.com/Anivesh91/LimitForge/compare/v3.0.0...v4.0.0
[3.0.0]: https://github.com/Anivesh91/LimitForge/compare/v2.0.0...v3.0.0
[2.0.0]: https://github.com/Anivesh91/LimitForge/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/Anivesh91/LimitForge/releases/tag/v1.0.0
