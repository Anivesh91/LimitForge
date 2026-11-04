import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { rateLimiter, MemoryStore, MetricsCollector } from '../src/index.js';

function createApp(t, options = {}) {
  const store = new MemoryStore();
  t.after(() => store.destroy());
  const app = express();
  app.set('trust proxy', true);
  return { app, limiter: rateLimiter({ limit: 2, windowMs: 60000, store, ...options }) };
}

const get = (app, path, ip = '192.0.2.1') => request(app).get(path).set('X-Forwarded-For', ip);

describe('route key scope', () => {
  for (const algorithm of ['fixed-window', 'sliding-window', 'token-bucket']) {
    it(`shares the global ${algorithm} quota across arbitrary paths for each client`, async (t) => {
      const { app, limiter } = createApp(t, algorithm === 'token-bucket'
        ? { algorithm, capacity: 2, refillRate: 0.000001 }
        : { algorithm });
      app.use(limiter);
      app.get('/users/:name', (req, res) => res.sendStatus(200));
      app.get('/other', (req, res) => res.sendStatus(200));
      assert.equal((await get(app, '/users/alice')).status, 200);
      assert.equal((await get(app, '/users/bob')).status, 200);
      assert.equal((await get(app, '/other')).status, 429);
      assert.equal((await get(app, '/users/carol', '192.0.2.2')).status, 200);
    });
  }

  it('retains separate quotas per HTTP method', async (t) => {
    const { app, limiter } = createApp(t, { limit: 1 });
    app.use(limiter);
    app.all('/resource', (req, res) => res.sendStatus(200));
    assert.equal((await get(app, '/resource')).status, 200);
    assert.equal((await get(app, '/resource')).status, 429);
    assert.equal((await request(app).post('/resource').set('X-Forwarded-For', '192.0.2.1')).status, 200);
  });

  it('uses the shared quota in app.use even when an earlier route set req.route', async (t) => {
    const { app, limiter } = createApp(t, { limit: 1 });
    app.get('/users/:name', (req, res, next) => next());
    app.get('/accounts/:name', (req, res, next) => next());
    app.use(limiter);
    app.use((req, res) => res.sendStatus(200));
    assert.equal((await get(app, '/users/alice')).status, 200);
    assert.equal((await get(app, '/accounts/bob')).status, 429);
  });

  it('uses a shared global quota when the same limiter previously ran on a route', async (t) => {
    const { app, limiter } = createApp(t, { limit: 1 });
    app.get('/users/:name', limiter, (req, res, next) => next());
    app.get('/accounts/:name', limiter, (req, res, next) => next());
    app.use(limiter);
    app.use((req, res) => res.sendStatus(200));
    assert.equal((await get(app, '/users/alice')).status, 200);
    assert.equal((await get(app, '/accounts/bob')).status, 429);
  });

  it('keeps route-level quotas separate and normalizes route parameters', async (t) => {
    const { app, limiter } = createApp(t, { limit: 1 });
    app.get('/users/:name', limiter, (req, res) => res.sendStatus(200));
    app.get('/health', limiter, (req, res) => res.sendStatus(200));
    assert.equal((await get(app, '/users/alice')).status, 200);
    assert.equal((await get(app, '/users/bob')).status, 429);
    assert.equal((await get(app, '/health')).status, 200);
  });

  it('supports an explicitly shared quota across route-level handlers', async (t) => {
    const { app, limiter } = createApp(t, { limit: 1, includeRoute: false });
    app.get('/users/:name', limiter, (req, res) => res.sendStatus(200));
    app.get('/health', limiter, (req, res) => res.sendStatus(200));
    assert.equal((await get(app, '/users/alice')).status, 200);
    assert.equal((await get(app, '/health')).status, 429);
  });

  it('supports a custom normalizer for a parameterized router mount', async (t) => {
    const { app, limiter } = createApp(t, { limit: 1, routeNormalizer: () => '/orgs/:org/users/:name' });
    const router = express.Router();
    router.get('/users/:name', limiter, (req, res) => res.sendStatus(200));
    app.use('/orgs/:org', router);
    assert.equal((await get(app, '/orgs/acme/users/alice')).status, 200);
    assert.equal((await get(app, '/orgs/other/users/bob')).status, 429);
  });

  it('uses per-path quotas when includeRoute is true in global middleware', async (t) => {
    const { app, limiter } = createApp(t, { limit: 1, includeRoute: true });
    app.use(limiter);
    app.get('/users/:name', (req, res) => res.sendStatus(200));
    assert.equal((await get(app, '/users/alice')).status, 200);
    assert.equal((await get(app, '/users/bob')).status, 200);
    assert.equal((await get(app, '/users/alice')).status, 429);
  });

  it('uses a custom normalizer for global route quotas by default', async (t) => {
    const { app, limiter } = createApp(t, {
      limit: 1,
      routeNormalizer: req => req.path.startsWith('/users/') ? '/users/:name' : '/other'
    });
    app.use(limiter);
    app.get('/users/:name', (req, res) => res.sendStatus(200));
    app.get('/other', (req, res) => res.sendStatus(200));
    assert.equal((await get(app, '/users/alice')).status, 200);
    assert.equal((await get(app, '/users/bob')).status, 429);
    assert.equal((await get(app, '/other')).status, 200);
  });

  it('lets includeRoute false override a custom normalizer and retains route labels for metrics', async (t) => {
    const collector = new MetricsCollector();
    const { app, limiter } = createApp(t, { limit: 1, includeRoute: false, routeNormalizer: req => req.path, metricsCollector: collector });
    app.use(limiter);
    app.get('/one', (req, res) => res.sendStatus(200));
    app.get('/two', (req, res) => res.sendStatus(200));
    assert.equal((await get(app, '/one')).status, 200);
    assert.equal((await get(app, '/two')).status, 429);
    const entries = collector.getSnapshot().counters.smartrate_requests_total;
    assert.ok(entries.some(e => e.labels.normalized_route === '/two' && e.labels.outcome === 'blocked'));
  });

  it('rejects non-boolean includeRoute values', () => {
    for (const value of ['false', 0, null]) {
      assert.throws(() => rateLimiter({ limit: 1, windowMs: 1000, includeRoute: value }), /includeRoute.*boolean/);
    }
  });
});
