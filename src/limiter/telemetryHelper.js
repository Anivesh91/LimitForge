import { MemoryStore } from '../stores/memoryStore.js';
import { RedisStore } from '../stores/redisStore.js';
import { CircuitBreakerOpenError, StoreTimeoutError } from '../resilience/errors.js';

export function safeTelemetry(fn) {
  try {
    fn();
  } catch {
    // safe telemetry boundary
  }
}

export function classifyStoreError(err) {
  if (err instanceof StoreTimeoutError) return 'timeout';
  if (err instanceof CircuitBreakerOpenError) return 'circuit_open';
  if (err?.code === 'ECONNREFUSED') return 'econnrefused';
  return 'store_error';
}

export function resolveStoreLabels(store, isResilient) {
  const defaultStoreLabel = isResilient
    ? 'resilient'
    : (store instanceof RedisStore ? 'redis' : (store instanceof MemoryStore ? 'memory' : 'custom'));
  const primaryStore = isResilient ? store.primaryStore : store;
  const primaryStoreLabel = primaryStore instanceof RedisStore
    ? 'redis'
    : (primaryStore instanceof MemoryStore ? 'memory' : (primaryStore?.name || 'primary'));

  return { defaultStoreLabel, primaryStoreLabel, primaryStore };
}

export function activeStoreLabel(result, defaultStoreLabel) {
  return result.store || (result.fallbackUsed ? 'fallback' : defaultStoreLabel);
}

export function startRequestSpan(otelBridge, req, algorithm) {
  if (!otelBridge) return null;
  let childSpan = null;
  safeTelemetry(() => {
    if (typeof otelBridge.startSpan === 'function') {
      childSpan = otelBridge.startSpan('limitforge.consume', {
        attributes: {
          'limitforge.algorithm': algorithm,
          'ratelimit.algorithm': algorithm
        }
      });
      if (childSpan) {
        req._limitForgeSpan = childSpan;
      }
    }
  });
  return childSpan;
}

export function endSpanSafely(span) {
  if (!span) return;
  safeTelemetry(() => {
    if (typeof span.end === 'function') {
      span.end();
    }
  });
}

export function recordStoreTiming({ collector, startNs, storeLabel }) {
  if (!collector || startNs <= 0) return;
  const durationSec = Number(process.hrtime.bigint() - startNs) / 1e9;
  safeTelemetry(() => collector.recordStoreDuration(durationSec, { store: storeLabel }));
}

export function recordOutcomeTelemetry({
  collector,
  otelBridge,
  req,
  result,
  algorithm,
  method,
  normalizedRoute,
  storeLabel,
  primaryStoreLabel
}) {
  if (collector) {
    safeTelemetry(() => {
      if (result.degraded) {
        collector.recordDegradedRequest({ reason: result.primaryError?.name || 'fallback' });
        if (result.primaryError) {
          collector.recordStoreError({
            store: primaryStoreLabel,
            error_type: classifyStoreError(result.primaryError)
          });
        }
      }
      collector.recordRequest({
        outcome: result.allowed ? 'allowed' : 'blocked',
        algorithm,
        method,
        normalized_route: normalizedRoute,
        store: storeLabel
      });
    });
  }

  if (otelBridge) {
    safeTelemetry(() => {
      if (result.degraded && result.primaryError) {
        otelBridge.recordStoreError({ req, storeError: result.primaryError, store: primaryStoreLabel });
      }
      otelBridge.recordEvaluation({
        req,
        result,
        algorithm,
        normalizedRoute,
        store: storeLabel
      });
    });
  }
}

export function recordFailureTelemetry({
  collector,
  otelBridge,
  req,
  storeError,
  onStoreError,
  algorithm,
  method,
  normalizedRoute,
  storeLabel
}) {
  if (collector) {
    safeTelemetry(() => {
      const errorType = classifyStoreError(storeError);
      collector.recordStoreError({ store: storeLabel, error_type: errorType });
      collector.recordDegradedRequest({ reason: errorType });

      if (onStoreError === 'fail-open' || onStoreError === 'fail-closed') {
        collector.recordRequest({
          outcome: onStoreError === 'fail-open' ? 'allowed' : 'blocked',
          algorithm,
          method,
          normalized_route: normalizedRoute,
          store: storeLabel
        });
      }
    });
  }

  if (otelBridge) {
    safeTelemetry(() => {
      otelBridge.recordStoreError({ req, storeError, store: storeLabel });
      if (onStoreError === 'fail-open' || onStoreError === 'fail-closed') {
        otelBridge.recordEvaluation({
          req,
          result: {
            allowed: onStoreError === 'fail-open',
            remaining: 0,
            reset: 30,
            retryAfter: 30
          },
          algorithm,
          normalizedRoute,
          store: storeLabel
        });
      }
    });
  }
}
