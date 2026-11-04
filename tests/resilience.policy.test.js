import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { rateLimiter, ResilientStore, withTimeout } from '../src/index.js';

describe('failure policy with resilient stores', () => {
  for (const mode of ['explicit', 'shorthand']) {
    for (const policy of ['onStoreError', 'failStrategy']) {
      it(`fails closed without consuming fallback using ${mode} and ${policy}`, async () => {
        let fallbackCalls = 0;
        const primary = { consume: async () => { throw new Error('primary unavailable'); } };
        const fallback = { consume: async () => { fallbackCalls++; return { allowed: true, remaining: 0, reset: 60 }; } };
        const storeOptions = mode === 'explicit'
          ? { store: new ResilientStore({ primaryStore: primary, fallbackStore: fallback, failureThreshold: 1 }) }
          : { store: primary, fallbackStore: fallback, failureThreshold: 1 };
        const app = express();
        app.get('/', rateLimiter({ limit: 1, windowMs: 60000, ...storeOptions, [policy]: 'fail-closed' }), (req, res) => res.sendStatus(200));
        for (let i = 0; i < 2; i++) {
          const res = await request(app).get('/');
          assert.equal(res.status, 503);
          assert.equal(res.headers['ratelimit-degraded'], 'true');
        }
        assert.equal(fallbackCalls, 0);
      });
    }
  }

  it('still uses fallback for the default policy', async () => {
    const primary = { consume: async () => { throw new Error('primary unavailable'); } };
    const store = new ResilientStore({ primaryStore: primary });
    const app = express();
    app.get('/', rateLimiter({ limit: 1, windowMs: 60000, store }), (req, res) => res.sendStatus(200));
    assert.equal((await request(app).get('/')).status, 200);
    assert.equal((await request(app).get('/')).status, 429);
    store.fallbackStore.destroy();
  });

  it('does not claim to cancel an already started operation', async () => {
    let complete;
    const operation = new Promise(resolve => { complete = resolve; });
    await assert.rejects(withTimeout(operation, 10), { name: 'StoreTimeoutError' });
    complete('applied');
    assert.equal(await operation, 'applied');
  });
});
