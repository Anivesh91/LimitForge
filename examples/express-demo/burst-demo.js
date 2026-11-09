import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import { rateLimiter, MemoryStore } from '../../src/index.js';

const app = express();
const PORT = Number(process.env.DEMO_PORT || 3003);

app.set('trust proxy', true);
app.use(express.json());

const store = new MemoryStore();
const BURST_CAPACITY = 5;
const REFILL_RATE = 1;
const REFILL_INTERVAL_MS = 1000;

app.get(
  '/api/burst',
  rateLimiter({
    algorithm: 'token-bucket',
    capacity: BURST_CAPACITY,
    refillRate: REFILL_RATE,
    refillIntervalMs: REFILL_INTERVAL_MS,
    store
  }),
  (req, res) => {
    res.json({
      success: true,
      message: 'Request allowed under Token Bucket burst quota',
      quota: {
        limit: res.get('ratelimit-limit'),
        remaining: res.get('ratelimit-remaining'),
        reset: res.get('ratelimit-reset')
      },
      timestamp: new Date().toISOString()
    });
  }
);

app.get('/', (req, res) => {
  res.json({
    title: 'LimitForge — Token Bucket & Burst Control Demo',
    description: 'Demonstrates burst tolerance combined with continuous, smooth rate-limiting refill.',
    configuration: {
      algorithm: 'token-bucket',
      capacity: BURST_CAPACITY,
      refillRate: REFILL_RATE,
      refillIntervalMs: REFILL_INTERVAL_MS,
      rule: `${BURST_CAPACITY} requests burst capacity, refilling smoothly at ${REFILL_RATE} token per ${REFILL_INTERVAL_MS}ms`
    },
    endpoints: [
      {
        path: '/api/burst',
        method: 'GET',
        description: 'Enforces Token Bucket rate limiting with burst allowance and smart Retry-After headers.'
      }
    ],
    curlExample: `curl -i http://localhost:${PORT}/api/burst`
  });
});

const server = app.listen(PORT, async () => {
  console.log(`LimitForge Token Bucket demo listening on http://localhost:${PORT}`);
  console.log(`Policy: capacity=${BURST_CAPACITY}, refill=${REFILL_RATE} token / ${REFILL_INTERVAL_MS}ms\n`);

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
  console.log(`[1/4] Firing burst of ${BURST_CAPACITY} requests`);
  const burstStatuses = [];

  for (let i = 1; i <= BURST_CAPACITY; i++) {
    const res = await makeRequest('/api/burst');
    burstStatuses.push(res.status);
    console.log(
      `  req #${i}: HTTP ${res.status} | remaining=${res.headers['ratelimit-remaining']} | reset=${res.headers['ratelimit-reset']}s`
    );
  }

  console.log(`\n[2/4] Firing request #${BURST_CAPACITY + 1} (exhausted bucket)`);
  const blocked = await makeRequest('/api/burst');
  console.log(
    `  req #${BURST_CAPACITY + 1}: HTTP ${blocked.status} | remaining=${blocked.headers['ratelimit-remaining']} | retry-after=${blocked.headers['retry-after']}s | reset=${blocked.headers['ratelimit-reset']}s`
  );
  console.log(`  payload: ${JSON.stringify(blocked.body)}`);

  const retrySec = Number(blocked.headers['retry-after'] || 1);
  console.log(`\n[3/4] Waiting ${retrySec}s for token refill`);
  await new Promise((resolve) => setTimeout(resolve, retrySec * 1000 + 100));

  console.log(`[4/4] Retrying request #${BURST_CAPACITY + 2}`);
  const recovered = await makeRequest('/api/burst');
  console.log(
    `  req #${BURST_CAPACITY + 2}: HTTP ${recovered.status} | remaining=${recovered.headers['ratelimit-remaining']} | reset=${recovered.headers['ratelimit-reset']}s`
  );

  const actualStatuses = [...burstStatuses, blocked.status, recovered.status];
  const expectedStatuses = [...Array(BURST_CAPACITY).fill(200), 429, 200];
  const failedRequest = actualStatuses.findIndex((status, index) => status !== expectedStatuses[index]);
  if (failedRequest !== -1) {
    console.error(
      `Simulation failed at request #${failedRequest + 1}: expected ${expectedStatuses[failedRequest]}, got ${actualStatuses[failedRequest]}`
    );
    server.close(() => process.exit(1));
    return;
  }

  console.log(`\nSimulation complete. Test manually: curl -i http://localhost:${PORT}/api/burst\n`);

  if (process.env.DEMO_AUTOCLOSE === 'true') {
    server.close(() => {
      process.exit(0);
    });
  }
}

function handleShutdown(signal) {
  console.log(`\n[${signal}] Shutting down...`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
