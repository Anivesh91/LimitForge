import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  rateLimiter,
  createPrometheusExporter,
  OpenTelemetryBridge
} from '../../src/index.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const otelBridge = new OpenTelemetryBridge({
  getSpan: (req) => req.telemetrySpan
});

app.use((req, res, next) => {
  req.telemetrySpan = {
    attributes: {},
    events: [],
    setAttribute(k, v) {
      this.attributes[k] = v;
    },
    addEvent(name, attrs) {
      this.events.push({ name, attrs });
    }
  };
  next();
});

const apiLimiter = rateLimiter({
  limit: 5,
  windowMs: 30000,
  algorithm: 'sliding-window',
  metrics: true,
  openTelemetry: otelBridge
});

const authLimiter = rateLimiter({
  capacity: 3,
  refillRate: 1,
  refillIntervalMs: 5000,
  algorithm: 'token-bucket',
  metrics: true,
  openTelemetry: otelBridge
});

app.get('/api/users/:id', apiLimiter, (req, res) => {
  res.json({
    success: true,
    user: { id: req.params.id, name: 'Alice Developer' },
    message: 'Request allowed by LimitForge Sliding Window'
  });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  res.json({
    success: true,
    message: 'Authentication successful. Consumed 1 token from bucket.'
  });
});

app.get('/metrics', createPrometheusExporter());

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', uptime: process.uptime() });
});

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  app.listen(PORT, () => {
    console.log(`LimitForge observability demo listening on http://localhost:${PORT}`);
    console.log(`  GET  http://localhost:${PORT}/api/users/42`);
    console.log(`  POST http://localhost:${PORT}/api/auth/login`);
    console.log(`  GET  http://localhost:${PORT}/metrics`);
  });
}

export default app;
