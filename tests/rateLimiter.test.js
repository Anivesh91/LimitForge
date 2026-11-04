import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import request from 'supertest';
import express from 'express';
import { rateLimiter } from '../src/index.js';
import demoRoutes, { closeRedisClient } from '../examples/express-demo/routes.js';
import { cleanupExpiredRecords } from '../src/limiter/rateLimiter.js';

function createTestApp() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  return app;
}

describe('SmartRate v1 — Test Suite', () => {

  it('starts both Redis-backed examples when Redis is unavailable', async () => {
    const reservation = net.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const run = promisify(execFile);
    const redisUrl = `redis://127.0.0.1:${port}`;
    const demo = `
      import assert from 'node:assert/strict';
      const { default: server } = await import('./examples/express-demo/server.js');
      const { closeRedisClient } = await import('./examples/express-demo/routes.js');
      if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/status');
      assert.equal(response.status, 200);
      assert.equal((await response.json()).store, 'memory');
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
      await closeRedisClient();
    `;
    await run(process.execPath, ['--input-type=module', '-e', demo], {
      cwd: new URL('..', import.meta.url), timeout: 5000, env: { ...process.env, NODE_ENV: 'development', REDIS_URL: redisUrl, PORT: '0' }
    });

    const stack = `
      import assert from 'node:assert/strict';
      import request from 'supertest';
      const { default: app } = await import('./examples/observability-stack/server.js');
      const response = await request(app).get('/api/public');
      assert.equal(response.status, 200);
      assert.equal(response.headers['ratelimit-degraded'], 'true');
      process.exit(0);
    `;
    await run(process.execPath, ['--input-type=module', '-e', stack], {
      cwd: new URL('..', import.meta.url), timeout: 5000, env: { ...process.env, NODE_ENV: 'test', REDIS_URL: redisUrl }
    });
  });

  describe('Option Validation (Fail-Fast)', () => {
    it('uses the documented defaults and preserves explicitly supplied options', async () => {
      for (const [options, expectedLimit, expectedWindow] of [
        [{}, 60, 60000],
        [{ limit: 3 }, 3, 60000],
        [{ windowMs: 5000 }, 60, 5000],
        [{ algorithm: 'sliding-window' }, 60, 60000]
      ]) {
        let received;
        const store = { consume: async params => {
          received = params;
          return { allowed: true, remaining: expectedLimit - 1, reset: 1 };
        } };
        const app = createTestApp();
        app.get('/', rateLimiter({ ...options, store }), (req, res) => res.sendStatus(200));
        assert.equal((await request(app).get('/')).status, 200);
        assert.equal(received.limit, expectedLimit);
        assert.equal(received.windowMs, expectedWindow);
      }
      assert.doesNotThrow(() => rateLimiter());
      assert.throws(() => rateLimiter({ limit: null }), /limit/);
      assert.throws(() => rateLimiter({ windowMs: null }), /windowMs/);
      assert.throws(() => rateLimiter({ algorithm: 'token-bucket' }), /capacity/);
    });

    it('respects standardHeaders while retaining Retry-After and degraded signals', async () => {
      assert.throws(() => rateLimiter({ standardHeaders: 'false' }), /standardHeaders/);
      const app = createTestApp();
      app.get('/quota', rateLimiter({ limit: 1, standardHeaders: false }), (req, res) => res.sendStatus(200));
      app.get('/failed', rateLimiter({ standardHeaders: false, store: { consume() { throw new Error('down'); } }, onStoreError: 'fail-closed' }), (req, res) => res.sendStatus(200));
      app.get('/fallback', rateLimiter({ limit: 1, standardHeaders: false, store: { consume() { throw new Error('down'); } }, fallbackStore: true }), (req, res) => res.sendStatus(200));
      const allowed = await request(app).get('/quota');
      const blocked = await request(app).get('/quota');
      const failed = await request(app).get('/failed');
      const degraded = await request(app).get('/fallback');
      const degradedBlocked = await request(app).get('/fallback');
      assert.equal(allowed.status, 200);
      assert.equal(blocked.status, 429);
      assert.equal(failed.status, 503);
      assert.equal(degraded.status, 200);
      assert.equal(degradedBlocked.status, 429);
      for (const res of [allowed, blocked, failed, degraded, degradedBlocked]) {
        assert.equal(res.headers['ratelimit-limit'], undefined);
        assert.equal(res.headers['ratelimit-remaining'], undefined);
        assert.equal(res.headers['ratelimit-reset'], undefined);
      }
      assert.ok(Number(blocked.headers['retry-after']) > 0);
      assert.equal(failed.headers['ratelimit-degraded'], 'true');
      assert.ok(Number(failed.headers['retry-after']) > 0);
      assert.equal(degraded.headers['ratelimit-degraded'], 'true');
      assert.equal(degradedBlocked.headers['ratelimit-degraded'], 'true');
      assert.ok(Number(degradedBlocked.headers['retry-after']) > 0);
    });

    it('enforces the default limit after sixty requests', async () => {
      const app = createTestApp();
      app.get('/', rateLimiter(), (req, res) => res.sendStatus(200));
      for (let i = 0; i < 60; i++) {
        const res = await request(app).get('/');
        assert.equal(res.status, 200);
        assert.equal(res.headers['ratelimit-limit'], '60');
      }
      assert.equal((await request(app).get('/')).status, 429);
    });
    it('throws RangeError when limit is 0, negative, or not an integer', () => {
      assert.throws(() => rateLimiter({ limit: 0, windowMs: 60000 }), { name: 'RangeError' });
      assert.throws(() => rateLimiter({ limit: -5, windowMs: 60000 }), { name: 'RangeError' });
      assert.throws(() => rateLimiter({ limit: '5', windowMs: 60000 }), { name: 'RangeError' });
      assert.throws(() => rateLimiter({ limit: 5.5, windowMs: 60000 }), { name: 'RangeError' });
    });

    it('throws RangeError when windowMs is 0, negative, or non-finite', () => {
      assert.throws(() => rateLimiter({ limit: 5, windowMs: 0 }), { name: 'RangeError' });
      assert.throws(() => rateLimiter({ limit: 5, windowMs: -100 }), { name: 'RangeError' });
      assert.throws(() => rateLimiter({ limit: 5, windowMs: Infinity }), { name: 'RangeError' });
      assert.throws(() => rateLimiter({ limit: 5, windowMs: '60000' }), { name: 'RangeError' });
    });

    it('throws TypeError when options is not an object', () => {
      assert.throws(() => rateLimiter(null), { name: 'TypeError' });
    });

    it('throws TypeError when prefix is provided but not a non-empty string', () => {
      assert.throws(() => rateLimiter({ limit: 5, windowMs: 60000, prefix: '' }), { name: 'TypeError' });
      assert.throws(() => rateLimiter({ limit: 5, windowMs: 60000, prefix: '   ' }), { name: 'TypeError' });
      assert.throws(() => rateLimiter({ limit: 5, windowMs: 60000, prefix: 123 }), { name: 'TypeError' });
    });
  });

  describe('Fixed Window Enforcement & Boundary Handling', () => {
    it('allows requests 1 through N (first allowed, exactly N allowed) and blocks N+1 with 429', async () => {
      const app = createTestApp();
      app.get(
        '/test-boundary',
        rateLimiter({ limit: 5, windowMs: 60_000 }),
        (req, res) => res.status(200).json({ success: true })
      );

      const testIp = '192.168.1.50';

      for (let i = 1; i <= 5; i++) {
        const response = await request(app)
          .get('/test-boundary')
          .set('X-Forwarded-For', testIp);

        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.equal(response.headers['ratelimit-limit'], '5');
        assert.equal(response.headers['ratelimit-remaining'], String(5 - i));
        assert.ok(Number(response.headers['ratelimit-reset']) > 0);
      }

      const blockedResponse = await request(app)
        .get('/test-boundary')
        .set('X-Forwarded-For', testIp);

      assert.equal(blockedResponse.status, 429);
      assert.equal(blockedResponse.body.success, false);
      assert.equal(blockedResponse.body.message, 'Too many requests');
      assert.ok(Number(blockedResponse.body.retryAfter) > 0);

      assert.equal(blockedResponse.headers['ratelimit-limit'], '5');
      assert.equal(blockedResponse.headers['ratelimit-remaining'], '0');
      assert.ok(Number(blockedResponse.headers['retry-after']) > 0);
    });

    it('ensures remaining header never drops below 0 across multiple blocked requests', async () => {
      const app = createTestApp();
      app.get(
        '/test-negative-guard',
        rateLimiter({ limit: 1, windowMs: 60_000 }),
        (req, res) => res.status(200).json({ success: true })
      );

      const testIp = '192.168.1.51';

      const res1 = await request(app).get('/test-negative-guard').set('X-Forwarded-For', testIp);
      assert.equal(res1.status, 200);
      assert.equal(res1.headers['ratelimit-remaining'], '0');

      const res2 = await request(app).get('/test-negative-guard').set('X-Forwarded-For', testIp);
      assert.equal(res2.status, 429);
      assert.equal(res2.headers['ratelimit-remaining'], '0');

      const res3 = await request(app).get('/test-negative-guard').set('X-Forwarded-For', testIp);
      assert.equal(res3.status, 429);
      assert.equal(res3.headers['ratelimit-remaining'], '0');
    });
  });

  describe('Isolation: IP, Route & HTTP Method', () => {
    it('isolates rate-limit buckets between different client IPs on the same route', async () => {
      const app = createTestApp();
      app.get(
        '/api/shared-endpoint',
        rateLimiter({ limit: 2, windowMs: 60_000 }),
        (req, res) => res.status(200).json({ success: true })
      );

      const ipA = '172.16.10.1';
      const ipB = '172.16.10.2';

      await request(app).get('/api/shared-endpoint').set('X-Forwarded-For', ipA);
      await request(app).get('/api/shared-endpoint').set('X-Forwarded-For', ipA);
      const ipABlocked = await request(app).get('/api/shared-endpoint').set('X-Forwarded-For', ipA);
      assert.equal(ipABlocked.status, 429);

      const ipBResponse = await request(app).get('/api/shared-endpoint').set('X-Forwarded-For', ipB);
      assert.equal(ipBResponse.status, 200);
      assert.equal(ipBResponse.headers['ratelimit-remaining'], '1');
    });

    it('isolates counters between different HTTP methods on the exact same route path', async () => {
      const app = createTestApp();
      const limiter = rateLimiter({ limit: 2, windowMs: 60_000 });

      app.get('/api/users', limiter, (req, res) => res.json({ method: 'GET' }));
      app.post('/api/users', limiter, (req, res) => res.json({ method: 'POST' }));

      const clientIp = '10.99.0.1';

      await request(app).get('/api/users').set('X-Forwarded-For', clientIp);
      await request(app).get('/api/users').set('X-Forwarded-For', clientIp);
      const getBlocked = await request(app).get('/api/users').set('X-Forwarded-For', clientIp);
      assert.equal(getBlocked.status, 429);

      const postResponse = await request(app).post('/api/users').set('X-Forwarded-For', clientIp);
      assert.equal(postResponse.status, 200);
      assert.equal(postResponse.headers['ratelimit-remaining'], '1');
    });

    it('isolates counters between different route paths for the same client IP', async () => {
      const app = createTestApp();
      app.use('/api', demoRoutes);

      const testIp = '10.99.0.2';

      for (let i = 0; i < 3; i++) {
        const res = await request(app).post('/api/login').set('X-Forwarded-For', testIp);
        assert.equal(res.status, 200);
      }
      const loginBlocked = await request(app).post('/api/login').set('X-Forwarded-For', testIp);
      assert.equal(loginBlocked.status, 429);

      const testRes = await request(app).get('/api/test').set('X-Forwarded-For', testIp);
      assert.equal(testRes.status, 200);
      assert.equal(testRes.headers['ratelimit-remaining'], '4');
    });

    it('strips query parameters so requests map to the same route counter', async () => {
      const app = createTestApp();
      app.get(
        '/api/products',
        rateLimiter({ limit: 2, windowMs: 60_000 }),
        (req, res) => res.status(200).json({ success: true })
      );

      const testIp = '10.99.0.3';

      await request(app).get('/api/products?page=1').set('X-Forwarded-For', testIp);
      await request(app).get('/api/products?page=2').set('X-Forwarded-For', testIp);

      const res3 = await request(app).get('/api/products?page=3').set('X-Forwarded-For', testIp);
      assert.equal(res3.status, 429);
    });

    it('allows configuring custom key prefix and passes it to the store', async () => {
      const app = createTestApp();
      let consumedKey = null;
      const customStore = {
        consume: async ({ key }) => {
          consumedKey = key;
          return { allowed: true, count: 1, remaining: 4, reset: 60 };
        }
      };

      app.get(
        '/api/prefixed',
        rateLimiter({ limit: 5, windowMs: 60_000, prefix: 'tenant-omega', store: customStore }),
        (req, res) => res.json({ success: true })
      );

      await request(app).get('/api/prefixed').set('X-Forwarded-For', '10.0.0.1');
      assert.ok(consumedKey.startsWith('tenant-omega:'), 'Key must start with custom prefix');
    });

    it('inherits prefix from custom store if not explicitly provided', async () => {
      const app = createTestApp();
      let consumedKey = null;
      const customStore = {
        prefix: 'inherited-store-prefix',
        consume: async ({ key }) => {
          consumedKey = key;
          return { allowed: true, count: 1, remaining: 4, reset: 60 };
        }
      };

      app.get(
        '/api/inherited-prefix',
        rateLimiter({ limit: 5, windowMs: 60_000, store: customStore }),
        (req, res) => res.json({ success: true })
      );

      await request(app).get('/api/inherited-prefix').set('X-Forwarded-For', '10.0.0.2');
      assert.ok(consumedKey.startsWith('inherited-store-prefix:'), 'Key must start with store prefix');
    });

    it('bypasses rate limiting when skip function returns true', async () => {
      const app = createTestApp();
      app.get(
        '/api/skippable',
        rateLimiter({
          limit: 1,
          windowMs: 60_000,
          skip: (req) => req.headers['x-internal-admin'] === 'secret'
        }),
        (req, res) => res.json({ success: true })
      );

      const testIp = '10.99.0.55';

      // 1st request with admin header -> skipped
      const res1 = await request(app).get('/api/skippable').set('X-Forwarded-For', testIp).set('x-internal-admin', 'secret');
      assert.equal(res1.status, 200);

      // 2nd request with admin header -> still skipped (not consuming quota)
      const res2 = await request(app).get('/api/skippable').set('X-Forwarded-For', testIp).set('x-internal-admin', 'secret');
      assert.equal(res2.status, 200);

      // 3rd request without admin header -> consumes quota (allowed)
      const res3 = await request(app).get('/api/skippable').set('X-Forwarded-For', testIp);
      assert.equal(res3.status, 200);

      // 4th request without admin header -> blocked
      const res4 = await request(app).get('/api/skippable').set('X-Forwarded-For', testIp);
      assert.equal(res4.status, 429);
    });

    it('supports custom statusCode and custom message when blocked', async () => {
      const app = createTestApp();
      app.get(
        '/api/custom-response',
        rateLimiter({
          limit: 1,
          windowMs: 60_000,
          statusCode: 403,
          message: { error: 'Rate limit reached, please upgrade plan', code: 'RATE_LIMIT_EXCEEDED' }
        }),
        (req, res) => res.json({ success: true })
      );

      const testIp = '10.99.0.66';

      const res1 = await request(app).get('/api/custom-response').set('X-Forwarded-For', testIp);
      assert.equal(res1.status, 200);

      const res2 = await request(app).get('/api/custom-response').set('X-Forwarded-For', testIp);
      assert.equal(res2.status, 403);
      assert.equal(res2.body.code, 'RATE_LIMIT_EXCEEDED');
      assert.equal(res2.body.error, 'Rate limit reached, please upgrade plan');
    });

    it('prevents rate limit bypass via parameterized route paths (e.g. /api/users/:id)', async () => {
      const app = createTestApp();
      app.get(
        '/api/users/:id',
        rateLimiter({ limit: 2, windowMs: 60_000 }),
        (req, res) => res.status(200).json({ success: true, id: req.params.id })
      );

      const testIp = '10.99.0.77';

      const res1 = await request(app).get('/api/users/101').set('X-Forwarded-For', testIp);
      assert.equal(res1.status, 200);
      assert.equal(res1.headers['ratelimit-remaining'], '1');

      const res2 = await request(app).get('/api/users/102').set('X-Forwarded-For', testIp);
      assert.equal(res2.status, 200);
      assert.equal(res2.headers['ratelimit-remaining'], '0');

      const res3 = await request(app).get('/api/users/103').set('X-Forwarded-For', testIp);
      assert.equal(res3.status, 429);
      assert.equal(res3.body.message, 'Too many requests');
    });

    it('prevents dynamic URL bypass in global middleware via sanitized fallback paths', async () => {
      const app = createTestApp();
      app.use(rateLimiter({ limit: 2, windowMs: 60_000 }));
      app.get('/items/:uuid', (req, res) => res.json({ success: true }));

      const testIp = '10.99.0.88';

      const res1 = await request(app).get('/items/a1b2c3d4-e5f6-7890-abcd-ef1234567890').set('X-Forwarded-For', testIp);
      assert.equal(res1.status, 200);

      const res2 = await request(app).get('/items/b2c3d4e5-f6a7-8901-bcde-fa2345678901').set('X-Forwarded-For', testIp);
      assert.equal(res2.status, 200);

      const res3 = await request(app).get('/items/c3d4e5f6-a7b8-9012-cdef-ab3456789012').set('X-Forwarded-For', testIp);
      assert.equal(res3.status, 429);
    });

    it('supports custom routeNormalizer for bespoke routing schemes', async () => {
      const app = createTestApp();
      app.get(
        '/tenant/:tenantId/orders/:orderId',
        rateLimiter({
          limit: 2,
          windowMs: 60_000,
          routeNormalizer: (req) => '/orders'
        }),
        (req, res) => res.json({ success: true })
      );

      const testIp = '10.99.0.99';

      await request(app).get('/tenant/t1/orders/o1').set('X-Forwarded-For', testIp);
      await request(app).get('/tenant/t2/orders/o2').set('X-Forwarded-For', testIp);

      const blocked = await request(app).get('/tenant/t3/orders/o3').set('X-Forwarded-For', testIp);
      assert.equal(blocked.status, 429);
    });
  });

  describe('Window Expiration, Reset & Stale Entry Cleanup', () => {
    it('resets request counter and allows requests again once the window duration elapses', async () => {
      const app = createTestApp();
      app.get(
        '/test-expiry',
        rateLimiter({ limit: 1, windowMs: 100 }),
        (req, res) => res.status(200).json({ success: true })
      );

      const testIp = '10.99.0.4';

      const res1 = await request(app).get('/test-expiry').set('X-Forwarded-For', testIp);
      assert.equal(res1.status, 200);

      const res2 = await request(app).get('/test-expiry').set('X-Forwarded-For', testIp);
      assert.equal(res2.status, 429);

      await new Promise((resolve) => setTimeout(resolve, 120));

      const res3 = await request(app).get('/test-expiry').set('X-Forwarded-For', testIp);
      assert.equal(res3.status, 200);
      assert.equal(res3.headers['ratelimit-remaining'], '0');
    });

    it('actually evicts expired records from the in-memory Map', async () => {
      const app = createTestApp();
      app.get(
        '/test-cleanup',
        rateLimiter({ limit: 2, windowMs: 50 }),
        (req, res) => res.status(200).json({ success: true })
      );

      const testIp = '10.99.0.5';

      await request(app).get('/test-cleanup').set('X-Forwarded-For', testIp);
      await new Promise((resolve) => setTimeout(resolve, 60));

      const removedCount = cleanupExpiredRecords();
      assert.ok(removedCount >= 1, `Expected at least 1 record removed, got: ${removedCount}`);
    });
  });

  describe('Demo Endpoints Verification', () => {
    it('enforces route-specific policy of 10 requests on /api/public', async () => {
      const app = createTestApp();
      app.use('/api', demoRoutes);

      const testIp = '10.99.0.6';

      for (let i = 1; i <= 10; i++) {
        const res = await request(app).get('/api/public').set('X-Forwarded-For', testIp);
        assert.equal(res.status, 200);
        assert.equal(res.headers['ratelimit-remaining'], String(10 - i));
      }

      const blocked = await request(app).get('/api/public').set('X-Forwarded-For', testIp);
      assert.equal(blocked.status, 429);
      assert.equal(blocked.headers['ratelimit-remaining'], '0');
      assert.ok(Number(blocked.headers['retry-after']) > 0);
    });
  });

  describe('Asynchronous Store Support & Error Handling', () => {
    it('supports custom asynchronous stores returning promises', async () => {
      const app = createTestApp();
      const mockAsyncStore = {
        async consume({ limit }) {
          return { allowed: true, count: 1, remaining: limit - 1, reset: 60 };
        }
      };

      app.get(
        '/test-async-store',
        rateLimiter({ limit: 5, windowMs: 60_000, store: mockAsyncStore }),
        (req, res) => res.json({ success: true })
      );

      const res = await request(app).get('/test-async-store');
      assert.equal(res.status, 200);
      assert.equal(res.headers['ratelimit-remaining'], '4');
    });

    it('forwards store errors to Express next(err) without unhandled promise rejections', async () => {
      const app = createTestApp();
      const failingStore = {
        async consume() {
          throw new Error('Redis connection lost');
        }
      };

      app.get(
        '/test-async-error',
        rateLimiter({ limit: 5, windowMs: 60_000, store: failingStore }),
        (req, res) => res.json({ success: true })
      );

      app.use((err, req, res, next) => {
        res.status(500).json({ error: err.message });
      });

      const res = await request(app).get('/test-async-error');
      assert.equal(res.status, 500);
      assert.equal(res.body.error, 'Redis connection lost');
    });
  });

  after(async () => {
    if (typeof closeRedisClient === 'function') {
      await closeRedisClient();
    }
  });
});
