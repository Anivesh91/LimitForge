const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeRequest(path, method = 'GET', body = null) {
  try {
    const options = { method, headers: {} };
    if (process.env.CHAOS_SECRET) {
      options.headers['x-chaos-secret'] = process.env.CHAOS_SECRET;
    }
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const start = Date.now();
    const res = await fetch(`${BASE_URL}${path}`, options);
    const duration = Date.now() - start;
    let data;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return {
      status: res.status,
      duration,
      degraded: res.headers.get('ratelimit-degraded') === 'true',
      remaining: res.headers.get('ratelimit-remaining'),
      reset: res.headers.get('ratelimit-reset'),
      retryAfter: res.headers.get('retry-after'),
      data
    };
  } catch (err) {
    return { status: 0, error: err.message };
  }
}

async function runSimulation() {
  console.log(`LimitForge traffic simulator targeting ${BASE_URL}\n`);

  const health = await makeRequest('/health');
  if (health.status !== 200) {
    console.error(`[ERROR] Server at ${BASE_URL} is unreachable. Ensure the server is running.`);
    process.exit(1);
  }
  console.log('[OK] Connected to LimitForge server.\n');

  console.log('[1/5] Baseline traffic (/api/public, /api/users/:id)');
  for (let i = 1; i <= 5; i++) {
    const r1 = await makeRequest('/api/public');
    const r2 = await makeRequest(`/api/users/${i}`);
    console.log(`  200 OK /api/public (rem=${r1.remaining}) | /api/users/${i} (rem=${r2.remaining})`);
    await sleep(200);
  }

  console.log('\n[2/5] Quota burst on /api/users/99 (12 requests)');
  for (let i = 1; i <= 12; i++) {
    const res = await makeRequest('/api/users/99');
    if (res.status === 200) {
      console.log(`  req #${i}: 200 OK (remaining=${res.remaining})`);
    } else if (res.status === 429) {
      console.log(`  req #${i}: 429 Too Many Requests (retry-after=${res.retryAfter}s)`);
    }
    await sleep(50);
  }

  console.log('\n[3/5] Chaos injection (simulating Redis outage)');
  await makeRequest('/api/chaos/break-store', 'POST');

  for (let i = 1; i <= 6; i++) {
    const res = await makeRequest('/api/public');
    console.log(`  req #${i}: ${res.status} OK (degraded=${res.degraded})`);
    await sleep(100);
  }

  const breakerCheck = await makeRequest('/health');
  console.log(`  circuitBreaker=${breakerCheck.data?.circuitBreaker?.state || 'OPEN'}`);

  console.log('\n[4/5] Restoring primary store and waiting 10.5s for resetTimeoutMs');
  await makeRequest('/api/chaos/heal-store', 'POST');
  await sleep(10500);

  const probeRes = await makeRequest('/api/public');
  const recoveredHealth = await makeRequest('/health');
  console.log(
    `  canary=${probeRes.status} (degraded=${probeRes.degraded}) | circuitBreaker=${recoveredHealth.data?.circuitBreaker?.state || 'CLOSED'}`
  );

  console.log('\n[5/5] Scraping /metrics');
  const metricsRes = await fetch(`${BASE_URL}/metrics`);
  const metricsText = await metricsRes.text();
  console.log(`  payload size: ${metricsText.length} bytes`);
  const sampleLines = metricsText
    .split('\n')
    .filter((l) => l.startsWith('limitforge_') && !l.startsWith('#'))
    .slice(0, 8);
  for (const line of sampleLines) {
    console.log(`  ${line}`);
  }

  console.log('\nSimulation complete. Grafana dashboard available at http://localhost:3001\n');
}

runSimulation().catch(console.error);
