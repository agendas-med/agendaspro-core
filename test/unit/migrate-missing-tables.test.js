process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createMissingBaselineTables } = require('../../scripts/migrate');

const BASELINE = path.join(__dirname, '../../sql/migrations/001_baseline.sql');

function columnsOf(table) {
  const baseline = require('node:fs').readFileSync(BASELINE, 'utf8');
  const block = baseline.slice(baseline.indexOf('CREATE TABLE `' + table + '`'));
  const body = block.slice(0, block.indexOf(') ENGINE'));
  return [...body.matchAll(/^\s*`([^`]+)`/gm)].map((m) => ({ name: m[1] }));
}

function fakeDb(existing) {
  const ran = [];
  const query = async (sql, params) => {
    ran.push(sql);
    if (/^SHOW FULL TABLES/i.test(sql)) return existing.map((name) => ({ Tables_in_db: name, Table_type: 'BASE TABLE' }));
    if (/information_schema\.columns/i.test(sql)) return columnsOf(params[0]);
    return [];
  };
  return { ran, query };
}

test('migrate: cria só as tabelas do baseline que faltam, com FK desligada e religada', async () => {
  const { ran, query } = fakeDb(['companies', 'users']);
  const created = await createMissingBaselineTables(query, BASELINE);
  assert.ok(created.includes('whatsapp_sessions'));
  assert.ok(!created.includes('companies'));
  assert.ok(!created.includes('users'));
  assert.equal(ran[1], 'SET FOREIGN_KEY_CHECKS = 0');
  assert.equal(ran[ran.length - 1], 'SET FOREIGN_KEY_CHECKS = 1');
  assert.ok(!ran.some((sql) => /^DROP\s+TABLE/i.test(sql)), 'nunca derruba tabela existente');
});

test('migrate: banco já completo não recebe nenhum CREATE', async () => {
  const all = (await createMissingBaselineTables(fakeDb([]).query, BASELINE));
  const { ran, query } = fakeDb(all);
  const created = await createMissingBaselineTables(query, BASELINE);
  assert.deepEqual(created, []);
  assert.ok(!ran.some((sql) => /^CREATE TABLE/i.test(sql)));
});

test('migrate: adiciona só a coluna ausente em tabela existente (ex.: appointments.notified_1h)', async () => {
  const ran = [];
  const query = async (sql, params) => {
    ran.push(sql);
    if (/^SHOW FULL TABLES/i.test(sql)) return [{ t: 'appointments' }];
    if (/information_schema\.columns/i.test(sql)) {
      const baseline = require('node:fs').readFileSync(BASELINE, 'utf8');
      const block = baseline.slice(baseline.indexOf('CREATE TABLE `appointments`'));
      const body = block.slice(0, block.indexOf(') ENGINE'));
      return [...body.matchAll(/^\s*`([^`]+)`/gm)].map((m) => ({ name: m[1] })).filter((c) => c.name !== 'notified_1h');
    }
    return [];
  };
  const changes = await createMissingBaselineTables(query, BASELINE);
  assert.ok(changes.includes('appointments.notified_1h'));
  const alters = ran.filter((sql) => /^ALTER TABLE `appointments`/.test(sql));
  assert.equal(alters.length, 1);
  assert.match(alters[0], /ADD COLUMN `notified_1h` tinyint\(1\) DEFAULT 0$/);
});
