# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [9.0.1] - 2026-11-09

### Fixed
- **Observability Docker Stack Dependencies (`examples/observability-stack/Dockerfile`)**: Explicitly installed `express` and optional peer dependency `redis` during image build so `docker compose up` starts cleanly with zero runtime dependencies in `package.json`; removed obsolete `version` key from `docker-compose.yml`.
- **TypeScript Declarations Alignment (`index.d.ts`)**: Added missing declarations for exported Prometheus formatting helpers (`escapeLabelValue`, `escapeHelpString`, `formatLabels`), telemetry metadata constants (`METRIC_METADATA`, `CIRCUIT_STATE_GAUGE_VALUES`, `DEFAULT_STORE_DURATION_BUCKETS`), and `CircuitBreaker.getStats()` runtime fields (`lastFailureTime`, `nextAttempt`, `probeInFlight`).

### Changed
- **Benchmark & README Sync (`docs/PERFORMANCE_REPORT.md`, `README.md`)**: Updated latency and throughput figures to reflect measured `v9.0.0` `npm run benchmark` results (`+2.4–2.5 µs` added p50 overhead, `222k–262k ops/s` in-memory).

---

## [9.0.0] - 2026-11-09

### Changed
- **BREAKING — Prometheus Metric Namespace (`limitforge_*`)**: Renamed all core Prometheus metrics from `smartrate_*` to `limitforge_*` (`limitforge_requests_total`, `limitforge_store_errors_total`, `limitforge_degraded_requests_total`, `limitforge_circuit_breaker_state`, `limitforge_store_duration_seconds`), updated alerting rules (`limitforge.rules` / `LimitForge*`), and replaced the legacy Grafana dashboard with `assets/dashboards/limitforge-grafana-dashboard.json`.
- **BREAKING — OpenTelemetry Span & Attribute Namespace (`limitforge.*`)**: Migrated child span names (`limitforge.consume`), span attributes (`limitforge.outcome`, `limitforge.algorithm`, `limitforge.route`, `limitforge.store`, `limitforge.remaining`, `limitforge.reset`, `limitforge.degraded`, `limitforge.store_error`), span events (`limitforge.rate_limit_exceeded`, `limitforge.store_error`), and the internal request span field (`req._limitForgeSpan`) from `smartrate.*` to `limitforge.*` while continuing to emit standard `ratelimit.*` attributes.
- **BREAKING — Runtime Error Prefixes (`LimitForge:`)**: Standardized all middleware, store, resilience, and Redis Lua script error messages from `SmartRate:` to `LimitForge:`.
- **Modular Middleware & Cleanup**: Refactored limiter internals into focused modules (`options.js`, `policyResolver.js`, `response.js`, `errorHandler.js`, `telemetryHelper.js`) and aligned documentation, examples, and test suites under the `LimitForge` identity.

### Removed
- Removed legacy `assets/dashboards/smartrate-grafana-dashboard.json`.

---

## [8.1.0] - 2026-11-05

### Added
- **Global Quota Sharing (`includeRoute`)**: Added `includeRoute` option to `rateLimiter()` (defaults to `false`), allowing global API rate limit quotas to be shared seamlessly across multiple route paths while retaining per-route isolation when desired.
- **Direct Prometheus Collector Integration**: `createPrometheusExporter()` now supports direct ingestion of pre-configured `MetricsCollector` instances alongside standard options objects.

### Fixed
- **Distributed Clock Drift Protection**: Updated Redis sliding window and token bucket Lua scripts to leverage Redis server time (`redis.call('TIME')`) instead of client timestamps, preventing desynchronization in multi-instance clusters.
- **Dynamic Fixed-Window Durations**: Fixed fixed-window duration handling in both `MemoryStore` and `RedisStore` when dynamic policy functions return runtime window values.
- **Redis Window Duration Rounding & Validation**: Ensured millisecond window durations are safely rounded up to whole seconds (`Math.ceil`) to prevent sub-second zero TTLs and rejected unsafe/non-positive duration values before issuing Redis commands.
- **Key Separation & Collision Hardening**: Escaped key separators (`:`) and components to eliminate ambiguity and prevent cross-tenant/cross-route key collision attacks.
- **Store Isolation & Memory Leak Prevention**: Isolated default limiter stores per middleware instance and resolved potential memory retention issues for unreferenced limiters.
- **Token Bucket Custom Refill Intervals**: Correctly accounted for custom `refillIntervalMs` intervals when calculating Redis token refill rates.
- **Resilience Store Fallback Timeout**: Enforced hard timeout guards on `ResilientStore` fallback operations to prevent indefinite hanging when upstream recovery fails.
- **OpenTelemetry Span Isolation**: Protected request pipeline from OpenTelemetry span creation or recording errors.
- **Metric Overflow & Cardinality Safeguards**: Preserved counter totals and handled gauge overflow within bounded series caps, dropping stale series safely under memory pressure.
- **TypeScript Declarations Alignment**: Updated `index.d.ts` ambient types to match runtime signatures for `createPrometheusExporter`, `recordStoreDuration`, `recordCircuitBreakerState`, and middleware zero-config defaults.
- **Cross-Platform CRLF Compatibility**: Standardized test regexes for Windows and POSIX line endings across telemetry test suites.

---

## [8.0.2] - 2026-11-04

### Changed
- **Documentation Restructure**: Reorganized the main README into a concise 200-line developer guide, shifting deep architectural and operational details into modular guides (`docs/architecture.md`, `docs/resilience.md`, `docs/observability.md`, and `docs/PERFORMANCE_REPORT.md`).
- **Technical Terminology & Semantics**: Grounded rate-limiting definitions from coarse DDoS prevention to application-level API request throttling; updated architecture diagrams to accurately reflect middleware route continuation (`next()`).
- **Telemetry Naming Context**: Clarified default `smartrate_*` metric event namespace for pre-built Grafana/Alertmanager compatibility and documented dual-emitted OpenTelemetry span attributes.
- **Community Policies**: Formally integrated `SECURITY.md` vulnerability reporting protocol, `CONTRIBUTING.md` developer workflow, and standardized `CHANGELOG.md`.

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

[9.0.1]: https://github.com/Anivesh91/LimitForge/compare/v9.0.0...v9.0.1
[9.0.0]: https://github.com/Anivesh91/LimitForge/compare/v8.1.0...v9.0.0
[8.1.0]: https://github.com/Anivesh91/LimitForge/compare/v8.0.2...v8.1.0
[8.0.2]: https://github.com/Anivesh91/LimitForge/compare/v8.0.1...v8.0.2
[8.0.1]: https://github.com/Anivesh91/LimitForge/compare/v8.0.0...v8.0.1
[8.0.0]: https://github.com/Anivesh91/LimitForge/compare/v7.0.0...v8.0.0
[7.0.0]: https://github.com/Anivesh91/LimitForge/compare/v6.0.0...v7.0.0
[6.0.0]: https://github.com/Anivesh91/LimitForge/compare/v5.0.0...v6.0.0
[5.0.0]: https://github.com/Anivesh91/LimitForge/compare/v4.0.0...v5.0.0
[4.0.0]: https://github.com/Anivesh91/LimitForge/compare/v3.0.0...v4.0.0
[3.0.0]: https://github.com/Anivesh91/LimitForge/compare/v2.0.0...v3.0.0
[2.0.0]: https://github.com/Anivesh91/LimitForge/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/Anivesh91/LimitForge/releases/tag/v1.0.0
