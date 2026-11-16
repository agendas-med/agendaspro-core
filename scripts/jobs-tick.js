#!/usr/bin/env node
// Gatilho horário da fila de jobs: aquece o dyno (GET /health com retentativas) e chama
// POST /internal/jobs/tick com Authorization: Bearer $JOBS_TICK_TOKEN.
// Uso: API_BASE_URL=https://SEU-APP.herokuapp.com JOBS_TICK_TOKEN=... node scripts/jobs-tick.js
// Não lê .env (rode onde as variáveis já existam: GitHub Actions secrets, crontab etc.).
// Nunca imprime o token nem a URL completa com credenciais.
const WARM_ATTEMPTS = Number(process.env.TICK_WARM_ATTEMPTS) || 6;
const WARM_DELAY_MS = Number(process.env.TICK_WARM_DELAY_MS) || 5000;
const TICK_TIMEOUT_MS = Number(process.env.TICK_TIMEOUT_MS) || 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function main({ env = process.env, log = console } = {}) {
  const base = String(env.API_BASE_URL || '').replace(/\/+$/, '');
  const token = env.JOBS_TICK_TOKEN || '';
  if (!/^https?:\/\//.test(base) || !token) {
    log.error('[tick] defina API_BASE_URL (http/https) e JOBS_TICK_TOKEN.');
    return 2;
  }

  let warm = false;
  for (let i = 1; i <= WARM_ATTEMPTS && !warm; i++) {
    try {
      const res = await request(`${base}/health`, { method: 'GET' }, 30000);
      warm = res.ok;
      if (!warm) log.warn(`[tick] /health respondeu ${res.status} (tentativa ${i})`);
    } catch (error) {
      log.warn(`[tick] /health falhou (tentativa ${i}): ${error.name}`);
    }
    if (!warm && i < WARM_ATTEMPTS) await sleep(WARM_DELAY_MS);
  }
  if (!warm) {
    log.error('[tick] API não respondeu ao aquecimento.');
    return 1;
  }

  try {
    const res = await request(`${base}/internal/jobs/tick`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    }, TICK_TIMEOUT_MS);
    const text = await res.text();
    if (!res.ok) {
      log.error(`[tick] /internal/jobs/tick respondeu ${res.status}`);
      return 1;
    }
    let stats = {};
    try { stats = JSON.parse(text); } catch { /* corpo não JSON */ }
    const keys = ['enqueued', 'claimed', 'done', 'retried', 'failed', 'released', 'remaining', 'durationMs'];
    log.log(`[tick] ok ${keys.map((k) => `${k}=${stats[k] ?? '-'}`).join(' ')}`);
    return 0;
  } catch (error) {
    log.error(`[tick] chamada falhou: ${error.name}`);
    return 1;
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });
module.exports = main;
