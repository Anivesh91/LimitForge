import express from 'express';
import { createClient } from 'redis';
import {
  rateLimiter,
  RedisStore,
  MemoryStore,
  ResilientStore,
  CircuitBreaker,
  createPrometheusExporter,
  defaultMetricsCollector,
  OpenTelemetryBridge
} from '../../src/index.js';

const app = express();
const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

app.use(express.json());

// setup opentelemetry bridge
const otelBridge = new OpenTelemetryBridge({
  getSpan: (req) => req.telemetrySpan
});

app.use((req, res, next) => {
  req.telemetrySpan = {
    attributes: {},
    events: [],
    setAttribute(k, v) { this.attributes[k] = v; },
    addEvent(name, attrs) { this.events.push({ name, attrs }); },
    recordException(err) { this.events.push({ name: 'exception', error: err.message }); }
  };
  next();
});

// setup redis primary store with fallback capability
let chaosActive = false;
let redisClient = null;

try {
  redisClient = createClient({ url: REDIS_URL });
  redisClient.on('error', (err) => {
    // expected during offline chaos states
  });
  await redisClient.connect().catch(() => {});
} catch {
}

const primaryRedisStore = new RedisStore({ client: redisClient });

const primaryStoreWrapper = {
  name: 'redis',
  async consume(params) {
    if (chaosActive || !redisClient || !redisClient.isOpen) {
      const error = new Error('Chaos Injection: Redis cluster unreachable (ECONNREFUSED)');
      error.code = 'ECONNREFUSED';
      throw error;
    }
    return primaryRedisStore.consume(params);
  }
};

const resilientStore = new ResilientStore({
  primaryStore: primaryStoreWrapper,
  fallbackStore: new MemoryStore(),
  circuitBreaker: new CircuitBreaker({
    failureThreshold: 3,
    resetTimeoutMs: 10000,
    id: 'redis-resilience'
  }),
  timeoutMs: 250
});

// rate limiters
const publicLimiter = rateLimiter({
  limit: 20,
  windowMs: 15000,
  algorithm: 'fixed-window',
  store: resilientStore,
  metrics: true,
  openTelemetry: otelBridge
});

const userLimiter = rateLimiter({
  limit: 8,
  windowMs: 10000,
  algorithm: 'sliding-window',
  store: resilientStore,
  metrics: true,
  openTelemetry: otelBridge
});

const loginLimiter = rateLimiter({
  capacity: 4,
  refillRate: 1,
  refillIntervalMs: 2000,
  algorithm: 'token-bucket',
  store: resilientStore,
  metrics: true,
  openTelemetry: otelBridge,
  breakerId: 'auth-bucket'
});

// api routes
app.get('/api/public', publicLimiter, (req, res) => {
  res.json({
    success: true,
    data: 'Public resource response',
    timestamp: Date.now()
  });
});

app.get('/api/users/:id', userLimiter, (req, res) => {
  res.json({
    success: true,
    user: { id: req.params.id, name: `User ${req.params.id}` },
    policy: 'sliding-window (8 req / 10s)'
  });
});

app.post('/api/auth/login', loginLimiter, (req, res) => {
  res.json({
    success: true,
    message: 'Login successful. 1 token consumed from Token Bucket.'
  });
});

const checkChaosAllowed = (req, res, next) => {
  if (process.env.NODE_ENV === 'production' && !process.env.ALLOW_CHAOS) {
    return res.status(403).json({ error: 'Chaos testing is disabled in production' });
  }
  const secret = process.env.CHAOS_SECRET;
  if (secret && req.headers['x-chaos-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized: Invalid x-chaos-secret' });
  }
  next();
};

app.post('/api/chaos/break-store', checkChaosAllowed, (req, res) => {
  chaosActive = true;
  res.json({
    status: 'chaos_activated',
    message: 'Primary store failing now. SmartRate will switch to fallback memory and trip circuit breaker.'
  });
});

app.post('/api/chaos/heal-store', checkChaosAllowed, (req, res) => {
  chaosActive = false;
  res.json({
    status: 'chaos_deactivated',
    message: 'Primary store restored. Circuit breaker can probe and recover.'
  });
});

// prometheus exporter endpoint
app.get('/metrics', createPrometheusExporter());

// healthcheck
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    chaosActive,
    circuitBreaker: resilientStore.getStats().circuitBreaker
  });
});

// global error handler
app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log('================================================================================');
    console.log('   SmartRate V7 — Production Observability Demo Stack');
    console.log('================================================================================');
    console.log(`• Express Server:       http://localhost:${PORT}`);
    console.log(`• Prometheus Metrics:   http://localhost:${PORT}/metrics`);
    console.log(`• Prometheus Server:    http://localhost:9090`);
    console.log(`• Grafana Dashboard:    http://localhost:3001 (admin / admin)`);
    console.log('--------------------------------------------------------------------------------');
    console.log('Active Routes:');
    console.log('  GET  /api/public        (Fixed Window: 20 req / 15s)');
    console.log('  GET  /api/users/:id     (Sliding Window: 8 req / 10s)');
    console.log('  POST /api/auth/login    (Token Bucket: 4 capacity, refill 1 / 2s)');
    console.log('  POST /api/chaos/break-store (Simulate Redis Outage)');
    console.log('  POST /api/chaos/heal-store  (Restore Redis Store)');
    console.log('================================================================================\n');
  });
}

export default app;
