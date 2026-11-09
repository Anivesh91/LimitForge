function createCleanupTimer(storeRef, intervalMs) {
  const timer = setInterval(() => {
    const store = storeRef.deref();
    if (store) store.cleanupExpiredRecords();
    else clearInterval(timer);
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function isRecordExpired(record, now, cleanupIntervalMs) {
  if (Array.isArray(record.timestamps)) {
    const cutoff = now - record.windowMs;
    while (record.timestamps.length > 0 && record.timestamps[0] <= cutoff) {
      record.timestamps.shift();
    }
    return record.timestamps.length === 0;
  }

  if (record.algorithm === 'token-bucket') {
    const elapsed = now - record.lastRefillTimestamp;
    const refillPerMs = (record.refillRate || 1) / (record.refillIntervalMs || 1000);
    const timeToFullMs = Math.max(0, (record.capacity - record.tokens) / refillPerMs);
    return elapsed >= timeToFullMs + cleanupIntervalMs;
  }

  if (record.windowStart !== undefined) {
    return now - record.windowStart >= record.windowMs;
  }

  return false;
}

export class MemoryStore {
  constructor(options = {}) {
    this.store = new Map();
    this.cleanupIntervalMs = options.cleanupIntervalMs || 60_000;
    this.cleanupInterval = null;
    this._ensureCleanupTimer();

    this._algorithms = {
      'fixed-window': (params) => this._consumeFixedWindow(params),
      'sliding-window': (params) => this._consumeSlidingWindow(params),
      'token-bucket': ({ key, limit, windowMs, capacity, refillRate, refillIntervalMs, cost, now }) =>
        this._consumeTokenBucket({
          key,
          capacity: capacity ?? limit,
          refillRate: refillRate ?? (limit && windowMs ? (limit * refillIntervalMs) / windowMs : 1),
          refillIntervalMs,
          cost,
          now
        })
    };
  }

  consume({
    key,
    limit,
    windowMs,
    algorithm = 'fixed-window',
    capacity,
    refillRate,
    refillIntervalMs = 1000,
    cost = 1,
    now = Date.now()
  }) {
    const handler = this._algorithms[algorithm] || this._algorithms['fixed-window'];
    return handler({ key, limit, windowMs, capacity, refillRate, refillIntervalMs, cost, now });
  }

  _consumeFixedWindow({ key, limit, windowMs, now }) {
    const record = this.store.get(key);

    if (!record || record.windowStart === undefined) {
      this.store.set(key, { count: 1, windowStart: now, windowMs });
      return {
        allowed: true,
        count: 1,
        remaining: Math.max(0, limit - 1),
        reset: Math.ceil(windowMs / 1000)
      };
    }

    // Track the latest observed window duration for cleanup sweeps.
    record.windowMs = windowMs;
    if (now - record.windowStart >= windowMs) {
      record.count = 1;
      record.windowStart = now;
      return {
        allowed: true,
        count: 1,
        remaining: Math.max(0, limit - 1),
        reset: Math.ceil(windowMs / 1000)
      };
    }

    if (record.count < limit) {
      record.count += 1;
      const reset = Math.max(1, Math.ceil((record.windowStart + windowMs - now) / 1000));
      return {
        allowed: true,
        count: record.count,
        remaining: Math.max(0, limit - record.count),
        reset
      };
    }

    const reset = Math.max(1, Math.ceil((record.windowStart + windowMs - now) / 1000));
    return {
      allowed: false,
      count: record.count,
      remaining: 0,
      reset,
      retryAfter: reset
    };
  }

  _consumeSlidingWindow({ key, limit, windowMs, now }) {
    const cutoff = now - windowMs;
    let record = this.store.get(key);

    if (!record || !Array.isArray(record.timestamps)) {
      record = { timestamps: [], windowMs };
      this.store.set(key, record);
    } else {
      record.windowMs = windowMs;
    }

    while (record.timestamps.length > 0 && record.timestamps[0] <= cutoff) {
      record.timestamps.shift();
    }

    const currentCount = record.timestamps.length;
    if (currentCount < limit) {
      record.timestamps.push(now);
      const newCount = currentCount + 1;
      const oldest = record.timestamps[0];
      return {
        allowed: true,
        count: newCount,
        remaining: Math.max(0, limit - newCount),
        reset: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
      };
    }

    const oldest = record.timestamps[0];
    const reset = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    return {
      allowed: false,
      count: currentCount,
      remaining: 0,
      reset,
      retryAfter: reset
    };
  }

  _consumeTokenBucket({ key, capacity, refillRate, refillIntervalMs = 1000, cost = 1, now }) {
    const refillPerMs = refillRate / refillIntervalMs;
    let record = this.store.get(key);

    if (!record || record.algorithm !== 'token-bucket') {
      record = {
        algorithm: 'token-bucket',
        tokens: capacity,
        lastRefillTimestamp: now,
        capacity,
        refillRate,
        refillIntervalMs
      };
      this.store.set(key, record);
    } else {
      record.capacity = capacity;
      record.refillRate = refillRate;
      record.refillIntervalMs = refillIntervalMs;

      const elapsed = Math.max(0, now - record.lastRefillTimestamp);
      if (elapsed > 0) {
        record.tokens = Math.min(record.capacity, record.tokens + elapsed * refillPerMs);
        record.lastRefillTimestamp = now;
      }
    }

    if (record.tokens >= cost) {
      record.tokens -= cost;
      const remaining = Math.max(0, Math.floor(record.tokens));
      const timeToFullMs = Math.max(0, (record.capacity - record.tokens) / refillPerMs);
      return {
        allowed: true,
        count: Math.max(0, record.capacity - remaining),
        remaining,
        reset: Math.max(1, Math.ceil(timeToFullMs / 1000))
      };
    }

    const waitMs = (cost - record.tokens) / refillPerMs;
    const retryAfter = Math.max(1, Math.ceil(waitMs / 1000));
    return {
      allowed: false,
      count: record.capacity,
      remaining: Math.max(0, Math.floor(record.tokens)),
      reset: retryAfter,
      retryAfter
    };
  }

  cleanupExpiredRecords(now = Date.now()) {
    let removed = 0;
    for (const [key, record] of this.store.entries()) {
      if (isRecordExpired(record, now, this.cleanupIntervalMs)) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  _ensureCleanupTimer() {
    if (!this.cleanupInterval) {
      this.cleanupInterval = createCleanupTimer(new WeakRef(this), this.cleanupIntervalMs);
    }
  }

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.store.clear();
  }
}

export default MemoryStore;
