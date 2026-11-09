import { EventEmitter } from 'node:events';
import { MemoryStore } from './memoryStore.js';
import { CircuitBreaker } from '../resilience/circuitBreaker.js';
import { withTimeout } from '../resilience/timeoutGuard.js';

/**
 * Dual-store failover wrapper pairing a distributed primary store with a local
 * fallback guarded by a timeout and CircuitBreaker (prioritizes availability over
 * global quota consistency during primary outages; set `onStoreError: 'fail-closed'`
 * on the middleware for strict global enforcement).
 */
export class ResilientStore extends EventEmitter {
  constructor(options = {}) {
    super();

    if (!options || typeof options !== 'object') {
      throw new TypeError('LimitForge: ResilientStore options must be an object.');
    }

    const {
      primaryStore,
      fallbackStore,
      circuitBreaker,
      breaker,
      timeoutMs = 250,
      failureThreshold = 5,
      resetTimeoutMs = 10000
    } = options;

    if (!primaryStore || typeof primaryStore.consume !== 'function') {
      throw new TypeError("LimitForge: ResilientStore requires a 'primaryStore' implementing a consume() method.");
    }
    this.primaryStore = primaryStore;

    if (fallbackStore !== undefined) {
      if (!fallbackStore || typeof fallbackStore.consume !== 'function') {
        throw new TypeError("LimitForge: ResilientStore 'fallbackStore' must implement a consume() method.");
      }
      this.fallbackStore = fallbackStore;
    } else {
      this.fallbackStore = new MemoryStore();
    }

    if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new RangeError(
        `LimitForge: ResilientStore 'timeoutMs' must be a positive number in milliseconds (received: ${timeoutMs}).`
      );
    }
    this.timeoutMs = timeoutMs;

    const chosenBreaker = circuitBreaker !== undefined ? circuitBreaker : breaker;
    if (chosenBreaker instanceof CircuitBreaker) {
      this.circuitBreaker = chosenBreaker;
    } else if (typeof chosenBreaker === 'object' && chosenBreaker !== null) {
      this.circuitBreaker = new CircuitBreaker(chosenBreaker);
    } else if (chosenBreaker === false) {
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

  get breaker() {
    return this.circuitBreaker;
  }

  async consume(params, { failOnPrimaryError = false } = {}) {
    const runPrimary = () =>
      this.timeoutMs
        ? withTimeout(this.primaryStore.consume(params), this.timeoutMs)
        : this.primaryStore.consume(params);

    let primaryError = null;
    try {
      const result = this.circuitBreaker
        ? await this.circuitBreaker.execute(runPrimary)
        : await runPrimary();

      this.emit('primarySuccess', { key: params.key });
      return {
        ...result,
        degraded: false,
        fallbackUsed: false,
        store: 'primary'
      };
    } catch (err) {
      primaryError = err;
    }

    if (failOnPrimaryError) {
      throw primaryError;
    }

    this.emit('fallback', {
      key: params.key,
      error: primaryError,
      circuitState: this.circuitBreaker ? this.circuitBreaker.getState() : 'NONE'
    });

    const fallbackResult = await withTimeout(this.fallbackStore.consume(params), this.timeoutMs);
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

export default ResilientStore;
