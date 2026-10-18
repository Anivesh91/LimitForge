import {
  METRIC_TYPE,
  METRIC_NAMES,
  CIRCUIT_STATE_GAUGE_VALUES,
  DEFAULT_STORE_DURATION_BUCKETS
} from './telemetryEvents.js';

function serializeLabelKey(labels = {}) {
  if (!labels || typeof labels !== 'object') return '';
  const entries = Object.entries(labels).filter(([k, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return '';
  entries.sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${k}="${String(v)}"`).join(',');
}

export class MetricsCollector {
  constructor(options = {}) {
    this.storeDurationBuckets = options.storeDurationBuckets || DEFAULT_STORE_DURATION_BUCKETS;
    this.maxSeries = typeof options.maxSeries === 'number' && options.maxSeries > 0 ? options.maxSeries : 1000;

    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();

    // Default gauge for circuit breaker state (0 = CLOSED)
    this.setGauge(METRIC_NAMES.CIRCUIT_BREAKER_STATE, CIRCUIT_STATE_GAUGE_VALUES.CLOSED);
  }

  incrementCounter(name, labels = {}, value = 1) {
    try {
      if (!name || typeof name !== 'string') return;
      if (typeof value !== 'number' || value <= 0) return;

      if (!this.counters.has(name)) {
        this.counters.set(name, new Map());
      }

      const metricMap = this.counters.get(name);
      let targetLabels = labels;
      let labelKey = serializeLabelKey(targetLabels);

      if (!metricMap.has(labelKey)) {
        if (metricMap.size >= this.maxSeries) {
          if (labels && labels.normalized_route) {
            targetLabels = { ...labels, normalized_route: '_overflow' };
            labelKey = serializeLabelKey(targetLabels);
            if (!metricMap.has(labelKey) && metricMap.size >= this.maxSeries) {
              return;
            }
          } else {
            return;
          }
        }
      }

      const current = metricMap.get(labelKey) || { value: 0, labels: { ...targetLabels } };
      current.value += value;
      metricMap.set(labelKey, current);
    } catch {
      // safe telemetry boundary
    }
  }

  setGauge(name, value, labels = {}) {
    try {
      if (!name || typeof name !== 'string') return;
      if (typeof value !== 'number' || !Number.isFinite(value)) return;

      if (!this.gauges.has(name)) {
        this.gauges.set(name, new Map());
      }

      const metricMap = this.gauges.get(name);
      let targetLabels = labels;
      let labelKey = serializeLabelKey(targetLabels);

      if (!metricMap.has(labelKey) && metricMap.size >= this.maxSeries) {
        return;
      }

      metricMap.set(labelKey, {
        value,
        labels: { ...targetLabels }
      });
    } catch {
      // safe telemetry boundary
    }
  }

  observeHistogram(name, durationSeconds, labels = {}, customBuckets = this.storeDurationBuckets) {
    try {
      if (!name || typeof name !== 'string') return;
      if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds < 0) return;

      if (!this.histograms.has(name)) {
        this.histograms.set(name, new Map());
      }

      const metricMap = this.histograms.get(name);
      let targetLabels = labels;
      let labelKey = serializeLabelKey(targetLabels);

      if (!metricMap.has(labelKey) && metricMap.size >= this.maxSeries) {
        return;
      }

      let record = metricMap.get(labelKey);
      if (!record) {
        const sortedBounds = [...customBuckets].sort((a, b) => a - b);
        record = {
          labels: { ...targetLabels },
          buckets: sortedBounds.map((le) => ({ le, count: 0 })),
          sum: 0,
          count: 0
        };
        metricMap.set(labelKey, record);
      }

      record.sum += durationSeconds;
      record.count += 1;

      for (const bucket of record.buckets) {
        if (durationSeconds <= bucket.le) {
          bucket.count += 1;
        }
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
    const snapshot = {
      counters: {},
      gauges: {},
      histograms: {}
    };

    for (const [name, metricMap] of this.counters.entries()) {
      snapshot.counters[name] = [];
      for (const record of metricMap.values()) {
        snapshot.counters[name].push({ ...record, labels: { ...record.labels } });
      }
    }

    for (const [name, metricMap] of this.gauges.entries()) {
      snapshot.gauges[name] = [];
      for (const record of metricMap.values()) {
        snapshot.gauges[name].push({ ...record, labels: { ...record.labels } });
      }
    }

    for (const [name, metricMap] of this.histograms.entries()) {
      snapshot.histograms[name] = [];
      for (const record of metricMap.values()) {
        snapshot.histograms[name].push({
          labels: { ...record.labels },
          buckets: record.buckets.map((b) => ({ ...b })),
          sum: record.sum,
          count: record.count
        });
      }
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
