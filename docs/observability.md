# Observability & Monitoring

LimitForge includes zero-dependency Prometheus exposition (`v0.0.4`), cardinality-bounded route sanitization, OpenTelemetry span enrichment, and sample Grafana/Alertmanager definitions.

## 1. Native Prometheus Exporter (`/metrics`)

Mount the exporter on any Express app without external dependencies such as `prom-client`:

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

Setting `metrics: true` records to the shared `defaultMetricsCollector` read by `createPrometheusExporter()`. For isolated per-app collection, pass a custom `MetricsCollector` as `metricsCollector` to `rateLimiter()` and to `createPrometheusExporter(collector)` (also accepts `{ collector }` or `{ metricsCollector }`, with `collector` taking precedence).

`GET /metrics` responds with `Content-Type: text/plain; version=0.0.4; charset=utf-8`:

```text
# HELP limitforge_requests_total Total number of rate limiter requests evaluated.
# TYPE limitforge_requests_total counter
limitforge_requests_total{algorithm="sliding-window",method="GET",normalized_route="/api/users/:id",outcome="allowed",store="redis"} 142
limitforge_requests_total{algorithm="sliding-window",method="GET",normalized_route="/api/users/:id",outcome="blocked",store="redis"} 8

# HELP limitforge_store_duration_seconds Duration of rate limiter store operations in seconds.
# TYPE limitforge_store_duration_seconds histogram
limitforge_store_duration_seconds_bucket{le="0.001",store="redis"} 138
limitforge_store_duration_seconds_bucket{le="0.005",store="redis"} 148
limitforge_store_duration_seconds_bucket{le="+Inf",store="redis"} 150
limitforge_store_duration_seconds_sum{store="redis"} 0.0892
limitforge_store_duration_seconds_count{store="redis"} 150

# HELP limitforge_circuit_breaker_state Current state of the rate limiter circuit breaker (0=CLOSED, 1=HALF_OPEN, 2=OPEN).
# TYPE limitforge_circuit_breaker_state gauge
limitforge_circuit_breaker_state{breaker="default"} 0
```

## 2. Metrics Catalog

All built-in middleware and cardinality diagnostics use the `limitforge_*` metric prefix:

| Metric Name | Type | Labels | Description |
| :--- | :---: | :--- | :--- |
| `limitforge_requests_total` | Counter | `algorithm`, `method`, `normalized_route`, `outcome`, `store` | Total evaluated requests (`allowed` / `blocked`) |
| `limitforge_store_duration_seconds` | Histogram | `store`, `le` | Store operation duration in seconds (11 default buckets: `0.0005`s–`1.0`s) |
| `limitforge_store_errors_total` | Counter | `store`, `error_type` | Store failures/timeouts (`timeout`, `circuit_open`, `econnrefused`, `store_error`) |
| `limitforge_circuit_breaker_state` | Gauge | `breaker` | Circuit breaker state (`0`=CLOSED, `1`=HALF_OPEN, `2`=OPEN) |
| `limitforge_degraded_requests_total` | Counter | `reason` | Requests served under degraded or fallback paths |
| `limitforge_metric_updates_dropped_total` | Counter | `metric_type`, `metric_name` | Gauge label updates dropped once `maxSeries` is reached |
| `limitforge_overflow_requests_allowed_total` | Counter | *None* | Allowed requests folded into the request overflow series |
| `limitforge_overflow_requests_blocked_total` | Counter | *None* | Blocked requests folded into the request overflow series |
| `limitforge_overflow_requests_other_total` | Counter | *None* | Other request outcomes folded into the request overflow series |

### Custom `MetricsCollector` API

```javascript
import { MetricsCollector } from 'limitforge';

const collector = new MetricsCollector({ maxSeries: 1000 });
collector.recordStoreDuration(0.0042, { store: 'redis' }); // duration in seconds
collector.recordCircuitBreakerState('OPEN', { breaker: 'main' });
```

## 3. Cardinality Guard & Route Sanitization

To protect Prometheus TSDB and Node heap memory under arbitrary URL scans or dynamic path traffic:

1. **No Client Identity Labels**: User IDs, API keys, and IP addresses are excluded from Prometheus labels.
2. **Route Parameter Sanitization**: Dynamic URL segments collapse to `:id` (integers, UUIDs, ULIDs, CUIDs, and long hex tokens >=16 chars). Matched Express routes prefer `req.baseUrl + req.route.path` directly.
3. **Bounded Series (`maxSeries`)**: `MetricsCollector` caps each metric at `1000` series by default:
   - **Counters & Histograms**: Reserve 1 slot (`normalized_route="_overflow"`, `limitforge_overflow="true"`) once series reach `maxSeries - 1`. With `maxSeries: 1`, all observations land in `_overflow`; overflow histograms keep the bucket bounds of the first overflow observation while retaining exact `count` and `sum`. Original per-label filters exclude `_overflow`.
   - **Global Overflow Outcomes**: `limitforge_overflow_requests_{allowed,blocked,other}_total` retain global outcome totals for requests aggregated into `_overflow`. Add these to filtered `limitforge_requests_total{outcome="..."}` queries for cluster totals; do not add them to unfiltered `limitforge_requests_total` totals (which already count `_overflow`).
   - **Gauges**: New label sets past `maxSeries` are dropped (existing series still update) and counted via `limitforge_metric_updates_dropped_total`.

## 4. OpenTelemetry Tracing (`OpenTelemetryBridge`)

`OpenTelemetryBridge` detects active spans via custom `getSpan(req)`, `req.span` / `req.telemetrySpan`, or global `@opentelemetry/api` `trace.getActiveSpan()`, working with or without `@opentelemetry/api` installed. When given a `tracer`, middleware creates a `limitforge.consume` child span and ends it in `finally`.

On every evaluation, active spans receive both standard `ratelimit.*` attributes (`ratelimit.allowed`, `ratelimit.remaining`, `ratelimit.reset`, `ratelimit.algorithm`, `ratelimit.store`, `ratelimit.degraded`, plus `ratelimit.circuit_state` when reported) and `limitforge.*` attributes (`limitforge.outcome`, `limitforge.algorithm`, `limitforge.route`, `limitforge.store`, `limitforge.remaining`, `limitforge.reset`, `limitforge.degraded`).

- **Blocked requests (`HTTP 429`)**: Adds a `limitforge.rate_limit_exceeded` event with `ratelimit.retry_after`, `limitforge.retry_after`, and `limitforge.route`.
- **Store errors / fallback**: Calls `span.recordException(err)`, sets `ratelimit.store_error: true` and `limitforge.store_error: true`, and records a `limitforge.store_error` event.

## 5. Grafana Dashboard & Alertmanager Assets

- **Grafana Dashboard** (`assets/dashboards/limitforge-grafana-dashboard.json`): Panels for throughput (allowed vs blocked), block-rate gauge, p50/p95/p99 store latency, error breakdown, route breakdown, and circuit breaker state.
- **Alertmanager Rules** (`assets/alerts/prometheus-rules.yml`): Alert rules for high block rate (`>25%`), store outages, open circuit breakers, elevated latency (`p95 > 50ms`), and degraded traffic.

See `examples/observability-stack/` for a runnable Docker Compose environment with Express, Redis, Prometheus, and Grafana.
