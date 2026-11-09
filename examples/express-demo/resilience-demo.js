import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import {
  rateLimiter,
  ResilientStore,
  MemoryStore,
  CIRCUIT_STATE
} from '../../src/index.js';

const app = express();
const PORT = Number(process.env.DEMO_PORT || 3004);

app.use(express.json());

class SimulatedRedisStore {
  constructor() {
    this.healthy = true;
    this.timeoutMode = false;
    this.calls = 0;
    this.state = new Map();
  }

  setHealthy(status) {
    this.healthy = status;
    this.timeoutMode = false;
  }

  setTimeoutMode(status) {
    this.timeoutMode = status;
  }

  async consume(params) {
    this.calls++;

    if (this.timeoutMode) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    if (!this.healthy) {
      throw new Error('Redis connection ECONNREFUSED: 127.0.0.1:6379');
    }

    const { key, limit, windowMs } = params;
    const now = Date.now();
    let record = this.state.get(key);

    if (!record || now >= record.resetTime) {
      record = { count: 0, resetTime: now + windowMs };
    }

    if (record.count >= limit) {
      const retryAfter = Math.max(1, Math.ceil((record.resetTime - now) / 1000));
      return {
        allowed: false,
        limit,
        remaining: 0,
        reset: Math.ceil(record.resetTime / 1000),
        retryAfter
      };
    }

    record.count++;
    this.state.set(key, record);
    return {
      allowed: true,
      limit,
      remaining: limit - record.count,
      reset: Math.ceil(record.resetTime / 1000),
      retryAfter: 0
    };
  }
}

const simulatedRedis = new SimulatedRedisStore();
const fallbackStore = new MemoryStore();

const resilientStore = new ResilientStore({
  primaryStore: simulatedRedis,
  fallbackStore,
  timeoutMs: 100,
  failureThreshold: 3,
  resetTimeoutMs: 1200
});

resilientStore.on('stateChange', (evt) => {
  console.log(`  [breaker] stateChange ${evt.from} -> ${evt.to}`);
});
resilientStore.on('circuitOpen', () => {
  console.log(`  [breaker] OPEN (bypassing primary for ${resilientStore.circuitBreaker.resetTimeoutMs}ms)`);
});
resilientStore.on('probe', () => {
  console.log('  [breaker] HALF_OPEN: running canary probe');
});
resilientStore.on('circuitClose', () => {
  console.log('  [breaker] CLOSED: primary store recovered');
});
resilientStore.on('fallback', (evt) => {
  console.log(`  [fallback] using local memory store (${evt.error.message})`);
});

const DEMO_LIMIT = 4;
const DEMO_WINDOW_MS = 60000;

app.get(
  '/api/resilient',
  rateLimiter({
    store: resilientStore,
    limit: DEMO_LIMIT,
    windowMs: DEMO_WINDOW_MS
  }),
  (req, res) => {
    res.json({
      success: true,
      message: 'Request allowed',
      quota: {
        limit: res.get('ratelimit-limit'),
        remaining: res.get('ratelimit-remaining'),
        reset: res.get('ratelimit-reset'),
        degraded: res.get('ratelimit-degraded') || 'false'
      },
      metadata: req.rateLimit || {},
      circuitState: resilientStore.circuitBreaker.getState()
    });
  }
);

app.get('/', (req, res) => {
  res.json({
    title: 'LimitForge — Resilience & Store Fault Tolerance Demo',
    description: 'Demonstrates timeout guard, circuit breaker, dual-store fallback, and canary recovery.',
    configuration: {
      primaryStore: 'SimulatedRedisStore',
      fallbackStore: 'MemoryStore',
      timeoutMs: 100,
      failureThreshold: 3,
      resetTimeoutMs: 1200,
      limit: DEMO_LIMIT,
      windowMs: DEMO_WINDOW_MS
    },
    endpoints: [
      {
        path: '/api/resilient',
        method: 'GET',
        description: 'Enforces rate limits backed by ResilientStore with automatic fallback and degraded tagging.'
      }
    ],
    curlExample: `curl -i http://localhost:${PORT}/api/resilient`
  });
});

const server = app.listen(PORT, async () => {
  console.log(`LimitForge resilience demo listening on http://localhost:${PORT}`);
  console.log('Store: ResilientStore (threshold=3, reset=1200ms, timeout=100ms)\n');

  try {
    await runSimulation();
  } catch (error) {
    console.error('Simulation failed:', error);
    server.close(() => process.exit(1));
  }
});

