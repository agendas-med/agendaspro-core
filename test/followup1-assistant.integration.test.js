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
      await expect(200, 'POST', '/users/register', { body: { accept_terms: true, accept_terms: true, name: label, email, password } });
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
    await t.test('2: degraded/source na resposta da mensagem', async () => {
      const conv = await newConv(oa);
      const pick = r => [r.status, r.data.data.source, r.data.data.degraded];
      assert.deepEqual(pick(await say(oa, conv, 'agenda de hoje')), [200, 'template', false], 'roteador determinístico');
      route('none');
      plan.reply = () => ({ reply: 'Posso ajudar com agenda e estoque.' });
      assert.deepEqual(pick(await say(oa, conv, 'o que você sabe fazer de interessante')), [200, 'ai', false]);
      route('list_services');
      plan.reply = () => { throw new Error('redação fora'); };
      const tpl = await say(oa, conv, 'me conte sobre os procedimentos oferecidos');
      assert.deepEqual(pick(tpl), [200, 'template', true], 'template após falha da redação');
      assert.equal(tpl.data.data.usage.counted, true);
      plan.route = () => { throw new Error('classificação fora'); };
      const down = await say(oa, conv, 'uma pergunta aberta qualquer');
      assert.deepEqual(pick(down), [200, 'fallback', true]);
      assert.equal(down.data.data.usage.counted, false);
      route('none');
      plan.reply = () => ({ reply: 'Resposta da IA.' });
    });
    await t.test('3: base de conhecimento active + PATCH parcial', async () => {
      const rag = require('../services/assistant/rag');
      const embCount = async id => Number((await sql("SELECT COUNT(*) AS n FROM assistant_embeddings WHERE company_id = ? AND source_type = 'knowledge' AND source_id = ?", [A, id]))[0].n);
      const k = (await oa.expect(201, 'POST', '/assistant/knowledge', { kind: 'policy', title: 'Política de remarcação', content: 'Remarcações gratuitas com 48 horas de antecedência mínima.' })).data.data;
      assert.equal(k.active, true, 'padrão ativo');
      await rag.reconcile(A);
      assert.ok(await embCount(k.id) >= 1);

      const off = (await oa.expect(200, 'PATCH', `/assistant/knowledge/${k.id}`, { active: false })).data.data;
      assert.deepEqual([off.active, off.title, off.content], [false, k.title, k.content], 'parcial mantém os demais');
      assert.equal(await embCount(k.id), 0, 'inativo sai do RAG na hora');
      await rag.reconcile(A);
      assert.equal(await embCount(k.id), 0, 'reconcile não reindexa inativo');
      const listed = (await oa.expect(200, 'GET', '/assistant/knowledge')).data.data.find(i => i.id === k.id);
      assert.equal(listed.active, false);

      route('search_knowledge', { query: 'remarcação antecedência' });
      const r = await say(oa, await newConv(oa), 'qual a política de remarcação?');
      assert.equal(r.status, 200);
      assert.ok((r.data.data.citations || []).every(c => !(c.source_type === 'knowledge' && c.source_id === k.id)), 'item inativo não é citado');
      route('none');

      const put = (await oa.expect(200, 'PUT', `/assistant/knowledge/${k.id}`, { kind: 'policy', title: 'Remarcação', content: k.content })).data.data;
      assert.deepEqual([put.title, put.active], ['Remarcação', false], 'PUT sem active mantém o valor');
      const on = (await oa.expect(200, 'PATCH', `/assistant/knowledge/${k.id}`, { active: true })).data.data;
      assert.equal(on.active, true);
      await rag.reconcile(A);
      assert.ok(await embCount(k.id) >= 1, 'reativado volta ao RAG');

      assert.equal((await oa.call('PATCH', `/assistant/knowledge/${k.id}`, {})).status, 400, 'PATCH vazio');
      assert.equal((await oa.call('PATCH', `/assistant/knowledge/${k.id}`, { active: 'talvez' })).status, 400);
      assert.equal((await ob.call('PATCH', `/assistant/knowledge/${k.id}`, { active: false })).status, 404, 'outra empresa');
      assert.ok([401, 403].includes((await ma.call('PATCH', `/assistant/knowledge/${k.id}`, { active: false })).status), 'não admin');
      const inactiveNew = (await oa.expect(201, 'POST', '/assistant/knowledge', { kind: 'faq', title: 'Rascunho', content: 'Texto ainda não publicado.', active: false })).data.data;
      assert.equal(inactiveNew.active, false);
    });
    await t.test('4: reemissão do confirm_token (POST /actions/:id/token)', async () => {
      const customersService = require('../services/customersService');
      await customersService.create(A, 'Cliente Token', null, null, '11900001111', null, null);
      const custA = (await sql("SELECT id FROM customers WHERE company_id = ? AND name = 'Cliente Token'", [A]))[0].id;
      const today = require('../services/assistant/tools')._today();
      const conv = await newConv(oa);
      const propose = async hour => {
        route('create_appointment', { customer_id: custA, service_ids: [serviceA], date: `${today} ${hour}` });
        const r = await oa.expect(200, 'POST', `/assistant/conversations/${conv}/messages`, { message: `agende a cliente token às ${hour}` });
        route('none');
        return r.data.data.proposed_actions[0];
      };
      const p = await propose('16:00');
      const tokenUrl = `/assistant/actions/${p.action_id}/token`;
      const confirmUrl = `/assistant/actions/${p.action_id}/confirm`;
      const pending = (await oa.expect(200, 'GET', `/assistant/conversations/${conv}`)).data.data.pending_actions;
      assert.equal(pending.find(a => a.action_id === p.action_id).confirm_token, undefined, 'listagem segue sem token');

      const r1 = (await oa.expect(200, 'POST', tokenUrl)).data.data;
      assert.deepEqual([r1.action_id, r1.tool, r1.expires_at, r1.params_preview], [p.action_id, p.tool, p.expires_at, null], 'não estende a expiração');
      assert.ok(r1.confirm_token && r1.confirm_token !== p.confirm_token, 'token novo, nunca o antigo');
      assert.equal(errCode(await ma.call('POST', tokenUrl)), 'action_not_found', 'outro usuário');
      assert.equal(errCode(await ob.call('POST', tokenUrl)), 'action_not_found', 'outra empresa');
      assert.equal((await oa.call('POST', '/assistant/actions/xyz/token')).status, 404);
      assert.equal(errCode(await oa.call('POST', confirmUrl, { confirm_token: p.confirm_token })), 'invalid_confirm_token', 'token anterior invalidado');
      const r2 = (await oa.expect(200, 'POST', tokenUrl)).data.data;
      assert.equal(errCode(await oa.call('POST', confirmUrl, { confirm_token: r1.confirm_token })), 'invalid_confirm_token');
      const audits = await sql("SELECT * FROM assistant_audit WHERE company_id = ? AND event = 'action_token_reissued'", [A]);
      assert.equal(audits.length, 2);
      assert.ok(audits.every(a => !JSON.stringify(a).includes(r2.confirm_token)), 'auditoria não guarda token');
      assert.equal((await oa.expect(200, 'POST', confirmUrl, { confirm_token: r2.confirm_token })).data.data.status, 'executed');
      assert.equal(errCode(await oa.call('POST', tokenUrl)), 'action_already_processed');

      const p2 = await propose('17:00');
      await sql('UPDATE assistant_actions SET expires_at_ms = ? WHERE public_id = ?', [Date.now() - 1000, p2.action_id]);
      const expired = await oa.call('POST', `/assistant/actions/${p2.action_id}/token`);
      assert.deepEqual([expired.status, errCode(expired)], [410, 'action_expired']);

      const p3 = await propose('18:00');
      assert.equal((await oa.expect(200, 'POST', `/assistant/actions/${p3.action_id}/confirm`, { confirm_token: p3.confirm_token })).data.data.status, 'executed', 'token v0 (formato F5-B) segue válido');
      const saved = process.env.ASSISTANT_TOKEN_SECRET;
      delete process.env.ASSISTANT_TOKEN_SECRET;
      try {
        assert.equal(errCode(await oa.call('POST', `/assistant/actions/${p2.action_id}/token`)), 'assistant_actions_disabled');
      } finally { process.env.ASSISTANT_TOKEN_SECRET = saved; }
    });
    await t.test('5: erros com código (KB, 403 admin_required, 404 por recurso)', async () => {
      const shape = r => [r.status, errCode(r)];
      for (const [method, path, body] of [['GET', '/assistant/knowledge'], ['POST', '/assistant/knowledge', { kind: 'faq', title: 'x', content: 'y' }],
        ['PUT', '/assistant/knowledge/1', { kind: 'faq', title: 'x', content: 'y' }], ['PATCH', '/assistant/knowledge/1', { active: false }], ['DELETE', '/assistant/knowledge/1']]) {
        assert.deepEqual(shape(await ma.call(method, path, body)), [403, 'admin_required'], `${method} ${path}`);
      }
      const bad = await oa.call('POST', '/assistant/knowledge', { kind: 'outro', title: '' });
      assert.deepEqual(shape(bad), [400, 'validation_error']);
      assert.ok(bad.data.error.message && bad.data.error.fields.some(f => f.field === 'kind'));
      assert.ok(Array.isArray(bad.data.errors) && bad.data.errors.length >= 2, 'errors[] do F5-B mantido');
      assert.deepEqual(shape(await oa.call('PUT', '/assistant/knowledge/999999', { kind: 'faq', title: 'x', content: 'y' })), [404, 'knowledge_not_found']);
      assert.deepEqual(shape(await oa.call('DELETE', '/assistant/knowledge/999999')), [404, 'knowledge_not_found']);
      assert.deepEqual(shape(await oa.call('PATCH', '/assistant/knowledge/abc', { active: true })), [404, 'knowledge_not_found']);
      const own = (await oa.expect(201, 'POST', '/assistant/knowledge', { kind: 'faq', title: '  Com espaços  ', content: 'z' })).data.data;
      assert.equal(own.title, 'Com espaços', 'trim aplicado');
      assert.deepEqual(shape(await ob.call('DELETE', `/assistant/knowledge/${own.id}`)), [404, 'knowledge_not_found'], 'outra empresa');

      await sql("INSERT INTO assistant_knowledge (company_id, kind, title, content, created_by) SELECT ?, 'faq', CONCAT('t', seq), 'c', ? FROM seq_1_to_500", [B, ownerB.id]);
      try {
        const full = await ob.call('POST', '/assistant/knowledge', { kind: 'faq', title: 'x', content: 'y' });
        assert.deepEqual([...shape(full), full.data.error.limit], [409, 'knowledge_limit_reached', 500]);
      } finally { await sql('DELETE FROM assistant_knowledge WHERE company_id = ?', [B]); }

      assert.deepEqual(shape(await oa.call('GET', '/assistant/conversations/nao-e-id')), [404, 'conversation_not_found']);
      assert.deepEqual(shape(await say(oa, 'nao-e-id', 'oi')), [404, 'conversation_not_found']);
      assert.deepEqual(shape(await oa.call('POST', '/assistant/actions/zz/confirm', { confirm_token: 'x'.repeat(20) })), [404, 'action_not_found']);
      assert.deepEqual(shape(await oa.call('POST', '/assistant/actions/zz/reject')), [404, 'action_not_found']);
    });
    await t.test('6: created_at/updated_at em UTC real (ISO com Z = instante correto)', async () => {
      const near = (iso, label) => {
        assert.match(String(iso), /Z$/, label);
        assert.ok(Math.abs(Date.parse(iso) - Date.now()) < 120000, `${label}: ${iso} vs ${new Date().toISOString()}`);
      };
      const conv = await newConv(oa);
      await say(oa, conv, 'agenda de hoje');
      const got = (await oa.expect(200, 'GET', `/assistant/conversations/${conv}`)).data.data;
      near(got.created_at, 'conversa');
      for (const m of got.messages) near(m.created_at, `mensagem ${m.role}`);
      near((await oa.expect(200, 'GET', '/assistant/conversations')).data.data.find(c => c.id === conv).updated_at, 'listagem');
      const k = (await oa.expect(201, 'POST', '/assistant/knowledge', { kind: 'faq', title: 'Horário', content: 'Abrimos às 9h.' })).data.data;
      near(k.created_at, 'kb created_at');
      near(k.updated_at, 'kb updated_at');
    });
    await t.test('7: proposta negada (402/403/503) não consome cota nem grava a pergunta', async () => {
      const snapshot = async (companyId, conv) => {
        const [c] = await sql('SELECT id, message_count FROM assistant_conversations WHERE public_id = ?', [conv]);
        const [{ n }] = await sql('SELECT COUNT(*) AS n FROM assistant_messages WHERE conversation_id = ?', [c.id]);
        return { used: await usedNow(companyId), count: Number(c.message_count), rows: Number(n) };
      };
      const svc = { name: 'Massagem relaxante', value: 80, duration: 60 };
      const cases = [
        ['403 membro em ferramenta de admin', ma, A, 403, 'assistant_forbidden'],
        ['503 sem segredo', oa, A, 503, 'assistant_actions_disabled'],
        ['402 plano sem ações', ob, B, 402, null],
      ];
      for (const [label, who, companyId, status, code] of cases) {
        const conv = await newConv(who);
        await say(who, conv, 'agenda de hoje');
        const before = await snapshot(companyId, conv);
        const saved = process.env.ASSISTANT_TOKEN_SECRET;
        if (status === 503) delete process.env.ASSISTANT_TOKEN_SECRET;
        try {
          route('create_service', svc);
          const r = await say(who, conv, 'crie o serviço massagem relaxante por 80 reais com 60 minutos');
          assert.equal(r.status, status, label);
          if (code) assert.equal(errCode(r), code, label);
        } finally { process.env.ASSISTANT_TOKEN_SECRET = saved; route('none'); }
        assert.deepEqual(await snapshot(companyId, conv), before, `${label}: cota, message_count e histórico intactos`);
      }
      const conv = await newConv(oa);
      const before = await usedNow(A);
      route('create_service', svc);
      const ok = await say(oa, conv, 'crie o serviço massagem relaxante por 80 reais com 60 minutos');
      route('none');
      assert.equal(ok.status, 200);
      assert.equal(ok.data.data.proposed_actions?.[0]?.tool, 'create_service');
      assert.equal(await usedNow(A), before + 1, 'proposta criada conta');
    });
    await t.test('8: DELETE da conversa e id nas mensagens', async () => {
      const conv = await newConv(oa);
      const sent = (await oa.expect(200, 'POST', `/assistant/conversations/${conv}/messages`, { message: 'agenda de hoje' })).data.data;
      assert.ok(Number.isInteger(sent.user_message_id) && sent.message_id > sent.user_message_id);
      const got = (await oa.expect(200, 'GET', `/assistant/conversations/${conv}`)).data.data;
      assert.deepEqual(got.messages.map(m => m.id), [sent.user_message_id, sent.message_id]);
      route('create_service', { name: 'Drenagem', value: 90, duration: 50 });
      const proposal = (await oa.expect(200, 'POST', `/assistant/conversations/${conv}/messages`, { message: 'crie o serviço drenagem' })).data.data.proposed_actions[0];
      route('none');

      assert.deepEqual([(await ma.call('DELETE', `/assistant/conversations/${conv}`)).status, errCode(await ma.call('DELETE', `/assistant/conversations/${conv}`))], [404, 'conversation_not_found'], 'outro usuário');
      assert.equal(errCode(await ob.call('DELETE', `/assistant/conversations/${conv}`)), 'conversation_not_found', 'outra empresa');
      assert.equal(errCode(await oa.call('DELETE', '/assistant/conversations/zz')), 'conversation_not_found');
      const [row] = await sql('SELECT id FROM assistant_conversations WHERE public_id = ?', [conv]);

      assert.deepEqual((await oa.expect(200, 'DELETE', `/assistant/conversations/${conv}`)).data.data, { id: conv, deleted: true });
      assert.equal(errCode(await oa.call('GET', `/assistant/conversations/${conv}`)), 'conversation_not_found');
      assert.equal(errCode(await oa.call('DELETE', `/assistant/conversations/${conv}`)), 'conversation_not_found', 'idempotência: segunda vez 404');
      assert.equal((await sql('SELECT COUNT(*) AS n FROM assistant_messages WHERE conversation_id = ?', [row.id]))[0].n, 0, 'mensagens apagadas');
      assert.ok(!(await oa.expect(200, 'GET', '/assistant/conversations')).data.data.some(c => c.id === conv));
      assert.equal((await sql('SELECT status FROM assistant_actions WHERE public_id = ?', [proposal.action_id]))[0].status, 'expired');
      const late = await oa.call('POST', `/assistant/actions/${proposal.action_id}/confirm`, { confirm_token: proposal.confirm_token });
      assert.deepEqual([late.status, errCode(late)], [410, 'action_expired'], 'proposta da conversa apagada não executa');
      assert.equal((await sql("SELECT COUNT(*) AS n FROM assistant_audit WHERE company_id = ? AND event = 'conversation_deleted'", [A]))[0].n, 1);
    });

  } finally {
    require('../services/ai/provider').setProvider(null);
    if (server) await new Promise(resolve => server.close(resolve));
    if (pool) await new Promise(resolve => pool.end(() => resolve()));
    await adminQuery('DROP DATABASE IF EXISTS ??', [database]).catch(() => {});
    admin.end();
  }
});
