#!/usr/bin/env node
// Drena a fila de jobs DIRETO no banco, sem HTTP. É o comando do Heroku Scheduler:
//   Add-on Heroku Scheduler -> a cada hora -> `npm run jobs:run`
// O Scheduler sobe um dyno avulso (one-off) com as mesmas config vars do app, roda este script e
// o dyno some. Não depende do web dyno estar acordado e não precisa de JOBS_TICK_TOKEN.
// Handlers e produtores são registrados ao carregar services/jobsService.
// Nunca imprime variáveis de ambiente nem dados de jobs: só as estatísticas do tick.
require('../config/env');

const MAX_BUDGET_MS = 120000;

function budgetFrom(env) {
  const value = Number(env.JOBS_RUN_BUDGET_MS);
  if (!Number.isFinite(value) || value <= 0) return 25000;
  return Math.min(value, MAX_BUDGET_MS);
}

async function main({ env = process.env, log = console, jobsService, closePool } = {}) {
  const service = jobsService || require('../services/jobsService');
  const close = closePool || (() => new Promise((resolve) => require('../mysql').pool.end(() => resolve())));
  try {
    const stats = await service.tick({ budgetMs: budgetFrom(env) });
    const keys = ['enqueued', 'claimed', 'done', 'retried', 'failed', 'released', 'producerErrors', 'remaining', 'durationMs'];
    log.log(`[jobs:run] ok ${keys.map((k) => `${k}=${stats[k] ?? '-'}`).join(' ')}`);
    return 0;
  } catch (error) {
    log.error(`[jobs:run] falhou: ${String(error?.message || error).slice(0, 200)}`);
    return 1;
  } finally {
    await close().catch(() => {});
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code));
}
module.exports = main;
module.exports.budgetFrom = budgetFrom;
