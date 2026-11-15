process.env.NODE_ENV = "test";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql');
const { promisify } = require('node:util');

test('fluxos reais no MariaDB isolado', { skip: !process.env.MYSQL_ROOT_PASSWORD, timeout: 90000 }, async t => {
  const database = `agendaspro_test_${process.pid}`;
  const admin = mysql.createConnection({ host: process.env.MYSQL_HOST, port: process.env.MYSQL_PORT, user: 'root', password: process.env.MYSQL_ROOT_PASSWORD, multipleStatements: true });
  const adminQuery = promisify(admin.query).bind(admin);
  let server;
  let pool;
  try {
    await adminQuery('CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', [database]);
    process.env.MYSQL_DATABASE = database;
    process.env.MYSQL_USER = 'root';
    process.env.MYSQL_PASSWORD = process.env.MYSQL_ROOT_PASSWORD;
    process.env.ENABLE_REMINDERS = 'false';
    process.env.ASAAS_API_KEY = '';
    process.env.JWT_KEY ||= 'integration-only-key';
    process.env.ASAAS_WEBHOOK_TOKEN ||= 'integration-webhook-token-32-characters';
    const migrate = require('../scripts/migrate');
    await migrate();
    const functions = require('../utils/functions');
    pool = require('../mysql').pool;
    const sql = functions.executeSql.bind(functions);
    const app = require('../app');
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let token, companyId;
    async function request(method, path, body, expected = 200, headers = {}) {
      const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(companyId ? { 'Selected-company': String(companyId) } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); } catch { data = raw; }
      assert.equal(response.status, expected, `${method} ${path}: ${raw}`);
      return data;
    }
    await request('GET', '/health');
    const registration = await request('POST', '/users/register', { name: 'Teste Local', email: 'integration@agendaspro.test', password: 'integration-password' });
    token = (await request('POST', '/users/login', { email: 'integration@agendaspro.test', password: 'integration-password' })).returnObj.jwtToken;
    const [business] = await sql('SELECT id FROM business_types LIMIT 1');
    companyId = (await request('POST', '/companies/create_company', {
      name: 'Empresa Integração', address: 'Rua de Testes', zip_code: '01310-100', city: 'São Paulo', state: 'SP', business_type: business.id,
      email: 'company@example.com', phone: '11999999999', document: '12345678901', address_number: '10', complement: '', birthDate: '1990-01-01', incomeValue: 5000,
    })).returnObj.id;
    await request('POST', '/customers', { name: 'Cliente Teste', cpf: '12345678901', birthday: '1990-01-01', tel: '11999999999', image: '', email: 'customer@example.com' });
    const customer = (await request('GET', '/customers')).returnObj[0];
    const serviceId = (await sql("INSERT INTO services (name, duration, value, cost, company_id, requires_location, accepts_quantity) VALUES ('Serviço em casa', 30, 25, 10, ?, 1, 1)", [companyId])).insertId;
    const [service] = await sql('SELECT * FROM services WHERE id = ?', [serviceId]);
    const servicePayload = { ...service, quantity: 2 };
    const appointment = { customer_id: customer.id, customer_name: customer.name, date: '2027-06-01 10:00:00', duration: 30, observations: '', services: [servicePayload], status: 'pendente_pagamento', zip_code: '01310-100', address: 'Avenida Paulista', number: '100', complement: 'Sala 1', city: 'São Paulo', state: 'SP' };
    let appointmentId, saleId;
    await t.test('cadastro, endereço, quantidade e reserva concorrente sem duplicar venda', async () => {
      const results = await Promise.allSettled([request('POST', '/appointments', appointment), request('POST', '/appointments', appointment)]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      const list = (await request('GET', '/appointments')).returnObj;
      assert.equal(list.length, 1);
      appointmentId = list[0].id;
      assert.equal(list[0].address, 'Avenida Paulista');
      assert.equal(list[0].services[0].quantity, 2);
      assert.equal(list[0].status, 'pendente_pagamento');
      const sales = (await request('GET', '/sales')).returnObj;
      assert.equal(sales.length, 1);
      assert.equal(sales[0].total, 50);
      saleId = sales[0].id;
      await request('POST', `/appointments/init/${appointmentId}`, {}, 400);
      await request('PATCH', `/appointments/${appointmentId}`, { ...appointment, date: '2027-06-01 11:00:00' });
      assert.equal((await request('GET', `/appointments/${appointmentId}`)).returnObj.payment_status, 'pendente');
    });
    await t.test('pagamento parcial e integral refletidos em venda, agenda e financeiro', async () => {
      await request('POST', '/sales/insert_payment', { sale_id: saleId, customer_id: customer.id, amount: 20, payment_type: 'dinheiro' });
      assert.equal((await request('GET', `/sales/${saleId}`)).returnObj.total_paid, 20);
      await request('POST', '/sales/insert_payment', { sale_id: saleId, customer_id: customer.id, amount: 31, payment_type: 'pix' }, 400);
      await request('POST', '/sales/insert_payment', { sale_id: saleId, customer_id: customer.id, amount: 30, payment_type: 'pix' });
      assert.equal((await request('GET', `/sales/${saleId}`)).returnObj.status, 'realizada');
      assert.equal((await request('GET', `/appointments/${appointmentId}`)).returnObj.payment_status, 'pago');
      await request('POST', `/appointments/init/${appointmentId}`, {});
      await request('POST', `/appointments/stop/${appointmentId}`, {});
      const finished = (await request('GET', `/appointments/${appointmentId}`)).returnObj;
      assert.equal(finished.status, 'realizado');
      const finance = await require('../services/financialService').returnFinancial(companyId);
      assert.equal(finance[0].value, 50);
      assert.equal(finance[0].status, 'Pago');
    });
    await t.test('edição e cancelamento de venda não descontam estoque duas vezes', async () => {
      const [unit] = await sql('SELECT id FROM units_of_measurement LIMIT 1');
      const productId = (await sql("INSERT INTO products (name, value, cost, current_stock, company_id, unit_of_measure) VALUES ('Produto teste', 10, 3, 10, ?, ?)", [companyId, unit.id])).insertId;
      const data = { company_id: companyId, customer_id: customer.id, appointment_id: null, products: [{ id: productId, name: 'Produto teste', value: 10, cost: 3, description: '', quantity: 2, available_quantity: 10 }], status: 'em_aberto' };
      const created = await request('POST', '/sales', data);
      const id = created.returnObj.id;
      await request('PATCH', `/sales/${id}`, data);
      assert.equal((await sql('SELECT current_stock FROM products WHERE id = ?', [productId]))[0].current_stock, 8);
      await request('PATCH', `/sales/${id}`, { ...data, status: 'cancelada' });
      assert.equal((await sql('SELECT current_stock FROM products WHERE id = ?', [productId]))[0].current_stock, 10);
      await request('DELETE', `/sales/${id}`);
    });
    await t.test('cancelar ou excluir agendamento devolve estoque e mantém atomicidade', async () => {
      await request('POST', '/appointments', { ...appointment, date: '2027-06-04 10:00:00' });
      const [sale] = await sql('SELECT * FROM sales WHERE company_id = ? ORDER BY id DESC LIMIT 1', [companyId]);
      const [product] = await sql('SELECT * FROM products WHERE company_id = ? LIMIT 1', [companyId]);
      const data = { company_id: companyId, customer_id: customer.id, appointment_id: sale.appointment_id,
        products: [{ id: product.id, name: product.name, value: product.value, cost: product.cost, description: '', quantity: 2, available_quantity: 10 }], status: 'em_aberto' };
      await request('PATCH', `/sales/${sale.id}`, data);
      await request('PATCH', `/sales/${sale.id}`, { ...data, products: [{ ...data.products[0], quantity: 1000 }] }, 400);
      assert.equal((await sql('SELECT current_stock FROM products WHERE id = ?', [product.id]))[0].current_stock, 8);
      await request('POST', `/appointments/cancel/${sale.appointment_id}`, {});
      await request('POST', `/appointments/cancel/${sale.appointment_id}`, {});
      assert.equal((await sql('SELECT current_stock FROM products WHERE id = ?', [product.id]))[0].current_stock, 10);
      await request('DELETE', `/appointments/${sale.appointment_id}`);
      assert.equal((await sql('SELECT * FROM sales WHERE id = ?', [sale.id])).length, 0);
    });
    await t.test('webhook autenticado, vinculado à cobrança e idempotente', async () => {
      await request('POST', '/appointments', { ...appointment, date: '2027-06-02 10:00:00' });
      const [sale] = await sql('SELECT * FROM sales WHERE id <> ? AND company_id = ? LIMIT 1', [saleId, companyId]);
      await sql('UPDATE sales SET pix_asaas_id = ? WHERE id = ?', ['pay_test', sale.id]);
      await sql("INSERT INTO accounts_receivable (sale_id, customer_id, amount, payment_type, status) VALUES (?, ?, 50, 'pix_asaas', 'EM ABERTO')", [sale.id, customer.id]);
      const notification = { event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_test', externalReference: `SALE_${sale.id}`, value: 50 } };
      await request('POST', '/webhook/asaas', notification, 401);
      const headers = { 'asaas-access-token': process.env.ASAAS_WEBHOOK_TOKEN };
      await request('POST', '/webhook/asaas', notification, 200, headers);
      await request('POST', '/webhook/asaas', { ...notification, event: 'PAYMENT_RECEIVED' }, 200, headers);
      const result = (await request('GET', `/sales/${sale.id}`)).returnObj;
      assert.equal(result.payments.length, 1);
      assert.equal(result.total_paid, 50);
      assert.equal(result.status, 'realizada');
      assert.equal(result.pix_payload, null);
      assert.equal((await sql('SELECT payment_status FROM appointments WHERE id = ?', [sale.appointment_id]))[0].payment_status, 'pago');
    });
    await t.test('geração, retomada, cancelamento e confirmação parcial de Pix', async () => {
      const asaas = require('../services/asaasService');
      const original = { getOrCreateCustomer: asaas.getOrCreateCustomer, createPixCharge: asaas.createPixCharge, cancelCharge: asaas.cancelCharge };
      let cancellations = 0;
      asaas.getOrCreateCustomer = async () => 'customer_fake';
      asaas.createPixCharge = async () => ({ paymentId: 'pay_partial', payload: 'pix-code', encodedImage: 'fake-image', expirationDate: '2027-06-03 23:59:59' });
      asaas.cancelCharge = async () => { cancellations++; };
      try {
        await sql("UPDATE companies SET asaas_api_key = 'fake-key', asaas_status = 'APPROVED' WHERE id = ?", [companyId]);
        await request('POST', '/appointments', { ...appointment, date: '2027-06-03 10:00:00' });
        const [sale] = await sql('SELECT * FROM sales WHERE company_id = ? ORDER BY id DESC LIMIT 1', [companyId]);
        const input = { sale_id: sale.id, customer_id: customer.id, amount: 25, payment_type: 'pix_asaas' };
        assert.equal((await request('POST', '/sales/insert_payment', input)).pix.payload, 'pix-code');
        const pending = (await request('GET', `/sales/${sale.id}`)).returnObj;
        assert.equal(pending.pix_encoded_image, 'fake-image');
        assert.equal(pending.payments.length, 0);
        await request('POST', '/sales/insert_payment', input, 400);
        await request('POST', '/sales/cancel_pix', { sale_id: sale.id });
        assert.equal(cancellations, 1);
        assert.equal((await request('GET', `/sales/${sale.id}`)).returnObj.pix_asaas_id, null);
        await request('POST', '/sales/insert_payment', input);
        const headers = { 'asaas-access-token': process.env.ASAAS_WEBHOOK_TOKEN };
        const webhook = { event: 'PAYMENT_RECEIVED', payment: { id: 'pay_partial', externalReference: `SALE_${sale.id}`, value: 25 } };
        await request('POST', '/webhook/asaas', { ...webhook, payment: { ...webhook.payment, value: 50 } }, 500, headers);
        await request('POST', '/webhook/asaas', webhook, 200, headers);
        const partial = (await request('GET', `/sales/${sale.id}`)).returnObj;
        assert.equal(partial.total_paid, 25);
        assert.equal(partial.status, 'em_aberto');
        assert.equal((await request('GET', `/appointments/${sale.appointment_id}`)).returnObj.status, 'pendente_pagamento');
      } finally { Object.assign(asaas, original); }
    });
    await t.test('encerramento automático respeita a preferência ativa', async () => {
      const id = (await sql("INSERT INTO appointments (company_id, customer_id, customer_name, date, duration, checkin) VALUES (?, ?, 'Cliente', NOW() - INTERVAL 2 HOUR, 30, NOW() - INTERVAL 1 HOUR)", [companyId, customer.id])).insertId;
      await functions.insertCompanyPreference(companyId, 'auto_finish_appointments', 0);
      assert.equal((await sql('SELECT status FROM appointment_status_view WHERE id = ?', [id]))[0].status, 'iniciado');
      await functions.insertCompanyPreference(companyId, 'auto_finish_appointments', 1);
      assert.equal((await sql('SELECT status FROM appointment_status_view WHERE id = ?', [id]))[0].status, 'realizado');
    });
    await t.test('isolamento de empresa em consulta e registro de pagamento', async () => {
      const other = (await sql("INSERT INTO companies (name, address) VALUES ('Outra empresa', 'Outra rua')")).insertId;
      await sql('INSERT INTO company_members (company_id, user_id) VALUES (?, ?)', [other, registration.returnObj.id]);
      await request('GET', `/sales/${saleId}`, undefined, 400, { 'Selected-company': String(other) });
      await request('POST', '/sales/insert_payment', { sale_id: saleId, customer_id: customer.id, amount: 1, payment_type: 'dinheiro' }, 400, { 'Selected-company': String(other) });
      assert.equal((await request('POST', '/customers/find', { search_string: String(customer.id) }, 200, { 'Selected-company': String(other) })).returnObj.length, 0);
    });
    await t.test('migração de contas a receber antigas preserva valores e pode ser repetida', async () => {
      await sql('ALTER TABLE accounts_receivable CHANGE amount value FLOAT NOT NULL');
      await migrate();
      await migrate();
      assert.equal((await sql('SELECT SUM(amount) AS total FROM accounts_receivable WHERE sale_id = ?', [saleId]))[0].total, 50);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (pool) await promisify(pool.end).bind(pool)();
    await adminQuery('DROP DATABASE IF EXISTS ??', [database]);
    admin.end();
  }
});
