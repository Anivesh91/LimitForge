
export class StoreTimeoutError extends Error {
  
  constructor(timeoutMs = 250, message) {
    super(message || `SmartRate: Rate limit store operation timed out after ${timeoutMs}ms.`);
    this.name = 'StoreTimeoutError';
    this.isTimeout = true;
    this.code = 'ERR_STORE_TIMEOUT';
    this.timeoutMs = timeoutMs;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, StoreTimeoutError);
    }
  }
}

export class CircuitBreakerOpenError extends Error {
  
  constructor(message, resetTimeoutMs) {
    super(message || 'SmartRate: Circuit breaker is OPEN. Store operations temporarily suspended.');
    this.name = 'CircuitBreakerOpenError';
    this.isCircuitOpen = true;
    this.code = 'ERR_CIRCUIT_OPEN';
    if (resetTimeoutMs !== undefined) {
      this.resetTimeoutMs = resetTimeoutMs;
    }

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CircuitBreakerOpenError);
    }
  }
}
