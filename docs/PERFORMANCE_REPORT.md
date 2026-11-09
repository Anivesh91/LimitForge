# LimitForge — Performance & Overhead Report

> Measured with nanosecond hardware timers (`process.hrtime.bigint()`) on LimitForge v9.0.0. Results vary by runtime version, hardware, store implementation, and traffic shape.

## 1. Summary

- **In-Memory Rate Limiting Overhead**: Fixed-window, sliding-window, and token-bucket `MemoryStore` scenarios added **2.4 µs to 2.5 µs** p50 latency over the baseline no-op middleware (`2.8 µs to 2.9 µs` total scenario p50).
- **Metrics Enabled**: Sliding window with in-memory Prometheus aggregation measured **6.70 µs p50** (+6.30 µs over baseline).
- **Metrics + OpenTelemetry Span Enrichment**: Sliding window with metrics and mock `OpenTelemetryBridge` span extraction measured **7.00 µs p50** (+6.60 µs over baseline).
- **Sequential Throughput**: Standalone `MemoryStore` evaluations sustained **222,000–262,000 ops/sec** in a single Node.js process.

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
| **1. No-op Baseline** *(Direct `next()`)* | 956,261 | 0.45 µs | 0.40 µs | 0.50 µs | 1.10 µs | *baseline* |
| **2. Fixed Window** *(MemoryStore)* | 262,777 | 3.57 µs | 2.80 µs | 5.00 µs | 7.50 µs | **+2.40 µs** |
| **3. Sliding Window** *(MemoryStore)* | 222,715 | 4.13 µs | 2.80 µs | 7.50 µs | 17.40 µs | **+2.40 µs** |
| **4. Token Bucket** *(MemoryStore)* | 250,508 | 3.65 µs | 2.90 µs | 5.60 µs | 16.30 µs | **+2.50 µs** |
| **5. Sliding Window + Metrics** | 108,884 | 8.81 µs | 6.70 µs | 16.30 µs | 26.80 µs | **+6.30 µs** |
| **6. Sliding Window + Metrics + OTel** | 105,791 | 9.21 µs | 7.00 µs | 15.90 µs | 25.30 µs | **+6.60 µs** |

## 4. Latency Breakdown

```text
No-op Baseline:        [ 0.40 µs ]
Fixed Window:          [ 0.40 µs ] + [ 2.40 µs ]
Sliding Window:        [ 0.40 µs ] + [ 2.40 µs ]
Token Bucket:          [ 0.40 µs ] + [ 2.50 µs ]
With Metrics:          [ 0.40 µs ] + [ 6.30 µs ]
With Metrics + OTel:   [ 0.40 µs ] + [ 6.60 µs ]
```

- **Fixed & Sliding Window (`2.80 µs` p50)**: Both sustain minimal per-request overhead; sliding window evicts timestamps older than `now - windowMs` from ordered per-key arrays.
- **Token Bucket (`2.90 µs` p50)**: Uses float arithmetic and timestamps with `O(1)` per-key state.
- **Route Normalization**: Reads Express `req.baseUrl + req.route.path` directly on matched routes without regex scanning.

## 5. In-Process vs Distributed Redis Cost

| Component | Latency | Share of Total |
| :--- | :---: | :---: |
| **LimitForge Middleware** *(measured MemoryStore p50)* | 2.80–2.90 µs | ~0.2–0.7% |
| **Redis Network RTT** *(same-VPC estimate)* | 300–1,000 µs | ~54–91% |
| **Redis Lua Execution** *(engine estimate)* | 100–250 µs | ~9–45% |
| **Estimated Total Distributed Check** | **402.8 µs–1.253 ms** | **100%** |

In distributed Redis setups, network RTT and Redis execution dominate end-to-end overhead; middleware evaluation contributes under 1%.

## 6. Reproducing Locally

```bash
git clone https://github.com/Anivesh91/LimitForge.git
cd LimitForge
npm install
npm run benchmark
```
