# LimitForge — Observability Demo Stack

Runnable Docker Compose stack integrating Express, LimitForge, Redis, Prometheus, Grafana, Alertmanager rules, and OpenTelemetry span instrumentation.

## Architecture

```text
                      +-----------------------------+
                      |       Client Traffic        |
                      +--------------+--------------+
                                     |
                                     v
                      +-----------------------------+
                      |      Express Application    |
                      |  (LimitForge Middleware)    |
                      +--------------+--------------+
                                     |
                +--------------------+--------------------+
                |                                         |
     (Primary Distributed)                          (Local Fallback)
                v                                         v
       +-----------------+                       +-----------------+
       |   RedisStore    |                       |   MemoryStore   |
       +--------+--------+                       +-----------------+
                |
                v (Failure / Timeout / Circuit Open)
       +-----------------+
       | Circuit Breaker | -> Degraded Mode (MemoryStore)
       +-----------------+
                |
                v
       +-----------------+
       |    /metrics     | <--- Scraped by Prometheus (:9090)
       +-----------------+             |
                                       v
                              +-----------------+
                              |     Grafana     | (:3001)
                              |    Dashboard    |
                              +-----------------+
```

## Quickstart (Docker Compose)

1. Start all services from the project root:
   ```bash
   docker compose -f examples/observability-stack/docker-compose.yml up -d --build
   ```
2. Open endpoints:
   - **Express App**: [http://localhost:3000](http://localhost:3000)
   - **Prometheus Metrics**: [http://localhost:3000/metrics](http://localhost:3000/metrics)
   - **Prometheus UI & Alerts**: [http://localhost:9090](http://localhost:9090)
   - **Grafana**: [http://localhost:3001](http://localhost:3001) *(login: `admin` / `limitforge_secure_dev`)*
3. Generate traffic, bursts, outages, and recovery:
   ```bash
   node examples/observability-stack/simulate-traffic.js
   ```

## OpenTelemetry Integration

- **In-Process Mock Span (`server.js`)**: Attaches mock request spans demonstrating `ratelimit.*` and `limitforge.*` attributes without requiring `@opentelemetry/sdk-node`.
- **Official Node SDK (`otel-sdk-example.js`)**: Connects `OpenTelemetryBridge` directly to `@opentelemetry/api` `trace.getActiveSpan()`:
  ```bash
  npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/sdk-trace-base
  node examples/observability-stack/otel-sdk-example.js
  ```

## Running Locally Without Docker

Start the demo server and traffic simulator from two terminals:

```bash
node examples/observability-stack/server.js
node examples/observability-stack/simulate-traffic.js
curl http://localhost:3000/metrics
```

## Simulating Outage & Recovery

Chaos endpoints in `server.js` are guarded by `chaosMiddleware.js` (`ALLOW_CHAOS` and `x-chaos-secret` when `NODE_ENV=production`).

### Trigger Outage
```bash
curl -X POST http://localhost:3000/api/chaos/break-store
```
- Primary store calls fail over to `MemoryStore` and attach `RateLimit-Degraded: true`.
- Increments `limitforge_store_errors_total{store="redis",error_type="econnrefused"}`.
- Trips the circuit breaker to `OPEN` (`2` on `limitforge_circuit_breaker_state`).
- Triggers `LimitForgeStoreOutage` and `LimitForgeCircuitBreakerOpen` alerts after evaluation windows.

### Restore Primary Store
```bash
curl -X POST http://localhost:3000/api/chaos/heal-store
```
- Restores Redis routing.
- After `resetTimeoutMs` (`10s`), the breaker transitions lazily to `HALF_OPEN`.
- The next request runs as a canary probe and resets the breaker to `CLOSED` (`0`) on success.

## Assets Included

- **Alert Rules** ([`assets/alerts/prometheus-rules.yml`](../../assets/alerts/prometheus-rules.yml)):
  - `LimitForgeHighBlockRate` (>25% 429 block rate)
  - `LimitForgeStoreOutage` (continuous store errors)
  - `LimitForgeCircuitBreakerOpen` (breaker in `OPEN` state)
  - `LimitForgeElevatedStoreLatency` (p95 store latency > 50ms)
  - `LimitForgeHighDegradedTraffic` (fallback traffic detected)
- **Grafana Dashboard** ([`assets/dashboards/limitforge-grafana-dashboard.json`](../../assets/dashboards/limitforge-grafana-dashboard.json)): Panels for throughput, block rate, circuit breaker state, p50/p95/p99 latency, store errors, and per-route traffic.
