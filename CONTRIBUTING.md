# Contributing to LimitForge

Thank you for your interest in contributing to **LimitForge**! We welcome community contributions, bug reports, documentation improvements, and architectural suggestions.

This document outlines our development workflows, coding standards, and pull request guidelines.

---

## Code of Conduct

By participating in this project, you agree to maintain a respectful, inclusive, and professional environment for everyone. Please treat contributors and users with kindness and constructive feedback.

---

## Development Setup

### Prerequisites
- **Node.js**: `>= 18.0.0` (Node 20+ or 22+ recommended)
- **npm**: `>= 9.0.0`
- **Redis** *(optional for local testing)*: Redis server running on `localhost:6379` (or via Docker) to run distributed and Lua integration tests.

### Getting Started

1. **Fork the repository** on GitHub:
   Navigate to [https://github.com/Anivesh91/LimitForge](https://github.com/Anivesh91/LimitForge) and click **Fork**.

2. **Clone your fork locally**:
   ```bash
   git clone https://github.com/<your-username>/LimitForge.git
   cd LimitForge
   ```

3. **Install dependencies**:
   ```bash
   npm install
   ```

4. **Verify existing tests pass**:
   ```bash
   npm test
   ```
   All tests should pass cleanly (253+ passing tests, 0 failures).

---

## Project Structure

```text
limitforge/
├── src/
│   ├── limiter/         # Express middleware & core rate limiter engine
│   ├── stores/          # MemoryStore, RedisStore, ResilientStore
│   ├── resilience/      # CircuitBreaker, TimeoutGuard, Error types
│   ├── telemetry/       # PrometheusExporter, MetricsCollector, OpenTelemetry
│   ├── scripts/         # Atomic Redis Lua scripts (.lua)
│   ├── utils/           # Route normalizer, key builder
│   └── index.js         # Public package entry point
├── tests/               # Native node:test unit & integration test suites
├── examples/            # Runnable Express demos & Docker observability stack
├── index.d.ts           # Public TypeScript typings
├── README.md            # Main user documentation
├── CHANGELOG.md         # Semantic version changelog
├── SECURITY.md          # Vulnerability reporting policy
└── package.json         # Package manifest & configuration
```

---

## Development Workflow

### 1. Create a Topic Branch
Always branch off the `master` branch:
```bash
git checkout -b feature/my-new-feature
# or
git checkout -b fix/resolve-timeout-bug
```

### 2. Coding Standards
- **ES Modules**: We strictly use native ES Modules (`import`/`export`).
- **Zero Runtime Dependencies**: The core limiter runs with zero external runtime dependencies. Do not add heavy production dependencies to `dependencies` in `package.json`.
- **Performance First**: Rate limiting middleware runs on every HTTP request. Avoid micro-allocations, redundant JSON serializations, unindexed lookups, or unneeded regex calls in hot request loops.
- **TypeScript Definitions**: If you modify any public options, signatures, or store methods, update `index.d.ts` accordingly.
- **Defensive Error Handling**: Telemetry, metrics collection, and store fallbacks must never crash user HTTP request flows.

### 3. Running Tests
We use Node.js's native test runner (`node:test`):

```bash
# Run the entire test suite
npm test

# Run a specific test file
node --test tests/memory-token-bucket.test.js
```

### 4. Running Benchmarks
If you touch the request evaluation pipeline, verify that overhead remains bounded within microseconds:
```bash
npm run benchmark
```

---

## Pull Request Guidelines

Before submitting your PR:
1. Ensure `npm test` passes 100% with zero failures.
2. If adding a new feature or fixing a bug, include corresponding unit/integration tests in `tests/`.
3. If public options changed, update `index.d.ts` and `README.md`.
4. Keep commits clean, atomic, and well-described:
   - `fix: prevent circuit breaker half-open race condition`
   - `docs: update redis store injection examples`
   - `feat: support custom sliding window interval`
5. Open a Pull Request against the `master` branch of `Anivesh91/LimitForge`.
6. Provide a concise description of your changes, motivation, and test coverage in the PR template.

---

## License

By contributing to LimitForge, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
