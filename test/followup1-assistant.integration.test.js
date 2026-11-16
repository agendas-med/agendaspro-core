process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql');
const { promisify } = require('node:util');

// Follow-up 1 (adendo do assistente, compatível com F5-B): status, degraded, base ativa/PATCH,
// reemissão do confirm_token, códigos de erro, created_at em UTC, cota, exclusão de conversa.
// IA = provider stub em memória; segredos falsos por execução.
const secret = () => crypto.randomBytes(32).toString('base64url');
function fakeEmbedding(text) {
  const v = new Float32Array(64);
  for (const word of String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]{3,}/g) || []) {
    v[crypto.createHash('md5').update(word).digest()[0] % 64] += 1;
  }
  return v;
}

test('Follow-up 1: adendo do assistente no MariaDB isolado', { skip: !process.env.MYSQL_ROOT_PASSWORD, timeout: 240000 }, async t => {
  const database = `agendaspro_fu1a_${process.pid}`;
  const admin = mysql.createConnection({ host: process.env.MYSQL_HOST, port: process.env.MYSQL_PORT, user: 'root', password: process.env.MYSQL_ROOT_PASSWORD });
  const adminQuery = promisify(admin.query).bind(admin);
  let server, pool;
  try {
    await adminQuery('CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', [database]);
    Object.assign(process.env, {
      MYSQL_DATABASE: database, MYSQL_USER: 'root', MYSQL_PASSWORD: process.env.MYSQL_ROOT_PASSWORD,
      ENABLE_INPROCESS_CRON: 'false', ASAAS_API_KEY: '', JWT_SECRET: secret(),
      APP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
      ADMIN_TOKEN: secret(), JOBS_TICK_TOKEN: secret(), ASAAS_WEBHOOK_TOKEN: secret(),
      ASAAS_SUBSCRIPTIONS_ENABLED: 'false', WHATSAPP_CLOUD_ENABLED: 'false', PUBLIC_CHAT_ENABLED: 'false',
      OPENAI_API_KEY: `sk-test-${secret()}`, OPENAI_EMBEDDING_MODEL: 'embedding-test',
      ASSISTANT_ENABLED: 'true', ASSISTANT_TOKEN_SECRET: secret(), ASSISTANT_RAG_ENABLED: 'true',
      ASSISTANT_RATE_PER_MIN: '1000', ASSISTANT_RAG_MIN_SCORE: '0.3',
    });
    for (const key of ['JWT_KEY', 'APP_TIMEZONE', 'OPENAI_MODEL_DEFAULT', 'AI_GLOBAL_DAILY_TOKENS', 'ASSISTANT_COMPANY_DAILY_TOKENS', 'ASSISTANT_RAG_INCLUDE_NOTES']) delete process.env[key];

    await require('../scripts/migrate')({ log: () => {} });
    const functions = require('../utils/functions');
    pool = require('../mysql').pool;
    const sql = functions.executeSql.bind(functions);
    const providerModule = require('../services/ai/provider');
    const assistant = require('../services/assistant/assistantService');

    const nulls = () => Object.fromEntries(Object.keys(assistant.CLASSIFY_SCHEMA.properties.args.properties).map(k => [k, null]));
    const plan = { route: () => ({ tool: 'none', args: nulls() }), reply: () => ({ reply: 'Resposta da IA.' }) };
    providerModule.setProvider({
      name: 'stub',
      async chat(request) {
        const out = request.schema?.name === 'assistant_route' ? plan.route(request) : plan.reply(request);
        return { content: typeof out === 'string' ? out : JSON.stringify(out), usage: { input: 200, output: 20 }, model: 'stub-chat' };
      },
      async embed({ input }) { return { vectors: input.map(fakeEmbedding), usage: { input: input.length * 10 } }; },
    });
    const route = (tool, args = {}) => { plan.route = () => ({ tool, args: { ...nulls(), ...args } }); };

    const app = require('../app');
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function call(method, path, { body, auth, company } = {}) {
      const response = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(company ? { 'Selected-company': String(company) } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: response.status, data, raw: text, headers: response.headers };
    }
    const expect = async (expected, ...args) => {
      const result = await call(...args);
      assert.equal(result.status, expected, `${args[0]} ${args[1]}: ${result.raw.slice(0, 400)}`);
      return result;
    };
    const errCode = r => r.data?.error?.code;

    const [business] = await sql('SELECT id FROM business_types LIMIT 1');
    async function account(label) {
      const email = `${label}-${process.pid}@agendaspro.test`;
      const password = `senha-${secret()}`;
      await expect(200, 'POST', '/users/register', { body: { name: label, email, password } });
      const login = (await expect(200, 'POST', '/users/login', { body: { email, password } })).data.returnObj;
      return { token: login.jwtToken, id: login.id };
    }
    async function company(owner, name, document) {
      return (await expect(200, 'POST', '/companies/create_company', {
        auth: owner.token,
        body: { name, address: 'Rua de Testes', zip_code: '01310-100', city: 'São Paulo', state: 'SP', business_type: business.id, email: 'clinica@example.test', phone: '11999999999', document, address_number: '10', complement: '', birthDate: '1990-01-01', incomeValue: 5000 },
      })).data.returnObj.id;
    }
    const ownerA = await account('dono-a');
    const ownerB = await account('dono-b');
    const memberA = await account('membro-a');
    const A = await company(ownerA, 'Clínica A', '52998224725');
    const B = await company(ownerB, 'Clínica B', '11144477735');
    await sql('INSERT INTO company_members (company_id, user_id) VALUES (?, ?)', [A, memberA.id]);
    const as = (user, companyId) => ({
      call: (method, path, body) => call(method, path, { body, auth: user.token, company: companyId }),
      expect: (status, method, path, body) => expect(status, method, path, { body, auth: user.token, company: companyId }),
    });
    const oa = as(ownerA, A), ma = as(memberA, A), ob = as(ownerB, B);
    const premium = async companyId => {
      const [p] = await sql("SELECT id, price_cents FROM plans WHERE code = 'premium'");
      const sub = (await sql("INSERT INTO company_subscriptions (company_id, plan_id, price_cents, status) VALUES (?, ?, ?, 'active')", [companyId, p.id, p.price_cents])).insertId;
      await sql("INSERT INTO subscription_invoices (company_id, subscription_id, plan_id, provider_payment_id, amount_cents, status, due_date, period_start, period_end) VALUES (?, ?, ?, ?, ?, 'paid', CURDATE(), NOW() - INTERVAL 1 DAY, NOW() + INTERVAL 29 DAY)", [companyId, sub, p.id, `pay_fu1a_${companyId}`, p.price_cents]);
    };
    const serviceA = (await sql('INSERT INTO services (name, duration, value, cost, company_id, requires_location, accepts_quantity) VALUES (?, 30, 40, 5, ?, 0, 0)', ['Limpeza de pele', A])).insertId;
    const newConv = async who => (await who.expect(201, 'POST', '/assistant/conversations')).data.data.id;
    const say = (who, conv, message) => who.call('POST', `/assistant/conversations/${conv}/messages`, { message });
    const usedNow = async companyId => Number((await sql("SELECT used FROM usage_counters WHERE company_id = ? AND metric = 'assistant_monthly_interactions'", [companyId]))[0]?.used || 0);

    await t.test('1: GET /assistant/status (somente leitura, funciona desligado)', async () => {
      const s = (await oa.expect(200, 'GET', '/assistant/status')).data.data;
      assert.equal(s.enabled, true);
      assert.equal(s.plan.code, 'free');
      assert.equal(s.role, 'admin');
      assert.deepEqual(s.usage, { interactions_used: 0, interactions_limit: 30, period: s.usage.period });
      assert.match(s.usage.period, /^\d{4}-\d{2}$/);
      assert.deepEqual(s.actions, { enabled: false, reason: 'plan', tools: [] });
      assert.equal(s.ai_available, true);
      assert.ok(s.read_tools.includes('get_schedule'));
      assert.equal((await sql('SELECT COUNT(*) AS n FROM usage_counters WHERE company_id = ?', [A]))[0].n, 0, 'status não cria contador');

      const conv = await newConv(oa);
      await say(oa, conv, 'agenda de hoje');
      assert.equal((await oa.expect(200, 'GET', '/assistant/status')).data.data.usage.interactions_used, 1);

      const m = (await ma.expect(200, 'GET', '/assistant/status')).data.data;
      assert.equal(m.role, 'member');
      assert.equal(m.knowledge_admin, false);

      process.env.ASSISTANT_ENABLED = 'false';
      try {
        const off = (await oa.expect(200, 'GET', '/assistant/status')).data.data;
        assert.equal(off.enabled, false);
        assert.deepEqual([off.actions.enabled, off.actions.reason, off.ai_available], [false, 'assistant_disabled', false]);
        assert.equal(errCode(await oa.call('GET', '/assistant/conversations')), 'assistant_disabled', 'demais rotas seguem 503');
      } finally { process.env.ASSISTANT_ENABLED = 'true'; }

      assert.equal((await call('GET', '/assistant/status')).status, 401);
      assert.ok([401, 403].includes((await as(ownerA, B).call('GET', '/assistant/status')).status));

      await premium(A);
      const p = (await oa.expect(200, 'GET', '/assistant/status')).data.data;
      assert.deepEqual([p.plan.code, p.actions.enabled, p.actions.reason, p.usage.interactions_limit], ['premium', true, null, 1000]);
      assert.ok(p.actions.tools.includes('create_service') && p.actions.tools.includes('cancel_appointment'));
      const pm = (await ma.expect(200, 'GET', '/assistant/status')).data.data;
      assert.ok(pm.actions.tools.includes('cancel_appointment') && !pm.actions.tools.includes('create_service'), 'membro não vê ferramentas de admin');
      const saved = process.env.ASSISTANT_TOKEN_SECRET;
      delete process.env.ASSISTANT_TOKEN_SECRET;
      try {
        assert.deepEqual((await oa.expect(200, 'GET', '/assistant/status')).data.data.actions, { enabled: false, reason: 'not_configured', tools: [] });
      } finally { process.env.ASSISTANT_TOKEN_SECRET = saved; }
      assert.equal((await ob.expect(200, 'GET', '/assistant/status')).data.data.plan.code, 'free', 'plano é da empresa do header');
    });
  } finally {
    require('../services/ai/provider').setProvider(null);
    if (server) await new Promise(resolve => server.close(resolve));
    if (pool) await new Promise(resolve => pool.end(() => resolve()));
    await adminQuery('DROP DATABASE IF EXISTS ??', [database]).catch(() => {});
    admin.end();
  }
});
