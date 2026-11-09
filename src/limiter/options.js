import { ResilientStore } from '../stores/resilientStore.js';
import { CircuitBreaker } from '../resilience/circuitBreaker.js';
import { defaultMetricsCollector } from '../telemetry/metricsCollector.js';
import { OpenTelemetryBridge } from '../telemetry/openTelemetryBridge.js';

export const SUPPORTED_ALGORITHMS = Object.freeze(['fixed-window', 'sliding-window', 'token-bucket']);
const VALID_STORE_ERROR_MODES = Object.freeze(['fail-open', 'fail-closed', 'error']);

const attachedBreakerCollectors = new WeakMap();

export const isPositiveInt = (val) => typeof val === 'number' && Number.isInteger(val) && val > 0;
export const isPositiveFinite = (val) => typeof val === 'number' && Number.isFinite(val) && val > 0;
const isNonEmptyString = (val) => typeof val === 'string' && val.trim().length > 0;

function validateBreakerThresholds({ failureThreshold, resetTimeoutMs, successThreshold }) {
  if (failureThreshold !== undefined && !isPositiveInt(failureThreshold)) {
    throw new RangeError(
      `LimitForge: CircuitBreaker 'failureThreshold' must be a positive integer (received: ${failureThreshold}).`
    );
  }
  if (resetTimeoutMs !== undefined && !isPositiveFinite(resetTimeoutMs)) {
    throw new RangeError(
      `LimitForge: CircuitBreaker 'resetTimeoutMs' must be a positive number in milliseconds (received: ${resetTimeoutMs}).`
    );
  }
  if (successThreshold !== undefined && !isPositiveInt(successThreshold)) {
    throw new RangeError(
      `LimitForge: CircuitBreaker 'successThreshold' must be a positive integer (received: ${successThreshold}).`
    );
  }
}

