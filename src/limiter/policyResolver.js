import { normalizeRoute } from '../utils/routeNormalizer.js';
import { isPositiveInt, isPositiveFinite } from './options.js';

export async function resolveClientIdentifier(req, keyGenerator) {
  const rawIdentifier = await keyGenerator(req);
  if (rawIdentifier !== undefined && rawIdentifier !== null && String(rawIdentifier).trim().length > 0) {
    return String(rawIdentifier).trim();
  }
  return req.ip || req.socket?.remoteAddress || '127.0.0.1';
}

export function resolveRouteScope({ req, middlewareFn, routeNormalizer, includeRoute, visitedRoutes }) {
  const method = (req.method || 'GET').toUpperCase();
  const normalizedRoute = normalizeRoute(req, routeNormalizer);

  // req.route remains populated from prior handlers during app.use() passes;
  // only treat the limiter as route-scoped if it sits directly on req.route.stack.
  let isRouteHandler = Array.isArray(req.route?.stack) &&
    req.route.stack.some((layer) => layer.handle === middlewareFn);
  if (isRouteHandler) {
    let routes = visitedRoutes.get(req);
    if (!routes) {
      routes = new WeakSet();
      visitedRoutes.set(req, routes);
    }
    if (routes.has(req.route)) {
      isRouteHandler = false;
    } else {
      routes.add(req.route);
    }
  }

  const useRoute = includeRoute ?? (isRouteHandler || Boolean(routeNormalizer));
  const routeKey = useRoute ? normalizedRoute : '__limitforge_global__';

  return { method, normalizedRoute, routeKey };
}

export async function resolveRequestPolicy({
  req,
  algorithm,
  limit,
  windowMs,
  capacity,
  refillRate,
  refillIntervalMs,
  cost
}) {
  const resolvedLimit = typeof limit === 'function' ? await limit(req) : limit;
  const resolvedWindowMs = typeof windowMs === 'function' ? await windowMs(req) : windowMs;
  const resolvedCapacity = typeof capacity === 'function' ? await capacity(req) : (capacity ?? resolvedLimit);
  const resolvedRefillIntervalMs = typeof refillIntervalMs === 'function'
    ? await refillIntervalMs(req)
    : (refillIntervalMs ?? 1000);

  let resolvedRefillRate;
  if (typeof refillRate === 'function') {
    resolvedRefillRate = await refillRate(req);
  } else if (refillRate !== undefined) {
    resolvedRefillRate = refillRate;
  } else if (resolvedLimit && resolvedWindowMs) {
    resolvedRefillRate = resolvedLimit * (resolvedRefillIntervalMs / resolvedWindowMs);
  }

  let requestCost = 1;
  if (typeof cost === 'function') {
    requestCost = await cost(req);
  } else if (typeof cost === 'number') {
    requestCost = cost;
  }

  if (algorithm === 'token-bucket') {
    if (!isPositiveInt(resolvedCapacity)) {
      throw new RangeError(`LimitForge: Dynamic 'capacity' must resolve to a positive integer (received: ${resolvedCapacity}).`);
    }
    if (!isPositiveFinite(resolvedRefillRate)) {
      throw new RangeError(`LimitForge: Dynamic 'refillRate' must resolve to a positive number (received: ${resolvedRefillRate}).`);
    }
    if (!isPositiveFinite(resolvedRefillIntervalMs)) {
      throw new RangeError(`LimitForge: Dynamic 'refillIntervalMs' must resolve to a positive number (received: ${resolvedRefillIntervalMs}).`);
    }
    if (!isPositiveInt(requestCost)) {
      throw new RangeError(`LimitForge: Dynamic 'cost' must resolve to a positive integer (received: ${requestCost}).`);
    }
  } else {
    if (!isPositiveInt(resolvedLimit)) {
      throw new RangeError(`LimitForge: Dynamic 'limit' must resolve to a positive integer (received: ${resolvedLimit}).`);
    }
    if (!isPositiveFinite(resolvedWindowMs)) {
      throw new RangeError(`LimitForge: Dynamic 'windowMs' must resolve to a positive number in milliseconds (received: ${resolvedWindowMs}).`);
    }
  }

  return {
    resolvedLimit,
    resolvedWindowMs,
    resolvedCapacity,
    resolvedRefillRate,
    resolvedRefillIntervalMs,
    requestCost,
    headerLimit: algorithm === 'token-bucket' ? resolvedCapacity : resolvedLimit
  };
}
