process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Chave efêmera gerada no próprio teste (nunca versionada).
process.env.APP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const { encrypt, decrypt, isEncrypted, safeEqual, sha256, randomToken } = require('../../utils/crypto');
const functions = require('../../utils/functions');
const { sendError, errorHandler, HttpError, GENERIC_MESSAGE } = require('../../middleware/errorHandler');
const requireToken = require('../../middleware/requireToken');
const webhookAuth = require('../../middleware/webhookAuth');
const rateLimit = require('../../middleware/rateLimit');
const validate = require('../../middleware/validate');

function fakeRes() {
  const res = { statusCode: 200, body: undefined, headers: {}, headersSent: false };
  res.status = code => { res.statusCode = code; return res; };
  res.send = body => { res.body = body; res.headersSent = true; return res; };
  res.json = res.send;
  res.set = (k, v) => { res.headers[k] = v; return res; };
  return res;
}
function fakeReq({ headers = {}, query = {}, ip = '10.0.0.1' } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: lower, query, ip, method: 'GET', path: '/x', get: name => lower[name.toLowerCase()] };
}
async function run(mw, req) {
  const res = fakeRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}
const quiet = fn => async () => {
  const { error, warn } = console;
  console.error = () => {}; console.warn = () => {};
  try { await fn(); } finally { console.error = error; console.warn = warn; }
};

test('crypto: AES-256-GCM ida e volta, legado em texto puro e adulteração', () => {
  const stored = encrypt('chave-asaas-de-teste');
  assert.ok(isEncrypted(stored));
  assert.ok(!stored.includes('chave-asaas-de-teste'));
  assert.notEqual(encrypt('x'), encrypt('x'), 'IV aleatório');
  assert.equal(decrypt(stored), 'chave-asaas-de-teste');
  assert.equal(decrypt('legado-texto-puro'), 'legado-texto-puro');
  assert.equal(encrypt(stored), stored, 'não cifra duas vezes');
  const parts = stored.split(':');
  const data = Buffer.from(parts[4], 'base64'); data[0] ^= 1; parts[4] = data.toString('base64');
  assert.throws(() => decrypt(parts.join(':')));
  const saved = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = Buffer.alloc(16).toString('base64');
  assert.throws(() => encrypt('x'), /32 bytes/);
  process.env.APP_ENCRYPTION_KEY = saved;
});

test('crypto: safeEqual, sha256 e randomToken', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('', ''), false, 'esperado vazio nunca autoriza');
  assert.equal(safeEqual(undefined, 'abc'), false);
  assert.equal(sha256('a').length, 64);
  assert.ok(Buffer.from(randomToken(32), 'base64url').length === 32);
});

test('requireToken: só header, tempo constante, desabilita sem env', quiet(async () => {
  delete process.env.TEST_ADMIN_TOKEN;
  assert.equal((await run(requireToken('TEST_ADMIN_TOKEN'), fakeReq())).res.statusCode, 503);
  process.env.TEST_ADMIN_TOKEN = 'token-admin-de-teste-com-32-caracteres!';
  const mw = requireToken('TEST_ADMIN_TOKEN');
  assert.equal((await run(mw, fakeReq({ headers: { authorization: 'Bearer errado' } }))).res.statusCode, 401);
  assert.equal((await run(mw, fakeReq({ query: { token: process.env.TEST_ADMIN_TOKEN } }))).nextCalled, false, 'query string não vale');
  assert.equal((await run(mw, fakeReq({ headers: { authorization: `Bearer ${process.env.TEST_ADMIN_TOKEN}` } }))).nextCalled, true);
  assert.equal((await run(mw, fakeReq({ headers: { 'x-admin-token': process.env.TEST_ADMIN_TOKEN } }))).nextCalled, true);
}));

test('webhookAuth: token separado de entrada, só header', quiet(async () => {
  delete process.env.WEBHOOK_SECRET_TOKEN;
  delete process.env.WHATSAPP_INBOUND_TOKEN;
  assert.equal((await run(webhookAuth, fakeReq())).res.statusCode, 503);
  process.env.WHATSAPP_INBOUND_TOKEN = 'inbound-de-teste-com-32-caracteres-xx';
  process.env.WHATSAPP_OUTBOUND_TOKEN = 'outbound-de-teste-com-32-caracteres-x';
  assert.equal((await run(webhookAuth, fakeReq({ query: { token: process.env.WHATSAPP_INBOUND_TOKEN } }))).res.statusCode, 401);
  assert.equal((await run(webhookAuth, fakeReq({ headers: { authorization: `Bearer ${process.env.WHATSAPP_OUTBOUND_TOKEN}` } }))).res.statusCode, 401, 'token de saída não autentica entrada');
  assert.equal((await run(webhookAuth, fakeReq({ headers: { authorization: `Bearer ${process.env.WHATSAPP_INBOUND_TOKEN}` } }))).nextCalled, true);
  assert.equal((await run(webhookAuth, fakeReq({ headers: { apikey: process.env.WHATSAPP_INBOUND_TOKEN } }))).nextCalled, true);
}));

