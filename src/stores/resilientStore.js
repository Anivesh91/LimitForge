import { EventEmitter } from 'node:events';
import { MemoryStore } from './memoryStore.js';
import { CircuitBreaker } from '../resilience/circuitBreaker.js';
import { withTimeout } from '../resilience/timeoutGuard.js';

export class ResilientStore extends EventEmitter {
  
  constructor(options = {}) {
    super();

    if (!options || typeof options !== 'object') {
      throw new TypeError('SmartRate: ResilientStore options must be an object.');
    }

    const {
      primaryStore,
      fallbackStore,
      circuitBreaker,
      timeoutMs = 250,
      failureThreshold = 5,
      resetTimeoutMs = 10000
    } = options;

    if (!primaryStore || typeof primaryStore.consume !== 'function') {
      throw new TypeError("SmartRate: ResilientStore requires a 'primaryStore' implementing a consume() method.");
    }
    this.primaryStore = primaryStore;

    if (fallbackStore !== undefined) {
      if (!fallbackStore || typeof fallbackStore.consume !== 'function') {
        throw new TypeError("SmartRate: ResilientStore 'fallbackStore' must implement a consume() method.");
      }
      this.fallbackStore = fallbackStore;
    } else {
      this.fallbackStore = new MemoryStore();
    }

    if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new RangeError(
        `SmartRate: ResilientStore 'timeoutMs' must be a positive number in milliseconds (received: ${timeoutMs}).`
      );
    }
    this.timeoutMs = timeoutMs;

    if (circuitBreaker instanceof CircuitBreaker) {
      this.circuitBreaker = circuitBreaker;
    } else if (typeof circuitBreaker === 'object' && circuitBreaker !== null) {
      this.circuitBreaker = new CircuitBreaker(circuitBreaker);
    } else if (circuitBreaker === false) {
      this.circuitBreaker = null;
    } else {
      this.circuitBreaker = new CircuitBreaker({ failureThreshold, resetTimeoutMs });
    }

    if (this.circuitBreaker) {
      this.circuitBreaker.on('stateChange', (evt) => this.emit('stateChange', evt));
      this.circuitBreaker.on('trip', (evt) => this.emit('circuitOpen', evt));
      this.circuitBreaker.on('close', (evt) => this.emit('circuitClose', evt));
      this.circuitBreaker.on('probe', (evt) => this.emit('probe', evt));
    }
  }

  async consume(params) {
    const runPrimary = () =>
      this.timeoutMs
        ? withTimeout(this.primaryStore.consume(params), this.timeoutMs)
        : this.primaryStore.consume(params);

    let primaryError = null;

    try {
      const primaryResult = this.circuitBreaker
        ? await this.circuitBreaker.execute(runPrimary)
        : await runPrimary();

      this.emit('primarySuccess', { key: params.key });

      return {
        ...primaryResult,
        degraded: false,
        fallbackUsed: false,
        store: 'primary'
      };
    } catch (err) {
      primaryError = err;
    }

    this.emit('fallback', {
      key: params.key,
      error: primaryError,
      circuitState: this.circuitBreaker ? this.circuitBreaker.getState() : 'NONE'
    });

    const fallbackResult = await this.fallbackStore.consume(params);

    return {
      ...fallbackResult,
      degraded: true,
      fallbackUsed: true,
      store: 'fallback',
      primaryError
    };
  }

  cleanupExpiredRecords(now) {
    let cleaned = 0;
    if (typeof this.primaryStore.cleanupExpiredRecords === 'function') {
      cleaned += this.primaryStore.cleanupExpiredRecords(now) || 0;
    }
    if (typeof this.fallbackStore.cleanupExpiredRecords === 'function') {
      cleaned += this.fallbackStore.cleanupExpiredRecords(now) || 0;
    }
    return cleaned;
  }

  getStats() {
    return {
      circuitBreaker: this.circuitBreaker ? this.circuitBreaker.getStats() : null,
      timeoutMs: this.timeoutMs,
      hasFallbackStore: Boolean(this.fallbackStore)
    };
  }
}
