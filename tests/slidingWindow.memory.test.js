import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { rateLimiter, MemoryStore } from '../src/index.js';

function createTestApp() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  return app;
}

describe('SmartRate v3 — Memory Sliding Window Tests', () => {

  describe('Algorithm Option Validation', () => {
    it('defaults to fixed-window when algorithm is omitted', () => {
      const limiter = rateLimiter({ limit: 5, windowMs: 60_000 });
      assert.equal(typeof limiter, 'function');
    });

    it('accepts explicit algorithm: fixed-window', () => {
      const limiter = rateLimiter({ algorithm: 'fixed-window', limit: 5, windowMs: 60_000 });
      assert.equal(typeof limiter, 'function');
    });

    it('accepts explicit algorithm: sliding-window', () => {
      const limiter = rateLimiter({ algorithm: 'sliding-window', limit: 5, windowMs: 60_000 });
      assert.equal(typeof limiter, 'function');
    });

    it('fails fast when algorithm is unrecognized', () => {
      assert.throws(
        () => rateLimiter({ algorithm: 'leaky-bucket', limit: 5, windowMs: 60_000 }),
        {
          name: 'TypeError',
          message: /Unsupported algorithm 'leaky-bucket'/
        }
      );

      assert.throws(
        () => rateLimiter({ algorithm: 'random', limit: 5, windowMs: 60_000 }),
        {
          name: 'TypeError',
          message: /Unsupported algorithm 'random'/
        }
      );
    });
  });

  describe('MemoryStore Sliding Window Unit Semantics', () => {
    it('enforces quota sequentially using rolling timestamps', () => {
      const store = new MemoryStore();
      const key = 'test:sliding:client1';
      const limit = 3;
      const windowMs = 60_000;
      const t0 = 100_000;

      const r1 = store.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: t0 });
      assert.equal(r1.allowed, true);
      assert.equal(r1.count, 1);
      assert.equal(r1.remaining, 2);

      const r2 = store.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: t0 + 1000 });
      assert.equal(r2.allowed, true);
      assert.equal(r2.count, 2);
      assert.equal(r2.remaining, 1);

      const r3 = store.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: t0 + 2000 });
      assert.equal(r3.allowed, true);
      assert.equal(r3.count, 3);
      assert.equal(r3.remaining, 0);

      const r4 = store.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: t0 + 3000 });
      assert.equal(r4.allowed, false);
      assert.equal(r4.count, 3);
      assert.equal(r4.remaining, 0);
      assert.ok(r4.retryAfter > 0);
    });

    it('enforces exact half-open interval boundary cutoff (now - windowMs, now]', () => {
      const store = new MemoryStore();
      const key = 'test:sliding:boundary';
      const limit = 2;
      const windowMs = 10_000;

      store.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: 10_000 });

      store.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: 15_000 });

      const resAt20s = store.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: 20_000 });
      assert.equal(resAt20s.allowed, true);
      assert.equal(resAt20s.count, 2);
      assert.equal(resAt20s.remaining, 0);
    });

    it('calculates dynamic reset and retryAfter based on oldest relevant timestamp', () => {
      const store = new MemoryStore();
      const key = 'test:sliding:reset';
      const limit = 1;
      const windowMs = 10_000;

      store.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: 100_000 });

      const blocked = store.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: 103_000 });
      assert.equal(blocked.allowed, false);
      assert.equal(blocked.reset, 7);
      assert.equal(blocked.retryAfter, 7);
    });

    it('cleans up stale sliding window records during periodic sweeper run', () => {
      const store = new MemoryStore();
      const key = 'test:sliding:cleanup';
      const limit = 2;
      const windowMs = 10_000;

      store.consume({ key, limit, windowMs, algorithm: 'sliding-window', now: 1_000 });

      const activeEvicted = store.cleanupExpiredRecords(5_000);
      assert.equal(activeEvicted, 0);

      const expiredEvicted = store.cleanupExpiredRecords(12_000);
      assert.equal(expiredEvicted, 1);
    });
  });

  describe('Boundary-Burst Comparison (Fixed Window vs Sliding Window)', () => {
    it('verifies boundary-burst prevention under tested scenario', () => {
      const store = new MemoryStore();
      const limit = 2;
      const windowMs = 10_000;

      const fixedKey = 'burst:fixed';
      const slidingKey = 'burst:sliding';

      store.consume({ key: fixedKey, limit, windowMs, algorithm: 'fixed-window', now: 0 });
      store.consume({ key: slidingKey, limit, windowMs, algorithm: 'sliding-window', now: 0 });

      const f2 = store.consume({ key: fixedKey, limit, windowMs, algorithm: 'fixed-window', now: 9_500 });
      const s2 = store.consume({ key: slidingKey, limit, windowMs, algorithm: 'sliding-window', now: 9_500 });
      assert.equal(f2.allowed, true);
      assert.equal(s2.allowed, true);

      const f3 = store.consume({ key: fixedKey, limit, windowMs, algorithm: 'fixed-window', now: 10_001 });
      assert.equal(f3.allowed, true, 'Fixed Window allows request right after boundary reset');

      const f4 = store.consume({ key: fixedKey, limit, windowMs, algorithm: 'fixed-window', now: 10_002 });
      assert.equal(f4.allowed, true, 'Fixed Window allows full quota burst right after reset');

      const s3 = store.consume({ key: slidingKey, limit, windowMs, algorithm: 'sliding-window', now: 10_001 });
      assert.equal(s3.allowed, true);

      const s4 = store.consume({ key: slidingKey, limit, windowMs, algorithm: 'sliding-window', now: 10_002 });
      assert.equal(s4.allowed, false, 'Sliding Window strictly blocks boundary burst');
      assert.equal(s4.remaining, 0);
      assert.equal(s4.retryAfter, 10);
    });
  });

  describe('Express Integration with Sliding Window', () => {
    it('enforces sliding window on Express routes and sets correct headers', async () => {
      const app = createTestApp();
      app.get(
        '/api/sliding-resource',
        rateLimiter({
          algorithm: 'sliding-window',
          limit: 2,
          windowMs: 60_000
        }),
        (req, res) => res.json({ success: true })
      );

      const clientIp = '192.168.5.1';

      const res1 = await request(app).get('/api/sliding-resource').set('X-Forwarded-For', clientIp);
      assert.equal(res1.status, 200);
      assert.equal(res1.headers['ratelimit-limit'], '2');
      assert.equal(res1.headers['ratelimit-remaining'], '1');

      const res2 = await request(app).get('/api/sliding-resource').set('X-Forwarded-For', clientIp);
      assert.equal(res2.status, 200);
      assert.equal(res2.headers['ratelimit-remaining'], '0');

      const res3 = await request(app).get('/api/sliding-resource').set('X-Forwarded-For', clientIp);
      assert.equal(res3.status, 429);
      assert.equal(res3.body.success, false);
      assert.equal(res3.headers['ratelimit-remaining'], '0');
      assert.ok(Number(res3.headers['retry-after']) > 0);
    });
  });
});
