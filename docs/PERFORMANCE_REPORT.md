# LimitForge — Performance & Overhead Report

> Benchmark results are based on empirical execution time measured with high-precision nanosecond hardware timers (`process.hrtime.bigint()`). LimitForge introduces measurable overhead, which varies by runtime environment, store selection, and traffic profile.

---

## 1. Executive Summary

- **In-Memory Rate Limiting Overhead:**  
  Fixed-window, sliding-window, and token-bucket `MemoryStore` scenarios measured **2.3 µs to 3.4 µs** added p50 latency over the baseline no-op middleware.
- **Metrics-Enabled Scenario:**  
  Sliding window with active in-memory Prometheus metrics aggregation measured **15.90 µs p50** (15.60 µs above baseline).
- **OpenTelemetry Span Enrichment:**  
  Sliding window with metrics and `OpenTelemetryBridge` mock span attribute extraction measured **11.70 µs p50** total scenario latency.
- **Peak Sequential Throughput:**  
  Rate-limited `MemoryStore` scenarios sustained over **230,000 sequential evaluations/second** per single Node.js process.

---

## 2. Test Environment & Methodology

- **Runtime:** Node.js v24.11.0 (V8 engine)
- **Operating System:** Windows 11 (win32 x64)
- **CPUs:** 8 Logical Cores
- **Timing Mechanism:** `process.hrtime.bigint()` (monotonic hardware clock, nanosecond precision)
- **Sample Size:** 10,000 measured requests per scenario
- **Warmup:** 1,000 unmeasured requests per scenario allowing V8 JIT optimization to reach steady-state machine code
- **Cardinality Mode:** Route normalization active (dynamic URL parameters collapsed to `:id`)

---

## 3. Benchmark Results

| Scenario | Throughput (ops/s) | Mean Latency | Median (p50) | 95th %ile (p95) | 99th %ile (p99) | Added p50 vs No-op |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **1. No-op Baseline** *(Direct `next()` invocation)* | 1,073,514 | 0.42 µs | 0.30 µs | 0.70 µs | 1.00 µs | *baseline* |
| **2. Fixed Window** *(MemoryStore)* | 232,634 | 3.95 µs | 3.20 µs | 4.90 µs | 10.20 µs | **+2.90 µs** |
| **3. Sliding Window** *(MemoryStore)* | 230,136 | 3.85 µs | 3.70 µs | 5.00 µs | 13.10 µs | **+3.40 µs** |
| **4. Token Bucket** *(MemoryStore)* | 226,453 | 4.09 µs | 2.60 µs | 7.30 µs | 12.90 µs | **+2.30 µs** |
| **5. Sliding Window + Metrics** | 45,404 | 21.14 µs | 15.90 µs | 30.10 µs | 87.10 µs | **+15.60 µs** |
| **6. Sliding Window + Metrics + OTel** | 61,027 | 15.92 µs | 11.70 µs | 25.60 µs | 56.50 µs | **+11.40 µs** |

*Note: 1 microsecond (µs) = 0.001 millisecond (ms) = 0.000001 second.*

---

## 4. Overhead Breakdown & Analysis

```text
No-op Baseline:        [ 0.30 µs ]
Fixed Window:          [ 0.30 µs ] + [ 2.90 µs ]
Sliding Window:        [ 0.30 µs ] + [ 3.40 µs ]
Token Bucket:          [ 0.30 µs ] + [ 2.30 µs ]
With Metrics:          [ 0.30 µs ] + [ 15.60 µs ]
With Metrics + OTel:   [ 0.30 µs ] + [ 11.40 µs ]
```

### Why Token Bucket & Sliding Window Are Fast
- **Token Bucket (`2.60 µs` p50):**  
  Calculates continuous replenishment using float arithmetic and timestamps without allocating dynamic structures or iterating over arrays.
- **Sliding Window (`3.70 µs` p50):**  
  Maintains chronological timestamp arrays with efficient shift eviction of timestamps older than `now - windowMs`.
- **Route Normalization:**  
  Uses Express internal route tables (`req.baseUrl + req.route.path`), bypassing regex evaluation for standard matched routes.

---

## 5. In-Memory vs Distributed Redis Latency

| Component | Measured / Estimated Latency | Fraction of Total |
| :--- | :---: | :---: |
| **LimitForge In-Process Middleware** *(measured MemoryStore p50)* | 2.60–3.70 µs | ~0.2–0.9% |
| **Redis Network Round-Trip Time** *(same-VPC estimate)* | 300–1,000 µs | ~54–91% |
| **Redis Lua Script Execution** *(Redis engine estimate)* | 100–250 µs | ~9–45% |
| **Estimated Total Distributed Rate Limit Check** | **402.6 µs–1.254 ms** | **100%** |

In distributed deployments, network round-trip time and Redis execution dominate total latency. In-process middleware evaluation contributes less than 1% of the overall request overhead.

---

## 6. How to Reproduce

You can reproduce this benchmark on your own machine:

```bash
git clone https://github.com/Anivesh91/LimitForge.git
cd LimitForge
npm install
npm run benchmark
```
