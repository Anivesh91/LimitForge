import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MemoryStore } from '../src/stores/memoryStore.js';

describe('SmartRate — MemoryStore Unit Tests', () => {

  it('initializes a fresh record on first consume call', async () => {
    const store = new MemoryStore();
    const result = await store.consume({ key: 'test:key:1', limit: 5, windowMs: 60_000 });

    assert.equal(result.allowed, true);
    assert.equal(result.count, 1);
    assert.equal(result.remaining, 4);
    assert.ok(result.reset > 0);
    assert.equal(result.retryAfter, undefined);

    store.destroy();
  });

  it('increments counter sequentially up to configured limit', async () => {
    const store = new MemoryStore();
    const key = 'test:key:2';

    for (let i = 1; i <= 3; i++) {
      const result = await store.consume({ key, limit: 3, windowMs: 60_000 });
      assert.equal(result.allowed, true);
      assert.equal(result.count, i);
      assert.equal(result.remaining, 3 - i);
    }

    const blocked = await store.consume({ key, limit: 3, windowMs: 60_000 });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.remaining, 0);
    assert.ok(blocked.retryAfter > 0);

    store.destroy();
  });

  it('resets counter after window duration has elapsed', async () => {
    const store = new MemoryStore();
    const key = 'test:key:3';

    const res1 = await store.consume({ key, limit: 1, windowMs: 50 });
    assert.equal(res1.allowed, true);

    const res2 = await store.consume({ key, limit: 1, windowMs: 50 });
    assert.equal(res2.allowed, false);

    await new Promise((resolve) => setTimeout(resolve, 60));

    const res3 = await store.consume({ key, limit: 1, windowMs: 50 });
    assert.equal(res3.allowed, true);
    assert.equal(res3.count, 1);
    assert.equal(res3.remaining, 0);

    store.destroy();
  });

  it('cleans up expired records and returns count of evicted entries', async () => {
    const store = new MemoryStore();

    await store.consume({ key: 'stale:1', limit: 5, windowMs: 30 });
    await store.consume({ key: 'stale:2', limit: 5, windowMs: 30 });
    await store.consume({ key: 'active:1', limit: 5, windowMs: 60_000 });

    await new Promise((resolve) => setTimeout(resolve, 40));

    const removed = store.cleanupExpiredRecords();
    assert.equal(removed, 2, `Expected 2 records removed, got: ${removed}`);
    assert.equal(store.store.has('stale:1'), false);
    assert.equal(store.store.has('stale:2'), false);
    assert.equal(store.store.has('active:1'), true);

    store.destroy();
  });

  it('automatically cleans expired records while the store is in use', async () => {
    const store = new MemoryStore({ cleanupIntervalMs: 10 });
    try {
      store.consume({ key: 'auto-cleanup', limit: 1, windowMs: 1 });
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(store.store.has('auto-cleanup'), false);
    } finally {
      store.destroy();
    }
  });

  it('does not keep an unused store alive solely through its cleanup timer', async () => {
    const moduleUrl = new URL('../src/stores/memoryStore.js', import.meta.url).href;
    const program = `
      import { MemoryStore } from ${JSON.stringify(moduleUrl)};
      let reference;
      (() => { const store = new MemoryStore(); reference = new WeakRef(store); })();
      for (let i = 0; i < 100; i++) {
        await new Promise(resolve => setImmediate(resolve));
        global.gc();
        await new Promise(resolve => setImmediate(resolve));
        if (!reference.deref()) { console.log('collected'); process.exit(0); }
      }
      process.exit(1);
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--expose-gc', '--input-type=module', '-e', program], { timeout: 10000 });
    assert.match(stdout, /collected/);
  });

  it('retains a fixed-window counter after its duration increases', () => {
    const store = new MemoryStore();
    try {
      const key = 'dynamic:longer';
      assert.equal(store.consume({ key, limit: 2, windowMs: 1000, now: 1000 }).allowed, true);
      assert.equal(store.consume({ key, limit: 2, windowMs: 10000, now: 1500 }).allowed, true);
      assert.equal(store.cleanupExpiredRecords(2001), 0);
      assert.equal(store.consume({ key, limit: 2, windowMs: 10000, now: 2001 }).allowed, false);
      assert.equal(store.cleanupExpiredRecords(10999), 0);
      assert.equal(store.cleanupExpiredRecords(11000), 1);
      assert.equal(store.consume({ key, limit: 2, windowMs: 10000, now: 11000 }).allowed, true);
    } finally {
      store.destroy();
    }
  });

  it('updates cleanup after a blocked request extends the window', () => {
    const store = new MemoryStore();
    try {
      const key = 'dynamic:blocked';
      store.consume({ key, limit: 1, windowMs: 1000, now: 1000 });
      assert.equal(store.consume({ key, limit: 1, windowMs: 10000, now: 1500 }).allowed, false);
      assert.equal(store.cleanupExpiredRecords(2001), 0);
      assert.equal(store.consume({ key, limit: 1, windowMs: 10000, now: 2001 }).allowed, false);
    } finally {
      store.destroy();
    }
  });

  it('isolates state between different keys', async () => {
    const store = new MemoryStore();

    await store.consume({ key: 'client:A', limit: 1, windowMs: 60_000 });
    const blockedA = await store.consume({ key: 'client:A', limit: 1, windowMs: 60_000 });
    assert.equal(blockedA.allowed, false);

    const allowedB = await store.consume({ key: 'client:B', limit: 1, windowMs: 60_000 });
    assert.equal(allowedB.allowed, true);
    assert.equal(allowedB.count, 1);

    store.destroy();
  });
});
