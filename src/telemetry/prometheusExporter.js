import {
  METRIC_TYPE,
  METRIC_METADATA
} from './telemetryEvents.js';
import { defaultMetricsCollector } from './metricsCollector.js';

export function escapeLabelValue(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

export function escapeHelpString(help) {
  return String(help)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n');
}

export function formatLabels(labels = {}, additionalLabels = {}) {
  const merged = { ...labels, ...additionalLabels };
  const entries = Object.entries(merged).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return '';

  entries.sort(([a], [b]) => a.localeCompare(b));
  const formatted = entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',');
  return `{${formatted}}`;
}

function appendScalarMetrics(lines, group, type, fallbackPrefix) {
  for (const [name, records] of Object.entries(group)) {
    if (!Array.isArray(records) || records.length === 0) continue;

    const meta = METRIC_METADATA[name] || { type, help: `${fallbackPrefix} metric ${name}` };
    lines.push(`# HELP ${name} ${escapeHelpString(meta.help)}`);
    lines.push(`# TYPE ${name} ${meta.type}`);

    for (const record of records) {
      lines.push(`${name}${formatLabels(record.labels)} ${record.value}`);
    }
  }
}

export function formatPrometheusMetrics(snapshot = {}) {
  const lines = [];
  const { counters = {}, gauges = {}, histograms = {} } = snapshot;

  appendScalarMetrics(lines, counters, METRIC_TYPE.COUNTER, 'Counter');
  appendScalarMetrics(lines, gauges, METRIC_TYPE.GAUGE, 'Gauge');

  for (const [name, records] of Object.entries(histograms)) {
    if (!Array.isArray(records) || records.length === 0) continue;

    const meta = METRIC_METADATA[name] || {
      type: METRIC_TYPE.HISTOGRAM,
      help: `Histogram metric ${name}`
    };

    lines.push(`# HELP ${name} ${escapeHelpString(meta.help)}`);
    lines.push(`# TYPE ${name} ${meta.type}`);

    for (const record of records) {
      const baseLabels = record.labels || {};
      if (Array.isArray(record.buckets)) {
        for (const bucket of record.buckets) {
          lines.push(`${name}_bucket${formatLabels(baseLabels, { le: bucket.le })} ${bucket.count}`);
        }
      }

      lines.push(`${name}_bucket${formatLabels(baseLabels, { le: '+Inf' })} ${record.count}`);
      const sumLabels = formatLabels(baseLabels);
      lines.push(`${name}_sum${sumLabels} ${record.sum}`);
      lines.push(`${name}_count${sumLabels} ${record.count}`);
    }
  }

  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

export function createPrometheusExporter(options = {}) {
  const collector = options.collector || options.metricsCollector ||
    (typeof options.getSnapshot === 'function' ? options : defaultMetricsCollector);

  return function prometheusExporterMiddleware(req, res, next) {
    try {
      const output = formatPrometheusMetrics(collector.getSnapshot());
      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.status(200).end(output);
    } catch (err) {
      next(err);
    }
  };
}
