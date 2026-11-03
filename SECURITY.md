# Security Policy

The **LimitForge** team takes security and resilience vulnerabilities seriously. We appreciate the responsible disclosure of security issues by the developer and security research community.

---

## Supported Versions

Only the latest major release receive active security updates and patches.

| Version | Supported          | Security Status         |
| :------ | :----------------- | :---------------------- |
| 8.x     | :white_check_mark: | Currently Supported     |
| < 8.0   | :x:                | End of Life (Upgrade)   |

---

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities through public GitHub issues, discussions, or social media.**

If you believe you have discovered a vulnerability in LimitForge:

1. **Email us privately** at:  
   **[aniveshsikarwar@gmail.com](mailto:aniveshsikarwar@gmail.com)**

2. **Use the subject line**:  
   `[SECURITY] Vulnerability Report: LimitForge`

3. **Include the following information**:
   - Description of the vulnerability and its potential impact.
   - Affected version(s) of LimitForge.
   - Minimal reproduction code or Proof of Concept (PoC) demonstrating the behavior.
   - Any proposed remediation, patch, or mitigation steps (if available).

---

## Response & Disclosure Process

1. **Acknowledgment**: You will receive an acknowledgment of your report within **48 hours**.
2. **Investigation & Triage**: Our team will verify and investigate the reported issue within **3 to 5 business days**.
3. **Patch Development**: If verified, a patch will be developed, tested, and published to the NPM registry as a new patch or minor release.
4. **Coordinated Disclosure**: Once the fix is released, we will coordinate public disclosure through GitHub Security Advisories, crediting the reporter (unless anonymity is requested).

---

## Security Best Practices for Users

When running LimitForge in production, consider the following best practices:

* **Hash Sensitive Client Identifiers**: If your `keyGenerator` consumes raw API keys, bearer tokens, or user secrets, enable `hashClientIdentifier: true` to prevent raw credentials from appearing in Redis storage keys.
* **Configure Express `trust proxy` Correctly**: If your application is hosted behind reverse proxies or load balancers (e.g. Cloudflare, AWS ALB, Nginx), configure `app.set('trust proxy', ...)` strictly with your upstream proxy CIDR blocks to prevent spoofed `X-Forwarded-For` headers.
* **Use ResilientStore with Timeouts**: Protect your production services against Redis network latency spikes or outages by wrapping your store with `ResilientStore` and setting an explicit `timeoutMs` (e.g. 150–250ms).
* **Bound Route Cardinality**: When using Prometheus metrics, use `normalizeRoute` to avoid dynamic ID segments in metric labels that could lead to TSDB memory exhaustion.
