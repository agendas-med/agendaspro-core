require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const mysql = require('mysql');
const { promisify } = require('node:util');

test('Mercado Pago: HTTP, MariaDB e provedor HTTP isolados', { skip: !process.env.MYSQL_ROOT_PASSWORD, timeout: 90000 }, async t => {
  const database = `agendaspro_mp_test_${process.pid}`;
  const admin = mysql.createConnection({ host: process.env.MYSQL_HOST, port: process.env.MYSQL_PORT,
    user: 'root', password: process.env.MYSQL_ROOT_PASSWORD, multipleStatements: true });
  const adminSql = promisify(admin.query).bind(admin);
  let server, provider, pool;
  const listen = async app => { const value = app.listen(0, '127.0.0.1'); await new Promise(resolve => value.once('listening', resolve)); return value; };
  try {
    await adminSql('CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', [database]);
    Object.assign(process.env, { MYSQL_DATABASE: database, MYSQL_USER: 'root', MYSQL_PASSWORD: process.env.MYSQL_ROOT_PASSWORD,
      ENABLE_REMINDERS: 'false', PAYMENT_PROVIDER: 'mercadopago', ASAAS_API_KEY: 'must-not-be-used',
      MP_ACCESS_TOKEN: 'local-fixture-only', MP_COLLECTOR_ID: '123', MP_ENV: 'test', MP_COMMISSION_BPS: '500',
      MP_PAYOUTS_ENABLED: 'false', MP_AUTO_PAYOUTS: 'false', MP_WEBHOOK_SECRET: 'local-signature-secret',
      MP_WEBHOOK_URL: 'https://example.test/webhook/mercadopago', MP_PAYOUT_WEBHOOK_URL: 'https://example.test/webhook/mercadopago/payouts' });
    process.env.JWT_KEY ||= 'integration-only-jwt';
    await require('../scripts/migrate')();
    const functions = require('../utils/functions');
    pool = require('../mysql').pool;
    const sql = functions.executeSql.bind(functions);
    const remotePayments = new Map(), remotePayouts = new Map(), paymentKeys = new Map(), payoutKeys = new Map();
    let paymentPosts = 0, payoutPosts = 0, dropPaymentResponse = false, dropPayoutResponse = false, asyncOrderResponse = false;
    let accountTags = ['test_user'];
    const orderResponse = payment => {
      const status = { approved: 'processed', pending: 'action_required', cancelled: 'canceled', refunded: 'refunded' }[payment.status];
      const detail = payment.status === 'approved' ? 'accredited' : 'waiting_transfer';
      return { id: payment.id, user_id: String(payment.collector_id), country_code: 'BRA', type: 'online', processing_mode: 'automatic',
        total_amount: String(payment.transaction_amount), total_paid_amount: payment.status === 'approved' ? String(payment.transaction_amount) : '0',
        external_reference: payment.external_reference, status, status_detail: detail,
        transactions: { payments: [{ id: `PAY${payment.id.slice(3)}`, amount: String(payment.transaction_amount), status, status_detail: detail,
          date_of_expiration: '2027-12-31T10:00:00Z', payment_method: { id: 'pix', type: 'bank_transfer', ...payment.point_of_interaction.transaction_data } }],
          refunds: payment.transaction_amount_refunded ? [{ amount: String(payment.transaction_amount_refunded) }] : [] } };
    };
    provider = await listen(http.createServer(async (req, res) => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString(); const body = raw ? JSON.parse(raw) : null;
        assert.equal(req.headers.authorization, 'Bearer local-fixture-only');
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/users/me') { res.end(JSON.stringify({ id: 123, site_id: 'MLB', tags: accountTags })); return; }
        if (req.url === '/v1/account/bank_report/list') { res.end(JSON.stringify([{ user_id: 123, file_name: 'bank-report-123.csv', date_created: '2026-10-24' }])); return; }
        if (req.url === '/v1/account/bank_report/bank-report-123.csv') {
          res.setHeader('Content-Type', 'text/csv');
          const rows = [...remotePayments.values()].filter(payment => payment.status === 'approved' && payment.money_release_status === 'released')
            .map(payment => `${payment.id};${payment.external_reference};release;payment;${payment.transaction_details.net_received_amount};0;${payment.transaction_amount};BRL;pix`);
          res.end(['ORDER_MP;EXTERNAL_REFERENCE;RECORD_TYPE;DESCRIPTION;NET_CREDIT_AMOUNT;NET_DEBIT_AMOUNT;GROSS_AMOUNT;CURRENCY;PAYMENT_METHOD', ...rows].join('\n')); return;
        }
        if (req.method === 'POST' && ['/v1/orders', '/v1/payments'].includes(req.url)) {
          const legacy = req.url === '/v1/payments';
          if (!legacy) {
            assert.equal(typeof body.total_amount, 'string'); assert.equal(body.type, 'online'); assert.equal(body.processing_mode, 'automatic');
            assert.equal(body.transactions.payments[0].payment_method.id, 'pix'); assert.equal(body.transactions.payments[0].amount, body.total_amount);
            assert.equal(body.notification_url, undefined);
          }
          paymentPosts++;
          const key = req.headers['x-idempotency-key'];
          const [durable] = await sql('SELECT request_body FROM mp_charges WHERE idempotency_key = ?', [key]);
          assert.equal(durable.request_body, raw, 'Intenção deve estar commitada antes do envio.');
          let payment = paymentKeys.get(key);
          if (!payment) {
            payment = { id: (legacy ? '' : 'ORD') + String(900000 + paymentKeys.size), collector_id: 123, live_mode: false,
              currency_id: 'BRL', payment_method_id: 'pix', transaction_amount: legacy ? body.transaction_amount : Number(body.total_amount),
              transaction_amount_refunded: 0, external_reference: body.external_reference, status: 'pending',
              date_of_expiration: body.date_of_expiration,
              money_release_status: 'pending', transaction_details: { net_received_amount: 99.01 },
              point_of_interaction: { transaction_data: { qr_code: 'test-pix', qr_code_base64: 'test-image', ticket_url: 'https://example.test/pix' } } };
            paymentKeys.set(key, payment); remotePayments.set(payment.id, payment);
          }
          if (dropPaymentResponse) { dropPaymentResponse = false; req.socket.destroy(); return; }
          if (asyncOrderResponse) {
            asyncOrderResponse = false;
            const response = orderResponse(payment); response.status = 'processing'; response.transactions = {};
            res.end(JSON.stringify(response)); return;
          }
          res.end(JSON.stringify(legacy ? payment : orderResponse(payment))); return;
        }
        const paymentId = req.url.match(/^\/v1\/orders\/(ORD\d+)(?:\/cancel)?$/)?.[1] || req.url.match(/^\/v1\/payments\/(\d+)$/)?.[1];
        if (paymentId) {
          const payment = remotePayments.get(paymentId); assert.ok(payment);
          if (req.method === 'PUT') payment.status = body.status;
          if (req.method === 'POST') { assert.ok(req.headers['x-idempotency-key']); payment.status = 'cancelled'; }
          res.end(JSON.stringify(paymentId.startsWith('ORD') ? orderResponse(payment) : payment)); return;
        }
        if (req.method === 'POST' && req.url === '/v1/payouts') {
          payoutPosts++;
          assert.equal(req.headers['x-test-token'], 'true');
          assert.equal(req.headers['x-enforce-signature'], 'false');
          const key = req.headers['x-idempotency-key'];
          const [durable] = await sql('SELECT request_body FROM mp_payouts WHERE idempotency_key = ?', [key]);
          assert.equal(durable.request_body, raw, 'Destino, valor e chave devem existir antes da transferência.');
          let response = payoutKeys.get(key);
          if (!response) {
            const id = `POP_${payoutKeys.size}`, transactionId = `TOP_${payoutKeys.size}`;
            const transaction = { id: transactionId, external_reference: body.external_reference,
              amount: body.transactions[0].amount, status: 'success', status_detail: 'in_progress' };
            remotePayouts.set(transactionId, transaction);
            response = { id, external_reference: body.external_reference, status: 'created', transactions: [transaction] };
            payoutKeys.set(key, response);
          }
          if (dropPayoutResponse) { dropPayoutResponse = false; req.socket.destroy(); return; }
          res.statusCode = 202; res.end(JSON.stringify(response)); return;
        }
        const transactionId = req.url.match(/^\/v1\/payouts\/[^/]+\/transactions\/([^/]+)$/)?.[1];
        if (transactionId) { res.end(JSON.stringify(remotePayouts.get(transactionId))); return; }
        res.statusCode = 404; res.end('{}');
      } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ fixture_error: error.message })); }
    }));
    require('../services/mercadoPagoService').client.defaults.baseURL = `http://127.0.0.1:${provider.address().port}`;
    server = await listen(require('../app'));
    const base = `http://127.0.0.1:${server.address().port}`;
    let token, companyId;
    async function request(method, path, body, expected = 200, headers = {}) {
      const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(companyId ? { 'Selected-company': String(companyId) } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const raw = await response.text(); let data; try { data = JSON.parse(raw); } catch { data = raw; }
      assert.equal(response.status, expected, `${method} ${path}: ${raw}`); return data;
    }
    const registration = await request('POST', '/users/register', { name: 'MP Teste', email: 'mp@example.test', password: 'integration-pass' });
    token = (await request('POST', '/users/login', { email: 'mp@example.test', password: 'integration-pass' })).returnObj.jwtToken;
    const [business] = await sql('SELECT id FROM business_types LIMIT 1');
    companyId = (await request('POST', '/companies/create_company', { name: 'MP Empresa', address: 'Rua de Testes', zip_code: '01310-100',
      city: 'São Paulo', state: 'SP', business_type: business.id, email: 'company@example.test', phone: '11999999999',
      document: '52998224725', address_number: '10', complement: '', birthDate: '1990-01-01', incomeValue: 5000 })).returnObj.id;
    await request('POST', '/customers', { name: 'Cliente MP', cpf: '11144477735', birthday: '1990-01-01', tel: '11999999999', image: '', email: 'payer@example.com' });
    const [customer] = await sql('SELECT id FROM customers WHERE company_id = ?', [companyId]);
    const [unit] = await sql('SELECT id FROM units_of_measurement LIMIT 1');
    const productId = (await sql("INSERT INTO products (name, value, cost, current_stock, company_id, unit_of_measure) VALUES ('Serviço Pix', 100, 0, 50, ?, ?)", [companyId, unit.id])).insertId;
    const newSale = () => require('../services/salesService').create(companyId, customer.id, null, [{ id: productId, quantity: 1 }]);
    const input = saleId => ({ sale_id: saleId, customer_id: customer.id, amount: 100, payment_type: 'pix_mercadopago' });
    const destination = { holder_name: 'Titular Teste', holder_document: '52998224725', bank_name: 'Banco Sandbox', pix_key_type: 'CPF', pix_key: '52998224725' };
    const signed = (paymentId, bodyId = paymentId) => {
      const digest = crypto.createHmac('sha256', process.env.MP_WEBHOOK_SECRET).update(`id:${paymentId.toLowerCase()};request-id:request-1;ts:1781009491;`).digest('hex');
      return request('POST', `/webhook/mercadopago?data.id=${paymentId}`, { type: 'order', data: { id: bodyId } }, bodyId === paymentId ? 200 : 401,
        { 'x-request-id': 'request-1', 'x-signature': `ts=1781009491,v1=${digest}` });
    };
    let saleId, charge, payoutId;
    await t.test('destino exige administrador, documento da empresa e retorna dados mascarados', async () => {
      await request('PUT', '/payments/mercadopago/destination', destination, 401, { Authorization: '' });
      await request('PUT', '/payments/mercadopago/destination', { ...destination, holder_document: '11144477735', pix_key: '11144477735' }, 400);
      await request('PUT', '/payments/mercadopago/destination', destination);
      const status = await request('GET', '/payments/mercadopago/status');
      assert.equal(status.destination.pix_key_masked, '***4725');
      assert.equal(status.destination.bank_name, 'Banco Sandbox');
      assert.equal(status.destination.pix_key, undefined);
      const { pix_key: omittedKey, ...withoutKey } = destination;
      await request('PUT', '/payments/mercadopago/destination', { ...withoutKey, bank_name: 'Banco atualizado' });
      assert.equal((await sql('SELECT pix_key FROM mp_destinations WHERE company_id = ?', [companyId]))[0].pix_key, omittedKey);
      await request('PUT', '/payments/mercadopago/destination', { ...withoutKey, pix_key_type: 'EMAIL' }, 400);
      assert.equal(JSON.stringify(status).includes('local-fixture-only'), false);
      const role = (await sql("INSERT INTO config_company_roles (company_id, name, permission, default_role) VALUES (?, 'Leitura', 0, 0)", [companyId])).insertId;
      const [assigned] = await sql('SELECT role_id FROM config_users_roles WHERE user_id = ?', [registration.returnObj.id]);
      await sql('UPDATE config_users_roles SET role_id = ? WHERE user_id = ?', [role, registration.returnObj.id]);
      await request('PUT', '/payments/mercadopago/destination', destination, 403);
      await sql('UPDATE config_users_roles SET role_id = ? WHERE user_id = ?', [assigned.role_id, registration.returnObj.id]);
    });
    await t.test('venda aceita ID e quantidade e mantém o preço do banco mesmo se o navegador enviar outro valor', async () => {
      const body = { company_id: companyId, customer_id: customer.id, appointment_id: null, status: 'em_aberto', products: [{ id: productId, quantity: 1 }] };
      const created = await request('POST', '/sales', body);
      await request('PATCH', `/sales/${created.returnObj.id}`, { ...body, products: [{ id: productId, quantity: 1, value: 0.01 }] });
      const result = (await request('GET', `/sales/${created.returnObj.id}`)).returnObj;
      assert.equal(result.total, 100);
      assert.equal(Number(result.products[0].value), 100);
    });
    await t.test('financeiro soma serviço e produto e atualiza o saldo a cada pagamento parcial', async () => {
      const serviceId = (await sql("INSERT INTO services (name, value, cost, duration, company_id) VALUES ('Atendimento financeiro', 30, 10, 30, ?)", [companyId])).insertId;
      const appointmentId = await require('../services/appointmentsService').create(companyId, customer.id, 'Cliente MP', '2027-08-01 10:00:00', 30, '', [{ id: serviceId, quantity: 1 }], 'pendente_pagamento');
      const [sale] = await sql('SELECT id FROM sales WHERE appointment_id = ? AND company_id = ?', [appointmentId, companyId]);
      await request('PATCH', `/sales/${sale.id}`, { company_id: companyId, customer_id: customer.id, appointment_id: appointmentId, status: 'em_aberto', products: [{ id: productId, quantity: 1 }] });
      const financial = async () => (await request('GET', '/financial')).returnObj.find(row => row.sale_id === sale.id);
      assert.equal((await financial()).value, 130);
      await request('POST', '/sales/insert_payment', { sale_id: sale.id, customer_id: customer.id, amount: 30, payment_type: 'dinheiro' });
      assert.equal((await financial()).remaining, 100);
      assert.equal((await financial()).status, 'Em Aberto');
      await request('POST', '/sales/insert_payment', { sale_id: sale.id, customer_id: customer.id, amount: 100, payment_type: 'dinheiro' });
      const received = await financial();
      assert.equal(received.value, 130);
      assert.equal(received.total_paid, 130);
      assert.equal(received.remaining, 0);
      assert.equal(received.status, 'Pago');
    });
    await t.test('criação concorrente e reentrega usam uma cobrança; venda pendente não aceita pagamento manual', async () => {
      saleId = await newSale(); const key = crypto.randomUUID();
      await request('POST', '/payments/mercadopago/charges', input(saleId), 400);
      const results = await Promise.all([1, 2].map(() => request('POST', '/payments/mercadopago/charges', input(saleId), 200, { 'Idempotency-Key': key })));
      charge = results[0]; assert.equal(charge.id, results[1].id); assert.equal(paymentPosts, 1);
      assert.equal(charge.pix.payload, 'test-pix');
      await request('POST', '/payments/mercadopago/charges', { ...input(saleId), amount: 99 }, 400, { 'Idempotency-Key': key });
      await request('POST', '/sales/insert_payment', { ...input(saleId), payment_type: 'dinheiro' }, 400);
      await request('DELETE', `/sales/${saleId}`, undefined, 400);
      await request('GET', `/payments/mercadopago/charges/${charge.id}`, undefined, 403, { 'Selected-company': '999999' });
      await request('GET', '/payments/mercadopago/charges', undefined, 403, { 'Selected-company': '999999' });
      const listed = await request('GET', '/payments/mercadopago/charges');
      assert.equal(listed[0].sale_id, saleId);
      assert.equal(listed[0].request_body, undefined);
    });
    await t.test('webhook confere assinatura, conta e valor; confirmação repetida cria um pagamento e um repasse', async () => {
      await request('POST', `/webhook/mercadopago?data.id=${charge.pix.paymentId}`, { type: 'payment', data: { id: charge.pix.paymentId } }, 401);
      await signed(charge.pix.paymentId, '999');
      const remote = remotePayments.get(charge.pix.paymentId); remote.status = 'approved';
      remote.collector_id = 999;
      await request('POST', `/payments/mercadopago/charges/${charge.id}/reconcile`, {}, 400);
      remote.collector_id = 123; remote.transaction_amount = 99;
      await request('POST', `/payments/mercadopago/charges/${charge.id}/reconcile`, {}, 400);
      remote.transaction_amount = 100;
      await Promise.all([signed(remote.id), signed(remote.id)]);
      const [count] = await sql('SELECT COUNT(*) AS total FROM payments WHERE sale_id = ?', [saleId]); assert.equal(count.total, 1);
      assert.equal((await request('GET', '/payments/mercadopago/payouts')).length, 0, 'Aprovação não informa líquido nem liberação na Orders API.');
      remote.money_release_status = 'released';
      await signed(remote.id);
      const payouts = await request('GET', '/payments/mercadopago/payouts'); assert.equal(payouts.length, 1);
      assert.equal(payouts[0].commission, 5); assert.equal(payouts[0].provider_fee, 0.99); assert.equal(payouts[0].amount, 94.01);
      payoutId = payouts[0].id;
      assert.equal((await request('GET', `/sales/${saleId}`)).returnObj.status, 'realizada');
    });
    await t.test('envio bloqueado sem saldo liberado/permissão; destino é congelado e crédito exige reconciliação', async () => {
      const remote = remotePayments.get(charge.pix.paymentId); remote.money_release_status = 'pending';
      await request('POST', `/payments/mercadopago/payouts/${payoutId}/submit`, {}, 400);
      remote.money_release_status = 'released';
      await request('POST', `/payments/mercadopago/payouts/${payoutId}/submit`, {}, 400);
      assert.equal(payoutPosts, 0);
      process.env.MP_PAYOUTS_ENABLED = 'true';
      remote.transaction_details.net_received_amount = 98;
      await request('POST', `/payments/mercadopago/payouts/${payoutId}/submit`, {}, 400); assert.equal(payoutPosts, 0);
      remote.transaction_details.net_received_amount = 99.01;
      await request('PUT', '/payments/mercadopago/destination', { ...destination, pix_key_type: 'EMAIL', pix_key: 'new@example.test' });
      const result = await request('POST', `/payments/mercadopago/payouts/${payoutId}/submit`, { amount: 999999, pix_key: 'attacker@example.test' });
      assert.equal(result.status, 'pending'); assert.equal(payoutPosts, 1);
      const [stored] = await sql('SELECT * FROM mp_payouts WHERE id = ?', [payoutId]);
      assert.equal(JSON.parse(stored.request_body).transactions[0].pix.chave, destination.pix_key);
      await request('POST', '/webhook/mercadopago/payouts', { payout: { id: stored.provider_payout_id }, id: stored.provider_transaction_id, status: 'success', status_detail: 'accredited' });
      assert.equal((await request('GET', '/payments/mercadopago/payouts'))[0].status, 'pending');
      remotePayouts.get(stored.provider_transaction_id).status_detail = 'accredited';
      const paid = await request('POST', `/payments/mercadopago/payouts/${payoutId}/reconcile`, {});
      assert.equal(paid.status, 'paid'); assert.ok(paid.paid_at);
      await request('POST', `/payments/mercadopago/payouts/${payoutId}/submit`, {}); assert.equal(payoutPosts, 1);
    });
    await t.test('respostas perdidas recuperam cobrança e repasse com o mesmo corpo e chave', async () => {
      const sale = await newSale(); const key = crypto.randomUUID(); dropPaymentResponse = true;
      await request('POST', '/payments/mercadopago/charges', input(sale), 400, { 'Idempotency-Key': key });
      const recovered = await request('POST', '/payments/mercadopago/charges', input(sale), 200, { 'Idempotency-Key': key });
      assert.equal(paymentKeys.size, 2);
      const remote = remotePayments.get(recovered.pix.paymentId); remote.status = 'approved'; remote.money_release_status = 'released';
      const confirmation = await request('POST', `/payments/mercadopago/charges/${recovered.id}/reconcile`, {});
      dropPayoutResponse = true;
      await request('POST', `/payments/mercadopago/payouts/${confirmation.payout_id}/submit`, {}, 400);
      await request('POST', `/payments/mercadopago/payouts/${confirmation.payout_id}/submit`, {});
      assert.equal(payoutKeys.size, 2, 'Resposta perdida não pode criar um segundo repasse.');
    });
    await t.test('cancelamento confirma no provedor; devolução após repasse exige revisão', async () => {
      const sale = await newSale(); const pending = await request('POST', '/payments/mercadopago/charges', input(sale), 200, { 'Idempotency-Key': crypto.randomUUID() });
      await request('POST', '/sales/cancel_pix', { sale_id: sale });
      assert.equal(remotePayments.get(pending.pix.paymentId).status, 'cancelled');
      assert.equal((await request('GET', `/sales/${sale}`)).returnObj.mp_charge_id, null);
      const remote = remotePayments.get(charge.pix.paymentId); remote.status = 'refunded'; remote.transaction_amount_refunded = 100;
      await signed(remote.id);
      assert.equal((await request('GET', '/payments/mercadopago/payouts')).find(p => p.id === payoutId).status, 'needs_review');
      assert.equal((await request('POST', `/payments/mercadopago/payouts/${payoutId}/reconcile`, {})).status, 'needs_review');
    });
    await t.test('Orders assíncrona recupera o QR sem criar uma segunda cobrança', async () => {
      const sale = await newSale(); const key = crypto.randomUUID(); asyncOrderResponse = true;
      const created = await request('POST', '/payments/mercadopago/charges', input(sale), 200, { 'Idempotency-Key': key });
      assert.equal(created.api, 'orders'); assert.equal(created.pix.payload, null);
      await request('POST', `/payments/mercadopago/charges/${created.id}/reconcile`, {});
      const restored = await request('GET', `/payments/mercadopago/charges/${created.id}`);
      assert.equal(restored.pix.payload, 'test-pix');
    });
    await t.test('cobrança antiga preserva API, chave e corpo de Payments após a migração', async () => {
      const sale = await newSale(); const key = crypto.randomUUID();
      const reference = `LEGACY_${crypto.randomUUID()}`;
      const body = JSON.stringify({ transaction_amount: 100, external_reference: reference, payment_method_id: 'pix', payer: { email: 'payer@example.com' } });
      const id = (await sql(`INSERT INTO mp_charges (company_id, sale_id, customer_id, environment, api_version, external_reference, idempotency_key,
        request_body, amount_cents, commission_bps) VALUES (?, ?, ?, 'test', 'payments', ?, ?, ?, 10000, 500)`, [companyId, sale, customer.id, reference, key, body])).insertId;
      await sql('UPDATE sales SET mp_charge_id = ? WHERE id = ?', [id, sale]);
      const recovered = await request('POST', '/payments/mercadopago/charges', input(sale), 200, { 'Idempotency-Key': key });
      assert.equal(recovered.api, 'payments'); assert.match(recovered.pix.paymentId, /^\d+$/);
      await request('POST', '/sales/cancel_pix', { sale_id: sale });
    });
    await t.test('conta real com MP_ENV=test bloqueia Orders antes de enviar uma cobrança', async () => {
      const sale = await newSale(); const key = crypto.randomUUID(); const posts = paymentPosts;
      accountTags = [];
      await request('POST', '/payments/mercadopago/charges', input(sale), 400, { 'Idempotency-Key': key });
      assert.equal(paymentPosts, posts);
      accountTags = ['test_user'];
      await request('POST', '/payments/mercadopago/charges', input(sale), 200, { 'Idempotency-Key': key });
      assert.equal(paymentPosts, posts + 1);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (provider) await new Promise(resolve => provider.close(resolve));
    if (pool) await promisify(pool.end).bind(pool)();
    await adminSql('DROP DATABASE IF EXISTS ??', [database]); admin.end();
  }
});
