process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const run = require('../../scripts/jobs-run');

function logger() {
  const lines = { log: [], error: [] };
  return { lines, log: { log: (m) => lines.log.push(m), error: (m) => lines.error.push(m) } };
}

test('jobs:run: executa o tick com o orçamento padrão, imprime estatísticas e fecha o pool', async () => {
  const { lines, log } = logger();
  let budget; let closed = 0;
  const code = await run({
    env: {}, log,
    jobsService: { tick: async ({ budgetMs }) => { budget = budgetMs; return { enqueued: 2, claimed: 3, done: 3, failed: 0, remaining: 0, durationMs: 120 }; } },
    closePool: async () => { closed++; },
  });
  assert.equal(code, 0);
  assert.equal(budget, 25000);
  assert.equal(closed, 1);
  assert.match(lines.log[0], /^\[jobs:run\] ok enqueued=2 claimed=3 done=3 retried=- failed=0/);
});

test('jobs:run: orçamento configurável, com teto de 120 s e padrão para valor inválido', () => {
  assert.equal(run.budgetFrom({ JOBS_RUN_BUDGET_MS: '60000' }), 60000);
  assert.equal(run.budgetFrom({ JOBS_RUN_BUDGET_MS: '999999' }), 120000);
  assert.equal(run.budgetFrom({ JOBS_RUN_BUDGET_MS: 'abc' }), 25000);
  assert.equal(run.budgetFrom({ JOBS_RUN_BUDGET_MS: '-1' }), 25000);
  assert.equal(run.budgetFrom({}), 25000);
});

test('jobs:run: falha do tick devolve 1, não vaza detalhes longos e ainda fecha o pool', async () => {
  const { lines, log } = logger();
  let closed = 0;
  const code = await run({
    env: {}, log,
    jobsService: { tick: async () => { throw new Error('x'.repeat(500)); } },
    closePool: async () => { closed++; },
  });
  assert.equal(code, 1);
  assert.equal(closed, 1);
  assert.ok(lines.error[0].length < 260);
});

test('jobs:run: erro ao fechar o pool não muda o código de saída', async () => {
  const { log } = logger();
  const code = await run({
    env: {}, log,
    jobsService: { tick: async () => ({}) },
    closePool: async () => { throw new Error('boom'); },
  });
  assert.equal(code, 0);
});