test('errorHandler: erro interno vira mensagem genérica com correlation id, sem SQL', quiet(() => {
  const sqlError = Object.assign(new Error("ER_PARSE_ERROR near 'DROP TABLE users'"), { code: 'ER_PARSE_ERROR', sql: 'SELECT * FROM users WHERE x = 1', sqlMessage: 'bad' });
  const req = fakeReq();
  const res = fakeRes();
  sendError(req, res, sqlError, 400);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.message, GENERIC_MESSAGE);
  assert.match(res.body.correlation_id, /^[a-f0-9]{16}$/);
  assert.ok(!JSON.stringify(res.body).includes('DROP'));

  const axiosLike = Object.assign(new Error('Request failed'), { isAxiosError: true, response: { data: { errors: [{ description: 'walletId de outra conta' }] } } });
  const res2 = fakeRes();
  sendError(fakeReq(), res2, axiosLike, 400, { text: true });
  assert.equal(res2.statusCode, 500);
  assert.ok(!String(res2.body).includes('walletId'), 'nunca devolve erro bruto do Asaas');

  const res3 = fakeRes();
  sendError(fakeReq(), res3, new Error('Já existe um agendamento neste intervalo.'), 400, { text: true });
  assert.equal(res3.statusCode, 400);
  assert.equal(res3.body, 'Já existe um agendamento neste intervalo.');

  const res4 = fakeRes();
  sendError(fakeReq(), res4, new HttpError(404, 'Cliente não encontrado.'));
  assert.deepEqual([res4.statusCode, res4.body], [404, { message: 'Cliente não encontrado.' }]);

  const res5 = fakeRes();
  sendError(fakeReq(), res5, { message: 'Sem permissão', request: { status: 401 } });
  assert.equal(res5.statusCode, 401);

  const res6 = fakeRes();
  errorHandler({ type: 'entity.too.large' }, fakeReq(), res6, () => {});
  assert.equal(res6.statusCode, 413);
  const res7 = fakeRes();
  errorHandler(new TypeError('x is undefined'), fakeReq(), res7, () => {});
  assert.equal(res7.statusCode, 500);
  assert.ok(res7.body.correlation_id);
}));

test('rateLimit: bloqueia acima do máximo com Retry-After e é fail-open', quiet(async () => {
  const original = functions.executeSql;
  const counters = new Map();
  functions.executeSql = async (sql, params) => {
    if (sql.startsWith('INSERT INTO rate_limits')) {
      const hits = (counters.get(params[0]) || 0) + 1;
      counters.set(params[0], hits);
      return { insertId: hits === 1 ? 0 : hits };
    }
    return { affectedRows: 0 };
  };
  try {
    const mw = rateLimit({ key: 'login', windowSec: 60, max: 2 });
    assert.equal((await run(mw, fakeReq())).nextCalled, true);
    assert.equal((await run(mw, fakeReq())).nextCalled, true);
    const blocked = await run(mw, fakeReq());
    assert.equal(blocked.res.statusCode, 429);
    assert.ok(Number(blocked.res.headers['Retry-After']) >= 1);
    assert.equal((await run(mw, fakeReq({ ip: '10.0.0.2' }))).nextCalled, true, 'chave inclui o IP');
    functions.executeSql = async () => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); };
    assert.equal((await run(mw, fakeReq())).nextCalled, true, 'falha do banco não derruba a rota');
  } finally {
    functions.executeSql = original;
  }
}));

test('selected-company: só inteiro positivo', () => {
  for (const bad of [undefined, '', '0', '-1', '1 OR 1=1', '1;DROP TABLE x', '1e3', '12345678901', ' ', 'abc']) {
    assert.equal(validate.parseCompanyId(bad), null, String(bad));
  }
  assert.equal(validate.parseCompanyId('42'), 42);
});

test('Joi: autenticação, horários e cliente', () => {
  const { users, companies, customers } = validate.schemas;
  assert.ok(users.register.validate({ name: 'Ana', email: 'ana@example.test', password: 'curta' }).error, 'senha nova >= 8');
  assert.ok(!users.register.validate({ name: 'Ana', email: 'ana@example.test', password: 'senha-longa-ok' }).error);
  assert.ok(users.login.validate({ email: "x' OR 1=1 --", password: 'a' }).error);
  assert.ok(users.login.validate({ email: 'a@example.test', password: 'a', extra: 1 }).error, 'campos desconhecidos rejeitados');
  assert.ok(users.checkJwt.validate({}).error, 'exige token ou refresh_token');
  assert.ok(!users.checkJwt.validate({ refresh_token: 'r'.repeat(43) }).error);
  assert.ok(users.refresh.validate({ refresh_token: 'curto' }).error);

  const hours = day => ({ configurations: { opening_hours: [day] } });
  const edit = companies.editCompany;
  const bad = [
    { day: 1, hours: [{ initial_date: "08:00'; DROP TABLE companies; --", final_date: '18:00' }] },
    { day: 1, hours: [{ initial_date: '25:00', final_date: '18:00' }] },
    { day: '1 OR 1=1', hours: [] },
    { day: 8, hours: [] },
  ];
  for (const day of bad) assert.ok(edit.validate(hours(day), { allowUnknown: true }).error, JSON.stringify(day));
  const good = edit.validate(hours({ day: 1, hours: [{ initial_date: '08:00', final_date: '18:00' }] }), { allowUnknown: true });
  assert.ok(!good.error || !good.error.details.some(d => d.path.includes('opening_hours')), good.error?.message);

  const customer = { name: 'Cliente', cpf: '12345678901', tel: '11999999999', image: '', email: '' };
  assert.ok(!customers.createCustomer.validate({ ...customer, birthday: null }).error, 'birthday opcional (null)');
  assert.ok(!customers.createCustomer.validate({ ...customer, birthday: '' }).error, 'birthday opcional (vazio)');
  assert.ok(!customers.createCustomer.validate(customer).error, 'birthday ausente');
});
