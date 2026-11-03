# Security Policy

The LimitForge team and contributors take the security of our distributed rate limiting and resilience middleware seriously. We appreciate your efforts to responsibly disclose vulnerabilities to help us keep our users and applications safe.

---

## Supported Versions

Only the latest major version receives active security updates and patches.

| Version | Supported          |
| ------- | ------------------ |
| 8.x     | :white_check_mark: |
| < 8.0   | :x:                |

We strongly advise all users to stay updated with the latest release on [npm](https://www.npmjs.com/package/limitforge).

---

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you believe you have discovered a security vulnerability in LimitForge (such as a rate-limit bypass, timing attack, denial-of-service vector, memory leak, or cryptographic issue):

1. **GitHub Security Advisory (Preferred):**
   Submit a private report through the [LimitForge Security Advisory Page](https://github.com/Anivesh91/LimitForge/security/advisories/new).

2. **Direct Email:**
   If you prefer email, send a detailed report to:
   - **Anivesh Sikarwar**: [aniveshsikarwar@gmail.com](mailto:aniveshsikarwar@gmail.com)
   - Subject line: `[SECURITY] Potential vulnerability in LimitForge`

### What to Include in Your Report

To help us triage and resolve the issue quickly, please provide:
- A clear description of the vulnerability.
- Steps to reproduce or a minimal Proof of Concept (PoC) script.
- The environment and versions used (Node.js version, LimitForge version, OS, Redis version if applicable).
- Potential impact and threat model (e.g., bypass of rate limits, memory exhaustion under heavy load).
- Any proposed fix or remediation (optional).

---

## Response Process & Timeline

When we receive a vulnerability report:

1. **Initial Acknowledgment:** We will acknowledge receipt of your report within **48 hours**.
2. **Investigation & Triage:** We will confirm the issue, assess severity (CVSS), and determine the affected components within **5 business days**.
3. **Patch Development:** A fix will be developed in a private security branch and validated against our full test suite.
4. **Coordinated Disclosure:** We will coordinate release timing with you. A patched version will be published to npm along with a GitHub Security Advisory crediting your discovery (unless you prefer to remain anonymous).

Thank you for helping keep LimitForge and the open-source ecosystem secure!
