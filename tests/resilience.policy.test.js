import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { rateLimiter, ResilientStore, StoreTimeoutError, withTimeout } from '../src/index.js';

async function within(promise, ms = 1000) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('test deadline exceeded')), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

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

  it('bounds a hanging fallback and leaves the primary breaker in control', async () => {
    let completeFallback;
    let primaryCalls = 0;
    const fallbackOperation = new Promise(resolve => { completeFallback = resolve; });
    const primary = { consume: async () => { primaryCalls++; throw new Error('primary unavailable'); } };
    const fallback = { consume: () => fallbackOperation };
    const store = new ResilientStore({ primaryStore: primary, fallbackStore: fallback, timeoutMs: 20, failureThreshold: 1 });
    let fallbackEvents = 0;
    store.on('fallback', () => fallbackEvents++);

    try {
      for (let i = 0; i < 2; i++) {
        await assert.rejects(within(store.consume({ key: 'client', limit: 1, windowMs: 1000 }), 500),
          err => err instanceof StoreTimeoutError && err.timeoutMs === 20);
      }
      assert.equal(primaryCalls, 1, 'an open primary breaker skips the next primary call');
      assert.equal(fallbackEvents, 2);
      assert.equal(store.breaker.getState(), 'OPEN');
    } finally {
      completeFallback({ allowed: true });
    }
    assert.deepEqual(await fallbackOperation, { allowed: true }, 'timeout did not cancel fallback work');
  });

  it('uses the default timeout for a fallback when timeoutMs is omitted', async () => {
    let release;
    const fallbackOperation = new Promise(resolve => { release = resolve; });
    const store = new ResilientStore({
      primaryStore: { consume: () => { throw new Error('primary unavailable'); } },
      fallbackStore: { consume: () => fallbackOperation },
      circuitBreaker: false
    });
    try {
      await assert.rejects(within(store.consume({ key: 'client', limit: 1, windowMs: 1000 }), 1500),
        err => err instanceof StoreTimeoutError && err.timeoutMs === 250);
    } finally {
      release({ allowed: true });
    }
  });

  it('gives a timed-out primary and a hanging fallback separate timeouts', async () => {
    let releasePrimary;
    let releaseFallback;
    const primaryOperation = new Promise(resolve => { releasePrimary = resolve; });
    const fallbackOperation = new Promise(resolve => { releaseFallback = resolve; });
    const store = new ResilientStore({
      primaryStore: { consume: () => primaryOperation },
      fallbackStore: { consume: () => fallbackOperation },
      timeoutMs: 20,
      circuitBreaker: false
    });
    let primaryError;
    store.on('fallback', event => { primaryError = event.error; });
    try {
      await assert.rejects(within(store.consume({ key: 'client', limit: 1, windowMs: 1000 })),
        err => err instanceof StoreTimeoutError && err.timeoutMs === 20 && err !== primaryError);
      assert.ok(primaryError instanceof StoreTimeoutError);
      assert.equal(primaryError.timeoutMs, 20);
    } finally {
      releasePrimary({ allowed: true });
      releaseFallback({ allowed: true });
    }
  });

  it('observes a fallback rejection that arrives after its timeout', async () => {
    let rejectFallback;
    const fallbackOperation = new Promise((resolve, reject) => { rejectFallback = reject; });
    const store = new ResilientStore({
      primaryStore: { consume: () => { throw new Error('primary unavailable'); } },
      fallbackStore: { consume: () => fallbackOperation },
      timeoutMs: 20,
      circuitBreaker: false
    });
    await assert.rejects(within(store.consume({ key: 'client', limit: 1, windowMs: 1000 })),
      { name: 'StoreTimeoutError', timeoutMs: 20 });
    rejectFallback(new Error('late fallback failure'));
    await new Promise(resolve => setImmediate(resolve));
  });

  for (const mode of ['explicit', 'shorthand']) {
    for (const policy of ['default', 'fail-open', 'custom']) {
      it(`handles a fallback timeout with ${mode} and ${policy} policy`, async () => {
        let release;
        const fallbackOperation = new Promise(resolve => { release = resolve; });
        const primary = { consume: async () => { throw new Error('primary unavailable'); } };
        const fallback = { consume: () => fallbackOperation };
        const storeOptions = mode === 'explicit'
          ? { store: new ResilientStore({ primaryStore: primary, fallbackStore: fallback, timeoutMs: 20, circuitBreaker: false }) }
          : { store: primary, fallbackStore: fallback, timeoutMs: 20, circuitBreaker: false };
        const onStoreError = policy === 'default' ? undefined
          : policy === 'fail-open' ? 'fail-open'
            : (err, req, res) => res.status(502).json({ name: err.name, timeoutMs: err.timeoutMs });
        const app = express();
        app.get('/', rateLimiter({ limit: 1, windowMs: 1000, ...storeOptions, onStoreError }), (req, res) => {
          res.status(200).json({ name: req.rateLimit.storeError.name, timeoutMs: req.rateLimit.storeError.timeoutMs });
        });
        app.use((err, req, res, next) => res.status(500).json({ name: err.name, timeoutMs: err.timeoutMs }));

        try {
          const res = await request(app).get('/').timeout({ deadline: 1000 });
          assert.equal(res.status, policy === 'default' ? 500 : policy === 'custom' ? 502 : 200);
          assert.equal(res.headers['ratelimit-degraded'], 'true');
          assert.deepEqual(res.body, { name: 'StoreTimeoutError', timeoutMs: 20 });
        } finally {
          release({ allowed: true });
        }
      });
    }
  }
});
