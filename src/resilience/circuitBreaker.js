import { EventEmitter } from 'node:events';
import { CircuitBreakerOpenError } from './errors.js';

export const CIRCUIT_STATE = Object.freeze({
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN'
});

export class CircuitBreaker extends EventEmitter {
  constructor(options = {}) {
    super();

    const {
      failureThreshold = 5,
      resetTimeoutMs = 10000,
      successThreshold = 1,
      isFailure = () => true
    } = options;

    if (typeof failureThreshold !== 'number' || !Number.isInteger(failureThreshold) || failureThreshold <= 0) {
      throw new RangeError(
        `SmartRate: CircuitBreaker 'failureThreshold' must be a positive integer (received: ${failureThreshold}).`
      );
    }
    if (typeof resetTimeoutMs !== 'number' || !Number.isFinite(resetTimeoutMs) || resetTimeoutMs <= 0) {
      throw new RangeError(
        `SmartRate: CircuitBreaker 'resetTimeoutMs' must be a positive number in milliseconds (received: ${resetTimeoutMs}).`
      );
    }
    if (typeof successThreshold !== 'number' || !Number.isInteger(successThreshold) || successThreshold <= 0) {
      throw new RangeError(
        `SmartRate: CircuitBreaker 'successThreshold' must be a positive integer (received: ${successThreshold}).`
      );
    }
    if (typeof isFailure !== 'function') {
      throw new TypeError("SmartRate: CircuitBreaker 'isFailure' must be a function.");
    }

    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.successThreshold = successThreshold;
    this.isFailure = isFailure;
    this.id = (typeof options.id === 'string' && options.id.trim()) || (typeof options.name === 'string' && options.name.trim()) || null;

    this.state = CIRCUIT_STATE.CLOSED;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.lastFailureTime = null;
    this.nextAttempt = 0;
    this.probeInFlight = false;
    this.probeGeneration = 0;
  }

  getState() {
    if (this.state === CIRCUIT_STATE.OPEN && Date.now() >= this.nextAttempt) {
      this._transitionTo(CIRCUIT_STATE.HALF_OPEN);
    }
    return this.state;
  }

  isOpen() { return this.getState() === CIRCUIT_STATE.OPEN; }
  isClosed() { return this.getState() === CIRCUIT_STATE.CLOSED; }
  isHalfOpen() { return this.getState() === CIRCUIT_STATE.HALF_OPEN; }

  _transitionTo(nextState, context = {}) {
    if (this.state === nextState) return;

    const from = this.state;
    this._invalidateProbe();
    this.state = nextState;

    if (nextState === CIRCUIT_STATE.CLOSED) {
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses = 0;
      this.probeInFlight = false;
    } else if (nextState === CIRCUIT_STATE.OPEN) {
      this.nextAttempt = Date.now() + this.resetTimeoutMs;
      this.probeInFlight = false;
    } else if (nextState === CIRCUIT_STATE.HALF_OPEN) {
      this.consecutiveSuccesses = 0;
      this.probeInFlight = false;
    }

    const eventPayload = {
      from,
      to: nextState,
      timestamp: Date.now(),
      ...context
    };

    this.emit('stateChange', eventPayload);

    if (nextState === CIRCUIT_STATE.OPEN) {
      this.emit('open', eventPayload);
      this.emit('trip', eventPayload);
    } else if (nextState === CIRCUIT_STATE.HALF_OPEN) {
      this.emit('halfOpen', eventPayload);
    } else if (nextState === CIRCUIT_STATE.CLOSED) {
      this.emit('close', eventPayload);
      this.emit('reset', eventPayload);
    }
  }

  _invalidateProbe() {
    this.probeGeneration += 1;
    this.probeInFlight = false;
  }

  _ownsProbe(token) {
    return token !== null &&
      token === this.probeGeneration &&
      this.probeInFlight &&
      this.state === CIRCUIT_STATE.HALF_OPEN;
  }

  async execute(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError("SmartRate: CircuitBreaker.execute() expects a function argument.");
    }

    const currentState = this.getState();
    if (currentState === CIRCUIT_STATE.OPEN) {
      const remainingMs = Math.max(0, this.nextAttempt - Date.now());
      throw new CircuitBreakerOpenError(
        `SmartRate: Circuit breaker is OPEN. Fast-failing without calling store (resets in ${remainingMs}ms).`,
        remainingMs
      );
    }

    let probeToken = null;
    if (currentState === CIRCUIT_STATE.HALF_OPEN) {
      if (this.probeInFlight) {
        throw new CircuitBreakerOpenError(
          'SmartRate: Circuit breaker is HALF_OPEN and a canary probe is already in-flight.',
          Math.max(0, this.nextAttempt - Date.now())
        );
      }
      this.probeInFlight = true;
      probeToken = ++this.probeGeneration;
      this.emit('probe', { timestamp: Date.now() });
    }

    try {
      const result = await fn();
      this._recordSuccess(probeToken);
      return result;
    } catch (err) {
      if ((probeToken === null || this._ownsProbe(probeToken)) && this.isFailure(err)) {
        this._recordFailure(err, probeToken);
      }
      throw err;
    } finally {
      if (this._ownsProbe(probeToken)) {
        this.probeInFlight = false;
        this.probeGeneration += 1;
      }
    }
  }

  _recordSuccess(probeToken = null) {
    const isProbe = probeToken !== null;
    if (isProbe && !this._ownsProbe(probeToken)) return;

    if (this.state === CIRCUIT_STATE.HALF_OPEN) {
      if (!isProbe) return;
      this.consecutiveSuccesses += 1;
      if (this.consecutiveSuccesses >= this.successThreshold) {
        this._transitionTo(CIRCUIT_STATE.CLOSED);
      }
    } else if (this.state === CIRCUIT_STATE.CLOSED) {
      this.consecutiveFailures = 0;
    }
  }

  _recordFailure(err, probeToken = null) {
    const isProbe = probeToken !== null;
    if (isProbe && !this._ownsProbe(probeToken)) return;
    if (this.state === CIRCUIT_STATE.HALF_OPEN && !isProbe) return;

    this.lastFailureTime = Date.now();
    this.consecutiveFailures += 1;

    if (this.state === CIRCUIT_STATE.HALF_OPEN) {
      this._transitionTo(CIRCUIT_STATE.OPEN, { error: err, probeFailed: true });
    } else if (this.state === CIRCUIT_STATE.CLOSED) {
      if (this.consecutiveFailures >= this.failureThreshold) {
        this._transitionTo(CIRCUIT_STATE.OPEN, { error: err, consecutiveFailures: this.consecutiveFailures });
      }
    }
  }

  trip(error) {
    this._invalidateProbe();
    this._transitionTo(CIRCUIT_STATE.OPEN, { error, manual: true });
  }

  reset() {
    this._invalidateProbe();
    this._transitionTo(CIRCUIT_STATE.CLOSED, { manual: true });
  }

  getStats() {
    return {
      state: this.getState(),
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      failureThreshold: this.failureThreshold,
      resetTimeoutMs: this.resetTimeoutMs,
      successThreshold: this.successThreshold,
      lastFailureTime: this.lastFailureTime,
      nextAttempt: this.nextAttempt,
      probeInFlight: this.probeInFlight
    };
  }
}
