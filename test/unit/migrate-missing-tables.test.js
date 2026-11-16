process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createMissingBaselineTables } = require('../../scripts/migrate');

const BASELINE = path.join(__dirname, '../../sql/migrations/001_baseline.sql');

function fakeDb(existing) {
  const ran = [];
  const query = async (sql) => {
    ran.push(sql);
    if (/^SHOW FULL TABLES/i.test(sql)) return existing.map((name) => ({ Tables_in_db: name, Table_type: 'BASE TABLE' }));
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
