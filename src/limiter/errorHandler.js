import { CircuitBreakerOpenError } from '../resilience/errors.js';
import { setDegradedHeader } from './response.js';
import { recordFailureTelemetry } from './telemetryHelper.js';

function computeRetryAfterSeconds(storeError, breaker) {
  if (storeError instanceof CircuitBreakerOpenError && typeof storeError.resetTimeoutMs === 'number') {
    return Math.max(1, Math.ceil(storeError.resetTimeoutMs / 1000));
  }
  if (breaker && breaker.isOpen()) {
    const remainingMs = Math.max(0, breaker.nextAttempt - Date.now());
    return Math.max(1, Math.ceil(remainingMs / 1000));
  }
  return 30;
}

export async function handleStoreFailure({
  storeError,
  req,
  res,
  next,
  onStoreError,
  breaker,
  collector,
  otelBridge,
  algorithm,
  method,
  normalizedRoute,
  storeLabel
}) {
  setDegradedHeader(res);
  req.rateLimit = { degraded: true, storeError };

  recordFailureTelemetry({
    collector,
    otelBridge,
    req,
    storeError,
    onStoreError,
    algorithm,
    method,
    normalizedRoute,
    storeLabel
  });

  if (onStoreError === 'fail-open') {
    return next();
  }

  if (onStoreError === 'fail-closed') {
    const retryAfterSeconds = computeRetryAfterSeconds(storeError, breaker);
    if (typeof res.setHeader === 'function' && !res.headersSent) {
      res.setHeader('Retry-After', String(retryAfterSeconds));
    }
    return res.status(503).json({
      success: false,
      error: 'Service Unavailable',
      message: 'Rate limiting service temporarily unavailable'
    });
  }

  if (typeof onStoreError === 'function') {
    return await onStoreError(storeError, req, res, next);
  }

  return next(storeError);
}
