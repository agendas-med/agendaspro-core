process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const functions = require('../../utils/functions');
const jobs = require('../../services/jobsService');

// executeSql falso: simula a tabela jobs só o suficiente para exercitar o tick.
function fakeDb(rows) {
  const log = { done: [], released: [], retried: [], failed: [] };
  let claimed = false;
  functions.executeSql = async (sql, params = []) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (q.startsWith('SELECT a.id')) return [];
    if (q.startsWith("UPDATE jobs SET status = 'running'")) {
      if (claimed) return { affectedRows: 0 };
      claimed = true;
      return { affectedRows: rows.length };
    }
    if (q.startsWith('SELECT id, type, payload')) return rows;
    if (q.startsWith("UPDATE jobs SET status = 'done'")) { log.done.push(params[0]); return {}; }
    if (q.startsWith("UPDATE jobs SET status = 'failed'")) { log.failed.push(params[1]); return {}; }
    if (q.startsWith("UPDATE jobs SET status = 'pending', lock_token = NULL, locked_until = NULL, last_error")) { log.retried.push({ id: params[2], delay: params[1] }); return {}; }
    if (q.includes('attempts = GREATEST')) { log.released.push(...params[0]); return {}; }
    if (q.startsWith('SELECT COUNT(*) AS pending')) return [{ pending: log.released.length }];
    throw new Error(`SQL inesperado: ${q.slice(0, 60)}`);
  };
  return log;
}

test('jobs: backoff exponencial com teto de 6 h', () => {
  assert.deepEqual([1, 2, 3, 4, 20].map(jobs.backoffSeconds), [60, 120, 240, 480, 21600]);
});

test('jobs: tick respeita o orçamento e devolve o que não processou', async () => {
  const original = functions.executeSql;
  let clock = 0;
  jobs.register('unit_slow', async () => { clock += 600; });
  const log = fakeDb([1, 2, 3].map(id => ({ id, type: 'unit_slow', payload: '{}', attempts: 1, max_attempts: 3 })));
  try {
    const stats = await jobs.tick({ budgetMs: 1000, now: () => clock });
    assert.deepEqual([stats.claimed, stats.done, stats.released, stats.remaining], [3, 2, 1, 1]);
    assert.deepEqual(log.done, [1, 2]);
    assert.deepEqual(log.released, [3], 'item 3 volta para a fila (próximo tick)');
  } finally {
    functions.executeSql = original;
  }
});

test('jobs: falha reagenda com backoff e esgota em failed; sem handler também falha', async () => {
  const original = functions.executeSql;
  const { error } = console;
  console.error = () => {};
  jobs.register('unit_fail', async () => { throw new Error('falha simulada'); });
  const log = fakeDb([
    { id: 10, type: 'unit_fail', payload: '{}', attempts: 2, max_attempts: 3 },
    { id: 11, type: 'unit_fail', payload: 'não-json', attempts: 3, max_attempts: 3 },
    { id: 12, type: 'tipo_inexistente', payload: '{}', attempts: 1, max_attempts: 1 },
  ]);
  try {
    const stats = await jobs.tick({ budgetMs: 5000 });
    assert.deepEqual([stats.retried, stats.failed], [1, 2]);
    assert.deepEqual(log.retried, [{ id: 10, delay: 120 }]);
    assert.deepEqual(log.failed, [11, 12]);
  } finally {
    functions.executeSql = original;
    console.error = error;
  }
});

test('jobs: drenagem oportunista desligada em NODE_ENV=test', () => {
  const original = functions.executeSql;
  let called = false;
  functions.executeSql = async () => { called = true; return {}; };
  try {
    delete process.env.JOBS_DRAIN_ON_WEBHOOK;
    jobs.drainSoon();
    assert.equal(called, false);
  } finally {
    functions.executeSql = original;
  }
});