async function makeRequest(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let body = {};
        try { body = JSON.parse(data); } catch { body = data; }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body
        });
      });
    }).on('error', reject);
  });
}

async function runSimulation() {
  const assertions = [];

  console.log('[1/6] Healthy primary store (CLOSED)');
  simulatedRedis.setHealthy(true);

  const resHealthy = await makeRequest('/api/resilient');
  console.log(
    `  HTTP ${resHealthy.status} | breaker=${resHealthy.body.circuitState} | remaining=${resHealthy.headers['ratelimit-remaining']} | degraded=${resHealthy.headers['ratelimit-degraded'] || 'false'}`
  );
  assertions.push({
    name: 'Stage 1 Healthy',
    pass: resHealthy.status === 200 && resHealthy.headers['ratelimit-degraded'] === undefined
  });

  console.log('\n[2/6] Simulating Redis outage (ECONNREFUSED)');
  simulatedRedis.setHealthy(false);

  for (let i = 1; i <= 3; i++) {
    const resFail = await makeRequest('/api/resilient');
    console.log(
      `  failure #${i}: HTTP ${resFail.status} | degraded=${resFail.headers['ratelimit-degraded']} | breaker=${resFail.body.circuitState}`
    );
    assertions.push({
      name: `Stage 2 Outage Request #${i}`,
      pass: resFail.status === 200 && resFail.headers['ratelimit-degraded'] === 'true'
    });
  }

  console.log('\n[3/6] Circuit breaker OPEN (primary bypassed)');
  const initialCalls = simulatedRedis.calls;
  const resOpen = await makeRequest('/api/resilient');
  const callsDuringOpen = simulatedRedis.calls - initialCalls;

  console.log(
    `  HTTP ${resOpen.status} | breaker=${resOpen.body.circuitState} | degraded=${resOpen.headers['ratelimit-degraded']} | primaryCalls=${callsDuringOpen}`
  );
  assertions.push({
    name: 'Stage 3 Breaker OPEN Zero Hammering',
    pass: resOpen.status === 200 &&
          resOpen.body.circuitState === CIRCUIT_STATE.OPEN &&
          resOpen.headers['ratelimit-degraded'] === 'true' &&
          callsDuringOpen === 0
  });

  console.log('\n[4/6] Exhausting local fallback quota');
  let blockedRes = null;
  for (let i = 0; i < 5; i++) {
    const r = await makeRequest('/api/resilient');
    if (r.status === 429) {
      blockedRes = r;
      console.log(
        `  HTTP 429 | retry-after=${r.headers['retry-after']}s | degraded=${r.headers['ratelimit-degraded']}`
      );
      break;
    }
  }

  assertions.push({
    name: 'Stage 4 Local Quota 429 Protection',
    pass: blockedRes !== null && blockedRes.status === 429 && blockedRes.headers['ratelimit-degraded'] === 'true'
  });

  console.log('\n[5/6] Restoring primary store and waiting for cooldown (1.3s)');
  simulatedRedis.setHealthy(true);
  await new Promise((resolve) => setTimeout(resolve, 1300));

  console.log('[6/6] Running canary probe (HALF_OPEN -> CLOSED)');
  const resRecovered = await makeRequest('/api/resilient');
  console.log(
    `  HTTP ${resRecovered.status} | breaker=${resRecovered.body.circuitState} | degraded=${resRecovered.headers['ratelimit-degraded'] || 'false'}`
  );

  assertions.push({
    name: 'Stage 5 Canary Recovery',
    pass: resRecovered.status === 200 &&
          resRecovered.body.circuitState === CIRCUIT_STATE.CLOSED &&
          resRecovered.headers['ratelimit-degraded'] === undefined
  });

  console.log('\nSummary:');
  let allPassed = true;
  for (const a of assertions) {
    if (a.pass) {
      console.log(`  PASS: ${a.name}`);
    } else {
      console.error(`  FAIL: ${a.name}`);
      allPassed = false;
    }
  }

  if (!allPassed) {
    server.close(() => process.exit(1));
    return;
  }

  if (process.env.DEMO_AUTOCLOSE === 'true') {
    server.close(() => process.exit(0));
  }
}

function handleShutdown(signal) {
  console.log(`\n[${signal}] Shutting down...`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
