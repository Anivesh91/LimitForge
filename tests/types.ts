import express, { Request, Response, NextFunction } from 'express';
import {
  rateLimiter,
  MemoryStore,
  RedisStore,
  ResilientStore,
  CircuitBreaker,
  OpenTelemetryBridge,
  MetricsCollector,
  defaultMetricsCollector,
  StoreTimeoutError,
  CircuitBreakerOpenError,
  buildRateLimitKey,
  normalizeRoute,
  sanitizePath,
  withTimeout,
  createPrometheusExporter,
  formatPrometheusMetrics,
  MAX_IDENTIFIER_LENGTH,
  CIRCUIT_STATE,
  METRIC_NAMES
} from 'limitforge';

const app = express();

// 1. Basic Rate Limiter
const basicLimiter = rateLimiter({
  limit: 10,
  windowMs: 60000,
  prefix: 'my-service'
});
app.use(basicLimiter);

// 2. Comprehensive Rate Limiter with all options
const memStore = new MemoryStore({ cleanupIntervalMs: 30000 });
const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 5000, breakerId: 'cb-1' });

const collector = new MetricsCollector();
collector.recordStoreDuration(0.125, { store: 'redis' });
collector.recordStoreDuration(0.125);
// @ts-expect-error duration must be a number in seconds
collector.recordStoreDuration({ store: 'redis', operation: 'get', outcome: 'success', duration_ms: 125 });
const otel = new OpenTelemetryBridge();

const fullLimiter = rateLimiter({
  limit: (req: Request) => 50,
  windowMs: (req: Request) => 60000,
  algorithm: 'token-bucket',
  capacity: 20,
  refillRate: 5,
  refillIntervalMs: 1000,
  cost: (req: Request) => 1,
  store: memStore,
  fallbackStore: true,
  prefix: 'api-gateway',
  circuitBreaker: cb,
  failureThreshold: 5,
  resetTimeoutMs: 10000,
  successThreshold: 2,
  breakerId: 'breaker-main',
  failStrategy: 'fail-open',
  onStoreError: 'fail-closed',
  metrics: collector,
  metricsCollector: collector,
  routeNormalizer: (req: Request) => '/normalized',
  includeRoute: true,
  standardHeaders: false,
  openTelemetry: otel,
  statusCode: 429,
  message: { error: 'Quota exceeded' },
  skip: (req: Request) => req.path === '/health',
  keyGenerator: (req: Request) => req.headers['x-api-key'] as string
});
app.use('/api', fullLimiter);

// 3. RedisStore & ResilientStore
const mockClient = {
  eval: async () => [1, 60000],
  sendCommand: async () => 'OK'
};
const redisStore = new RedisStore({ client: mockClient, prefix: 'redis-prefix' });

const resilient = new ResilientStore({
  primaryStore: redisStore,
  fallbackStore: memStore,
  circuitBreaker: cb,
  timeoutMs: 300
});

const activeBreaker: CircuitBreaker | null = resilient.circuitBreaker;
const aliasBreaker: CircuitBreaker | null = resilient.breaker;

// 4. Utility Functions
const key: string = buildRateLimitKey({
  prefix: 'test',
  method: 'GET',
  route: '/items',
  clientIdentifier: '127.0.0.1'
});

const reqMock = { baseUrl: '/api', route: { path: '/items/:id' } } as unknown as Request;
const routeName: string = normalizeRoute(reqMock);
const sanitized: string = sanitizePath('/api/items/123');

// 5. Resilience & Errors
const timeoutErr = new StoreTimeoutError(250, 'timeout');
const cbErr = new CircuitBreakerOpenError('open', 5000);

// 6. Prometheus exporter
app.get('/metrics', createPrometheusExporter(collector));
app.get('/metrics-options', createPrometheusExporter({ collector }));
app.get('/metrics-alias', createPrometheusExporter({ metricsCollector: collector }));
app.get('/metrics-custom', createPrometheusExporter({ getSnapshot: () => ({}) }));
app.get('/metrics-default', createPrometheusExporter());
// @ts-expect-error collector must implement getSnapshot
createPrometheusExporter({ collector: {} });

console.log('TypeScript definitions test passed compilation!');
