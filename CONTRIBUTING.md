# Contributing to LimitForge

Contributions, bug fixes, and documentation improvements are welcome. This guide covers local setup, coding conventions, and PR checks.

## Code of Conduct

Keep discussions constructive and respectful in issues, pull requests, and reviews.

## Development Setup

### Prerequisites
- **Node.js**: `>= 18.0.0`
- **npm**: `>= 9.0.0`
- **Redis** *(optional)*: Running locally on `localhost:6379` (via Docker or native install) to execute live Redis Lua integration tests.

### Getting Started

1. Fork [https://github.com/Anivesh91/LimitForge](https://github.com/Anivesh91/LimitForge) and clone locally:
   ```bash
   git clone https://github.com/<your-username>/LimitForge.git
   cd LimitForge
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the test suite and type check:
   ```bash
   npm test
   npm run typecheck
   ```
   When `REDIS_URL` is unset, live Redis integration tests are skipped automatically.

## Project Structure

```text
LimitForge/
├── src/
│   ├── limiter/         # Express middleware engine
│   ├── stores/          # MemoryStore, RedisStore, ResilientStore
│   ├── resilience/      # CircuitBreaker, timeout guard, error classes
│   ├── telemetry/       # Prometheus exporter, MetricsCollector, OpenTelemetry bridge
│   ├── scripts/         # Atomic Redis Lua scripts (.lua)
│   ├── utils/           # Route normalizer & key encoding helpers
│   ├── benchmark/       # Benchmark runner & percentile helpers
│   └── index.js         # Package entry point
├── assets/              # Sample Grafana dashboard & Prometheus alerting rules
├── docs/                # Architecture, resilience, observability & performance docs
├── examples/            # Express demos & Docker observability stack
├── scripts/             # Benchmark CLI entrypoint
├── tests/               # node:test unit & integration suites
├── index.d.ts           # Ambient TypeScript declarations
├── package.json
└── README.md
```

## Development Workflow

### 1. Branch Off `master`
```bash
git checkout -b feature/my-change
# or
git checkout -b fix/timeout-edge-case
```

### 2. Coding Conventions
- **ES Modules only**: Use standard `import` / `export` syntax (`"type": "module"`).
- **Zero runtime dependencies**: Do not add runtime packages to `dependencies` in `package.json`.
- **Low hot-path allocation**: Middleware runs on every request; avoid unnecessary allocations, heavy regexes, or blocking synchronous work in the request path.
- **Type definitions**: Keep `index.d.ts` aligned whenever public options, exports, or method signatures change.
- **Fault-isolated telemetry**: Metrics and tracing helpers must never throw into request handling.

### 3. Tests & Benchmarks
```bash
# Run full suite
npm test

# Run with live Redis
REDIS_URL=redis://localhost:6379 npm test

# Run a single test file
node --test tests/tokenBucket.memory.test.js

# Verify TypeScript declarations
npm run typecheck

# Measure middleware latency overhead
npm run benchmark
```

## Pull Request Checklist

1. `npm test` passes with zero failures (include new tests for features or bug fixes).
2. `npm run typecheck` passes cleanly (`index.d.ts` updated if public API changed).
3. Documentation in `README.md` / `docs/` reflects any behavior or option changes.
4. Commits are concise and focused (e.g., `fix: prevent circuit breaker half-open race condition`).
5. Target the `master` branch with a brief summary of motivation, changes, and verification.

## License

By contributing, you agree your contributions are licensed under the project's [MIT License](LICENSE).
