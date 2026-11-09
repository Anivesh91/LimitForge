# LimitForge — Performance & Overhead Report

> Measured with nanosecond hardware timers (`process.hrtime.bigint()`). Results vary by runtime version, hardware, store implementation, and traffic shape.

## 1. Summary

- **In-Memory Rate Limiting Overhead**: Fixed-window, sliding-window, and token-bucket `MemoryStore` scenarios added **2.3 µs to 3.4 µs** p50 latency over the baseline no-op middleware (`2.6 µs to 3.7 µs` total scenario p50).
- **Metrics Enabled**: Sliding window with in-memory Prometheus aggregation measured **15.90 µs p50** (+15.60 µs over baseline).
- **Metrics + OpenTelemetry Span Enrichment**: Sliding window with metrics and mock `OpenTelemetryBridge` span extraction measured **11.70 µs p50**.
- **Sequential Throughput**: Standalone `MemoryStore` evaluations sustained over **226,000–232,000 ops/sec** in a single Node.js process.

## 2. Test Environment & Methodology

- **Runtime**: Node.js v24.11.0 (V8)
- **OS / CPU**: Windows 11 (win32 x64), 8 logical cores
- **Clock**: `process.hrtime.bigint()`
- **Warmup**: 1,000 unmeasured requests per scenario so V8 JIT settles before measurement
- **Sample Size**: 10,000 measured requests per scenario
- **Route Normalization**: Active (dynamic segments collapsed to `:id`)

## 3. Benchmark Results

| Scenario | Throughput (ops/s) | Mean | p50 | p95 | p99 | Added p50 vs No-op |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **1. No-op Baseline** *(Direct `next()`)* | 1,073,514 | 0.42 µs | 0.30 µs | 0.70 µs | 1.00 µs | *baseline* |
| **2. Fixed Window** *(MemoryStore)* | 232,634 | 3.95 µs | 3.20 µs | 4.90 µs | 10.20 µs | **+2.90 µs** |
| **3. Sliding Window** *(MemoryStore)* | 230,136 | 3.85 µs | 3.70 µs | 5.00 µs | 13.10 µs | **+3.40 µs** |
| **4. Token Bucket** *(MemoryStore)* | 226,453 | 4.09 µs | 2.60 µs | 7.30 µs | 12.90 µs | **+2.30 µs** |
| **5. Sliding Window + Metrics** | 45,404 | 21.14 µs | 15.90 µs | 30.10 µs | 87.10 µs | **+15.60 µs** |
| **6. Sliding Window + Metrics + OTel** | 61,027 | 15.92 µs | 11.70 µs | 25.60 µs | 56.50 µs | **+11.40 µs** |

## 4. Latency Breakdown

```text
No-op Baseline:        [ 0.30 µs ]
Fixed Window:          [ 0.30 µs ] + [ 2.90 µs ]
Sliding Window:        [ 0.30 µs ] + [ 3.40 µs ]
Token Bucket:          [ 0.30 µs ] + [ 2.30 µs ]
With Metrics:          [ 0.30 µs ] + [ 15.60 µs ]
With Metrics + OTel:   [ 0.30 µs ] + [ 11.40 µs ]
```

- **Token Bucket (`2.60 µs` p50)**: Uses float arithmetic and timestamps with `O(1)` per-key state.
- **Sliding Window (`3.70 µs` p50)**: Evicts timestamps older than `now - windowMs` from ordered per-key arrays.
- **Route Normalization**: Reads Express `req.baseUrl + req.route.path` directly on matched routes without regex scanning.

## 5. In-Process vs Distributed Redis Cost

| Component | Latency | Share of Total |
| :--- | :---: | :---: |
| **LimitForge Middleware** *(measured MemoryStore p50)* | 2.60–3.70 µs | ~0.2–0.9% |
| **Redis Network RTT** *(same-VPC estimate)* | 300–1,000 µs | ~54–91% |
| **Redis Lua Execution** *(engine estimate)* | 100–250 µs | ~9–45% |
| **Estimated Total Distributed Check** | **402.6 µs–1.254 ms** | **100%** |

In distributed Redis setups, network RTT and Redis execution dominate end-to-end overhead; middleware evaluation contributes under 1%.

## 6. Reproducing Locally

```bash
git clone https://github.com/Anivesh91/LimitForge.git
cd LimitForge
npm install
npm run benchmark
```
