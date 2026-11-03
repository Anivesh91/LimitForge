# Contributing to LimitForge

First off, thank you for considering contributing to **LimitForge**! Open source libraries thrive on community collaboration, and whether you are fixing a typo in documentation, reporting a bug, or submitting a new storage engine, your help is welcome.

---

## Code of Conduct

Please help maintain a welcoming, respectful, and inclusive environment. Be constructive, open to feedback, and considerate of fellow contributors.

---

## Getting Started

### Prerequisites

* **Node.js**: `>= 18.0.0` (LimitForge relies on modern Node standard libraries like `node:test`, `node:crypto`, and native ES Modules).
* **Git**: Installed and configured.
* **Docker** (Optional, recommended for Redis tests): To run a local Redis container:
  ```bash
  docker run -d -p 6379:6379 --name redis-limitforge redis:7-alpine
  ```

### Development Setup

1. **Fork the repository** on GitHub:  
   [https://github.com/Anivesh91/LimitForge](https://github.com/Anivesh91/LimitForge)

2. **Clone your fork locally**:
   ```bash
   git clone https://github.com/<your-username>/LimitForge.git
   cd LimitForge
   ```

3. **Install development dependencies**:
   ```bash
   npm install
   ```

---

## Development Scripts

| Command | Purpose |
| :--- | :--- |
| `npm test` | Runs the full test suite (260+ tests using `node:test`) |
| `npm run typecheck` | Compiles TypeScript tests against `index.d.ts` declarations (`tsc --noEmit`) |
| `npm run benchmark` | Measures empirical execution overhead using `process.hrtime.bigint()` |
| `npm run dev` | Boots the Express demo server with file watching |
| `npm run demo:multi` | Runs multi-instance distributed rate limiting verification |
| `npm run demo:stack` | Boots the full Prometheus + Grafana observability stack demo |

---

## Architectural Principles & Rules

When contributing code to LimitForge, please adhere to these core architectural guidelines:

1. **Zero Runtime Dependencies Policy**:  
   LimitForge enforces a strict zero-runtime-dependency rule. We do not accept PRs introducing packages into `"dependencies"`. All core algorithms, metrics serialization, and circuit breakers must be implemented using standard Node.js APIs (`node:crypto`, `node:events`, `node:fs`). Third-party integrations (e.g. `redis`, `express`) are treated strictly as optional `peerDependencies`.

2. **Native ES Modules (ESM)**:  
   The codebase uses modern ES Module syntax (`import` / `export`). Avoid CommonJS `require()` or `module.exports`.

3. **Fail-Safe Error Boundaries**:  
   Rate limiting is middleware. It must **never** crash or unhandle an error that takes down the consumer's host application. Store errors, Redis timeouts, and telemetry failures must be caught cleanly and routed through the configured failure policy.

4. **Atomic Lua Execution**:  
   Any distributed state operation in `RedisStore` that requires reading and writing timestamps or tokens must be implemented as an atomic Lua script to eliminate race conditions under high concurrency.

5. **TypeScript Declarations**:  
   If you add or modify a public configuration option, function, or store method, you **must** update the corresponding declaration in `index.d.ts` and ensure `npm run typecheck` passes with zero errors.

---

## Pull Request Guidelines

1. **Create a Feature Branch**:
   ```bash
   git checkout -b feat/my-awesome-feature
   # or
   git checkout -b fix/issue-description
   ```

2. **Write Unit Tests**:  
   Add test coverage for your changes under the `tests/` directory. Aim for high coverage of edge cases, boundary conditions, and invalid parameter inputs.

3. **Verify Tests & Types**:  
   Before opening your PR, verify that all suites pass cleanly:
   ```bash
   npm test
   npm run typecheck
   ```

4. **Write Clear Commit Messages**:  
   Use descriptive, imperative commit messages (e.g., `add configurable key prefix to RedisStore`, `fix sliding window boundary calculation`).

5. **Submit the Pull Request**:  
   Open your PR against the `master` branch of `Anivesh91/LimitForge`. Include a clear description of what changed, why it was needed, and any related issue numbers.

---

## License

By contributing to LimitForge, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
