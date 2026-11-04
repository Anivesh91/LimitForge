# Observability & Monitoring

LimitForge includes native, production-grade observability covering Prometheus metrics exposition, Grafana dashboards, Alertmanager rules, and OpenTelemetry distributed tracing.

---

## 1. Zero-Dependency Native Prometheus Exposition (`/metrics`)

LimitForge serializes metrics strictly following the **Prometheus Text Exposition Format (v0.0.4)** without requiring third-party libraries like `prom-client`.

### Setup

Mount the exporter on any Express application:

```javascript
import express from 'express';
import { rateLimiter, createPrometheusExporter } from 'limitforge';

const app = express();

// Apply rate limiting middleware
app.use(rateLimiter({ limit: 100, windowMs: 60000, metrics: true }));

// Expose standard Prometheus scrape endpoint
app.get('/metrics', createPrometheusExporter());

app.listen(3000);
```

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:c64de25533acf908a37a7a1a7e5a5cf9ba6147b69fe88b3411b2a046cfabb81e -->

`metrics: true` records to the shared default collector used by `createPrometheusExporter()`. For an independent collector, pass the same instance as `metricsCollector` to the limiter and to `createPrometheusExporter(collector)`. The exporter also accepts `{ collector }` or `{ metricsCollector: collector }`; if both options are provided, `collector` takes precedence.

<!-- /coderabbit-ai-generated:v1 -->

When scraped by Prometheus (`GET /metrics`), LimitForge returns `Content-Type: text/plain; version=0.0.4; charset=utf-8`:

```text
# HELP smartrate_requests_total Total number of rate limiter requests evaluated.
# TYPE smartrate_requests_total counter
smartrate_requests_total{algorithm="sliding-window",method="GET",normalized_route="/api/users/:id",outcome="allowed",store="redis"} 142
smartrate_requests_total{algorithm="sliding-window",method="GET",normalized_route="/api/users/:id",outcome="blocked",store="redis"} 8

# HELP smartrate_store_duration_seconds Latency of rate limiter store operations in seconds.
# TYPE smartrate_store_duration_seconds histogram
smartrate_store_duration_seconds_bucket{le="0.001",store="redis"} 138
smartrate_store_duration_seconds_bucket{le="0.005",store="redis"} 148
smartrate_store_duration_seconds_bucket{le="+Inf",store="redis"} 150
smartrate_store_duration_seconds_sum{store="redis"} 0.0892
smartrate_store_duration_seconds_count{store="redis"} 150

# HELP smartrate_circuit_breaker_state Current state of the store circuit breaker (0=CLOSED, 1=OPEN, 2=HALF_OPEN).
# TYPE smartrate_circuit_breaker_state gauge
smartrate_circuit_breaker_state{breaker="default"} 0
```

---

## 2. Metric Schemas & Telemetry Namespace

> **Note on Telemetry Naming:**  
> LimitForge uses `smartrate_*` as the default metric event namespace. This maintains seamless drop-in compatibility with pre-built Grafana dashboards, Alertmanager rules, and existing Prometheus alerting pipelines.

### Metrics Catalog

| Metric Name | Type | Labels | Description |
| :--- | :---: | :--- | :--- |
| **`smartrate_requests_total`** | Counter | `algorithm`, `method`, `normalized_route`, `outcome`, `store` | Total evaluated requests partitioned by outcome (`allowed` vs `blocked`). |
| **`smartrate_store_duration_seconds`** | Histogram | `store`, `le` | Store execution latency in seconds with 11 calibrated microsecond-to-second buckets. |
| **`smartrate_store_errors_total`** | Counter | `store` | Number of store execution failures or timeout errors. |
| **`smartrate_circuit_breaker_state`** | Gauge | `breaker` | Instantaneous circuit breaker state (`0` = CLOSED, `1` = OPEN, `2` = HALF_OPEN). |
| **`smartrate_degraded_requests_total`** | Counter | *None* | Number of requests served under fallback or degraded store mode. |

---

## 3. Cardinality Guard & Route Sanitization

Uncontrolled label cardinality is the leading cause of memory exhaustion in Prometheus TSDB. LimitForge enforces strict label hygiene:

1. **Client Identifiers Excluded**: User IDs, API keys, and client IPs are **never** attached to Prometheus labels.
2. **Dynamic Route Sanitization**: Dynamic URL segments are automatically collapsed into standard `:id` route parameters:
   - `/users/42` $\to$ `/users/:id`
   - `/orders/550e8400-e29b-41d4-a716-446655440000` $\to$ `/orders/:id` (UUID)
   - `/items/01ARZ3NDEKTSV4RRFFQ69G5FAV` $\to$ `/items/:id` (ULID)
3. **Hard Series Bound (`maxSeries`)**:
   `MetricsCollector` enforces an in-process maximum series limit (default: 1,000 series per metric). If arbitrary random paths are flooded (e.g., fuzzing attacks), excess paths aggregate into a designated `_overflow` metric bucket, preventing Node.js heap leaks.

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:15a8a16d2420dadb2d4c8354edba08bae350b8cf3d52d4ac98df74fa530b912e -->

Each counter reserves one series for overflow. The aggregate has `normalized_route="_overflow"` and `limitforge_overflow="true"`; original route, outcome, method, store, and other labels are not retained in that series. Queries filtered by those labels will not include overflow counts. With `maxSeries: 1`, all counter increments aggregate there. Gauges and histograms continue to drop new label combinations when their series limit is reached; existing series continue updating.

<!-- /coderabbit-ai-generated:v1 -->

---

## 4. OpenTelemetry Distributed Tracing

LimitForge includes an `OpenTelemetryBridge` that automatically extracts active request spans using duck typing. It functions with or without `@opentelemetry/api` installed in your project.

### Active Span Enrichment

On every request, the active span is enriched with both standard `ratelimit.*` semantic conventions and backward-compatible `smartrate.*` attributes:

```typescript
// Standard Semantic Conventions
span.setAttribute('ratelimit.allowed', true);
span.setAttribute('ratelimit.remaining', 49);
span.setAttribute('ratelimit.reset', 60);
span.setAttribute('ratelimit.algorithm', 'token-bucket');
span.setAttribute('ratelimit.store', 'redis');
span.setAttribute('ratelimit.degraded', false);

// Telemetry Attributes
span.setAttribute('smartrate.outcome', 'allowed');
span.setAttribute('smartrate.route', '/api/users/:id');
```

When a request is blocked (HTTP 429), a `smartrate.rate_limit_exceeded` span event is added with `retry_after`. When a store fails, an exception is recorded on the span alongside `ratelimit.store_error: true`.

---

## 5. Grafana Dashboard & Alertmanager Assets

LimitForge provides out-of-the-box infrastructure monitoring configurations in the repository's `assets/` directory:

- **Grafana Dashboard** (`assets/dashboards/smartrate-grafana-dashboard.json`):
  Importable JSON dashboard with real-time panels for Throughput (allowed vs blocked), Block Rate ratio gauge, Store Latency p50/p95/p99 percentiles, and Circuit Breaker status.
- **Alertmanager Rules** (`assets/alerts/prometheus-rules.yml`):
  Production alerts for High Block Rate (>25%), Store Outages, Circuit Breaker Open events, and Store Latency degradation (p95 > 50ms).

For a complete runnable Docker Compose environment featuring Express, Redis, Prometheus, and Grafana, see `examples/observability-stack/`.