export function validateOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('LimitForge: Options must be an object.');
  }

  const {
    limit,
    windowMs,
    store,
    algorithm = 'fixed-window',
    keyGenerator,
    capacity,
    refillRate,
    refillIntervalMs,
    cost,
    timeoutMs,
    onStoreError,
    failStrategy,
    circuitBreaker,
    failureThreshold,
    resetTimeoutMs,
    successThreshold,
    fallbackStore,
    metrics,
    metricsCollector,
    routeNormalizer,
    includeRoute,
    openTelemetry,
    hashClientIdentifier,
    breakerId,
    prefix,
    skip,
    statusCode,
    standardHeaders
  } = options;

  if (prefix !== undefined && !isNonEmptyString(prefix)) {
    throw new TypeError("LimitForge: 'prefix' must be a non-empty string.");
  }
  if (skip !== undefined && typeof skip !== 'function') {
    throw new TypeError("LimitForge: 'skip' must be a function.");
  }
  if (statusCode !== undefined && (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599)) {
    throw new RangeError(`LimitForge: 'statusCode' must be a valid HTTP status code integer (received: ${statusCode}).`);
  }
  if (standardHeaders !== undefined && typeof standardHeaders !== 'boolean') {
    throw new TypeError("LimitForge: 'standardHeaders' must be a boolean.");
  }
  if (breakerId !== undefined && !isNonEmptyString(breakerId)) {
    throw new TypeError("LimitForge: 'breakerId' must be a non-empty string.");
  }
  if (hashClientIdentifier !== undefined && typeof hashClientIdentifier !== 'boolean' && typeof hashClientIdentifier !== 'function') {
    throw new TypeError("LimitForge: 'hashClientIdentifier' must be a boolean or a hash function.");
  }
  if (openTelemetry !== undefined && typeof openTelemetry !== 'boolean' && (typeof openTelemetry !== 'object' || openTelemetry === null)) {
    throw new TypeError("LimitForge: 'openTelemetry' must be a boolean, an options object, or an OpenTelemetryBridge instance.");
  }
  if (
    metrics !== undefined &&
    typeof metrics !== 'boolean' &&
    (typeof metrics !== 'object' || metrics === null || typeof metrics.recordRequest !== 'function')
  ) {
    throw new TypeError("LimitForge: 'metrics' must be a boolean or a MetricsCollector instance.");
  }
  if (
    metricsCollector !== undefined &&
    (typeof metricsCollector !== 'object' || metricsCollector === null || typeof metricsCollector.recordRequest !== 'function')
  ) {
    throw new TypeError("LimitForge: 'metricsCollector' must be an object implementing a recordRequest() method.");
  }
  if (routeNormalizer !== undefined && typeof routeNormalizer !== 'function') {
    throw new TypeError("LimitForge: 'routeNormalizer' must be a function.");
  }
  if (includeRoute !== undefined && typeof includeRoute !== 'boolean') {
    throw new TypeError("LimitForge: 'includeRoute' must be a boolean.");
  }
  if (
    fallbackStore !== undefined &&
    typeof fallbackStore !== 'boolean' &&
    (typeof fallbackStore !== 'object' || fallbackStore === null || typeof fallbackStore.consume !== 'function')
  ) {
    throw new TypeError("LimitForge: 'fallbackStore' must be a boolean or an object implementing a consume() method.");
  }
  if (timeoutMs !== undefined && !isPositiveFinite(timeoutMs)) {
    throw new RangeError(`LimitForge: 'timeoutMs' must be a positive number in milliseconds (received: ${timeoutMs}).`);
  }

  const effectiveStoreError = onStoreError !== undefined ? onStoreError : failStrategy;
  if (
    effectiveStoreError !== undefined &&
    typeof effectiveStoreError !== 'function' &&
    !VALID_STORE_ERROR_MODES.includes(effectiveStoreError)
  ) {
    throw new TypeError(
      `LimitForge: 'onStoreError' must be 'fail-open', 'fail-closed', 'error', or a function (received: ${effectiveStoreError}).`
    );
  }

  if (circuitBreaker !== undefined) {
    if (typeof circuitBreaker !== 'boolean' && (typeof circuitBreaker !== 'object' || circuitBreaker === null)) {
      throw new TypeError("LimitForge: 'circuitBreaker' must be a boolean, an options object, or a CircuitBreaker instance.");
    }
    if (typeof circuitBreaker === 'object' && !(circuitBreaker instanceof CircuitBreaker)) {
      validateBreakerThresholds(circuitBreaker);
    }
  }
  validateBreakerThresholds({ failureThreshold, resetTimeoutMs, successThreshold });

  if (keyGenerator !== undefined && typeof keyGenerator !== 'function') {
    throw new TypeError("LimitForge: 'keyGenerator' must be a function.");
  }
  if (typeof algorithm !== 'string' || !SUPPORTED_ALGORITHMS.includes(algorithm)) {
    throw new TypeError(
      `LimitForge: Unsupported algorithm '${algorithm}'. Supported algorithms: ${SUPPORTED_ALGORITHMS.join(', ')}.`
    );
  }

  if (algorithm === 'token-bucket') {
    if (capacity === undefined && limit === undefined) {
      throw new RangeError("LimitForge: Token Bucket requires a positive integer 'capacity' (or 'limit') (received: undefined).");
    }
    const targetCap = capacity !== undefined ? capacity : limit;
    if (typeof targetCap !== 'function' && !isPositiveInt(targetCap)) {
      throw new RangeError(
        `LimitForge: Token Bucket requires a positive integer 'capacity' (or 'limit') (received: ${targetCap}).`
      );
    }
    if (refillRate === undefined && (limit === undefined || windowMs === undefined)) {
      throw new RangeError("LimitForge: Token Bucket requires a positive number 'refillRate' (or 'limit' and 'windowMs') (received: undefined).");
    }
    if (refillRate !== undefined && typeof refillRate !== 'function' && !isPositiveFinite(refillRate)) {
      throw new RangeError(
        `LimitForge: Token Bucket requires a positive number 'refillRate' (or 'limit' and 'windowMs') (received: ${refillRate}).`
      );
    }
    if (refillIntervalMs !== undefined && typeof refillIntervalMs !== 'function' && !isPositiveFinite(refillIntervalMs)) {
      throw new RangeError(`LimitForge: Token Bucket requires a positive number 'refillIntervalMs' (received: ${refillIntervalMs}).`);
    }
    if (cost !== undefined) {
      if (typeof cost !== 'number' && typeof cost !== 'function') {
        throw new TypeError("LimitForge: 'cost' must be a positive integer or a function.");
      }
      if (typeof cost === 'number' && !isPositiveInt(cost)) {
        throw new RangeError(`LimitForge: 'cost' must be a positive integer (received: ${cost}).`);
      }
    }
  } else {
    if (limit !== undefined && typeof limit !== 'function' && !isPositiveInt(limit)) {
      throw new RangeError(`LimitForge: 'limit' must be a positive integer (received: ${limit}).`);
    }
    if (windowMs !== undefined && typeof windowMs !== 'function' && !isPositiveFinite(windowMs)) {
      throw new RangeError(`LimitForge: 'windowMs' must be a positive number in milliseconds (received: ${windowMs}).`);
    }
  }

  if (store !== undefined && (!store || typeof store.consume !== 'function')) {
    throw new TypeError("LimitForge: 'store' must be an object implementing a consume() method.");
  }
}

function resolveCollector(metricsCollector, metrics) {
  if (metricsCollector) return metricsCollector;
  if (typeof metrics === 'object' && metrics !== null && typeof metrics.recordRequest === 'function') {
    return metrics;
  }
  return metrics === true ? defaultMetricsCollector : undefined;
}

