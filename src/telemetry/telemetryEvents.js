

export const METRIC_TYPE = Object.freeze({
  COUNTER: 'counter',
  GAUGE: 'gauge',
  HISTOGRAM: 'histogram'
});

export const METRIC_NAMES = Object.freeze({
  REQUESTS_TOTAL: 'smartrate_requests_total',
  STORE_ERRORS_TOTAL: 'smartrate_store_errors_total',
  DEGRADED_REQUESTS_TOTAL: 'smartrate_degraded_requests_total',
  METRIC_UPDATES_DROPPED_TOTAL: 'limitforge_metric_updates_dropped_total',
  OVERFLOW_REQUESTS_ALLOWED_TOTAL: 'limitforge_overflow_requests_allowed_total',
  OVERFLOW_REQUESTS_BLOCKED_TOTAL: 'limitforge_overflow_requests_blocked_total',
  OVERFLOW_REQUESTS_OTHER_TOTAL: 'limitforge_overflow_requests_other_total',
  CIRCUIT_BREAKER_STATE: 'smartrate_circuit_breaker_state',
  STORE_DURATION_SECONDS: 'smartrate_store_duration_seconds'
});

export const CIRCUIT_STATE_GAUGE_VALUES = Object.freeze({
  CLOSED: 0,
  HALF_OPEN: 1,
  OPEN: 2
});

export const DEFAULT_STORE_DURATION_BUCKETS = Object.freeze([
  0.0005,
  0.001,
  0.0025,
  0.005,
  0.01,
  0.025,
  0.05,
  0.1,
  0.25,
  0.5,
  1.0
]);

export const METRIC_METADATA = Object.freeze({
  [METRIC_NAMES.REQUESTS_TOTAL]: {
    type: METRIC_TYPE.COUNTER,
    help: 'Total number of rate limiter requests evaluated.'
  },
  [METRIC_NAMES.STORE_ERRORS_TOTAL]: {
    type: METRIC_TYPE.COUNTER,
    help: 'Total number of store or timeout errors encountered.'
  },
  [METRIC_NAMES.DEGRADED_REQUESTS_TOTAL]: {
    type: METRIC_TYPE.COUNTER,
    help: 'Total number of requests handled under degraded or fallback conditions.'
  },
  [METRIC_NAMES.METRIC_UPDATES_DROPPED_TOTAL]: {
    type: METRIC_TYPE.COUNTER,
    help: 'Total metric updates dropped because the series limit was reached.'
  },
  [METRIC_NAMES.OVERFLOW_REQUESTS_ALLOWED_TOTAL]: {
    type: METRIC_TYPE.COUNTER,
    help: 'Allowed requests included in the request counter overflow series.'
  },
  [METRIC_NAMES.OVERFLOW_REQUESTS_BLOCKED_TOTAL]: {
    type: METRIC_TYPE.COUNTER,
    help: 'Blocked requests included in the request counter overflow series.'
  },
  [METRIC_NAMES.OVERFLOW_REQUESTS_OTHER_TOTAL]: {
    type: METRIC_TYPE.COUNTER,
    help: 'Requests with other outcomes included in the request counter overflow series.'
  },
  [METRIC_NAMES.CIRCUIT_BREAKER_STATE]: {
    type: METRIC_TYPE.GAUGE,
    help: 'Current state of the rate limiter circuit breaker (0=CLOSED, 1=HALF_OPEN, 2=OPEN).'
  },
  [METRIC_NAMES.STORE_DURATION_SECONDS]: {
    type: METRIC_TYPE.HISTOGRAM,
    help: 'Duration of rate limiter store operations in seconds.'
  }
});
