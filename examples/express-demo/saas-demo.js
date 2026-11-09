import 'dotenv/config';
import express from 'express';
import { rateLimiter, MemoryStore } from '../../src/index.js';

const app = express();
const PORT = Number(process.env.SAAS_DEMO_PORT || 3005);

app.set('trust proxy', true);
app.use(express.json());

const memoryStore = new MemoryStore();

const API_KEY_REGISTRY = {
  ak_free_123: { name: 'Acme Starter', tier: 'free' },
  ak_pro_456: { name: 'Beta Scale', tier: 'pro' },
  ak_ent_789: { name: 'Global Enterprise', tier: 'enterprise' }
};

const TIER_POLICIES = {
  free: { capacity: 5, refillRate: 1 },
  pro: { capacity: 20, refillRate: 5 },
  enterprise: { capacity: 100, refillRate: 25 }
};

app.use((req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey && API_KEY_REGISTRY[apiKey]) {
    req.customer = API_KEY_REGISTRY[apiKey];
    req.apiKey = apiKey;
  } else {
    req.customer = { name: 'Anonymous Public', tier: 'free' };
    req.apiKey = req.ip || '127.0.0.1';
  }
  next();
});

const saasLimiter = rateLimiter({
  store: memoryStore,
  algorithm: 'token-bucket',
  keyGenerator: (req) => req.apiKey,
  capacity: (req) => TIER_POLICIES[req.customer?.tier || 'free'].capacity,
  refillRate: (req) => TIER_POLICIES[req.customer?.tier || 'free'].refillRate,
  cost: (req) => (req.path.includes('/export') || req.body?.heavy === true ? 5 : 1)
});

app.use('/api', saasLimiter);

app.get('/api/data', (req, res) => {
  res.json({
    success: true,
    message: 'Data retrieved successfully',
    customer: req.customer,
    endpoint: '/api/data',
    cost: '1 token',
    timestamp: new Date().toISOString()
  });
});

app.post('/api/export', (req, res) => {
  res.json({
    success: true,
    message: 'Heavy data export completed',
    customer: req.customer,
    endpoint: '/api/export',
    cost: '5 tokens',
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.json({
    title: 'LimitForge — SaaS Multi-Tier & Dynamic Policy Demo',
    tiers: {
      free: { apiKey: 'ak_free_123', ...TIER_POLICIES.free },
      pro: { apiKey: 'ak_pro_456', ...TIER_POLICIES.pro },
      enterprise: { apiKey: 'ak_ent_789', ...TIER_POLICIES.enterprise }
    },
    sampleRequests: [
      `curl -H "x-api-key: ak_free_123" http://localhost:${PORT}/api/data`,
      `curl -H "x-api-key: ak_pro_456" http://localhost:${PORT}/api/data`,
      `curl -X POST -H "x-api-key: ak_ent_789" http://localhost:${PORT}/api/export`
    ]
  });
});

let server;

export function startSaasDemoServer(port = PORT) {
  return new Promise((resolve) => {
    server = app.listen(port, () => {
      console.log(`LimitForge SaaS demo listening on http://localhost:${port}`);
      console.log('  Free:       x-api-key: ak_free_123 (cap 5, refill 1/s)');
      console.log('  Pro:        x-api-key: ak_pro_456  (cap 20, refill 5/s)');
      console.log('  Enterprise: x-api-key: ak_ent_789  (cap 100, refill 25/s)');
      console.log('  Routes:     GET /api/data (cost 1), POST /api/export (cost 5)');
      resolve(server);
    });
  });
}

if (process.argv[1] && process.argv[1].endsWith('saas-demo.js')) {
  startSaasDemoServer();
}

export { app };
