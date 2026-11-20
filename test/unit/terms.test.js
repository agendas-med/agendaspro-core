process.env.NODE_ENV = 'test';
process.env.JWT_KEY ||= 'unit-test-only-jwt-key-with-32-chars!!';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const axios = require('axios');
const functions = require('../../utils/functions');
const schemas = require('../../schemas/users');
const usersRouter = require('../../routes/users');
const { TERMS_VERSION } = require('../../config/legal');

// Aceite dos Termos (LGPD): sem banco. O SQL é capturado por stub de functions.executeSql.
const MESSAGE = 'É preciso aceitar os Termos de Uso e a Política de Privacidade.';
const base = { name: 'Ana', email: 'ana@example.test', password: 'senha-longa-ok' };

function stubDb(handler) {
  const calls = [];
  const original = functions.executeSql;
  functions.executeSql = async (sql, params) => {
    calls.push({ sql, params });
    if (/rate_limits|refresh_tokens/.test(sql)) return { insertId: 1 };
    return handler(sql, params);
  };
  return { calls, restore: () => { functions.executeSql = original; } };
}

function listen() {
  const app = express();
  app.use(express.json());
  app.use('/users', usersRouter);
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function post(server, path, body) {
  return fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('schema register: accept_terms é obrigatório e somente true', () => {
  const missing = schemas.register.validate(base);
  assert.equal(missing.error.details[0].message, MESSAGE);
  for (const value of [false, 'true', 1, null]) {
    assert.ok(schemas.register.validate({ ...base, accept_terms: value }).error, `aceitou ${JSON.stringify(value)}`);
  }
  assert.equal(schemas.register.validate({ ...base, accept_terms: true }).error, undefined);
});

test('POST /users/register: sem aceite -> 400 sem gravar; com aceite -> grava data, versão e IP', async () => {
  const db = stubDb(async () => ({ insertId: 7 }));
  const server = await listen();
  try {
    const rejected = await post(server, '/users/register', base);
    assert.equal(rejected.status, 400);
    assert.equal(db.calls.filter(c => /INSERT INTO users/.test(c.sql)).length, 0);

    const accepted = await post(server, '/users/register', { ...base, accept_terms: true });
    assert.equal(accepted.status, 200);
    const insert = db.calls.find(c => /INSERT INTO users/.test(c.sql));
    assert.match(insert.sql, /terms_accepted_at, terms_version, terms_accept_ip\) VALUES \(\?, \?, \?, NOW\(\), \?, \?\)/);
    assert.equal(insert.params[3], TERMS_VERSION);
    assert.ok(insert.params[4], 'IP do aceite gravado');
  } finally {
    server.closeAllConnections();
    server.close();
    db.restore();
  }
});

async function googleLogin(existingRows) {
  const originalPost = axios.post;
  const originalGet = axios.get;
  axios.post = async () => ({ data: { access_token: 'access-token-stub' } });
  axios.get = async () => ({ data: { id: 'g-123', email: 'ana@example.test', given_name: 'Ana', picture: 'https://example.test/p.png' } });
  const db = stubDb(async (sql) => {
    if (/SELECT id FROM users WHERE code/.test(sql)) return existingRows;
    if (/INSERT INTO users/.test(sql)) return { insertId: 42 };
    if (/SELECT id, email, name FROM users/.test(sql)) return [{ id: 42, email: 'ana@example.test', name: 'Ana' }];
    return [];
  });
  const server = await listen();
  try {
    const response = await post(server, '/users/google-login', { token: 'auth-code-stub' });
    assert.equal(response.status, 200);
    return db.calls;
  } finally {
    server.closeAllConnections();
    server.close();
    db.restore();
    axios.post = originalPost;
    axios.get = originalGet;
  }
}

test('login Google: conta nova grava aceite por texto (data, versão e IP)', async () => {
  const calls = await googleLogin([]);
  const insert = calls.find(c => /INSERT INTO users \(code/.test(c.sql));
  assert.ok(insert, 'conta nova criada');
  assert.match(insert.sql, /terms_accepted_at, terms_version, terms_accept_ip\) VALUES \(\?, \?, \?, \?, NOW\(\), \?, \?\)/);
  assert.equal(insert.params[4], TERMS_VERSION);
  assert.ok(insert.params[5], 'IP do aceite gravado');
});

test('login Google: conta existente não recebe novo aceite (sem INSERT)', async () => {
  const calls = await googleLogin([{ id: 5 }]);
  assert.equal(calls.filter(c => /INSERT INTO users/.test(c.sql)).length, 0);
});
