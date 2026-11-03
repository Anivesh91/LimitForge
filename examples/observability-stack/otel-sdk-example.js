/**
 * LimitForge — Real OpenTelemetry SDK Integration Example
 *
 * Demonstrates wiring LimitForge's OpenTelemetryBridge directly into
 * the official OpenTelemetry Node.js SDK (@opentelemetry/sdk-node).
 *
 * Required dependencies for production tracing:
 *   npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/sdk-trace-base
 *
 * Run:
 *   node examples/observability-stack/otel-sdk-example.js
 */

import express from 'express';
import { rateLimiter, OpenTelemetryBridge, MemoryStore } from '../../src/index.js';

async function bootstrap() {
  let tracer = null;
  let getActiveSpan = null;

  try {
    const { trace } = await import('@opentelemetry/api');
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { ConsoleSpanExporter, SimpleSpanProcessor } = await import('@opentelemetry/sdk-trace-base');

    const sdk = new NodeSDK({
      spanProcessor: new SimpleSpanProcessor(new ConsoleSpanExporter())
    });

    sdk.start();
    tracer = trace.getTracer('limitforge-service', '8.0.1');
    getActiveSpan = () => trace.getActiveSpan();
    console.log('[OpenTelemetry] Official Node SDK initialized with ConsoleSpanExporter.');
  } catch {
    console.warn('[OpenTelemetry] @opentelemetry/sdk-node is not installed in demo devDependencies.');
    console.warn('[OpenTelemetry] Falling back to duck-typed active span provider.');
  }

  const app = express();

  // Wire LimitForge bridge with OpenTelemetry tracer
  const otelBridge = new OpenTelemetryBridge({
    tracer,
    getSpan: (req) => (getActiveSpan ? getActiveSpan() : req.telemetrySpan)
  });

  // Request span lifecycle middleware
  app.use((req, res, next) => {
    if (tracer) {
      tracer.startActiveSpan(`${req.method} ${req.baseUrl || req.path}`, (span) => {
        res.on('finish', () => span.end());
        next();
      });
    } else {
      req.telemetrySpan = {
        attributes: {},
        events: [],
        setAttribute(k, v) { this.attributes[k] = v; },
        addEvent(name, attrs) { this.events.push({ name, attrs }); },
        recordException(err) { this.events.push({ name: 'exception', message: err.message }); }
      };
      next();
    }
  });

  // Apply LimitForge rate limiter with OpenTelemetry integration
  app.use(
    '/api',
    rateLimiter({
      limit: 10,
      windowMs: 15000,
      store: new MemoryStore(),
      openTelemetry: otelBridge
    })
  );

  app.get('/api/data', (req, res) => {
    res.json({
      status: 'ok',
      message: 'Request successful. Check console for emitted telemetry span.'
    });
  });

  const PORT = process.env.OTEL_EXAMPLE_PORT || 3002;
  if (process.env.NODE_ENV !== 'test') {
    app.listen(PORT, () => {
      console.log(`[LimitForge] OpenTelemetry example server running on http://localhost:${PORT}`);
    });
  }

  return app;
}

export default bootstrap;

if (process.env.NODE_ENV !== 'test') {
  bootstrap().catch(console.error);
}
