import {
  METRIC_NAMES,
  CIRCUIT_STATE_GAUGE_VALUES,
  DEFAULT_STORE_DURATION_BUCKETS
} from './telemetryEvents.js';

function serializeLabelKey(labels = {}) {
  if (!labels || typeof labels !== 'object') return '';
  const entries = Object.entries(labels).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return '';
  entries.sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${k}="${String(v)}"`).join(',');
}

// Symbols avoid colliding with serialized user labels; OVERFLOW_COUNTER_LABELS
// explicitly identifies capped aggregate series in Prometheus output.
const OVERFLOW_COUNTER_KEY = Symbol('counter overflow');
const OVERFLOW_HISTOGRAM_KEY = Symbol('histogram overflow');
const OVERFLOW_COUNTER_LABELS = Object.freeze({ normalized_route: '_overflow', limitforge_overflow: 'true' });
const OVERFLOW_COUNTER_LABEL_KEY = serializeLabelKey(OVERFLOW_COUNTER_LABELS);

function resolveBoundedSeries(metricMap, labels, overflowKey, maxSeries) {
  const labelKey = serializeLabelKey(labels);
  const normalSeries = metricMap.size - (metricMap.has(overflowKey) ? 1 : 0);
  if (labelKey === OVERFLOW_COUNTER_LABEL_KEY || (!metricMap.has(labelKey) && normalSeries >= Math.ceil(maxSeries) - 1)) {
    return { seriesKey: overflowKey, seriesLabels: OVERFLOW_COUNTER_LABELS, isOverflow: true };
  }
  return { seriesKey: labelKey, seriesLabels: labels, isOverflow: false };
}

export class MetricsCollector {
  constructor(options = {}) {
    this.storeDurationBuckets = options.storeDurationBuckets || DEFAULT_STORE_DURATION_BUCKETS;
    this.maxSeries = typeof options.maxSeries === 'number' && options.maxSeries > 0 ? options.maxSeries : 1000;

    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();

    this.setGauge(METRIC_NAMES.CIRCUIT_BREAKER_STATE, CIRCUIT_STATE_GAUGE_VALUES.CLOSED);
  }

  incrementCounter(name, labels = {}, value = 1) {
    try {
      if (!name || typeof name !== 'string' || typeof value !== 'number' || value <= 0) return;

      let metricMap = this.counters.get(name);
      if (!metricMap) {
        metricMap = new Map();
        this.counters.set(name, metricMap);
      }

      const { seriesKey, seriesLabels, isOverflow } = resolveBoundedSeries(
        metricMap,
        labels,
        OVERFLOW_COUNTER_KEY,
        this.maxSeries
      );

      const current = metricMap.get(seriesKey) || { value: 0, labels: { ...seriesLabels } };
      current.value += value;
      metricMap.set(seriesKey, current);

      if (name === METRIC_NAMES.REQUESTS_TOTAL && isOverflow) {
        const outcomeMetric = labels?.outcome === 'allowed'
          ? METRIC_NAMES.OVERFLOW_REQUESTS_ALLOWED_TOTAL
          : labels?.outcome === 'blocked'
            ? METRIC_NAMES.OVERFLOW_REQUESTS_BLOCKED_TOTAL
            : METRIC_NAMES.OVERFLOW_REQUESTS_OTHER_TOTAL;
        this.incrementCounter(outcomeMetric, {}, value);
      }
    } catch {
      // safe telemetry boundary
    }
  }

  setGauge(name, value, labels = {}) {
    try {
      if (!name || typeof name !== 'string' || typeof value !== 'number' || !Number.isFinite(value)) return;

      let metricMap = this.gauges.get(name);
      if (!metricMap) {
        metricMap = new Map();
        this.gauges.set(name, metricMap);
      }

      const labelKey = serializeLabelKey(labels);
      if (!metricMap.has(labelKey) && metricMap.size >= this.maxSeries) {
        this.incrementCounter(METRIC_NAMES.METRIC_UPDATES_DROPPED_TOTAL, { metric_type: 'gauge', metric_name: name });
        return;
      }

      metricMap.set(labelKey, { value, labels: { ...labels } });
    } catch {
      // safe telemetry boundary
    }
  }

  observeHistogram(name, durationSeconds, labels = {}, customBuckets = this.storeDurationBuckets) {
    try {
      if (!name || typeof name !== 'string' || typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds < 0) {
        return;
      }

      let metricMap = this.histograms.get(name);
      if (!metricMap) {
        metricMap = new Map();
        this.histograms.set(name, metricMap);
      }

      const { seriesKey, seriesLabels } = resolveBoundedSeries(
        metricMap,
        labels,
        OVERFLOW_HISTOGRAM_KEY,
        this.maxSeries
      );

      let record = metricMap.get(seriesKey);
      if (!record) {
        const sortedBounds = [...customBuckets].sort((a, b) => a - b);
        record = {
          labels: { ...seriesLabels },
          buckets: sortedBounds.map((le) => ({ le, count: 0 })),
          sum: 0,
          count: 0
        };
        metricMap.set(seriesKey, record);
      }

      record.sum += durationSeconds;
      record.count += 1;
      for (const bucket of record.buckets) {
        if (durationSeconds <= bucket.le) bucket.count += 1;
      }
    } catch {
      // safe telemetry boundary
    }
  }

  recordRequest({ outcome, algorithm, method, normalized_route, store }) {
    this.incrementCounter(METRIC_NAMES.REQUESTS_TOTAL, {
      outcome: outcome || 'unknown',
      algorithm: algorithm || 'unknown',
      method: (method || 'GET').toUpperCase(),
      normalized_route: normalized_route || '/',
      store: store || 'unknown'
    });
  }

  recordStoreError({ store, error_type }) {
    this.incrementCounter(METRIC_NAMES.STORE_ERRORS_TOTAL, {
      store: store || 'unknown',
      error_type: error_type || 'store_error'
    });
  }

  recordDegradedRequest({ reason }) {
    this.incrementCounter(METRIC_NAMES.DEGRADED_REQUESTS_TOTAL, {
      reason: reason || 'fallback'
    });
  }

  recordCircuitBreakerState(state, labels = {}) {
    const numericValue =
      CIRCUIT_STATE_GAUGE_VALUES[state] !== undefined
        ? CIRCUIT_STATE_GAUGE_VALUES[state]
        : CIRCUIT_STATE_GAUGE_VALUES.CLOSED;

    this.setGauge(METRIC_NAMES.CIRCUIT_BREAKER_STATE, numericValue, labels);
  }

  recordStoreDuration(durationSeconds, labels = {}) {
    this.observeHistogram(METRIC_NAMES.STORE_DURATION_SECONDS, durationSeconds, labels);
  }

  getSnapshot() {
    const snapshot = { counters: {}, gauges: {}, histograms: {} };

    for (const [name, metricMap] of this.counters.entries()) {
      snapshot.counters[name] = Array.from(metricMap.values(), (r) => ({ ...r, labels: { ...r.labels } }));
    }
    for (const [name, metricMap] of this.gauges.entries()) {
      snapshot.gauges[name] = Array.from(metricMap.values(), (r) => ({ ...r, labels: { ...r.labels } }));
    }
    for (const [name, metricMap] of this.histograms.entries()) {
      snapshot.histograms[name] = Array.from(metricMap.values(), (r) => ({
        labels: { ...r.labels },
        buckets: r.buckets.map((b) => ({ ...b })),
        sum: r.sum,
        count: r.count
      }));
    }

    return snapshot;
  }

  reset() {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.setGauge(METRIC_NAMES.CIRCUIT_BREAKER_STATE, CIRCUIT_STATE_GAUGE_VALUES.CLOSED);
  }
}

export const defaultMetricsCollector = new MetricsCollector();