function resolveOtelBridge(openTelemetry) {
  if (openTelemetry instanceof OpenTelemetryBridge) return openTelemetry;
  if (typeof openTelemetry === 'object' && openTelemetry !== null) {
    return typeof openTelemetry.recordEvaluation === 'function'
      ? openTelemetry
      : new OpenTelemetryBridge(openTelemetry);
  }
  return openTelemetry === true ? new OpenTelemetryBridge() : null;
}

function resolveBreaker({ circuitBreaker, failureThreshold, resetTimeoutMs, successThreshold }) {
  if (circuitBreaker instanceof CircuitBreaker) return circuitBreaker;
  if (typeof circuitBreaker === 'object' && circuitBreaker !== null) return new CircuitBreaker(circuitBreaker);
  if (circuitBreaker === true || failureThreshold !== undefined || resetTimeoutMs !== undefined || successThreshold !== undefined) {
    return new CircuitBreaker({ failureThreshold, resetTimeoutMs, successThreshold });
  }
  return null;
}

function bindBreakerTelemetry(breaker, collector, activeBreakerId) {
  if (!collector || !breaker) return;

  let collectorsForBreaker = attachedBreakerCollectors.get(breaker);
  if (!collectorsForBreaker) {
    collectorsForBreaker = new Set();
    attachedBreakerCollectors.set(breaker, collectorsForBreaker);
  }
  if (collectorsForBreaker.has(collector)) return;

  collectorsForBreaker.add(collector);
  const breakerLabels = activeBreakerId ? { breaker: activeBreakerId } : {};
  const recordState = (state) => {
    try {
      if (typeof collector.recordCircuitBreakerState === 'function') {
        collector.recordCircuitBreakerState(state, breakerLabels);
      }
    } catch {
      // safe telemetry boundary
    }
  };

  breaker.on('stateChange', (evt) => recordState(evt.to));
  try {
    recordState(breaker.getState());
  } catch {
    // safe telemetry boundary
  }
}

export function resolveMiddlewareConfig(options, createDefaultStore) {
  const {
    limit: configuredLimit,
    windowMs: configuredWindowMs,
    capacity,
    refillRate,
    refillIntervalMs = 1000,
    cost = 1,
    timeoutMs = 250,
    onStoreError: rawOnStoreError,
    failStrategy,
    circuitBreaker,
    failureThreshold,
    resetTimeoutMs,
    successThreshold,
    fallbackStore,
    metrics,
    metricsCollector,
    routeNormalizer,
    includeRoute,
    openTelemetry,
    hashClientIdentifier = false,
    breakerId,
    prefix,
    skip,
    statusCode,
    standardHeaders = true,
    message
  } = options;

  const algorithm = options.algorithm || 'fixed-window';
  const collector = resolveCollector(metricsCollector, metrics);
  const otelBridge = resolveOtelBridge(openTelemetry);
  let breaker = resolveBreaker({ circuitBreaker, failureThreshold, resetTimeoutMs, successThreshold });
  let store = options.store || createDefaultStore();

  if (store instanceof ResilientStore) {
    const hasBreakerOptions =
      circuitBreaker !== undefined ||
      failureThreshold !== undefined ||
      resetTimeoutMs !== undefined ||
      successThreshold !== undefined;
    if (hasBreakerOptions && breaker !== store.circuitBreaker) {
      throw new TypeError('LimitForge: Configure the circuit breaker on the ResilientStore when using it as the store.');
    }
    breaker = store.circuitBreaker;
  } else if (fallbackStore) {
    store = new ResilientStore({
      primaryStore: store,
      fallbackStore: fallbackStore === true ? undefined : fallbackStore,
      circuitBreaker: circuitBreaker === false ? false : (breaker || undefined),
      timeoutMs
    });
    breaker = store.circuitBreaker;
  }

  const activeBreakerId =
    breakerId ||
    breaker?.id ||
    (typeof circuitBreaker === 'object' && circuitBreaker?.id ? circuitBreaker.id : null) ||
    null;

  if (breaker && activeBreakerId && !breaker.id) {
    breaker.id = activeBreakerId;
  }

  bindBreakerTelemetry(collector ? breaker : null, collector, activeBreakerId);

  return {
    algorithm,
    limit: configuredLimit === undefined && algorithm !== 'token-bucket' ? 60 : configuredLimit,
    windowMs: configuredWindowMs === undefined && algorithm !== 'token-bucket' ? 60000 : configuredWindowMs,
    capacity,
    refillRate,
    refillIntervalMs,
    cost,
    timeoutMs,
    onStoreError: rawOnStoreError !== undefined ? rawOnStoreError : failStrategy,
    store,
    isResilient: store instanceof ResilientStore,
    breaker,
    collector,
    otelBridge,
    routeNormalizer,
    includeRoute,
    hashClientIdentifier,
    prefix,
    skip,
    statusCode,
    standardHeaders,
    message
  };
}
