export class MemoryStore {
  constructor(options = {}) {
    this.store = new Map();
    this.cleanupIntervalMs = options.cleanupIntervalMs || 60_000;
    this.cleanupInterval = null;
    this._ensureCleanupTimer();
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
    if (algorithm === 'sliding-window') {
      return this._consumeSlidingWindow({ key, limit, windowMs, now });
    }

    if (algorithm === 'token-bucket') {
      const resolvedCapacity = capacity ?? limit;
      const resolvedRefillRate = refillRate ?? (limit && windowMs ? (limit * refillIntervalMs) / windowMs : 1);
      return this._consumeTokenBucket({
        key,
        capacity: resolvedCapacity,
        refillRate: resolvedRefillRate,
        refillIntervalMs,
        cost,
        now
      });
    }

    return this._consumeFixedWindow({ key, limit, windowMs, now });
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

    const elapsed = now - record.windowStart;
    if (elapsed >= windowMs) {
      record.count = 1;
      record.windowStart = now;
      record.windowMs = windowMs;

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
      const remaining = Math.max(0, limit - newCount);
      const oldest = record.timestamps[0];
      const reset = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));

      return {
        allowed: true,
        count: newCount,
        remaining,
        reset
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
        const tokensToAdd = elapsed * refillPerMs;
        record.tokens = Math.min(record.capacity, record.tokens + tokensToAdd);
        record.lastRefillTimestamp = now;
      }
    }

    if (record.tokens >= cost) {
      record.tokens -= cost;
      const remaining = Math.max(0, Math.floor(record.tokens));
      const timeToFullMs = Math.max(0, (record.capacity - record.tokens) / refillPerMs);
      const reset = Math.max(1, Math.ceil(timeToFullMs / 1000));

      return {
        allowed: true,
        count: Math.max(0, record.capacity - remaining),
        remaining,
        reset
      };
    }

    const neededTokens = cost - record.tokens;
    const waitMs = neededTokens / refillPerMs;
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
      if (Array.isArray(record.timestamps)) {
        const cutoff = now - record.windowMs;
        while (record.timestamps.length > 0 && record.timestamps[0] <= cutoff) {
          record.timestamps.shift();
        }
        if (record.timestamps.length === 0) {
          this.store.delete(key);
          removed++;
        }
      } else if (record.algorithm === 'token-bucket') {
        const elapsed = now - record.lastRefillTimestamp;
        const refillPerMs = (record.refillRate || 1) / (record.refillIntervalMs || 1000);
        const timeToFullMs = Math.max(0, (record.capacity - record.tokens) / refillPerMs);
        if (elapsed >= timeToFullMs + this.cleanupIntervalMs) {
          this.store.delete(key);
          removed++;
        }
      } else if (record.windowStart !== undefined) {
        if (now - record.windowStart >= record.windowMs) {
          this.store.delete(key);
          removed++;
        }
      }
    }

    return removed;
  }

  _ensureCleanupTimer() {
    if (!this.cleanupInterval) {
      this.cleanupInterval = setInterval(() => {
        this.cleanupExpiredRecords();
      }, this.cleanupIntervalMs);

      if (typeof this.cleanupInterval.unref === 'function') {
        this.cleanupInterval.unref();
      }
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
