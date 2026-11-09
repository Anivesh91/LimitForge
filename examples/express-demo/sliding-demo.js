import 'dotenv/config';
import express from 'express';
import { rateLimiter, MemoryStore } from '../../src/index.js';

const app = express();
const PORT = Number(process.env.DEMO_PORT || 3002);

app.set('trust proxy', true);
app.use(express.json());

const memoryStore = new MemoryStore();

app.get(
  '/api/fixed',
  rateLimiter({
    algorithm: 'fixed-window',
    limit: 5,
    windowMs: 10_000,
    store: memoryStore
  }),
  (req, res) => {
    res.json({
      success: true,
      algorithm: 'fixed-window',
      message: 'Request allowed under Fixed Window policy (5 req / 10s)',
      timestamp: new Date().toISOString()
    });
  }
);

app.get(
  '/api/sliding',
  rateLimiter({
    algorithm: 'sliding-window',
    limit: 5,
    windowMs: 10_000,
    store: memoryStore
  }),
  (req, res) => {
    res.json({
      success: true,
      algorithm: 'sliding-window',
      message: 'Request allowed under Rolling Sliding Window policy (5 req / 10s)',
      timestamp: new Date().toISOString()
    });
  }
);

app.get('/', (req, res) => {
  res.json({
    title: 'LimitForge — Algorithm Comparison Demo',
    endpoints: [
      {
        path: '/api/fixed',
        algorithm: 'fixed-window',
        limit: 5,
        windowMs: 10000,
        note: 'Fixed window permits edge bursts across boundary rollovers'
      },
      {
        path: '/api/sliding',
        algorithm: 'sliding-window',
        limit: 5,
        windowMs: 10000,
        note: 'Rolling window enforces at most 5 requests over any 10s interval'
      }
    ]
  });
});

let server;

export function startDemoServer(port = PORT) {
  return new Promise((resolve) => {
    server = app.listen(port, () => {
      console.log(`LimitForge comparison demo listening on http://localhost:${port}`);
      console.log(`  GET /api/fixed   -> fixed-window (5 req / 10s)`);
      console.log(`  GET /api/sliding -> sliding-window (5 req / 10s)`);
      resolve(server);
    });
  });
}

if (process.argv[1] && process.argv[1].endsWith('sliding-demo.js')) {
  startDemoServer();
}

export default app;
