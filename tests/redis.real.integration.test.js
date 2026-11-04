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

  for (const algorithm of ['fixed-window', 'sliding-window']) {
    it(`accepts fractional ${algorithm} windows without leaving unexpired keys`, async (t) => {
      const client = await connect();
      const prefix = `limitforge-test-${randomUUID()}`;
      t.after(async () => {
        const keys = await client.keys(`${prefix}:*`);
        if (keys.length) await client.del(keys);
        client.destroy();
      });
      const store = new RedisStore({ client, prefix });
      for (const windowMs of [1.5, 1000.5]) {
        const key = `fraction-${windowMs}`;
        const result = await store.consume({ key, algorithm, limit: 1, windowMs });
        assert.equal(result.allowed, true);
        const ttl = await client.pTTL(`${prefix}:${key}`);
        assert.notEqual(ttl, -1, 'key must have an expiry or already be expired');
        if (windowMs === 1000.5) {
          assert.ok(ttl > 0 && ttl <= 1001);
          assert.equal((await store.consume({ key, algorithm, limit: 1, windowMs })).allowed, false);
        }
      }

      const app = express();
      app.get('/', rateLimiter({ store, algorithm, limit: 1, windowMs: 1000.5 }), (req, res) => res.sendStatus(200));
      assert.equal((await request(app).get('/')).status, 200);
      assert.equal((await request(app).get('/')).status, 429);
    });

    it(`rejects an oversized ${algorithm} window before changing Redis state`, async (t) => {
      const client = await connect();
      const prefix = `limitforge-test-${randomUUID()}`;
      t.after(async () => {
        const keys = await client.keys(`${prefix}:*`);
        if (keys.length) await client.del(keys);
        client.destroy();
      });
      const store = new RedisStore({ client, prefix });
      const fresh = { key: 'fresh', algorithm, limit: 2, windowMs: Number.MAX_VALUE };
      await assert.rejects(store.consume(fresh), /out of range/);
      assert.equal(await client.exists(`${prefix}:fresh`), 0);

      const active = { key: 'active', algorithm, limit: 2, windowMs: 60000 };
      assert.equal((await store.consume(active)).allowed, true);
      await assert.rejects(store.consume({ ...active, windowMs: Number.MAX_VALUE }), /out of range/);
      const after = await store.consume(active);
      assert.equal(after.allowed, true);
      assert.equal(after.count, 2);
      assert.ok(await client.pTTL(`${prefix}:active`) > 0);
    });
  }

  it('does not discard existing quota for extremely small positive windows', async (t) => {
    const client = await connect();
    const prefix = `limitforge-test-${randomUUID()}`;
    t.after(async () => {
      const keys = await client.keys(`${prefix}:*`);
      if (keys.length) await client.del(keys);
      client.destroy();
    });
    const now = 1000000000000;
    // Freeze Redis TIME for the fixed-window script so both operations fall in
    // the same millisecond without depending on network timing.
    const fixedClient = {
      eval(script, options) {
        const call = 'local clock = redis.call("TIME")';
        assert.ok(script.includes(call));
        return client.eval(script.replace(call, 'local clock = {"1000000000", "0"}'), options);
      }
    };
    const fixed = new RedisStore({ client: fixedClient, prefix });
    await client.set(`${prefix}:tiny-fixed`, `lf1|1|${now}|0`, { PX: 60000 });
    assert.equal((await fixed.consume({ key: 'tiny-fixed', limit: 1, windowMs: Number.MIN_VALUE })).allowed, false);

    await client.zAdd(`${prefix}:tiny-sliding`, [{ score: now, value: 'prior' }]);
    await client.pExpire(`${prefix}:tiny-sliding`, 60000);
    const sliding = new RedisStore({ client, prefix });
    assert.equal((await sliding.consume({ key: 'tiny-sliding', algorithm: 'sliding-window', limit: 1, windowMs: Number.MIN_VALUE, now })).allowed, false);
  });

  it('reports retry timing from the rounded sliding window duration', async (t) => {
    const client = await connect();
    const prefix = `limitforge-test-${randomUUID()}`;
    t.after(async () => {
      const keys = await client.keys(`${prefix}:*`);
      if (keys.length) await client.del(keys);
      client.destroy();
    });
    const now = 1000000000000;
    await client.zAdd(`${prefix}:retry`, [{ score: now, value: 'prior' }]);
    await client.pExpire(`${prefix}:retry`, 60000);
    const result = await new RedisStore({ client, prefix }).consume({
      key: 'retry', algorithm: 'sliding-window', limit: 1, windowMs: 1000.000001, now
    });
    assert.equal(result.allowed, false);
    assert.equal(result.retryAfter, 2);
  });

  it('shares the global quota across arbitrary paths using Redis', async (t) => {
    const client = await connect();
    const prefix = `limitforge-test-${randomUUID()}`;
    t.after(async () => {
      const keys = await client.keys(`${prefix}:*`);
      if (keys.length) await client.del(keys);
      client.destroy();
    });
    const app = express();
    app.use(rateLimiter({ limit: 1, windowMs: 60000, store: new RedisStore({ client, prefix }) }));
    app.get('/users/:name', (req, res) => res.sendStatus(200));
    assert.equal((await request(app).get('/users/alice')).status, 200);
    assert.equal((await request(app).get('/users/bob')).status, 429);
  });

  it('retains a fixed-window quota when a request extends its duration', async (t) => {
    const client = await connect();
    const prefix = `limitforge-test-${randomUUID()}`;
    t.after(async () => {
      const keys = await client.keys(`${prefix}:*`);
      if (keys.length) await client.del(keys);
      client.destroy();
    });
    const store = new RedisStore({ client, prefix });
    const app = express();
    app.get('/', rateLimiter({
      store,
      limit: 2,
      windowMs: req => req.headers['x-window'] === 'long' ? 7000 : 700
    }), (req, res) => res.sendStatus(200));

    assert.equal((await request(app).get('/')).status, 200);
    assert.equal((await request(app).get('/').set('x-window', 'long')).status, 200);
    const keys = await client.keys(`${prefix}:*`);
    assert.equal(keys.length, 1);
    assert.ok(await client.pTTL(keys[0]) > 6000, 'extended window must outlive the original TTL');
    const blocked = await request(app).get('/').set('x-window', 'long');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers['ratelimit-remaining'], '0');
  });

  it('applies shorter windows from the original start and keeps fixed deadlines', async (t) => {
    const client = await connect();
    const prefix = `limitforge-test-${randomUUID()}`;
    t.after(async () => {
      const keys = await client.keys(`${prefix}:*`);
      if (keys.length) await client.del(keys);
      client.destroy();
    });
    const store = new RedisStore({ client, prefix });
    const params = { key: 'shorten', limit: 2, windowMs: 10000 };
    assert.equal((await store.consume(params)).count, 1);
    const key = `${prefix}:shorten`;
    const original = await client.get(key);
    const [marker, count, start] = original.split('|');
    await client.set(key, `${marker}|${count}|${Number(start) - 5000}|0`, { PX: 10000 });
    const reset = await store.consume({ ...params, windowMs: 1000 });
    assert.equal(reset.allowed, true);
    assert.equal(reset.count, 1);

    const firstTtl = await client.pTTL(key);
    await store.consume({ ...params, windowMs: 1000 });
    assert.ok(await client.pTTL(key) <= firstTtl, 'ordinary traffic must not extend a fixed window');
  });

  it('migrates legacy numeric counters without losing counts or shortening their TTL', async (t) => {
    const client = await connect();
    const prefix = `limitforge-test-${randomUUID()}`;
    t.after(async () => {
      const keys = await client.keys(`${prefix}:*`);
      if (keys.length) await client.del(keys);
      client.destroy();
    });
    const store = new RedisStore({ client, prefix });
    const key = `${prefix}:legacy`;
    await client.set(key, '2', { PX: 5000 });
    const result = await store.consume({ key: 'legacy', limit: 3, windowMs: 1000 });
    assert.equal(result.count, 3);
    assert.equal(result.allowed, true);
    assert.ok(await client.pTTL(key) > 4000);
    assert.match(await client.get(key), /^lf1\|3\|\d+\|\d+$/);
    assert.equal((await store.consume({ key: 'legacy', limit: 3, windowMs: 1000 })).allowed, false);
    await assert.rejects(client.incr(key));

    await client.set(`${prefix}:legacy-short`, '2', { PX: 5000 });
    const extended = await store.consume({ key: 'legacy-short', limit: 3, windowMs: 60000 });
    assert.equal(extended.count, 3);
    assert.ok(await client.pTTL(`${prefix}:legacy-short`) > 50000);
  });

  it('preserves legacy keys when migration cannot safely proceed', async (t) => {
    const client = await connect();
    const prefix = `limitforge-test-${randomUUID()}`;
    t.after(async () => {
      const keys = await client.keys(`${prefix}:*`);
      if (keys.length) await client.del(keys);
      client.destroy();
    });
    const store = new RedisStore({ client, prefix });
    await client.set(`${prefix}:orphan`, '7');
    await assert.rejects(store.consume({ key: 'orphan', limit: 10, windowMs: 1000 }), /without an expiration TTL/);
    assert.equal(await client.get(`${prefix}:orphan`), '7');
    await client.set(`${prefix}:overflow`, '9223372036854775807', { PX: 5000 });
    await assert.rejects(store.consume({ key: 'overflow', limit: 10, windowMs: 1000 }), /overflow/);
    assert.equal(await client.get(`${prefix}:overflow`), '9223372036854775807');
  });

  it('preserves signed and high-value Redis counters during migration', async (t) => {
    const client = await connect();
    const prefix = `limitforge-test-${randomUUID()}`;
    t.after(async () => {
      const keys = await client.keys(`${prefix}:*`);
      if (keys.length) await client.del(keys);
      client.destroy();
    });
    const store = new RedisStore({ client, prefix });
    await client.set(`${prefix}:negative`, '-2', { PX: 5000 });
    assert.equal((await store.consume({ key: 'negative', limit: 10, windowMs: 1000 })).count, -1);
    assert.equal((await store.consume({ key: 'negative', limit: 10, windowMs: 1000 })).count, 0);
    await client.set(`${prefix}:large`, '9007199254740992', { PX: 5000 });
    await store.consume({ key: 'large', limit: 10, windowMs: 1000 });
    assert.match(await client.get(`${prefix}:large`), /^lf1\|9007199254740993\|\d+\|\d+$/);
    await client.set(`${prefix}:near-overflow`, '9223372036854775806', { PX: 5000 });
    const nearOverflow = await store.consume({ key: 'near-overflow', limit: 10, windowMs: 1000 });
    assert.equal(nearOverflow.allowed, false);
    assert.ok(nearOverflow.count > 0);
  });

  it('migrates an existing counter atomically across Redis clients', async (t) => {
    const clientA = await connect();
    const clientB = await connect();
    const prefix = `limitforge-test-${randomUUID()}`;
    t.after(async () => {
      const keys = await clientA.keys(`${prefix}:*`);
      if (keys.length) await clientA.del(keys);
      clientA.destroy();
      clientB.destroy();
    });
    await clientA.set(`${prefix}:legacy`, '2', { PX: 5000 });
    const stores = [new RedisStore({ client: clientA, prefix }), new RedisStore({ client: clientB, prefix })];
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => stores[i % 2].consume({ key: 'legacy', limit: 10, windowMs: 60000 })));
    assert.equal(results.filter(result => result.allowed).length, 8);
    assert.equal(Math.max(...results.map(result => result.count)), 22);
    assert.match(await clientA.get(`${prefix}:legacy`), /^lf1\|22\|\d+\|\d+$/);
  });

  it('uses Redis time for distributed windows even when application clocks differ', async (t) => {
    const clientA = await connect();
    const clientB = await connect();
    const prefix = `limitforge-test-${randomUUID()}`;
    t.after(async () => {
      const keys = await clientA.keys(`${prefix}:*`);
      if (keys.length) await clientA.del(keys);
      clientA.destroy();
      clientB.destroy();
    });
    const storeA = new RedisStore({ client: clientA, prefix });
    const storeB = new RedisStore({ client: { sendCommand: args => clientB.sendCommand(args) }, prefix });
    const clock = Date.now;
    function consumeWithClock(store, params, offset) {
      Date.now = () => clock() + offset;
      try { return store.consume(params); }
      finally { Date.now = clock; }
    }

    const sliding = { key: 'sliding-clock', algorithm: 'sliding-window', limit: 1, windowMs: 60000 };
    assert.equal((await consumeWithClock(storeA, sliding, -3600000)).allowed, true);
    const blocked = await consumeWithClock(storeB, sliding, 3600000);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfter >= 55 && blocked.retryAfter <= 60);

    const bucket = { key: 'bucket-clock', algorithm: 'token-bucket', capacity: 1, refillRate: 1, refillIntervalMs: 60000 };
    assert.equal((await consumeWithClock(storeA, bucket, 3600000)).allowed, true);
    assert.equal((await consumeWithClock(storeB, bucket, -3600000)).allowed, false);
    assert.equal((await consumeWithClock(storeA, bucket, 3600000)).allowed, false);
  });

  it('retains explicit time overrides and does not refill when time moves backwards', async (t) => {
    const client = await connect();
    const prefix = `limitforge-test-${randomUUID()}`;
    t.after(async () => {
      const keys = await client.keys(`${prefix}:*`);
      if (keys.length) await client.del(keys);
      client.destroy();
    });
    const store = new RedisStore({ client, prefix });
    const sliding = { key: 'sliding-override', algorithm: 'sliding-window', limit: 1, windowMs: 60000 };
    assert.equal((await store.consume({ ...sliding, now: 100000 })).allowed, true);
    assert.equal((await store.consume({ ...sliding, now: 159999 })).allowed, false);
    assert.equal((await store.consume({ ...sliding, now: 160000 })).allowed, true);

    const bucket = { key: 'bucket-override', algorithm: 'token-bucket', capacity: 1, refillRate: 1, refillIntervalMs: 1000 };
    assert.equal((await store.consume({ ...bucket, now: 100000 })).allowed, true);
    assert.equal((await store.consume({ ...bucket, now: 99000 })).allowed, false);
    assert.equal((await store.consume({ ...bucket, now: 100000 })).allowed, false);
    assert.equal((await store.consume({ ...bucket, now: 101000 })).allowed, true);
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
    assert.match(await client.get(keys[0]), /^lf1\|1\|\d+\|\d+$/);
  });
});
