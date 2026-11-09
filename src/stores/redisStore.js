import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { escapeKeySegment } from '../utils/keyBuilder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const loadScript = (name) => fs.readFileSync(path.join(__dirname, '../scripts', name), 'utf-8');

const FIXED_WINDOW_LUA = loadScript('fixedWindow.lua');
const SLIDING_WINDOW_LUA = loadScript('slidingWindow.lua');
const TOKEN_BUCKET_LUA = loadScript('tokenBucket.lua');

export class RedisStore {
  constructor(options) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('LimitForge: RedisStore options must be an object.');
    }
    if (!options.client || typeof options.client !== 'object') {
      throw new TypeError(
        'LimitForge: RedisStore requires a pre-connected Redis client instance (options.client). ' +
        'Please create and connect a Redis client in your application and inject it here.'
      );
    }
    if (typeof options.client.eval !== 'function' && typeof options.client.sendCommand !== 'function') {
      throw new TypeError('LimitForge: Injected Redis client does not appear to be a valid Redis client instance.');
    }
    if (options.prefix !== undefined && (typeof options.prefix !== 'string' || options.prefix.trim().length === 0)) {
      throw new TypeError("LimitForge: RedisStore 'prefix' must be a non-empty string.");
    }

    this.client = options.client;
    this.prefix = typeof options.prefix === 'string' ? options.prefix.trim() : undefined;
    this.script = FIXED_WINDOW_LUA;
    this.fixedScript = FIXED_WINDOW_LUA;
    this.slidingScript = SLIDING_WINDOW_LUA;
    this.tokenBucketScript = TOKEN_BUCKET_LUA;

    this._algorithms = {
      'fixed-window': (params) => this._consumeFixedWindow(params),
      'sliding-window': (params) => this._consumeSlidingWindow(params),
      'token-bucket': (params) => this._consumeTokenBucket(params)
    };
  }

  _resolveKey(key) {
    if (!this.prefix) return key;
    const encodedPrefix = escapeKeySegment(this.prefix);
    if (key.startsWith(`${encodedPrefix}:`)) return key;
    if (key.startsWith(`${this.prefix}:`)) return `${encodedPrefix}${key.slice(this.prefix.length)}`;
    return `${encodedPrefix}:${key}`;
  }

  async _evalLua(script, key, args = []) {
    const stringArgs = args.map(String);
    if (typeof this.client.eval === 'function') {
      return this.client.eval(script, { keys: [key], arguments: stringArgs });
    }
    return this.client.sendCommand(['EVAL', script, '1', key, ...stringArgs]);
  }

  async consume({
    key,
    limit,
    windowMs,
    algorithm = 'fixed-window',
    capacity,
    refillRate,
    refillIntervalMs = 1000,
    cost = 1,
    now
  }) {
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw new TypeError("LimitForge: RedisStore 'key' must be a non-empty string.");
    }

    const useServerTime = now === undefined;
    const requestedNow = useServerTime ? Date.now() : now;
    const handler = this._algorithms[algorithm] || this._algorithms['fixed-window'];

    return handler({
      key,
      limit,
      windowMs,
      capacity,
      refillRate,
      refillIntervalMs,
      cost,
      now: requestedNow,
      useServerTime
    });
  }

  async _consumeTokenBucket({ key, limit, windowMs, capacity, refillRate, refillIntervalMs = 1000, cost = 1, now, useServerTime }) {
    const resolvedCapacity = capacity ?? limit;
    if (typeof resolvedCapacity !== 'number' || !Number.isInteger(resolvedCapacity) || resolvedCapacity <= 0) {
      throw new RangeError(`LimitForge: RedisStore 'capacity' must be a positive integer (received: ${resolvedCapacity}).`);
    }
    if (typeof refillIntervalMs !== 'number' || !Number.isFinite(refillIntervalMs) || refillIntervalMs <= 0) {
      throw new RangeError(`LimitForge: RedisStore 'refillIntervalMs' must be a positive number (received: ${refillIntervalMs}).`);
    }

    const resolvedRefillRate = refillRate ?? (limit && windowMs ? (limit * refillIntervalMs) / windowMs : undefined);
    if (typeof resolvedRefillRate !== 'number' || !Number.isFinite(resolvedRefillRate) || resolvedRefillRate <= 0) {
      throw new RangeError(`LimitForge: RedisStore 'refillRate' must be a positive number (received: ${resolvedRefillRate}).`);
    }

    const storeKey = this._resolveKey(key);
    const rawResult = await this._evalLua(this.tokenBucketScript, storeKey, [
      now,
      resolvedCapacity,
      resolvedRefillRate,
      refillIntervalMs,
      cost,
      useServerTime ? '1' : '0'
    ]);

    const [rawAllowed, rawRemaining, rawReset, rawRetryAfter] = Array.isArray(rawResult)
      ? rawResult
      : [1, resolvedCapacity - cost, 1, 0];

    const allowed = Number(rawAllowed) === 1;
    const remaining = Number(rawRemaining);

    return {
      allowed,
      count: Math.max(0, resolvedCapacity - remaining),
      remaining,
      reset: Number(rawReset),
      ...(allowed ? {} : { retryAfter: Number(rawRetryAfter) })
    };
  }

  _validateWindowParams(limit, windowMs) {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
      throw new RangeError(`LimitForge: RedisStore 'limit' must be a positive integer (received: ${limit}).`);
    }
    if (typeof windowMs !== 'number' || !Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError(`LimitForge: RedisStore 'windowMs' must be a positive number in milliseconds (received: ${windowMs}).`);
    }
  }

  async _consumeFixedWindow({ key, limit, windowMs }) {
    this._validateWindowParams(limit, windowMs);
    const storeKey = this._resolveKey(key);
    const rawResult = await this._evalLua(this.fixedScript, storeKey, [windowMs]);
    const [rawCount, rawTtlMs] = Array.isArray(rawResult) ? rawResult : [1, windowMs];

    const count = Number(rawCount);
    const ttlMs = Number(rawTtlMs);
    if (ttlMs === -1) {
      throw new Error(`LimitForge: Key '${key}' exists in Redis without an expiration TTL.`);
    }

    const resetSeconds = Math.max(1, Math.ceil((ttlMs > 0 ? ttlMs : windowMs) / 1000));
    const allowed = count <= limit;

    return {
      allowed,
      count,
      remaining: Math.max(0, limit - count),
      reset: resetSeconds,
      ...(allowed ? {} : { retryAfter: resetSeconds })
    };
  }

  async _consumeSlidingWindow({ key, limit, windowMs, now, useServerTime }) {
    this._validateWindowParams(limit, windowMs);
    const storeKey = this._resolveKey(key);
    const uniqueId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10);
    const member = `${now}:${uniqueId}`;

    const rawResult = await this._evalLua(this.slidingScript, storeKey, [
      now,
      windowMs,
      limit,
      member,
      useServerTime ? '1' : '0'
    ]);
    const [rawAllowed, rawCount, rawOldestScore, rawServerNow = now] = Array.isArray(rawResult)
      ? rawResult
      : [1, 1, now, now];

    const allowed = Number(rawAllowed) === 1;
    const count = Number(rawCount);
    const resetMs = (Number(rawOldestScore) + Math.ceil(windowMs)) - Number(rawServerNow);
    const resetSeconds = Math.max(1, Math.ceil(resetMs / 1000));

    return {
      allowed,
      count,
      remaining: Math.max(0, limit - count),
      reset: resetSeconds,
      ...(allowed ? {} : { retryAfter: resetSeconds })
    };
  }
}

export default RedisStore;
