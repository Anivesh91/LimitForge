import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { rateLimiter, MemoryStore } from '../src/index.js';
import { cleanupExpiredRecords } from '../src/limiter/rateLimiter.js';

describe('default limiter stores', () => {
  for (const algorithm of ['fixed-window', 'sliding-window', 'token-bucket']) {
    it(`keeps two default ${algorithm} limiters on the same route independent`, async () => {
      const settings = algorithm === 'token-bucket'
        ? { algorithm, capacity: 5, refillRate: 0.000001 }
        : { algorithm, limit: 5, windowMs: 60000 };
      const first = rateLimiter(settings);
      const second = rateLimiter(settings);
      const app = express();
      app.get('/same', first, second, (req, res) => res.sendStatus(200));
      for (let i = 0; i < 5; i++) assert.equal((await request(app).get('/same')).status, 200);
      assert.equal((await request(app).get('/same')).status, 429);
    });
  }

  it('keeps default limiters with different policies independent', async () => {
    const app = express();
    app.get('/same', rateLimiter({ limit: 4, windowMs: 60000 }), rateLimiter({ limit: 2, windowMs: 60000 }), (req, res) => res.sendStatus(200));
    assert.equal((await request(app).get('/same')).status, 200);
    assert.equal((await request(app).get('/same')).status, 200);
    assert.equal((await request(app).get('/same')).status, 429);
  });

  it('retains one limiter\'s route-specific quotas when it is reused', async () => {
    const app = express();
    const limiter = rateLimiter({ limit: 1, windowMs: 60000 });
    app.get('/one', limiter, (req, res) => res.sendStatus(200));
    app.get('/two', limiter, (req, res) => res.sendStatus(200));
    assert.equal((await request(app).get('/one')).status, 200);
    assert.equal((await request(app).get('/one')).status, 429);
    assert.equal((await request(app).get('/two')).status, 200);
  });

  it('shares its own quota when the same limiter is reused by two apps', async () => {
    const limiter = rateLimiter({ limit: 1, windowMs: 60000 });
    const appA = express();
    const appB = express();
    appA.get('/same', limiter, (req, res) => res.sendStatus(200));
    appB.get('/same', limiter, (req, res) => res.sendStatus(200));
    assert.equal((await request(appA).get('/same')).status, 200);
    assert.equal((await request(appB).get('/same')).status, 429);
  });

  it('preserves intentional sharing when a store is explicitly supplied', async () => {
    const store = new MemoryStore();
    try {
      const app = express();
      const options = { store, limit: 5, windowMs: 60000 };
      app.get('/same', rateLimiter(options), rateLimiter(options), (req, res) => res.sendStatus(200));
      assert.equal((await request(app).get('/same')).status, 200);
      assert.equal((await request(app).get('/same')).status, 200);
      assert.equal((await request(app).get('/same')).status, 429);
    } finally {
      store.destroy();
    }
  });

  it('isolates explicit shared-store policies when distinct prefixes are configured', async () => {
    const store = new MemoryStore();
    try {
      const app = express();
      const options = { store, limit: 2, windowMs: 60000 };
      app.get('/same', rateLimiter({ ...options, prefix: 'policy-a' }), rateLimiter({ ...options, prefix: 'policy-b' }), (req, res) => res.sendStatus(200));
      assert.equal((await request(app).get('/same')).status, 200);
      assert.equal((await request(app).get('/same')).status, 200);
      assert.equal((await request(app).get('/same')).status, 429);
    } finally {
      store.destroy();
    }
  });

  it('keeps manual cleanup working across default limiter stores', async () => {
    cleanupExpiredRecords();
    const app = express();
    app.get('/same', rateLimiter({ limit: 2, windowMs: 10 }), rateLimiter({ limit: 2, windowMs: 10 }), (req, res) => res.sendStatus(200));
    assert.equal((await request(app).get('/same')).status, 200);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(cleanupExpiredRecords(), 2);
    assert.equal((await request(app).get('/same')).status, 200);
  });
});
