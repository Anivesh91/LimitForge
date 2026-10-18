import express from 'express';
import {
  rateLimiter,
  createPrometheusExporter,
  defaultMetricsCollector,
  OpenTelemetryBridge
} from '../../src/index.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// simulated opentelemetry span injection middleware
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

// sensitive login route protected by token bucket
const authLimiter = rateLimiter({
  capacity: 3,
  refillRate: 1,
  refillIntervalMs: 5000,
  algorithm: 'token-bucket',
  metrics: true,
  openTelemetry: otelBridge
});

// routes
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

// prometheus scrape endpoint
app.get('/metrics', createPrometheusExporter());

// healthcheck
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', uptime: process.uptime() });
});

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  app.listen(PORT, () => {
    console.log('================================================================================');
    console.log(`   LimitForge V7 — Observability & Prometheus Demo Server`);
    console.log('================================================================================');
    console.log(`• Listening on:            http://localhost:${PORT}`);
    console.log(`• Prometheus /metrics:    http://localhost:${PORT}/metrics`);
    console.log(`• Protected API Route:     http://localhost:${PORT}/api/users/42`);
    console.log(`• Protected Auth Route:    POST http://localhost:${PORT}/api/auth/login`);
    console.log('--------------------------------------------------------------------------------');
    console.log('Test with curl commands:');
    console.log(`  curl http://localhost:${PORT}/api/users/42`);
    console.log(`  curl http://localhost:${PORT}/metrics\n`);
  });
}

export default app;
