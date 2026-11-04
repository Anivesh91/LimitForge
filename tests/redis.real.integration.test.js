import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import express from 'express';
import request from 'supertest';
import { RedisStore, ResilientStore, rateLimiter } from '../src/index.js';

const redisUrl = process.env.REDIS_URL;

describe('real Redis integration', { skip: !redisUrl && 'Set REDIS_URL to run real Redis integration tests' }, () => {
  async function connect() {
    const client = createClient({ url: redisUrl, disableOfflineQueue: true, socket: { reconnectStrategy: false } });
    client.on('error', () => {});
    await client.connect();
    return client;
  }

  it('enforces each algorithm atomically across independent clients', async (t) => {
    const clientA = await connect();
    const clientB = await connect();
    const prefix = `limitforge-test-${randomUUID()}`;
    t.after(async () => {
      const keys = await clientA.keys(`${prefix}:*`);
      if (keys.length) await clientA.del(keys);
      clientA.destroy();
      clientB.destroy();
    });
    const stores = [new RedisStore({ client: clientA, prefix }), new RedisStore({ client: clientB, prefix })];
    for (const algorithm of ['fixed-window', 'sliding-window', 'token-bucket']) {
      const params = { key: algorithm, algorithm, limit: 5, windowMs: 60000, capacity: 5, refillRate: 0.000001, refillIntervalMs: 1000 };
      const results = await Promise.all(Array.from({ length: 30 }, (_, i) => stores[i % 2].consume(params)));
      assert.equal(results.filter(result => result.allowed).length, 5, algorithm);
      assert.ok(await clientA.pTTL(`${prefix}:${algorithm}`) > 0, `${algorithm} has an expiry`);
    }
  });

  it('fails closed on a disconnected primary and resumes after reconnecting', async (t) => {
    const client = await connect();
    const prefix = `limitforge-test-${randomUUID()}`;
    const resilient = new ResilientStore({ primaryStore: new RedisStore({ client, prefix }), circuitBreaker: false });
    t.after(() => resilient.fallbackStore.destroy());
    const app = express();
    app.get('/', rateLimiter({ limit: 2, windowMs: 60000, store: resilient, onStoreError: 'fail-closed' }), (req, res) => res.sendStatus(200));
    assert.equal((await request(app).get('/')).status, 200);
    client.destroy();
    const failed = await request(app).get('/');
    assert.equal(failed.status, 503);
    assert.equal(failed.headers['ratelimit-degraded'], 'true');
    assert.equal(resilient.fallbackStore.store.size, 0);
    const recoveredClient = await connect();
    t.after(async () => {
      const keys = await recoveredClient.keys(`${prefix}:*`);
      if (keys.length) await recoveredClient.del(keys);
      recoveredClient.destroy();
    });
    resilient.primaryStore = new RedisStore({ client: recoveredClient, prefix });
    assert.equal((await request(app).get('/')).status, 200);
    assert.equal((await request(app).get('/')).status, 429);
  });

  it('fails closed when a Redis operation times out even if it later executes', async (t) => {
    const client = await connect();
    const prefix = `limitforge-test-${randomUUID()}`;
    t.after(async () => {
      const keys = await client.keys(`${prefix}:*`);
      if (keys.length) await client.del(keys);
      client.destroy();
    });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let finished;
    const executed = new Promise(resolve => { finished = resolve; });
    const delayedClient = {
      async eval(script, options) {
        await gate;
        try { return await client.eval(script, options); }
        finally { finished(); }
      }
    };
    const resilient = new ResilientStore({ primaryStore: new RedisStore({ client: delayedClient, prefix }), timeoutMs: 10 });
    t.after(() => resilient.fallbackStore.destroy());
    const app = express();
    app.get('/', rateLimiter({ limit: 2, windowMs: 60000, store: resilient, onStoreError: 'fail-closed' }), (req, res) => res.sendStatus(200));
    try {
      assert.equal((await request(app).get('/')).status, 503);
      assert.equal(resilient.fallbackStore.store.size, 0);
    } finally {
      release();
      await executed;
    }
    const keys = await client.keys(`${prefix}:*`);
    assert.equal(keys.length, 1);
    assert.equal(await client.get(keys[0]), '1');
  });
});
