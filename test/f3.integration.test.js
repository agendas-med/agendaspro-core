process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const mysql = require('mysql');
const { promisify } = require('node:util');

// F3: API pública de agendamento no MariaDB isolado. Nada externo é chamado: Asaas é monkeypatch,
// Turnstile e WhatsApp são um stub HTTP local; segredos gerados por execução.
const secret = () => crypto.randomBytes(32).toString('base64url');
const SITE = 'https://site.example.test';

test('F3: API pública (página, disponibilidade, reserva, sinal Pix, gestão, limites)', { skip: !process.env.MYSQL_ROOT_PASSWORD, timeout: 240000 }, async t => {
  const database = `agendaspro_f3_${process.pid}`;
  const admin = mysql.createConnection({ host: process.env.MYSQL_HOST, port: process.env.MYSQL_PORT, user: 'root', password: process.env.MYSQL_ROOT_PASSWORD });
  const adminQuery = promisify(admin.query).bind(admin);
  let server, pool, stub;
  try {
    await adminQuery('CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', [database]);
    const sent = [];
    const turnstileCalls = [];
    stub = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        if (req.url === '/turnstile') {
          const params = new URLSearchParams(body);
          turnstileCalls.push(params.get('response'));
          return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: params.get('response') === 'ok' && !!params.get('secret') }));
        }
        sent.push(JSON.parse(body || '{}'));
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ messages: [{ id: `wamid.f3${sent.length}${Date.now()}` }] }));
      });
    });
    await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
    const stubUrl = `http://127.0.0.1:${stub.address().port}`;
    Object.assign(process.env, {
      MYSQL_DATABASE: database, MYSQL_USER: 'root', MYSQL_PASSWORD: process.env.MYSQL_ROOT_PASSWORD,
      ENABLE_INPROCESS_CRON: 'false', ASAAS_API_KEY: '', JWT_SECRET: secret(),
      APP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
      ADMIN_TOKEN: secret(), JOBS_TICK_TOKEN: secret(), ASAAS_WEBHOOK_TOKEN: secret(),
      WHATSAPP_INBOUND_TOKEN: secret(), WHATSAPP_OUTBOUND_TOKEN: secret(), WHATSAPP_API_URL: stubUrl,
      ASAAS_MAIN_WALLET_ID: 'wallet-plataforma-teste', ASAAS_SUBSCRIPTIONS_ENABLED: 'false',
      PUBLIC_BOOKING_TOKEN_SECRET: secret(), TURNSTILE_ENABLED: 'true', TURNSTILE_SECRET_KEY: secret(),
      TURNSTILE_VERIFY_URL: `${stubUrl}/turnstile`, PUBLIC_SITE_URL: SITE, PUBLIC_CORS_ORIGINS: SITE,
      PUBLIC_BOOKING_IP_MAX: '1000', PUBLIC_LEADS_IP_MAX: '6', PUBLIC_SLUG_MISS_MAX: '5',
      SALES_NOTIFY_WHATSAPP: '11900000000',
      // F4: avisos pela WhatsApp Cloud API (Graph falso local).
      WHATSAPP_CLOUD_ENABLED: 'true', META_GRAPH_URL: stubUrl, META_PHONE_NUMBER_ID: '100000000000003',
      META_ACCESS_TOKEN: secret(), META_APP_SECRET: secret(), META_VERIFY_TOKEN: secret(),
    });
    for (const key of ['JWT_KEY', 'APP_TIMEZONE', 'TURNSTILE_DEV_BYPASS', 'USER_EMAIL', 'SALES_NOTIFY_EMAIL']) delete process.env[key];

    await require('../scripts/migrate')({ log: () => {} });
    const functions = require('../utils/functions');
    await functions.executeSql("UPDATE whatsapp_templates SET status = 'approved'");
    pool = require('../mysql').pool;
    const sql = functions.executeSql.bind(functions);
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
      assert.equal(result.status, expected, `${args[0]} ${args[1]}: ${result.raw.slice(0, 400)}`);
      return result.data;
    };
    const pub = (method, path, body, expected) => expect(expected, method, `/public${path}`, { body });
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
      const ctx = { companyId, token: login.jwtToken };
      ctx.as = (method, path, body, expected = 200) => expect(expected, method, path, { body, auth: ctx.token, company: ctx.companyId });
      return ctx;
    }
    const A = await tenant('a', '52998224725');
    const B = await tenant('b', '11144477735');
    const service = async (companyId, name, duration, value) => (await sql('INSERT INTO services (name, duration, value, cost, company_id, requires_location, accepts_quantity) VALUES (?, ?, ?, 0, ?, 0, 0)', [name, duration, value, companyId])).insertId;
    const corte = await service(A.companyId, 'Corte', 30, 40);
    const barba = await service(A.companyId, 'Barba', 30, 20);
    const quimica = await service(A.companyId, 'Química', 60, 100);
    const serviceB = await service(B.companyId, 'Serviço B', 30, 50);
    const proA = (await A.as('POST', '/professionals', { name: 'Ana', service_ids: [corte, barba, quimica] }, 201)).data;
    const proB = (await B.as('POST', '/professionals', { name: 'Beto', service_ids: [serviceB] }, 201)).data;
    for (const [company, pro] of [[A.companyId, proA.id], [B.companyId, proB.id]]) {
      for (let weekday = 0; weekday < 7; weekday++) {
        await sql("INSERT INTO availability_rules (company_id, professional_id, weekday, start_time, end_time) VALUES (?, ?, ?, '08:00', '18:00')", [company, pro, weekday]);
      }
    }
    const [{ D }] = await sql("SELECT DATE_FORMAT(NOW() + INTERVAL 7 DAY, '%Y-%m-%d') AS D");
    const slugA = `empresa-a-${process.pid}`;
    const slugB = `empresa-b-${process.pid}`;
    let seq = 0;
    const key = () => `chave-${process.pid}-${++seq}-${crypto.randomBytes(4).toString('hex')}`;
    const phone = n => `+55119${String(70000000 + n).padStart(8, '0')}`;
    const bookingBody = (extra = {}) => ({
      service_ids: [corte], professional_id: null, start: `${D}T10:00`,
      customer: { name: 'Maria Teste', phone: phone(1), email: 'maria@example.test' },
      consent: true, source: 'instagram', idempotency_key: key(), turnstile_token: 'ok', ...extra,
    });
    const slots = async (slug, serviceId = corte, extra = '') => {
      const data = await pub('GET', `/b/${slug}/availability?service_id=${serviceId}&from=${D}&to=${D}${extra}`, undefined, 200);
      return data.days[0].slots;
    };

    await t.test('página pública: slug automático, validação, unicidade e flags', async () => {
      const page = (await A.as('GET', '/public-page')).data;
      assert.match(page.slug, /^empresa-a/, 'slug gerado na criação');
      assert.equal(page.public_page_enabled, false);
      await pub('GET', `/b/${page.slug}`, undefined, 404);
      await A.as('PUT', '/public-page', { slug: 'admin' }, 400);
      await A.as('PUT', '/public-page', { slug: 'a--b' }, 400);
      await A.as('PUT', '/public-page', { company_id: B.companyId }, 400);
      await A.as('PUT', '/public-page', { slug: slugA, public_page_enabled: true, public_description: 'Barbearia de teste', theme_primary_color: '#112233' });
      await B.as('PUT', '/public-page', { slug: slugA }, 409);
      await B.as('PUT', '/public-page', { slug: slugB, public_page_enabled: true });
      await A.as('PUT', `/public-page/services/${quimica}`, { deposit_cents: 100 }, 400);
      await A.as('PUT', `/public-page/services/${quimica}`, { deposit_cents: 3000 });
      await B.as('PUT', `/public-page/services/${quimica}`, { deposit_cents: 0 }, 404);
    });

    await t.test('GET /public/b/:slug: dados públicos, powered_by Free, sem sinal sem Asaas', async () => {
      const res = await call('GET', `/public/b/${slugA}`, { headers: { Origin: SITE } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), SITE);
      assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const { company, services, professionals } = res.data;
      assert.deepEqual([company.name, company.slug, company.powered_by, company.theme.primary_color, company.timezone], ['Empresa a', slugA, true, null, 'America/Sao_Paulo']);
      assert.equal(company.address, 'Rua de Testes, 10 - São Paulo/SP');
      assert.ok(!('id' in company) && !('asaas_status' in company) && !('document' in company));
      assert.deepEqual(services.map(s => s.name).sort(), ['Barba', 'Corte'], 'serviço com sinal oculto sem Asaas aprovado');
      assert.deepEqual(services.find(s => s.id === corte), { id: corte, name: 'Corte', description: null, duration_min: 30, price_cents: 4000, deposit_cents: 0, requires_payment: false });
      assert.deepEqual(professionals.map(p => [p.id, p.name]), [[proA.id, 'Ana']]);
      const evil = await call('GET', `/public/b/${slugA}`, { headers: { Origin: 'https://evil.example.test' } });
      assert.equal(evil.headers.get('access-control-allow-origin'), null);
      assert.equal((await pub('GET', `/b/${slugB}`, undefined, 200)).services.length, 1);
    });

    await t.test('disponibilidade: validação, 14 dias, isolamento entre empresas', async () => {
      const list = await slots(slugA);
      assert.ok(list.some(s => s.start === '10:00' && s.professional_id === proA.id));
      assert.ok(list.every(s => s.professional_id === proA.id));
      assert.equal(list[0].start, '08:00');
      const both = await slots(slugA, `${corte},${barba}`);
      assert.ok(!both.some(s => s.start === '17:30'), 'duração somada (60 min) não cabe às 17:30');
      const [{ far }] = await sql("SELECT DATE_FORMAT(NOW() + INTERVAL 22 DAY, '%Y-%m-%d') AS far");
      assert.equal((await pub('GET', `/b/${slugA}/availability?service_id=${corte}&from=${D}&to=${far}`, undefined, 400)).error.code, 'validation_error');
      assert.equal((await pub('GET', `/b/${slugA}/availability?service_id=${corte}&from=${D}&to=${D}&company_id=${B.companyId}`, undefined, 400)).error.code, 'validation_error');
      await pub('GET', `/b/${slugA}/availability?service_id=${serviceB}&from=${D}&to=${D}`, undefined, 400);
      await pub('GET', `/b/${slugA}/availability?service_id=${corte}&professional_id=${proB.id}&from=${D}&to=${D}`, undefined, 400);
      await pub('GET', `/b/${slugA}/availability?service_id=${corte}&from=2027-02-30&to=2027-02-30`, undefined, 400);
    });

    let first;
    await t.test('reserva: consentimento, Turnstile, campos extras, criação e LGPD', async () => {
      assert.equal((await pub('POST', `/b/${slugA}/bookings`, bookingBody({ consent: false }), 400)).error.code, 'consent_required');
      assert.equal((await pub('POST', `/b/${slugA}/bookings`, bookingBody({ turnstile_token: 'ruim' }), 400)).error.code, 'turnstile_failed');
      assert.equal((await pub('POST', `/b/${slugA}/bookings`, bookingBody({ company_id: B.companyId }), 400)).error.code, 'validation_error');
      assert.equal((await pub('POST', `/b/${slugA}/bookings`, bookingBody({ service_ids: [serviceB] }), 400)).error.code, 'validation_error');
      const body = bookingBody({ service_ids: [corte, barba] });
      first = { body, res: await pub('POST', `/b/${slugA}/bookings`, body, 201) };
      const { booking, manage_token: token, payment } = first.res;
      assert.equal(payment, undefined);
      assert.deepEqual({ ...booking, id: undefined }, {
        id: undefined, status: 'confirmed', start: `${D}T10:00`, end: `${D}T11:00`, service_ids: [corte, barba], service_names: ['Corte', 'Barba'],
        professional_id: proA.id, professional_name: 'Ana', deposit_cents: 0,
      });
      assert.match(booking.id, /^[A-Za-z0-9_-]{22}$/);
      assert.match(token, /^v1\./);
      const [row] = await sql('SELECT pb.company_id, a.source, a.payment_status, a.hold_expires_at, c.name, c.tel FROM public_bookings pb JOIN appointments a ON a.id = pb.appointment_id JOIN customers c ON c.id = pb.customer_id WHERE pb.public_id = ?', [booking.id]);
      assert.deepEqual({ ...row }, { company_id: A.companyId, source: 'instagram', payment_status: 'isento', hold_expires_at: null, name: 'Maria Teste', tel: '11970000001' });
      const [consent] = await sql("SELECT purpose, granted, source FROM consents WHERE company_id = ? AND purpose = 'public_booking'", [A.companyId]);
      assert.deepEqual({ ...consent }, { purpose: 'public_booking', granted: 1, source: 'public:instagram' });
      assert.ok(!(await slots(slugA)).some(s => ['10:00', '10:30'].includes(s.start)), 'horário some da disponibilidade');
      assert.ok((await slots(slugB, serviceB)).some(s => s.start === '10:00'), 'B não é afetada');
    });

    await t.test('idempotência: reenvio devolve a mesma reserva; dados diferentes = 409', async () => {
      const turnstileBefore = turnstileCalls.length;
      const again = await pub('POST', `/b/${slugA}/bookings`, first.body, 200);
      assert.equal(again.booking.id, first.res.booking.id);
      assert.equal(again.manage_token, first.res.manage_token);
      assert.equal(turnstileCalls.length, turnstileBefore, 'reenvio não consome Turnstile');
      const changed = await pub('POST', `/b/${slugA}/bookings`, { ...first.body, start: `${D}T14:00` }, 409);
      assert.equal(changed.error.code, 'idempotency_conflict');
      assert.equal((await sql('SELECT COUNT(*) AS n FROM public_bookings WHERE company_id = ?', [A.companyId]))[0].n, 1);
      // Mesma chave na empresa B é outra reserva (chave é por empresa).
      await pub('POST', `/b/${slugB}/bookings`, { ...first.body, service_ids: [serviceB] }, 201);
    });

    await t.test('conflito, antecedência mínima e cliente reaproveitado pelo telefone', async () => {
      assert.equal((await pub('POST', `/b/${slugA}/bookings`, bookingBody({ start: `${D}T10:30`, customer: { name: 'Outra', phone: phone(2) } }), 409)).error.code, 'slot_taken');
      const [{ soon }] = await sql("SELECT DATE_FORMAT(NOW() + INTERVAL 30 MINUTE, '%Y-%m-%dT%H:%i') AS soon");
      assert.equal((await pub('POST', `/b/${slugA}/bookings`, bookingBody({ start: soon }), 409)).error.code, 'slot_taken');
      await pub('POST', `/b/${slugA}/bookings`, bookingBody({ start: `${D}T08:00`, customer: { name: 'Nome Diferente', phone: '(11) 97000-0001' } }), 201);
      const customers = await sql("SELECT id, name FROM customers WHERE company_id = ? AND tel = '11970000001'", [A.companyId]);
      assert.deepEqual(customers.map(c => c.name), ['Maria Teste'], 'um cliente; nome cadastrado preservado');
      const [{ n }] = await sql("SELECT COUNT(*) AS n FROM customers WHERE company_id = ? AND tel = '11970000001'", [B.companyId]);
      assert.equal(n, 1, 'B tem o próprio cadastro');
    });

    await t.test('concorrência: mesma vaga em paralelo -> só uma reserva', async () => {
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => call('POST', `/public/b/${slugA}/bookings`, {
        body: bookingBody({ start: `${D}T15:00`, customer: { name: `Paralelo ${i}`, phone: phone(100 + i) } }),
      })));
      const statuses = results.map(r => r.status).sort();
      assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409], JSON.stringify(results.map(r => r.data)));
      assert.ok(results.filter(r => r.status === 409).every(r => r.data.error.code === 'slot_taken'));
      const [{ n }] = await sql("SELECT COUNT(*) AS n FROM appointments WHERE company_id = ? AND date = ? AND canceled = 0", [A.companyId, `${D} 15:00:00`]);
      assert.equal(n, 1);
    });

    await t.test('gestão por token: visão sem PII, adulterado 404, expirado 410', async () => {
      const token = first.res.manage_token;
      const view = await pub('GET', `/bookings/${token}`, undefined, 200);
      assert.equal(view.booking.status, 'confirmed');
      assert.deepEqual(view.company, { name: 'Empresa a', slug: slugA, address: 'Rua de Testes, 10 - São Paulo/SP', phone: '11999999999', timezone: 'America/Sao_Paulo' });
      assert.deepEqual(view.policy, { can_cancel: true, can_reschedule: true, min_notice_hours: 2 });
      assert.ok(!JSON.stringify(view).includes('970000001') && !JSON.stringify(view).includes('Maria'), 'sem dados do cliente');
      const parts = token.split('.');
      const tampered = [parts[0], parts[1], parts[2], (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1)].join('.');
      assert.equal((await pub('GET', `/bookings/${tampered}`, undefined, 404)).error.code, 'not_found');
      await pub('GET', '/bookings/qualquer-coisa', undefined, 404);
      const expired = require('../services/publicTokens').issue(first.res.booking.id, new Date(Date.now() - 1000));
      assert.equal((await pub('GET', `/bookings/${expired}`, undefined, 410)).error.code, 'token_expired');
      await pub('POST', `/bookings/${expired}/cancel`, {}, 410);
      await pub('POST', `/bookings/${token}/cancel`, { motivo: 'x' }, 400);
    });

    await t.test('remarcar e cancelar pelo token; janela de cancelamento', async () => {
      const created = await pub('POST', `/b/${slugA}/bookings`, bookingBody({ start: `${D}T12:00`, customer: { name: 'Remarca', phone: phone(3) } }), 201);
      const token = created.manage_token;
      assert.equal((await pub('POST', `/bookings/${token}/reschedule`, { start: `${D}T15:00` }, 409)).error.code, 'slot_taken');
      const moved = await pub('POST', `/bookings/${token}/reschedule`, { start: `${D}T16:00` }, 200);
      assert.deepEqual([moved.booking.start, moved.booking.end, moved.booking.status], [`${D}T16:00`, `${D}T16:30`, 'confirmed']);
      assert.ok((await slots(slugA)).some(s => s.start === '12:00'), 'vaga antiga liberada');
      const cancelled = await pub('POST', `/bookings/${token}/cancel`, {}, 200);
      assert.deepEqual([cancelled.booking.status, cancelled.booking.cancellation_reason, cancelled.policy.can_cancel], ['cancelled', 'customer', false]);
      assert.equal((await pub('POST', `/bookings/${token}/cancel`, {}, 409)).error.code, 'already_cancelled');
      await pub('POST', `/bookings/${token}/reschedule`, { start: `${D}T17:00` }, 409);
      assert.ok((await slots(slugA)).some(s => s.start === '16:00'), 'vaga liberada após cancelar');
      const [{ status }] = await sql('SELECT s.status FROM sales s JOIN public_bookings pb ON pb.sale_id = s.id WHERE pb.public_id = ?', [created.booking.id]);
      assert.equal(status, 'cancelada');

      const late = await pub('POST', `/b/${slugA}/bookings`, bookingBody({ start: `${D}T17:00`, customer: { name: 'Tarde', phone: phone(4) } }), 201);
      await sql("UPDATE appointments a JOIN public_bookings pb ON pb.appointment_id = a.id SET a.date = DATE_FORMAT(NOW() + INTERVAL 60 MINUTE, '%Y-%m-%d %H:%i:00') WHERE pb.public_id = ?", [late.booking.id]);
      const view = await pub('GET', `/bookings/${late.manage_token}`, undefined, 200);
      assert.deepEqual([view.policy.can_cancel, view.policy.can_reschedule], [false, false]);
      assert.equal((await pub('POST', `/bookings/${late.manage_token}/cancel`, {}, 409)).error.code, 'cancel_window_closed');
    });

    await t.test('confirmação ao cliente pela fila (WhatsApp com link de gestão)', async () => {
      const jobs = require('../services/jobsService');
      sent.length = 0;
      await jobs.tick({ budgetMs: 10000 });
      const msg = sent.find(m => m.to === '5511970000001');
      assert.ok(msg, JSON.stringify(sent.map(m => m.to)));
      assert.equal(msg.template.name, 'agendamento_confirmado');
      assert.match(msg.template.components[0].parameters.map(p => p.text).join('|'), new RegExp(`${SITE}/agendamento/v1\\.`));
      const [{ n }] = await sql("SELECT COUNT(*) AS n FROM jobs WHERE type = 'booking_confirmation' AND status = 'done'");
      assert.ok(n >= 3);
    });

    // ---------- sinal Pix ----------
    const asaas = require('../services/asaasService');
    const charges = [];
    const originals = { getOrCreateCustomer: asaas.getOrCreateCustomer, createPixCharge: asaas.createPixCharge, cancelCharge: asaas.cancelCharge };
    let failNext = false;
    asaas.getOrCreateCustomer = async () => 'cus_teste';
    asaas.cancelCharge = async () => {};
    asaas.createPixCharge = async args => {
      if (failNext) { failNext = false; throw Object.assign(new Error('falha simulada'), { response: { status: 500 } }); }
      charges.push(args);
      return { paymentId: `pay_f3_${charges.length}`, payload: `pix-copia-e-cola-${charges.length}`, expirationDate: null, encodedImage: 'iVBORw0KGgo=' };
    };
    await sql("UPDATE companies SET asaas_api_key = ?, asaas_status = 'APPROVED' WHERE id = ?", [require('../utils/crypto').encrypt('chave-ficticia'), A.companyId]);
    const hook = body => call('POST', '/webhook/asaas', { body, headers: { 'asaas-access-token': process.env.ASAAS_WEBHOOK_TOKEN } });
    const depositBody = (start, n) => bookingBody({ service_ids: [quimica], start: `${D}T${start}`, customer: { name: `Sinal ${n}`, phone: phone(200 + n) } });

    let paidLater;
    await t.test('sinal: Pix com split, pending_payment e confirmação pelo webhook', async () => {
      const page = await pub('GET', `/b/${slugA}`, undefined, 200);
      assert.deepEqual(page.services.find(s => s.id === quimica).deposit_cents, 3000);
      assert.equal(page.services.find(s => s.id === quimica).requires_payment, true);
      const body = depositBody('09:00', 1);
      const res = await pub('POST', `/b/${slugA}/bookings`, body, 201);
      assert.equal(res.booking.status, 'pending_payment');
      assert.deepEqual({ ...res.payment, expires_at: undefined }, { provider: 'asaas', amount_cents: 3000, pix_qr_base64: 'iVBORw0KGgo=', pix_copy_paste: 'pix-copia-e-cola-1', expires_at: undefined });
      assert.ok(new Date(res.payment.expires_at).getTime() > Date.now());
      const charge = charges.at(-1);
      assert.equal(charge.value, 30);
      assert.deepEqual(charge.split, [{ walletId: 'wallet-plataforma-teste', fixedValue: 1.5 }]);
      assert.match(charge.externalReference, /^SALE_\d+$/);
      assert.equal((await pub('POST', `/b/${slugA}/bookings`, body, 200)).payment.pix_copy_paste, 'pix-copia-e-cola-1', 'reenvio devolve o mesmo Pix');
      assert.equal(charges.length, 1);
      assert.equal((await pub('GET', `/bookings/${res.manage_token}`, undefined, 200)).payment.pix_copy_paste, 'pix-copia-e-cola-1');
      assert.ok(!(await slots(slugA)).some(s => s.start === '09:00'), 'reserva pendente ocupa a vaga');
      assert.equal((await pub('POST', `/bookings/${res.manage_token}/reschedule`, { start: `${D}T13:00` }, 409)).error.code, 'not_allowed');

      const r = await hook({ id: 'evt_f3_paid_1', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_f3_1', externalReference: charge.externalReference, value: 30 } });
      assert.equal(r.status, 200, r.raw);
      const view = await pub('GET', `/bookings/${res.manage_token}`, undefined, 200);
      assert.equal(view.booking.status, 'confirmed');
      assert.equal(view.payment, undefined);
      const [appt] = await sql('SELECT a.payment_status, a.hold_expires_at FROM appointments a JOIN public_bookings pb ON pb.appointment_id = a.id WHERE pb.public_id = ?', [res.booking.id]);
      assert.deepEqual({ ...appt }, { payment_status: 'sinal_pago', hold_expires_at: null });
      const [{ n }] = await sql("SELECT COUNT(*) AS n FROM jobs WHERE type = 'booking_confirmation' AND dedupe_key LIKE 'booking_confirmed:%'");
      assert.ok(n >= 1);
    });

    await t.test('sinal não pago expira na leitura (sem cron); pago tarde com vaga tomada = conflito', async () => {
      paidLater = await pub('POST', `/b/${slugA}/bookings`, depositBody('13:00', 2), 201);
      await sql('UPDATE appointments a JOIN public_bookings pb ON pb.appointment_id = a.id SET a.hold_expires_at = NOW() - INTERVAL 1 MINUTE WHERE pb.public_id = ?', [paidLater.booking.id]);
      const view = await pub('GET', `/bookings/${paidLater.manage_token}`, undefined, 200);
      assert.deepEqual([view.booking.status, view.booking.cancellation_reason, view.payment], ['cancelled', 'payment_expired', undefined]);
      const [status] = await sql("SELECT s.status_name FROM appointment_status_view s JOIN public_bookings pb ON pb.appointment_id = s.id WHERE pb.public_id = ?", [paidLater.booking.id]).catch(() => [null]);
      if (status) assert.equal(status.status_name, 'cancelado');
      assert.ok((await slots(slugA)).some(s => s.start === '13:00'), 'vaga liberada pelo tempo');
      await pub('POST', `/b/${slugA}/bookings`, bookingBody({ start: `${D}T13:00`, customer: { name: 'Tomou', phone: phone(5) } }), 201);

      const charge = charges.at(-1);
      const r = await hook({ id: 'evt_f3_paid_late', event: 'PAYMENT_RECEIVED', payment: { id: `pay_f3_${charges.length}`, externalReference: charge.externalReference, value: 30 } });
      assert.equal(r.status, 200, r.raw);
      const [row] = await sql('SELECT a.canceled, a.payment_status, pb.conflict_at IS NOT NULL AS conflict, pb.cancel_reason FROM appointments a JOIN public_bookings pb ON pb.appointment_id = a.id WHERE pb.public_id = ?', [paidLater.booking.id]);
      assert.deepEqual({ ...row }, { canceled: 1, payment_status: 'sinal_pago', conflict: 1, cancel_reason: 'paid_after_expiry' });
      const [{ n }] = await sql("SELECT COUNT(*) AS n FROM appointments WHERE company_id = ? AND date = ? AND canceled = 0", [A.companyId, `${D} 13:00:00`]);
      assert.equal(n, 1, 'sem dupla reserva');
    });

    await t.test('falha ao gerar o Pix: 503 payment_unavailable e vaga liberada', async () => {
      failNext = true;
      assert.equal((await pub('POST', `/b/${slugA}/bookings`, depositBody('14:00', 3), 503)).error.code, 'payment_unavailable');
      assert.ok((await slots(slugA)).some(s => s.start === '14:00'));
    });

    await t.test('Turnstile fail closed: sem segredo -> 503 em reserva e lead', async () => {
      const saved = process.env.TURNSTILE_SECRET_KEY;
      delete process.env.TURNSTILE_SECRET_KEY;
      process.env.TURNSTILE_ENABLED = 'false';
      try {
        assert.equal((await pub('POST', `/b/${slugA}/bookings`, bookingBody({ start: `${D}T14:30`, customer: { name: 'Sem Captcha', phone: phone(6) } }), 503)).error.code, 'service_unavailable');
        assert.equal((await pub('POST', '/leads', { name: 'Lead Sem Captcha', whatsapp: phone(7), segment: 'barbearia', source: 'site', turnstile_token: 'ok' }, 503)).error.code, 'service_unavailable');
      } finally {
        process.env.TURNSTILE_SECRET_KEY = saved;
        process.env.TURNSTILE_ENABLED = 'true';
      }
    });

    await t.test('limites: telefone por empresa e leads por IP/telefone (Retry-After)', async () => {
      await sql('DELETE FROM rate_limits');
      const past = '2020-01-01T10:00';
      for (let i = 0; i < 5; i++) {
        assert.equal((await pub('POST', `/b/${slugA}/bookings`, bookingBody({ start: past, customer: { name: 'Lim', phone: phone(300) } }), 409)).error.code, 'slot_taken');
      }
      const limited = await call('POST', `/public/b/${slugA}/bookings`, { body: bookingBody({ start: past, customer: { name: 'Lim', phone: phone(300) } }) });
      assert.equal(limited.status, 429);
      assert.equal(limited.data.error.code, 'rate_limited');
      assert.ok(Number(limited.headers.get('retry-after')) > 0);
      await pub('POST', `/b/${slugB}/bookings`, bookingBody({ service_ids: [serviceB], start: past, customer: { name: 'Lim', phone: phone(300) } }), 409);

      const lead = (n, extra = {}) => ({ name: 'Lead Teste', whatsapp: phone(n), email: 'lead@example.test', segment: 'barbearia', source: 'site/home', message: 'Quero saber mais', turnstile_token: 'ok', ...extra });
      sent.length = 0;
      assert.deepEqual(await pub('POST', '/leads', lead(400), 201), { ok: true });
      await pub('POST', '/leads', lead(400), 201);
      await pub('POST', '/leads', lead(400, { source: undefined }), 201);
      assert.deepEqual((await sql('SELECT source FROM leads ORDER BY id')).map(r => r.source), ['site/home', 'site/home', 'site']);
      assert.equal((await pub('POST', '/leads', lead(400), 429)).error.code, 'rate_limited');
      assert.equal((await pub('POST', '/leads', lead(401, { extra: 1 }), 400)).error.code, 'validation_error');
      assert.equal((await pub('POST', '/leads', lead(401, { turnstile_token: 'ruim' }), 400)).error.code, 'turnstile_failed');
      const ipLimited = await call('POST', '/public/leads', { body: lead(402) });
      assert.equal(ipLimited.status, 429);
      assert.ok(Number(ipLimited.headers.get('retry-after')) > 0);
      assert.equal((await sql('SELECT COUNT(*) AS n FROM leads'))[0].n, 3);
      await require('../services/jobsService').tick({ budgetMs: 10000 });
      const notice = sent.filter(m => m.to === '5511900000000');
      assert.equal(notice.length, 3);
      assert.equal(notice[0].template.name, 'lead_novo');
      assert.equal(notice[0].template.components[0].parameters[0].text, 'Lead Teste');
    });

    await t.test('anti-enumeração de slug e 404 JSON', async () => {
      await sql('DELETE FROM rate_limits');
      for (let i = 0; i < 5; i++) assert.equal((await pub('GET', `/b/nao-existe-${i}`, undefined, 404)).error.code, 'not_found');
      const blocked = await call('GET', `/public/b/${slugA}`);
      assert.equal(blocked.status, 429, 'mesmo slug válido bloqueado após muitas tentativas');
      assert.equal((await pub('GET', '/rota-inexistente', undefined, 404)).error.code, 'not_found');
    });

    Object.assign(asaas, originals);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (stub) await new Promise(resolve => stub.close(resolve));
    if (pool) await new Promise(resolve => pool.end(resolve));
    await adminQuery('DROP DATABASE IF EXISTS ??', [database]).catch(() => {});
    admin.end();
  }
});
