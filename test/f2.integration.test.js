process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const mysql = require('mysql');
const { promisify } = require('node:util');

// F2: planos/entitlement, assinatura (provedor stub), comissão com split, profissionais,
// expediente/bloqueios, fuso por empresa, lembrete 2h e /static. Nada externo é chamado:
// Asaas e WhatsApp são stubs locais; segredos gerados por execução.
const secret = () => crypto.randomBytes(32).toString('base64url');

test('F2: planos, comissão, profissionais e lembrete 2h no MariaDB isolado', { skip: !process.env.MYSQL_ROOT_PASSWORD, timeout: 180000 }, async t => {
  const database = `agendaspro_f2_${process.pid}`;
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
      ASAAS_MAIN_WALLET_ID: 'wallet-plataforma-teste', ASAAS_SUBSCRIPTIONS_ENABLED: 'false',
      PLAN_PREMIUM_PRICE_CENTS: '4990', BILLING_GRACE_DAYS: '3',
    });
    delete process.env.JWT_KEY;
    delete process.env.APP_TIMEZONE;

    const sent = [];
    stub = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => { sent.push(JSON.parse(body || '{}')); res.writeHead(200).end('{}'); });
    });
    await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
    process.env.WHATSAPP_API_URL = `http://127.0.0.1:${stub.address().port}`;

    await require('../scripts/migrate')({ log: () => {} });
    const functions = require('../utils/functions');
    pool = require('../mysql').pool;
    const sql = functions.executeSql.bind(functions);
    const app = require('../app');
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    async function call(method, path, { body, auth, company, headers = {}, redirect } = {}) {
      const response = await fetch(base + path, {
        method, redirect,
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
      const ctx = { email, userId: login.id, token: login.jwtToken, companyId };
      ctx.as = (method, path, body, expected = 200) => expect(expected, method, path, { body, auth: ctx.token, company: ctx.companyId });
      return ctx;
    }
    const A = await tenant('a', '52998224725');
    const B = await tenant('b', '11144477735');

    await A.as('POST', '/customers', { name: 'Cliente A', cpf: '39053344705', birthday: null, tel: '11988887777', image: '', email: '' });
    const customerA = (await A.as('GET', '/customers')).returnObj[0];
    const serviceA = (await sql("INSERT INTO services (name, duration, value, cost, company_id, requires_location, accepts_quantity) VALUES ('Corte', 30, 40, 10, ?, 0, 0)", [A.companyId])).insertId;
    const serviceB = (await sql("INSERT INTO services (name, duration, value, cost, company_id, requires_location, accepts_quantity) VALUES ('Barba', 30, 30, 5, ?, 0, 0)", [B.companyId])).insertId;
    const [serviceRow] = await sql('SELECT * FROM services WHERE id = ?', [serviceA]);
    const appointment = (date, extra = {}) => ({ customer_id: customerA.id, customer_name: customerA.name, date, duration: 30, observations: '', services: [serviceRow], status: 'agendado', ...extra });
    const hook = body => call('POST', '/webhook/asaas', { body, headers: { 'asaas-access-token': process.env.ASAAS_WEBHOOK_TOKEN } });

    let proA, proB;
    await t.test('planos: catálogo e entitlement Free por padrão', async () => {
      const plans = (await A.as('GET', '/billing/plans')).data;
      assert.deepEqual(plans.map(p => [p.code, p.commission_bps, p.price_cents]), [['free', 500, 0], ['premium', 50, 4990]]);
      assert.ok(plans.every(p => !('id' in p)));
      const overview = (await A.as('GET', '/billing/subscription')).data;
      assert.deepEqual([overview.entitlement.plan_code, overview.entitlement.source, overview.subscription, overview.subscriptions_enabled], ['free', 'free', null, false]);
      await A.as('POST', '/billing/subscription', { plan_code: 'premium' }, 503);
      await A.as('POST', '/billing/subscription', { plan_code: 'premium', company_id: B.companyId }, 400);
      await A.as('POST', '/billing/subscription', { plan_code: 'gold' }, 400);
      await A.as('GET', '/billing/commissions?from=2027-13-01', undefined, 400);
    });

    await t.test('profissionais: CRUD, quota Free e isolamento A/B', async () => {
      proA = (await A.as('POST', '/professionals', { name: 'Ana', color: '#AA00CC', service_ids: [serviceA] }, 201)).data;
      assert.deepEqual([proA.name, proA.active, proA.service_ids], ['Ana', true, [serviceA]]);
      const blocked = await A.as('POST', '/professionals', { name: 'Bia' }, 402);
      assert.equal(blocked.error.code, 'plan_upgrade_required');
      assert.deepEqual([blocked.error.quota, blocked.error.limit, blocked.error.used], ['max_professionals', 1, 1]);
      await A.as('POST', '/professionals', { name: 'Campo extra', company_id: B.companyId }, 400);
      await B.as('POST', '/professionals', { name: 'Serviço alheio', service_ids: [serviceA] }, 400);
      await B.as('POST', '/professionals', { name: 'Usuário alheio', user_id: A.userId }, 400);
      proB = (await B.as('POST', '/professionals', { name: 'Beto', service_ids: [serviceB] }, 201)).data;

      assert.ok(!(await B.as('GET', '/professionals')).data.some(p => p.id === proA.id));
      await B.as('GET', `/professionals/${proA.id}`, undefined, 404);
      await B.as('PATCH', `/professionals/${proA.id}`, { name: 'Invadido' }, 404);
      await B.as('DELETE', `/professionals/${proA.id}`, undefined, 404);
      await A.as('GET', '/professionals/abc', undefined, 400);
      assert.equal((await A.as('GET', `/professionals/${proA.id}`)).data.name, 'Ana');
      await A.as('PATCH', `/professionals/${proA.id}`, { phone: '(11) 98888-7777' });
      assert.deepEqual(Object.keys(proA).sort(), ['active', 'color', 'email', 'id', 'name', 'phone', 'photo_url', 'service_ids', 'user_id']);

      // Reativar conta na quota: desativa Ana, cria Bia, reativar Ana estoura o Free.
      assert.deepEqual((await A.as('DELETE', `/professionals/${proA.id}`)).data, { deactivated: true });
      const bia = (await A.as('POST', '/professionals', { name: 'Bia' }, 201)).data;
      const reactivate = await A.as('PATCH', `/professionals/${proA.id}`, { active: true }, 402);
      assert.equal(reactivate.error.quota, 'max_professionals');
      await A.as('DELETE', `/professionals/${bia.id}`);
      assert.equal((await A.as('PATCH', `/professionals/${proA.id}`, { active: true })).data.active, true);
      assert.deepEqual((await A.as('GET', '/professionals')).data.map(p => p.id), [proA.id]);
      const all = (await A.as('GET', '/professionals?include_inactive=true')).data;
      assert.deepEqual(all.map(p => [p.id, p.active]).sort((x, y) => x[0] - y[0]), [[proA.id, true], [bia.id, false]]);
    });

    await t.test('expediente e bloqueios: validação, isolamento e conflito no agendamento', async () => {
      // 2027-03-10 é quarta-feira (weekday 3).
      await A.as('POST', '/availability-rules', { professional_id: proA.id, weekday: 3, start_time: '09:00', end_time: '12:00' }, 201);
      await A.as('POST', '/availability-rules', { professional_id: proA.id, weekday: 3, start_time: '11:00', end_time: '13:00' }, 400);
      await A.as('POST', '/availability-rules', { professional_id: proA.id, weekday: 3, start_time: '15:00', end_time: '14:00' }, 400);
      await B.as('POST', '/availability-rules', { professional_id: proA.id, weekday: 1, start_time: '09:00', end_time: '12:00' }, 404);
      await B.as('PUT', `/availability-rules/professional/${proA.id}`, { rules: [] }, 404);
      await A.as('PUT', `/availability-rules/professional/${proA.id}`, { rules: [
        { weekday: 3, start_time: '09:00', end_time: '12:00' }, { weekday: 3, start_time: '11:00', end_time: '13:00' },
      ] }, 400);
      const replaced = (await A.as('PUT', `/availability-rules/professional/${proA.id}`, { rules: [
        { weekday: 4, start_time: '13:00', end_time: '24:00' }, { weekday: 3, start_time: '09:00', end_time: '12:00' },
      ] })).data;
      assert.deepEqual(replaced.map(({ id, ...r }) => r), [
        { professional_id: proA.id, weekday: 3, start_time: '09:00', end_time: '12:00' },
        { professional_id: proA.id, weekday: 4, start_time: '13:00', end_time: '24:00' },
      ]);
      const ruleA = (await A.as('GET', `/availability-rules?professional_id=${proA.id}`)).data[0];
      assert.deepEqual(Object.keys(ruleA).sort(), ['end_time', 'id', 'professional_id', 'start_time', 'weekday']);
      assert.equal((await B.as('GET', '/availability-rules')).data.length, 0);
      await B.as('DELETE', `/availability-rules/${ruleA.id}`, undefined, 404);

      const block = (await A.as('POST', '/time-blocks', { professional_id: proA.id, starts_at: '2027-03-10 11:00', ends_at: '2027-03-10 12:00', reason: 'Médico' }, 201)).data;
      await A.as('POST', '/time-blocks', { starts_at: '2027-03-10 11:00', ends_at: '2027-03-10 10:00' }, 400);
      await B.as('POST', '/time-blocks', { professional_id: proA.id, starts_at: '2027-03-10 11:00', ends_at: '2027-03-10 12:00' }, 404);
      assert.equal((await B.as('GET', '/time-blocks')).data.length, 0);
      await B.as('DELETE', `/time-blocks/${block.id}`, undefined, 404);
      const listedBlocks = (await A.as('GET', '/time-blocks?from=2027-03-10%2000:00&to=2027-03-11%2000:00')).data;
      assert.deepEqual(listedBlocks, [{ id: block.id, professional_id: proA.id, starts_at: '2027-03-10 11:00:00', ends_at: '2027-03-10 12:00:00', reason: 'Médico' }]);

      await A.as('POST', '/appointments', appointment('2027-03-10 08:00:00', { professional_id: proA.id }), 400); // fora do expediente
      await A.as('POST', '/appointments', appointment('2027-03-10 11:30:00', { professional_id: proA.id }), 400); // bloqueio
      await A.as('POST', '/appointments', appointment('2027-03-10 09:00:00', { professional_id: proB.id }), 400); // profissional de B
      await A.as('POST', '/appointments', appointment('2027-03-10 09:00:00', { professional_id: proA.id }));
      await A.as('POST', '/appointments', appointment('2027-03-10 09:15:00', { professional_id: proA.id }), 400); // conflito
      const [row] = await sql('SELECT id, professional_id FROM appointments WHERE company_id = ? AND date = ?', [A.companyId, '2027-03-10 09:00:00']);
      assert.equal(row.professional_id, proA.id);
      const listed = await A.as('GET', '/appointments?start=2027-03-10&end=2027-03-10');
      const item = (listed.returnObj || listed.data).find(a => a.id === row.id);
      assert.equal(item.professional_id, proA.id);
      // F4: hora de parede sem offset (não depende do timezone do pool).
      assert.deepEqual([item.date, item.start, item.end], ['2027-03-10 09:00:00', '2027-03-10 09:00:00', '2027-03-10 09:30:00']);
      assert.equal((await A.as('GET', `/appointments/${row.id}`)).returnObj.start, '2027-03-10 09:00:00');
      // F4: filtro professional_id (sem include_unassigned só os do profissional).
      await A.as('POST', '/appointments', appointment('2027-03-10 14:00:00'));
      const byPro = (await A.as('GET', `/appointments?start=2027-03-10&end=2027-03-10&professional_id=${proA.id}`)).returnObj;
      assert.deepEqual(byPro.map(a => a.professional_id), [proA.id]);
      const withFree = (await A.as('GET', `/appointments?start=2027-03-10&end=2027-03-10&professional_id=${proA.id}&include_unassigned=true`)).returnObj;
      assert.equal(withFree.length, 2);
      assert.equal((await B.as('GET', `/appointments?professional_id=${proA.id}`)).returnObj.length, 0);
      await A.as('GET', '/appointments?professional_id=abc', undefined, 400);
      // F4: bloqueios da empresa entram por padrão no filtro por profissional; include_company_blocks=false exclui.
      const companyBlock = (await A.as('POST', '/time-blocks', { starts_at: '2027-03-10 15:00', ends_at: '2027-03-10 16:00', reason: 'Reunião' }, 201)).data;
      const proBlocks = q => A.as('GET', `/time-blocks?from=2027-03-10%2000:00&to=2027-03-11%2000:00&professional_id=${proA.id}${q}`).then(r => r.data.map(b => b.id));
      assert.deepEqual(await proBlocks(''), [block.id, companyBlock.id]);
      assert.deepEqual(await proBlocks('&include_company_blocks=false'), [block.id]);
      await A.as('DELETE', `/time-blocks/${companyBlock.id}`);
      await A.as('PATCH', `/appointments/${row.id}`, appointment('2027-03-10 10:00:00', { professional_id: proB.id }), 400);
      // Sem profissional: regra legada (sem expediente) continua funcionando.
      await A.as('POST', '/appointments', appointment('2027-03-11 08:00:00'));
      // Feriado da empresa inteira bloqueia também agendamentos sem profissional.
      await A.as('POST', '/time-blocks', { starts_at: '2027-03-12 00:00', ends_at: '2027-03-13 00:00', reason: 'Feriado' }, 201);
      await A.as('POST', '/appointments', appointment('2027-03-12 10:00:00'), 400);
      await A.as('DELETE', `/time-blocks/${block.id}`);
    });

    await t.test('fuso por empresa', async () => {
      assert.deepEqual((await A.as('GET', '/companies/timezone')).returnObj, { timezone: null, effective: 'America/Sao_Paulo' });
      await A.as('PUT', '/companies/timezone', { timezone: 'Nada/Disso' }, 400);
      await A.as('PUT', '/companies/timezone', { timezone: 'America/Manaus' });
      assert.equal((await A.as('GET', '/companies/timezone')).returnObj.effective, 'America/Manaus');
      assert.equal((await B.as('GET', '/companies/timezone')).returnObj.timezone, null, 'B não é afetada');
      await A.as('PUT', '/companies/timezone', { timezone: null });
    });

    await t.test('quota de equipe no Free (convite)', async () => {
      const mail = require('../config/sendEmail');
      const original = mail.sendEmail;
      mail.sendEmail = async () => {};
      try {
        const [role] = await sql('SELECT id FROM config_company_roles WHERE company_id = ? LIMIT 1', [A.companyId]);
        await A.as('POST', '/companies/invite_user', { name: 'Primeiro', email: `p1-${process.pid}@agendaspro.test`, role: role.id });
        const blocked = await A.as('POST', '/companies/invite_user', { name: 'Segundo', email: `p2-${process.pid}@agendaspro.test`, role: role.id }, 402);
        assert.deepEqual([blocked.error.code, blocked.error.quota, blocked.error.limit], ['plan_upgrade_required', 'max_team_users', 2]);
      } finally {
        mail.sendEmail = original;
      }
    });

    // Pix com split: stub do Asaas da empresa.
    const asaas = require('../services/asaasService');
    const charges = [];
    const originals = { getOrCreateCustomer: asaas.getOrCreateCustomer, createPixCharge: asaas.createPixCharge };
    asaas.getOrCreateCustomer = async () => 'cus_teste';
    asaas.createPixCharge = async args => {
      charges.push(args);
      return { paymentId: `pay_split_${charges.length}`, payload: 'pix-copia-e-cola', expirationDate: null, encodedImage: '' };
    };
    await sql("UPDATE companies SET asaas_api_key = ?, asaas_status = 'APPROVED' WHERE id = ?", [require('../utils/crypto').encrypt('chave-ficticia'), A.companyId]);
    async function pixSale(date) {
      await A.as('POST', '/appointments', appointment(date));
      const [sale] = await sql('SELECT s.id FROM sales s JOIN appointments a ON a.id = s.appointment_id WHERE a.company_id = ? AND a.date = ?', [A.companyId, date]);
      await A.as('POST', '/sales/insert_payment', { sale_id: sale.id, customer_id: customerA.id, amount: 40, payment_type: 'pix_asaas' });
      return { sale, charge: charges.at(-1), paymentId: `pay_split_${charges.length}` };
    }

    await t.test('comissão Free: 5% em centavos, split fixo na carteira da plataforma', async () => {
      const { sale, charge, paymentId } = await pixSale('2027-04-01 10:00:00');
      assert.equal(charge.value, 40);
      assert.deepEqual(charge.split, [{ walletId: 'wallet-plataforma-teste', fixedValue: 2 }]);
      const [commission] = await sql('SELECT sale_id, plan_code, commission_bps, gross_cents, commission_cents, split_applied, status FROM sale_commissions WHERE provider_payment_id = ?', [paymentId]);
      assert.deepEqual({ ...commission }, { sale_id: sale.id, plan_code: 'free', commission_bps: 500, gross_cents: 4000, commission_cents: 200, split_applied: 1, status: 'pending' });
      assert.equal((await hook({ id: 'evt_sale_paid_1', event: 'PAYMENT_RECEIVED', payment: { id: paymentId, externalReference: `SALE_${sale.id}`, value: 40 } })).status, 200);
      const report = (await A.as('GET', '/billing/commissions')).data;
      assert.deepEqual(report.totals_settled, { gross_cents: 4000, commission_cents: 200, net_cents: 3800 });
      assert.equal((await B.as('GET', '/billing/commissions')).data.items.length, 0, 'B não vê comissões de A');
    });

    await t.test('assinatura Premium (provedor stub) + webhook: entitlement e comissão 0,5%', async () => {
      const billing = require('../services/billingService');
      const today = require('../utils/time').wallClock(new Date()).slice(0, 10);
      const calls = [];
      billing.setProvider({
        createCustomer: async args => { calls.push(['customer', args]); return 'cus_plataforma'; },
        createSubscription: async args => { calls.push(['subscription', args]); return { id: 'sub_teste_1', nextDueDate: args.nextDueDate }; },
        listPayments: async () => [{ id: 'pay_sub_1', value: 49.9, dueDate: today, invoiceUrl: 'https://example.test/fatura/1' }],
        cancelSubscription: async id => { calls.push(['cancel', id]); },
      });
      process.env.ASAAS_SUBSCRIPTIONS_ENABLED = 'true';
      let overview = (await A.as('POST', '/billing/subscription', { plan_code: 'premium', billing_type: 'PIX' })).data;
      assert.equal(overview.entitlement.plan_code, 'free', 'só vira Premium com fatura paga');
      assert.deepEqual([overview.subscription.status, overview.subscription.plan_code, overview.subscription.price_cents], ['pending', 'premium', 4990]);
      assert.equal(overview.pending_invoice_url, 'https://example.test/fatura/1');
      const sub = calls.find(c => c[0] === 'subscription')[1];
      assert.deepEqual([sub.value, sub.billingType, sub.nextDueDate, sub.externalReference], [49.9, 'PIX', today, `SUB_${A.companyId}`]);
      // Repetir o pedido não cria outra assinatura.
      calls.length = 0;
      await A.as('POST', '/billing/subscription', { plan_code: 'premium' });
      assert.equal(calls.length, 0, 'idempotente');

      const paid = { id: 'evt_sub_paid_1', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_sub_1', subscription: 'sub_teste_1', value: 49.9, dueDate: today } };
      assert.equal((await hook(paid)).status, 200);
      assert.equal((await hook(paid)).data.duplicate, true);
      overview = (await A.as('GET', '/billing/subscription')).data;
      assert.deepEqual([overview.entitlement.plan_code, overview.entitlement.source, overview.entitlement.commission_bps, overview.subscription.status], ['premium', 'paid', 50, 'active']);
      assert.equal((await B.as('GET', '/billing/subscription')).data.entitlement.plan_code, 'free', 'B continua Free');
      const invoices = (await A.as('GET', '/billing/invoices')).data;
      assert.deepEqual(invoices.map(i => [i.status, i.amount_cents, i.plan_code]), [['paid', 4990, 'premium']]);
      assert.equal((await B.as('GET', '/billing/invoices')).data.length, 0);
      // Evento atrasado (CREATED depois do RECEIVED) não rebaixa a fatura paga.
      await hook({ id: 'evt_sub_late_1', event: 'PAYMENT_CREATED', payment: { id: 'pay_sub_1', subscription: 'sub_teste_1', value: 49.9, dueDate: today } });
      assert.equal((await A.as('GET', '/billing/invoices')).data[0].status, 'paid');

      // Premium libera o 2º profissional e a comissão cai para 0,5%.
      await A.as('POST', '/professionals', { name: 'Bia' }, 201);
      const { charge, paymentId } = await pixSale('2027-04-02 10:00:00');
      assert.deepEqual(charge.split, [{ walletId: 'wallet-plataforma-teste', fixedValue: 0.2 }]);
      const [commission] = await sql('SELECT plan_code, commission_bps, commission_cents FROM sale_commissions WHERE provider_payment_id = ?', [paymentId]);
      assert.deepEqual({ ...commission }, { plan_code: 'premium', commission_bps: 50, commission_cents: 20 });
      await hook({ id: 'evt_sale_overdue_2', event: 'PAYMENT_OVERDUE', payment: { id: paymentId, externalReference: 'SALE_0', value: 40 } });
      assert.equal((await sql('SELECT status FROM sale_commissions WHERE provider_payment_id = ?', [paymentId]))[0].status, 'canceled');

      // Estorno da fatura: volta ao Free na leitura, sem cron.
      await hook({ id: 'evt_sub_refund_1', event: 'PAYMENT_REFUNDED', payment: { id: 'pay_sub_1', subscription: 'sub_teste_1', value: 49.9, dueDate: today } });
      assert.equal((await A.as('GET', '/billing/subscription')).data.entitlement.plan_code, 'free');
      await sql("UPDATE subscription_invoices SET status = 'paid' WHERE provider_payment_id = 'pay_sub_1'");
      assert.equal((await A.as('GET', '/billing/subscription')).data.entitlement.plan_code, 'premium');
    } );

    await t.test('lembrete 2h só para Premium; 24h não duplica quando próximo', async () => {
      const jobs = require('../services/jobsService');
      const [pref] = await sql("SELECT id FROM preferences WHERE code = 'notificate_scheduling'");
      for (const company of [A.companyId, B.companyId]) await sql('INSERT INTO config_companies_preferences (company_id, preference_id, active) VALUES (?, ?, 1)', [company, pref.id]);
      await B.as('POST', '/customers', { name: 'Cliente B', cpf: '11144477735', birthday: null, tel: '21977776666', image: '', email: '' });
      const customerB = (await B.as('GET', '/customers')).returnObj[0];
      const [serviceRowB] = await sql('SELECT * FROM services WHERE id = ?', [serviceB]);
      const at = async interval => (await sql(`SELECT DATE_FORMAT(NOW() + INTERVAL ${interval}, '%Y-%m-%d %H:%i:00') AS d`))[0].d;
      const soon = await at('2 HOUR');
      await A.as('POST', '/appointments', appointment(soon));
      await B.as('POST', '/appointments', { customer_id: customerB.id, customer_name: customerB.name, date: soon, duration: 30, observations: '', services: [serviceRowB], status: 'agendado' });
      const [appA] = await sql('SELECT id FROM appointments WHERE company_id = ? AND date = ?', [A.companyId, soon]);
      const [appB] = await sql('SELECT id FROM appointments WHERE company_id = ? AND date = ?', [B.companyId, soon]);

      sent.length = 0;
      const stats = await jobs.tick({ budgetMs: 10000 });
      assert.equal(stats.enqueued, 3, '24h de A e B + 2h só de A');
      const [jobA2h] = await sql("SELECT status FROM jobs WHERE type = 'appointment_reminder_2h' AND dedupe_key LIKE ?", [`reminder2h:${appA.id}:%`]);
      assert.equal(jobA2h.status, 'done');
      assert.equal((await sql("SELECT COUNT(*) AS total FROM jobs WHERE type = 'appointment_reminder_2h' AND dedupe_key LIKE ?", [`reminder2h:${appB.id}:%`]))[0].total, 0, 'Free não recebe 2h');
      assert.equal(sent.length, 2, 'uma mensagem por agendamento');
      assert.equal(sent.filter(m => m.number === '5511988887777').length, 1);
      assert.match(sent.find(m => m.number === '5511988887777').text, /Falta pouco/);
      const [flagsA] = await sql('SELECT notified_1h, notified_2h FROM appointments WHERE id = ?', [appA.id]);
      assert.deepEqual([flagsA.notified_1h, flagsA.notified_2h], [1, 1]);
      sent.length = 0;
      assert.equal((await jobs.tick({ budgetMs: 10000 })).enqueued, 0, 'idempotente');
      assert.equal(sent.length, 0);
    });

    await t.test('/public liberado para a API da F3; estáticos em /static', async () => {
      const res = await call('GET', '/public/default-user-image.png');
      assert.equal(res.status, 404);
      assert.equal(typeof res.data, 'object', 'JSON 404');
      assert.equal((await fetch(`${base}/static/default-user-image.png`)).status, 200);
      const legacy = await call('GET', '/public/uploads/foto.png', { redirect: 'manual' });
      assert.equal(legacy.status, 301);
      assert.equal(legacy.headers.get('location'), '/static/uploads/foto.png');
    });

    asaas.getOrCreateCustomer = originals.getOrCreateCustomer;
    asaas.createPixCharge = originals.createPixCharge;
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (stub) await new Promise(resolve => stub.close(resolve));
    if (pool) await new Promise(resolve => pool.end(resolve));
    await adminQuery('DROP DATABASE IF EXISTS ??', [database]).catch(() => {});
    admin.end();
  }
});
