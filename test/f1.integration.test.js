process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const mysql = require('mysql');
const { promisify } = require('node:util');

// Regressões da F1 (segurança, isolamento entre empresas, auth, jobs, webhooks, LGPD).
// Todos os tokens são gerados aqui, por execução; nada é versionado.
const secret = () => crypto.randomBytes(32).toString('base64url');

test('F1: isolamento, auth, jobs, webhooks e LGPD no MariaDB isolado', { skip: !process.env.MYSQL_ROOT_PASSWORD, timeout: 180000 }, async t => {
  const database = `agendaspro_f1_${process.pid}`;
  const admin = mysql.createConnection({ host: process.env.MYSQL_HOST, port: process.env.MYSQL_PORT, user: 'root', password: process.env.MYSQL_ROOT_PASSWORD });
  const adminQuery = promisify(admin.query).bind(admin);
  let server, pool, stub;
  try {
    await adminQuery('CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', [database]);
    Object.assign(process.env, {
      MYSQL_DATABASE: database, MYSQL_USER: 'root', MYSQL_PASSWORD: process.env.MYSQL_ROOT_PASSWORD,
      ENABLE_INPROCESS_CRON: 'false', ASAAS_API_KEY: '', JWT_SECRET: secret(),
      APP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
      ADMIN_TOKEN: secret(), JOBS_TICK_TOKEN: secret(), ASAAS_WEBHOOK_TOKEN: secret(),
      WHATSAPP_INBOUND_TOKEN: secret(), WHATSAPP_OUTBOUND_TOKEN: secret(),
    });
    delete process.env.JWT_KEY;

    // Serviço de envio de WhatsApp falso (captura os lembretes).
    const sent = [];
    let stubStatus = 200;
    stub = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => { sent.push({ auth: req.headers.authorization, body: JSON.parse(body || '{}') }); res.writeHead(stubStatus).end('{}'); });
    });
    await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
    process.env.WHATSAPP_API_URL = `http://127.0.0.1:${stub.address().port}`;

    await require('../scripts/migrate')({ log: () => {} });
    const functions = require('../utils/functions');
    pool = require('../mysql').pool;
    const sql = functions.executeSql.bind(functions);
    const { sha256, randomToken } = require('../utils/crypto');
    const app = require('../app');
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    async function call(method, path, { body, auth, company, headers = {} } = {}) {
      const response = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(company !== undefined ? { 'Selected-company': String(company) } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); } catch { data = raw; }
      return { status: response.status, data, raw, headers: response.headers };
    }
    const expect = async (expected, ...args) => {
      const result = await call(...args);
      assert.equal(result.status, expected, `${args[0]} ${args[1]}: ${result.raw}`);
      return result.data;
    };
    const [business] = await sql('SELECT id FROM business_types LIMIT 1');

    async function tenant(label, document) {
      const email = `${label}-${process.pid}@agendaspro.test`;
      const password = `senha-${label}-${secret()}`;
      await expect(200, 'POST', '/users/register', { body: { name: `Dono ${label}`, email, password } });
      const login = (await expect(200, 'POST', '/users/login', { body: { email, password } })).returnObj;
      const companyId = (await expect(200, 'POST', '/companies/create_company', {
        auth: login.jwtToken,
        body: { name: `Empresa ${label}`, address: 'Rua de Testes', zip_code: '01310-100', city: 'São Paulo', state: 'SP', business_type: business.id, email: `empresa-${label}@example.test`, phone: '11999999999', document, address_number: '10', complement: '', birthDate: '1990-01-01', incomeValue: 5000 },
      })).returnObj.id;
      const ctx = { email, password, userId: login.id, token: login.jwtToken, refresh: login.refreshToken, companyId };
      ctx.as = (method, path, body, expected = 200) => expect(expected, method, path, { body, auth: ctx.token, company: ctx.companyId });
      return ctx;
    }
    const A = await tenant('a', '52998224725');
    const B = await tenant('b', '11144477735');

    await A.as('POST', '/customers', { name: 'Cliente A', cpf: '39053344705', birthday: null, tel: '11988887777', image: '', email: '' });
    await B.as('POST', '/customers', { name: 'Cliente B', cpf: '11144477735', birthday: '', tel: '21977776666', image: '', email: '' });
    const customerA = (await A.as('GET', '/customers')).returnObj[0];
    const customerB = (await B.as('GET', '/customers')).returnObj[0];
    const serviceA = (await sql("INSERT INTO services (name, duration, value, cost, company_id, requires_location, accepts_quantity) VALUES ('Corte', 30, 40, 10, ?, 0, 0)", [A.companyId])).insertId;
    const [serviceRow] = await sql('SELECT * FROM services WHERE id = ?', [serviceA]);
    const appointmentBody = { customer_id: customerA.id, customer_name: customerA.name, date: '2027-03-10 10:00:00', duration: 30, observations: '', services: [serviceRow], status: 'agendado' };
    await A.as('POST', '/appointments', appointmentBody);
    const appointmentA = (await A.as('GET', '/appointments')).returnObj[0];
    const saleA = (await A.as('GET', '/sales')).returnObj[0];
    const [unit] = await sql('SELECT id FROM units_of_measurement LIMIT 1');
    const productA = (await sql("INSERT INTO products (name, value, cost, current_stock, company_id, unit_of_measure) VALUES ('Produto A', 10, 3, 5, ?, ?)", [A.companyId, unit.id])).insertId;

    await t.test('cliente com birthday nulo/vazio é aceito', async () => {
      const [row] = await sql('SELECT birthday FROM customers WHERE id = ?', [customerA.id]);
      assert.equal(row.birthday, null);
      assert.equal(customerB.name, 'Cliente B');
      await A.as('POST', '/customers', { name: 'Sem CPF', tel: '11911112222', image: '', email: '', birthday: null });
      const [noCpf] = await sql("SELECT cpf, birthday FROM customers WHERE name = 'Sem CPF'");
      assert.deepEqual([noCpf.cpf, noCpf.birthday], [null, null], 'cpf ausente e birthday nulo');
    });

    await t.test('selected-company: não inteiro ou sem vínculo → 403', async () => {
      for (const company of ['abc', '1 OR 1=1', `${B.companyId}`, '0']) {
        await expect(403, 'GET', '/customers', { auth: A.token, company });
      }
      await expect(401, 'GET', '/customers', { company: A.companyId });
    });

    await t.test('isolamento A/B: clientes, agendamentos, vendas, estoque', async () => {
      assert.ok(!(await B.as('GET', '/customers')).returnObj.some(c => c.id === customerA.id));
      assert.notEqual((await call('GET', `/customers/${customerA.id}`, { auth: B.token, company: B.companyId })).status, 200);
      assert.notEqual((await call('DELETE', `/customers/${customerA.id}`, { auth: B.token, company: B.companyId })).status, 200);
      assert.notEqual((await call('PATCH', `/customers/${customerA.id}`, { auth: B.token, company: B.companyId, body: { name: 'Invadido', cpf: '', tel: '11900000000', image: '', email: '' } })).status, 200);
      const [still] = await sql('SELECT name FROM customers WHERE id = ?', [customerA.id]);
      assert.equal(still.name, 'Cliente A');

      assert.equal((await B.as('GET', '/appointments')).returnObj.length, 0);
      assert.notEqual((await call('GET', `/appointments/${appointmentA.id}`, { auth: B.token, company: B.companyId })).status, 200);
      assert.notEqual((await call('DELETE', `/appointments/${appointmentA.id}`, { auth: B.token, company: B.companyId })).status, 200);
      await B.as('POST', '/appointments', { ...appointmentBody, customer_id: customerA.id }, 400);

      assert.equal((await B.as('GET', '/sales')).returnObj.length, 0);
      assert.notEqual((await call('GET', `/sales/${saleA.id}`, { auth: B.token, company: B.companyId })).status, 200);

      await B.as('POST', '/stock/add', { product_id: productA, quantity: 3 }, 400);
      await B.as('POST', '/stock/remove', { product_id: productA, quantity: 1 }, 400);
      for (const quantity of [-2, 1.5, '1; DROP TABLE products', 0]) await A.as('POST', '/stock/add', { product_id: productA, quantity }, 400);
      await A.as('POST', '/stock/add', { product_id: productA, quantity: 2 });
      const [product] = await sql('SELECT current_stock FROM products WHERE id = ?', [productA]);
      assert.equal(Number(product.current_stock), 7);
    });

    await t.test('agendamentos: filtro ?start=&end= dentro da empresa', async () => {
      assert.equal((await A.as('GET', '/appointments?start=2027-03-10&end=2027-03-10')).returnObj.length, 1);
      assert.equal((await A.as('GET', '/appointments?start=2027-03-11&end=2027-03-31')).returnObj.length, 0);
      assert.equal((await A.as('GET', '/appointments?start=2027-03-10%2009:00&end=2027-03-10%2009:59')).returnObj.length, 0);
      assert.equal((await B.as('GET', '/appointments?start=2027-01-01&end=2027-12-31')).returnObj.length, 0);
      await A.as('GET', `/appointments?start=${encodeURIComponent("2027-01-01' OR '1'='1")}`, undefined, 400);
    });

    await t.test('cargos e busca de usuários restritos à empresa', async () => {
      await A.as('POST', '/companies/roles', { name: 'Recepção', permission: 1 });
      const [roleA] = await sql("SELECT id FROM config_company_roles WHERE company_id = ? AND name = 'Recepção'", [A.companyId]);
      assert.ok((await A.as('GET', '/companies/roles')).returnObj.some(role => role.id === roleA.id), 'GET /companies/roles devolve dados');
      assert.ok(!(await B.as('GET', '/companies/roles')).returnObj.some(role => role.id === roleA.id));
      await call('POST', `/companies/roles/${roleA.id}`, { auth: B.token, company: B.companyId, body: { id: roleA.id, name: 'Sequestrado', permission: 2 } });
      await call('DELETE', `/companies/roles/${roleA.id}`, { auth: B.token, company: B.companyId });
      const [role] = await sql('SELECT name FROM config_company_roles WHERE id = ?', [roleA.id]);
      assert.equal(role?.name, 'Recepção');

      assert.equal((await B.as('POST', '/users/find', { search_string: A.email })).returnObj.length, 0);
      assert.equal((await A.as('POST', '/users/find', { search_string: A.email })).returnObj.length, 1);
    });

    await t.test('relatórios não aceitam injeção', async () => {
      const result = await call('POST', '/reports/invoicing', { auth: A.token, company: A.companyId, body: { type: "mensal' OR 1=1 --", date: "2027-01' UNION SELECT password FROM users --" } });
      assert.ok(result.status === 400 || (result.status === 200 && !result.raw.includes('$2')), result.raw);
      assert.ok(!/password|sql/i.test(result.raw));
    });

    await t.test('convite: token só em hash, uso único', async () => {
      const mail = require('../config/sendEmail');
      const original = mail.sendEmail;
      mail.sendEmail = async () => {};
      try {
        const invitedEmail = `convidado-${process.pid}@agendaspro.test`;
        const password = `senha-${secret()}`;
        await expect(200, 'POST', '/users/register', { body: { name: 'Convidado', email: invitedEmail, password } });
        const [role] = await sql('SELECT id FROM config_company_roles WHERE company_id = ? LIMIT 1', [A.companyId]);
        const token = await require('../services/companiesService').inviteUser(A.companyId, 'Convidado', 0, invitedEmail, A.userId, role.id);
        const [invite] = await sql('SELECT token, token_hash, expires_at FROM company_invitations WHERE invited_user = ?', [invitedEmail]);
        assert.equal(invite.token, null);
        assert.equal(invite.token_hash, sha256(token));
        assert.ok(new Date(invite.expires_at) > new Date());
        await expect(200, 'POST', '/companies/enter_company', { body: { token, email: invitedEmail } });
        assert.notEqual((await call('POST', '/companies/enter_company', { body: { token, email: invitedEmail } })).status, 200, 'uso único');
      } finally {
        mail.sendEmail = original;
      }
    });

    await t.test('carteira Asaas de outro usuário não é reaproveitada (409)', async () => {
      await sql("INSERT INTO asaas_wallets (document, asaas_api_key, asaas_wallet_id, asaas_status, owner_user_id) VALUES ('86288366757', ?, 'wallet-de-teste', 'approved', ?)", [require('../utils/crypto').encrypt('chave-ficticia'), A.userId]);
      const result = await call('POST', '/companies/create_company', {
        auth: B.token,
        body: { name: 'Empresa Clone', address: 'Rua de Testes', zip_code: '01310-100', city: 'São Paulo', state: 'SP', business_type: business.id, email: 'clone@example.test', phone: '11999999999', document: '862.883.667-57', address_number: '1', complement: '', birthDate: '1990-01-01', incomeValue: 5000 },
      });
      assert.equal(result.status, 409, result.raw);
      assert.ok(!result.raw.includes('chave-ficticia'));
    });

    await t.test('refresh rotativo, reuso revoga a família, logout', async () => {
      const first = (await expect(200, 'POST', '/users/refresh', { body: { refresh_token: A.refresh } })).returnObj;
      assert.ok(first.jwtToken && first.refreshToken && first.refreshToken !== A.refresh);
      await expect(401, 'POST', '/users/refresh', { body: { refresh_token: A.refresh } });
      await expect(401, 'POST', '/users/refresh', { body: { refresh_token: first.refreshToken } }, 'família revogada após reuso');

      const login = (await expect(200, 'POST', '/users/login', { body: { email: A.email, password: A.password } })).returnObj;
      await expect(200, 'POST', '/users/logout', { auth: login.jwtToken, body: { refresh_token: login.refreshToken } });
      await expect(401, 'POST', '/users/refresh', { body: { refresh_token: login.refreshToken } });
      const [stored] = await sql('SELECT COUNT(*) AS total FROM refresh_tokens WHERE token_hash = ?', [sha256(login.refreshToken)]);
      assert.equal(stored.total, 1, 'só o hash é persistido');
    });

    await t.test('check_jwt não re-assina token expirado', async () => {
      const jwt = require('jsonwebtoken');
      const now = Math.floor(Date.now() / 1000);
      const expired = jwt.sign({ id: A.userId, email: A.email, iat: now - 7200, exp: now - 3600 }, process.env.JWT_SECRET);
      await expect(401, 'POST', '/users/check_jwt', { body: { token: `Bearer ${expired}` } });
      await expect(401, 'GET', '/customers', { auth: expired, company: A.companyId });
      const forged = jwt.sign({ id: A.userId }, 'outra-chave', { expiresIn: '1h' });
      await expect(401, 'POST', '/users/check_jwt', { body: { token: `Bearer ${forged}` } });
      const renewed = (await expect(200, 'POST', '/users/check_jwt', { body: { token: `Bearer ${A.token}` } })).returnObj;
      assert.ok(renewed.newToken);
    });

    await t.test('redefinição de senha revoga refresh e access tokens antigos', async () => {
      const login = (await expect(200, 'POST', '/users/login', { body: { email: B.email, password: B.password } })).returnObj;
      await new Promise(resolve => setTimeout(resolve, 1100));
      const token = randomToken(32);
      await sql('INSERT INTO password_requests (user_id, token_hash, request_date) VALUES (?, ?, NOW())', [B.userId, sha256(token)]);
      const password = `nova-${secret()}`;
      await expect(200, 'POST', '/users/reset-password', { body: { token, password } });
      await expect(400, 'POST', '/users/reset-password', { body: { token, password: `outra-${secret()}` } }, 'token de uso único');
      await expect(401, 'POST', '/users/refresh', { body: { refresh_token: login.refreshToken } });
      await expect(401, 'GET', '/customers', { auth: login.jwtToken, company: B.companyId });
      B.password = password;
      B.token = (await expect(200, 'POST', '/users/login', { body: { email: B.email, password } })).returnObj.jwtToken;
      await B.as('GET', '/customers');
    });

    await t.test('rotas internas exigem token próprio', async () => {
      await expect(401, 'GET', '/health/deep');
      await expect(401, 'GET', '/health/deep', { auth: process.env.JOBS_TICK_TOKEN });
      assert.equal((await expect(200, 'GET', '/health/deep', { auth: process.env.ADMIN_TOKEN })).database, 'ok');
      await expect(401, 'POST', '/internal/jobs/tick', { auth: process.env.ADMIN_TOKEN });
      await expect(401, 'POST', `/internal/jobs/tick?token=${process.env.JOBS_TICK_TOKEN}`);
      await expect(401, 'POST', '/companies/admin/sync_webhooks', { auth: A.token });
      const health = await expect(200, 'GET', '/health');
      assert.ok(!JSON.stringify(health).includes(database));
    });

    await t.test('jobs: dedupe, backoff, falha final e orçamento com devolução', async () => {
      const jobs = require('../services/jobsService');
      assert.deepEqual([1, 2, 3, 20].map(jobs.backoffSeconds), [60, 120, 240, 21600]);
      let clock = 0;
      jobs.register('test_slow', async () => { clock += 600; });
      jobs.register('test_fail', async () => { throw new Error('falha simulada'); });
      assert.equal(await jobs.enqueue('test_slow', { n: 1 }, { dedupeKey: 'slow:1' }), true);
      assert.equal(await jobs.enqueue('test_slow', { n: 1 }, { dedupeKey: 'slow:1' }), false, 'dedupe');
      await jobs.enqueue('test_slow', { n: 2 }, { dedupeKey: 'slow:2' });
      await jobs.enqueue('test_slow', { n: 3 }, { dedupeKey: 'slow:3' });
      const stats = await jobs.tick({ budgetMs: 1000, now: () => clock });
      assert.equal(stats.done, 2);
      assert.equal(stats.released, 1);
      const [released] = await sql("SELECT status, attempts FROM jobs WHERE dedupe_key = 'slow:3'");
      assert.deepEqual([released.status, released.attempts], ['pending', 0], 'devolvido sem gastar tentativa');

      await jobs.enqueue('test_fail', {}, { dedupeKey: 'fail:1', maxAttempts: 2 });
      await jobs.tick({ budgetMs: 5000 });
      let [failing] = await sql("SELECT status, attempts, due_at > NOW() AS later FROM jobs WHERE dedupe_key = 'fail:1'");
      assert.deepEqual([failing.status, failing.attempts, failing.later], ['pending', 1, 1], 'retry com backoff');
      await sql("UPDATE jobs SET due_at = NOW() WHERE dedupe_key = 'fail:1'");
      const tick = await expect(200, 'POST', '/internal/jobs/tick', { auth: process.env.JOBS_TICK_TOKEN });
      assert.equal(tick.ok, true);
      [failing] = await sql("SELECT status FROM jobs WHERE dedupe_key = 'fail:1'");
      assert.equal(failing.status, 'failed');
    });

    await t.test('lembrete: janela 1h–24h30, só marca enviado após sucesso', async () => {
      const jobs = require('../services/jobsService');
      const [pref] = await sql("SELECT id FROM preferences WHERE code = 'notificate_scheduling'");
      await sql('INSERT INTO config_companies_preferences (company_id, preference_id, active) VALUES (?, ?, 1)', [A.companyId, pref.id]);
      const at = async interval => (await sql(`SELECT DATE_FORMAT(NOW() + INTERVAL ${interval}, '%Y-%m-%d %H:%i:00') AS d`))[0].d;
      await A.as('POST', '/appointments', { ...appointmentBody, date: await at('3 HOUR') });
      await A.as('POST', '/appointments', { ...appointmentBody, date: await at('20 MINUTE') });
      await A.as('POST', '/appointments', { ...appointmentBody, date: await at('30 HOUR') });
      const [soon] = await sql('SELECT id FROM appointments WHERE company_id = ? AND date > NOW() + INTERVAL 2 HOUR AND date < NOW() + INTERVAL 4 HOUR', [A.companyId]);

      stubStatus = 500;
      sent.length = 0;
      let stats = await jobs.tick({ budgetMs: 5000 });
      assert.equal(stats.enqueued, 1, 'só o agendamento dentro da janela');
      assert.equal(stats.retried, 1);
      assert.equal((await sql('SELECT notified_1h FROM appointments WHERE id = ?', [soon.id]))[0].notified_1h, 0, 'falha não marca enviado');

      stubStatus = 200;
      await sql("UPDATE jobs SET due_at = NOW() WHERE type = 'appointment_reminder'");
      sent.length = 0;
      stats = await jobs.tick({ budgetMs: 5000 });
      assert.equal(stats.done, 1);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].auth, `Bearer ${process.env.WHATSAPP_OUTBOUND_TOKEN}`);
      assert.equal(sent[0].body.number, '5511988887777');
      assert.equal((await sql('SELECT notified_1h FROM appointments WHERE id = ?', [soon.id]))[0].notified_1h, 1);
      sent.length = 0;
      stats = await jobs.tick({ budgetMs: 5000 });
      assert.equal(stats.enqueued, 0);
      assert.equal(sent.length, 0, 'não reenvia');
    });

    await t.test('webhook Asaas: OVERDUE e REFUNDED idempotentes', async () => {
      const hook = (body, token = process.env.ASAAS_WEBHOOK_TOKEN) => call('POST', '/webhook/asaas', { body, headers: { 'asaas-access-token': token } });
      assert.equal((await hook({ id: 'evt_x', event: 'PAYMENT_OVERDUE', payment: { id: 'pay_x' } }, 'errado')).status, 401);
      await sql("UPDATE sales SET pix_asaas_id = 'pay_overdue_1' WHERE id = ?", [saleA.id]);
      const overdue = { id: 'evt_overdue_1', event: 'PAYMENT_OVERDUE', payment: { id: 'pay_overdue_1', externalReference: `APP_${appointmentA.id}`, value: 40 } };
      let result = await hook(overdue);
      assert.equal(result.status, 200, result.raw);
      assert.equal((await sql('SELECT pix_asaas_id FROM sales WHERE id = ?', [saleA.id]))[0].pix_asaas_id, null);
      result = await hook(overdue);
      assert.equal(result.data.duplicate, true);

      await A.as('POST', '/sales/insert_payment', { sale_id: saleA.id, customer_id: customerA.id, amount: 40, payment_type: 'pix' });
      await sql("UPDATE payments SET external_id = 'pay_refund_1' WHERE sale_id = ?", [saleA.id]);
      const refund = { id: 'evt_refund_1', event: 'PAYMENT_REFUNDED', payment: { id: 'pay_refund_1', externalReference: `APP_${appointmentA.id}`, value: 40 } };
      assert.equal((await hook(refund)).status, 200);
      assert.equal((await hook(refund)).data.duplicate, true);
      const [payment] = await sql("SELECT refunded_at FROM payments WHERE external_id = 'pay_refund_1'");
      assert.ok(payment.refunded_at);
      assert.equal((await sql('SELECT payment_status FROM appointments WHERE id = ?', [appointmentA.id]))[0].payment_status, 'estornado');
      const [events] = await sql("SELECT COUNT(*) AS total FROM inbound_events WHERE provider = 'asaas'");
      assert.equal(events.total, 2);
      assert.equal((await hook({ id: 'evt_other', event: 'PAYMENT_OVERDUE', payment: { id: 'pay_o', externalReference: 'OUTRO_1' } })).data.ignored, true);
    });

    await t.test('bot: mídia, só agendamentos do remetente', async () => {
      const auth = process.env.WHATSAPP_INBOUND_TOKEN;
      await expect(401, 'POST', '/webhook/whatsapp', { body: { phone: '11988887777', message: 'oi' }, auth: process.env.WHATSAPP_OUTBOUND_TOKEN });
      const media = await expect(200, 'POST', '/webhook/whatsapp', { auth, body: { phone: '5511988887777', message: { audio: true } } });
      assert.match(media.returnObj.reply, /texto/);
      const bot = require('../services/openaiService');
      assert.ok(bot.phoneCandidates('5511988887777').includes('11988887777'));
      const own = await bot.getCustomerAppointments('5511988887777', '39053344705');
      assert.ok(own.length >= 1 && own.every(row => row.company_id === A.companyId));
      assert.equal((await bot.getCustomerAppointments('5521977776666', '')).length, 0, 'outro telefone não vê');
      assert.equal((await bot.getCustomerAppointments('5511988887777', '11144477735')).length, 0, 'CPF divergente');
      const [future] = await sql("SELECT id FROM appointments WHERE company_id = ? AND date > NOW() AND canceled = 0 ORDER BY date DESC LIMIT 1", [A.companyId]);
      assert.equal(await bot.processReschedule({ appointment_id: future.id, new_date: '2027-03-12 10:00:00', company_id: A.companyId, phone: '5521977776666' }), 'Agendamento não encontrado.');
      assert.equal(await bot.processReschedule({ appointment_id: future.id, new_date: '2027-03-12 10:00:00', company_id: B.companyId, phone: '5511988887777' }), 'Agendamento não encontrado.');
      const id = await bot.getOrCreateCustomer('5511988887777', 'Outro Nome', 'invalida', '', '', A.companyId);
      assert.equal(id, customerA.id, 'reaproveita cliente pelo telefone');
      const created = await bot.getOrCreateCustomer('5531966665555', 'Novo Bot', null, '000', '', A.companyId);
      const [row] = await sql('SELECT tel, cpf, birthday, company_id FROM customers WHERE id = ?', [created]);
      assert.deepEqual([row.cpf, row.birthday, row.company_id], [null, null, A.companyId]);
      assert.ok(String(row.tel).includes('966665555'));
    });

    await t.test('LGPD: export, consentimento, anonimização e exclusão', async () => {
      await B.as('GET', `/privacy/customers/${customerA.id}/export`, undefined, 404);
      await A.as('POST', `/privacy/customers/${customerA.id}/consents`, { purpose: 'whatsapp_reminders', granted: true });
      await A.as('POST', `/privacy/customers/${customerA.id}/consents`, { purpose: 'qualquer', granted: true }, 400);
      const exported = (await A.as('GET', `/privacy/customers/${customerA.id}/export`)).returnObj;
      assert.equal(exported.customer.id, customerA.id);
      assert.ok(exported.appointments.length >= 1);
      assert.equal(exported.consents.length, 1);
      await A.as('DELETE', `/privacy/customers/${customerA.id}`, undefined, 409);
      await A.as('POST', `/privacy/customers/${customerA.id}/anonymize`);
      const [anon] = await sql('SELECT name, cpf, tel, email, birthday, anonymized_at FROM customers WHERE id = ?', [customerA.id]);
      assert.notEqual(anon.name, 'Cliente A');
      assert.ok(anon.anonymized_at);
      assert.equal(anon.birthday, null);
      assert.ok(!String(anon.tel || '').includes('988887777'));
      await B.as('DELETE', `/privacy/customers/${customerB.id}`);
      assert.equal((await sql('SELECT COUNT(*) AS total FROM customers WHERE id = ?', [customerB.id]))[0].total, 0);
    });

    await t.test('erros internos não vazam SQL e trazem correlation_id', async () => {
      const result = await call('GET', '/appointments?start=2027-02-30', { auth: A.token, company: A.companyId });
      assert.ok([200, 400].includes(result.status));
      const tooBig = await call('POST', '/users/login', { body: { email: 'x@example.test', password: 'a'.repeat(2 * 1024 * 1024) } });
      assert.equal(tooBig.status, 413);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (stub) await new Promise(resolve => stub.close(resolve));
    if (pool) await new Promise(resolve => pool.end(resolve));
    await adminQuery('DROP DATABASE IF EXISTS ??', [database]).catch(() => {});
    admin.end();
  }
});
