import { MemoryStore } from '../stores/memoryStore.js';
import { buildRateLimitKey } from '../utils/keyBuilder.js';
import { withTimeout } from '../resilience/timeoutGuard.js';
import { validateOptions, resolveMiddlewareConfig } from './options.js';
import { resolveClientIdentifier, resolveRouteScope, resolveRequestPolicy } from './policyResolver.js';
import { setDegradedHeader, setRateLimitHeaders, sendBlockedResponse } from './response.js';
import { handleStoreFailure } from './errorHandler.js';
import {
  resolveStoreLabels,
  activeStoreLabel,
  startRequestSpan,
  endSpanSafely,
  recordStoreTiming,
  recordOutcomeTelemetry
} from './telemetryHelper.js';

const defaultMemoryStores = new Set();
const defaultStoreRegistry = new FinalizationRegistry((reference) => defaultMemoryStores.delete(reference));
const DEFAULT_KEY_GENERATOR = (req) => req.ip || req.socket?.remoteAddress || '127.0.0.1';

export function cleanupExpiredRecords() {
  let removed = 0;
  for (const reference of defaultMemoryStores) {
    const store = reference.deref();
    if (store) removed += store.cleanupExpiredRecords();
    else defaultMemoryStores.delete(reference);
  }
  return removed;
}

function createDefaultMemoryStore() {
  const store = new MemoryStore();
  const reference = new WeakRef(store);
  defaultMemoryStores.add(reference);
  defaultStoreRegistry.register(store, reference);
  return store;
}

export function rateLimiter(options = {}) {
  validateOptions(options);

  const config = resolveMiddlewareConfig(options, createDefaultMemoryStore);
  const keyGenerator = options.keyGenerator || DEFAULT_KEY_GENERATOR;
  const { defaultStoreLabel, primaryStoreLabel, primaryStore } = resolveStoreLabels(
    config.store,
    config.isResilient
  );
  const visitedRoutes = new WeakMap();

  const rateLimiterMiddleware = async function rateLimiterMiddleware(req, res, next) {
    if (typeof config.skip === 'function') {
      try {
        if (await config.skip(req)) return next();
      } catch (skipErr) {
        return next(skipErr);
      }
    }

    const childSpan = startRequestSpan(config.otelBridge, req, config.algorithm);

    try {
      const clientIdentifier = await resolveClientIdentifier(req, keyGenerator);
      const { method, normalizedRoute, routeKey } = resolveRouteScope({
        req,
        middlewareFn: rateLimiterMiddleware,
        routeNormalizer: config.routeNormalizer,
        includeRoute: config.includeRoute,
        visitedRoutes
      });

      const effectivePrefix = config.prefix || config.store?.prefix || primaryStore?.prefix || 'limitforge';
      const key = buildRateLimitKey({
        prefix: effectivePrefix,
        algorithm: config.algorithm,
        method,
        route: routeKey,
        clientIdentifier,
        hashClientIdentifier: config.hashClientIdentifier
      });

      const policy = await resolveRequestPolicy({
        req,
        algorithm: config.algorithm,
        limit: config.limit,
        windowMs: config.windowMs,
        capacity: config.capacity,
        refillRate: config.refillRate,
        refillIntervalMs: config.refillIntervalMs,
        cost: config.cost
      });

      const storeStart = config.collector ? process.hrtime.bigint() : 0n;
      let result;

      try {
        const executeConsume = () => {
          const params = {
            key,
            limit: policy.resolvedLimit,
            windowMs: policy.resolvedWindowMs,
            algorithm: config.algorithm,
            capacity: policy.resolvedCapacity,
            refillRate: policy.resolvedRefillRate,
            refillIntervalMs: policy.resolvedRefillIntervalMs,
            cost: policy.requestCost
          };
          return config.isResilient
            ? config.store.consume(params, { failOnPrimaryError: config.onStoreError === 'fail-closed' })
            : withTimeout(config.store.consume(params), config.timeoutMs);
        };

        result = (config.breaker && !config.isResilient)
          ? await config.breaker.execute(executeConsume)
          : await executeConsume();

        recordStoreTiming({
          collector: config.collector,
          startNs: storeStart,
          storeLabel: activeStoreLabel(result, defaultStoreLabel)
        });
      } catch (storeError) {
        recordStoreTiming({
          collector: config.collector,
          startNs: storeStart,
          storeLabel: defaultStoreLabel
        });

        return await handleStoreFailure({
          storeError,
          req,
          res,
          next,
          onStoreError: config.onStoreError,
          breaker: config.breaker,
          collector: config.collector,
          otelBridge: config.otelBridge,
          algorithm: config.algorithm,
          method,
          normalizedRoute,
          storeLabel: defaultStoreLabel
        });
      }

      if (result.degraded) {
        setDegradedHeader(res);
        req.rateLimit = {
          degraded: true,
          fallbackUsed: Boolean(result.fallbackUsed),
          store: result.store,
          primaryError: typeof result.primaryError?.name === 'string' && result.primaryError.name
            ? result.primaryError.name
            : 'Error'
        };
      }

      recordOutcomeTelemetry({
        collector: config.collector,
        otelBridge: config.otelBridge,
        req,
        result,
        algorithm: config.algorithm,
        method,
        normalizedRoute,
        storeLabel: activeStoreLabel(result, defaultStoreLabel),
        primaryStoreLabel
      });

      setRateLimitHeaders(res, {
        limit: policy.headerLimit,
        remaining: result.remaining,
        reset: result.reset,
        retryAfter: result.retryAfter,
        standardHeaders: config.standardHeaders
      });

      if (result.allowed) {
        return next();
      }

      return await sendBlockedResponse({
        req,
        res,
        statusCode: config.statusCode,
        message: config.message,
        retryAfter: result.retryAfter
      });
    } catch (err) {
      return next(err);
    } finally {
      endSpanSafely(childSpan);
    }
  };

  rateLimiterMiddleware.circuitBreaker = config.breaker;
  rateLimiterMiddleware.metricsCollector = config.collector;
  return rateLimiterMiddleware;
}

export default rateLimiter;
