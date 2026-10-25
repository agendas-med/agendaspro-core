require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const moment = require('moment');
const functions = require('../utils/functions');
const users = require('../services/usersService');
const companies = require('../services/companiesService');
const customers = require('../services/customersService');
const appointments = require('../services/appointmentsService');
const { pool } = require('../mysql');

async function seed() {
  if (!['localhost', '127.0.0.1'].includes(process.env.MYSQL_HOST) || process.env.NODE_ENV === 'production') throw new Error('Dados de demonstração disponíveis apenas no ambiente local.');
  const email = 'demo@agendaspro.test';
  let password = process.env.DEMO_PASSWORD;
  if (!password) {
    password = crypto.randomBytes(18).toString('base64url');
    fs.appendFileSync(path.join(__dirname, '../.env'), `\nDEMO_PASSWORD=${password}\n`);
  }
  const sql = functions.executeSql.bind(functions);
  const existing = await sql('SELECT id FROM users WHERE email = ?', [email]);
  if (!existing.length) {
    const user = await users.register('Demonstração Local', email, password);
    const [business] = await sql('SELECT id FROM business_types LIMIT 1');
    // Cria a empresa sem chamar serviços externos durante a demonstração.
    const companyId = (await sql("INSERT INTO companies (name, address, city, state, business_type, asaas_status) VALUES ('AgendasPro Local', 'Rua de Demonstração, 100', 'São Paulo', 'SP', ?, 'UNCONFIGURED')", [business.id])).insertId;
    await users.enterCompany(user.id, companyId);
    const roleId = await companies.createRole(companyId, 'Gerente', 1, true);
    await users.insertRole(user.id, roleId);
    await companies.insertCompanyDefaultPreferences(companyId);
    await customers.create(companyId, 'Cliente Demonstração', '12345678901', '1990-01-01', '11999999999', '', 'demo.customer@example.com');
    const [customer] = await sql('SELECT * FROM customers WHERE company_id = ?', [companyId]);
    const serviceId = (await sql("INSERT INTO services (name, duration, value, cost, company_id, accepts_quantity) VALUES ('Atendimento', 30, 50, 15, ?, 1)", [companyId])).insertId;
    const [unit] = await sql('SELECT id FROM units_of_measurement LIMIT 1');
    await sql("INSERT INTO products (name, value, cost, company_id, unit_of_measure, current_stock) VALUES ('Produto demonstração', 20, 8, ?, ?, 10)", [companyId, unit.id]);
    const date = moment().utcOffset(-180).format('YYYY-MM-DD') + ' 10:00:00';
    await appointments.create(companyId, customer.id, customer.name, date, 30, 'Agendamento de demonstração local', [{ id: serviceId, quantity: 1 }], 'agendado');
  }
  fs.writeFileSync(path.join(__dirname, '../.local-access.md'), `# Acesso local\n\nSistema: http://localhost:8080/entrar\n\nE-mail: ${email}\n\nSenha: ${password}\n\nConta de demonstração criada apenas neste MariaDB local.\n`);
  console.log('Demonstração pronta. Consulte .local-access.md para acessar.');
}
seed().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
