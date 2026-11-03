# Changelog

All notable changes to **LimitForge** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [8.0.1] - 2026-10-19

### Changed
- **Official NPM Branding**: Rebranded published package to `limitforge` with public unscoped registry distribution.
- **Repository Metadata**: Synchronized GitHub repository URL, issue tracker, and homepage to `https://github.com/Anivesh91/LimitForge`.
- **Demo & Observability Alignment**: Unified all demonstration servers, traffic simulators, and benchmark banners under the LimitForge identity.
- **TypeScript Type Definitions**: Enriched `index.d.ts` with strict typings for `StoreErrorMode`, `CircuitBreakerOptions`, `CircuitBreaker`, `IRateLimitStore`, and `routeNormalizer`.

### Fixed
- Fixed documentation links and CI status badge endpoints.

---

## [8.0.0] - 2026-10-18

### Added
- **Official NPM Release**: Formally released package on NPM registry.
- **TypeScript Declarations**: Added comprehensive ambient type definitions in `index.d.ts` covering all options, algorithms, stores, resilience guards, and telemetry bridges.
- **Production Tarball Whitelist**: Added `files` field in `package.json` packaging only runtime assets (`src/`, `index.d.ts`, `README.md`, `LICENSE`), eliminating internal tests and dev tools from consumer downloads.
- **Root License**: Added official MIT `LICENSE` file.
- **GitHub Actions CI/CD Pipeline**: Multi-version test matrix running on Node.js 18, 20, and 22 with live Redis service container.
- **Proxy Configuration in Demos**: Enabled `trust proxy` in Express demos for accurate client IP resolution behind Cloudflare, Railway, AWS ALB, and reverse proxies.
- **Production Hardening**: Enforced 127.0.0.1 loopback binding for local Redis instances and added authenticated chaos injection in observability demo stack.

---

## [7.0.0] - 2026-10-15

### Added
- **Zero-Dependency Native Prometheus Exposition (`/metrics`)**: Serializes counters, gauges, and cumulative histograms strictly adhering to standard Prometheus text exposition format (v0.0.4) without requiring `prom-client`.
- **In-Memory Metrics Engine (`MetricsCollector`)**: High-throughput thread-safe aggregation with strict `maxSeries` memory bound and `_overflow` route aggregation.
- **Cardinality Guard & Dynamic Route Sanitization (`normalizeRoute`)**: Automatically collapses numeric, UUID, ULID, and CUID identifiers into `:id` segments to protect TSDBs from label explosion.
- **Circuit Breaker Isolation**: Supports `breakerId` for isolated gauge metrics (`smartrate_circuit_breaker_state{breaker="..."}`) and WeakMap listener deduplication.
- **ResilientStore Outage Observability**: Automatically increments `smartrate_store_errors_total` and records span exceptions when primary store operations fail or time out.
- **Duck-Typed OpenTelemetry Bridge (`OpenTelemetryBridge`)**: Enriches request spans with semantic attributes (`smartrate.outcome`, `smartrate.algorithm`, `smartrate.route`, `smartrate.remaining`, `smartrate.reset`) and emits span events without requiring `@opentelemetry/api`.
- **Production Grafana Dashboard**: Pre-built importable Grafana dashboard JSON (`assets/dashboards/smartrate-grafana-dashboard.json`) featuring live throughput, block rate ratio, and latency percentiles.
- **Production Alertmanager Rules**: Standard Prometheus alerting rules (`assets/alerts/prometheus-rules.yml`) for High Block Rate (>25%), Store Outages, Circuit Breaker trips, and High Store Latency (p95 > 50ms).
- **High-Precision Benchmarking CLI (`npm run benchmark`)**: Nanosecond-precision overhead measurement (`process.hrtime.bigint()`) across 6 scenarios with 1,000 warmups + 10,000 requests each.

---

## [6.0.0] - 2026-09-28

### Added
- **Store Timeout Guard (`withTimeout`, `StoreTimeoutError`)**: Enforces bounded operation latency (`timeoutMs`) on store calls to prevent slow database sockets from hanging Node.js event loops.
- **Store Failure Policies (`onStoreError`)**:
  - `fail-open`: Requests bypass rate limiting cleanly during database outages (`next()`), attaching `RateLimit-Degraded: true`.
  - `fail-closed`: Requests are rejected with `HTTP 503 Service Unavailable` and dynamic `Retry-After`.
  - Custom callback: `(err, req, res, next)` for application-specific fallback routing.
- **Circuit Breaker Engine (`CircuitBreaker`)**: Stateful state machine (`CLOSED`, `OPEN`, `HALF_OPEN`) with fast-failing during outages and single canary probes for graceful self-healing.
- **Dual-Store Resilience Wrapper (`ResilientStore`)**: Combines a primary store (e.g., Redis) with an automatic local fallback store (e.g., MemoryStore).

---

## [5.0.0] - 2026-09-26

### Added
- **Option C HTTP Recovery & Reset Semantics**: Exact mathematical parity across MemoryStore and RedisStore for `RateLimit-Reset` and `Retry-After`.
- **Client Recovery Verification**: End-to-end simulation of `200 OK` (burst) $\to$ `429 Too Many Requests` $\to$ wait `Retry-After` $\to$ `200 OK` recovery.
- **Parallel Burst Concurrency Stress Tests**: Verification of 50 simultaneous parallel requests enforcing exact burst capacity under distributed Redis Lua.

---

## [4.0.0] - 2026-09-25

### Added
- **Token Bucket Algorithm (`algorithm: 'token-bucket'`)**: Sub-second continuous token refill with burst capacity handling.
- **Custom Client Identity (`keyGenerator`)**: Custom identifier generation supporting API keys, User IDs, and multi-tenant keys with automatic fallback to client IP.
- **Dynamic Tier-Based Policies**: Dynamic resolution of `limit`, `windowMs`, `capacity`, and `refillRate` per request based on authenticated user tier.
- **Weighted Request Costs (`cost`)**: Variable token consumption based on request payload weight or query parameters.
- **Defensive Identifier Hashing**: Optional SHA-256 cryptographic hashing (`hashClientIdentifier: true`) to mask raw API tokens in storage.

---

## [3.0.0] - 2026-09-24

### Added
- **Rolling Sliding Window Algorithm (`algorithm: 'sliding-window'`)**: Eliminates boundary-burst vulnerabilities using precise timestamp tracking.
- **Atomic Redis ZSET Lua Engine**: High-performance sorted set implementation with rolling window eviction and atomic state transitions.
- **Cross-Instance Synchronization**: Shared rate limiting across multiple distinct Express application instances.

---

## [2.0.0] - 2026-09-23

### Added
- **Pluggable Storage Architecture**: Decoupled middleware engine from storage backend via `IRateLimitStore` interface.
- **Distributed Redis Storage (`RedisStore`)**: Distributed atomic rate limiting across multiple server nodes using Redis Lua scripts.
- **Lua Script Optimization**: Atomic increment and TTL assignment in a single Redis round-trip.

---

## [1.0.0] - 2026-09-22

### Added
- Initial release of In-Memory Fixed Window rate limiter for Express.js.
- Standard rate limit response headers (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`).
- Configurable window duration and maximum request thresholds.
