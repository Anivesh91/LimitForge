#!/usr/bin/env node
import os from 'node:os';
import { runBenchmark } from '../src/benchmark/benchmarkRunner.js';

async function main() {
  console.log('LimitForge Benchmark');
  console.log(`Node: ${process.version} | ${process.platform} (${process.arch}) | CPUs: ${os.cpus().length}`);
  console.log('Config: 1,000 warmup / 10,000 samples per scenario (hrtime.bigint)\n');

  const start = Date.now();
  const report = await runBenchmark({ iterations: 10000, warmup: 1000 });
  const totalDuration = ((Date.now() - start) / 1000).toFixed(2);

  const tableRows = report.scenarios.map((s) => ({
    'Scenario': s.scenario,
    'Throughput (ops/s)': s.opsPerSec.toLocaleString(),
    'Mean (µs)': s.stats.meanUs.toFixed(2),
    'p50 (µs)': s.stats.p50Us.toFixed(2),
    'p95 (µs)': s.stats.p95Us.toFixed(2),
    'p99 (µs)': s.stats.p99Us.toFixed(2),
    'Added p50 (µs)': s.overheadP50Us > 0 ? `+${s.overheadP50Us.toFixed(2)} µs` : 'baseline'
  }));

  console.table(tableRows);

  console.log('\nOverhead Summary');
  console.log(`  Total time:               ${totalDuration}s`);
  console.log(`  No-op baseline (p50):     ${report.scenarios[0].stats.p50Us} µs`);
  console.log(
    `  Fixed Window overhead:    +${report.scenarios[1].overheadP50Us} µs (${(report.scenarios[1].overheadP50Us / 1000).toFixed(4)} ms)`
  );
  console.log(
    `  Sliding Window overhead:  +${report.scenarios[2].overheadP50Us} µs (${(report.scenarios[2].overheadP50Us / 1000).toFixed(4)} ms)`
  );
  console.log(
    `  Token Bucket overhead:    +${report.scenarios[3].overheadP50Us} µs (${(report.scenarios[3].overheadP50Us / 1000).toFixed(4)} ms)`
  );
  console.log(
    `  Metrics overhead:         +${(report.scenarios[4].stats.p50Us - report.scenarios[2].stats.p50Us).toFixed(2)} µs over sliding window`
  );
  console.log(`  Metrics + OTel mock p50:  ${report.scenarios[5].stats.p50Us} µs`);
  console.log('\nResults vary by runtime and workload.\n');
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
