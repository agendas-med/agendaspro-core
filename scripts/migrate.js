require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql');
const { promisify } = require('node:util');

// DDL do MariaDB faz commit implícito. Cada passo é repetível para permitir retomar.
async function migrate() {
  const conn = mysql.createConnection({
    host: process.env.MYSQL_HOST, port: process.env.MYSQL_PORT,
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE, multipleStatements: true, charset: 'utf8mb4',
  });
  const query = promisify(conn.query).bind(conn);
  try {
    const [lock] = await query("SELECT GET_LOCK('agendaspro_schema', 30) AS acquired");
    if (!lock.acquired) throw new Error('Outra migração está em execução.');
    const tables = await query('SHOW FULL TABLES');
    if (!tables.length) {
      await query(fs.readFileSync(path.join(__dirname, '../sql/structure.sql'), 'utf8'));
    }
    const add = async (table, column, definition) => {
      const rows = await query('SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
      if (!rows.length) await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
      return !rows.length;
    };
    await query(`CREATE TABLE IF NOT EXISTS asaas_wallets (
      document VARCHAR(20) PRIMARY KEY, asaas_api_key VARCHAR(255) NOT NULL,
      asaas_wallet_id VARCHAR(100) NOT NULL, asaas_status VARCHAR(20) DEFAULT 'PENDING'
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    for (const [column, definition] of Object.entries({
      document: 'VARCHAR(20) NULL', email: 'VARCHAR(100) NULL', phone: 'VARCHAR(20) NULL',
      address_number: 'VARCHAR(20) NULL', complement: 'VARCHAR(100) NULL',
      asaas_wallet_id: 'VARCHAR(255) NULL', asaas_api_key: 'VARCHAR(255) NULL',
      asaas_status: "VARCHAR(20) NOT NULL DEFAULT 'PENDING'",
    })) await add('companies', column, definition);
    await add('customers', 'email', 'VARCHAR(255) NULL');
    await add('appointments', 'payment_status', "VARCHAR(20) DEFAULT 'isento'");
    await add('appointment_services', 'quantity', 'INT NOT NULL DEFAULT 1');
    for (const [column, definition] of Object.entries({
      requires_location: 'TINYINT(1) NOT NULL DEFAULT 0', accepts_quantity: 'TINYINT(1) NOT NULL DEFAULT 0',
      measurement_unit: "VARCHAR(50) NOT NULL DEFAULT 'unidade'",
    })) await add('services', column, definition);
    for (const [column, definition] of Object.entries({
      pix_asaas_id: 'VARCHAR(255) NULL', pix_payload: 'TEXT NULL', pix_expiration_date: 'DATETIME NULL',
      pix_encoded_image: 'MEDIUMTEXT NULL',
    })) await add('sales', column, definition);
    const legacyValue = await query("SHOW COLUMNS FROM accounts_receivable LIKE 'value'");
    const amount = await query("SHOW COLUMNS FROM accounts_receivable LIKE 'amount'");
    if (legacyValue.length && !amount.length) await query('ALTER TABLE accounts_receivable CHANGE COLUMN value amount FLOAT NOT NULL');
    await add('accounts_receivable', 'sale_id', 'INT NULL');
    await add('accounts_receivable', 'payment_type', 'VARCHAR(50) NULL');
    await add('accounts_receivable', 'receive_date', 'DATETIME NULL');
    await query('ALTER TABLE accounts_receivable MODIFY customer_id INT NULL, MODIFY due_date DATE NULL');
    const foreignKeys = await query("SELECT 1 FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = 'accounts_receivable' AND column_name = 'sale_id' AND referenced_table_name = 'sales'");
    if (!foreignKeys.length) await query('ALTER TABLE accounts_receivable ADD CONSTRAINT fk_receivable_sale FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE');
    await query("ALTER TABLE whatsapp_sessions MODIFY status VARCHAR(50) DEFAULT 'active'");
    await query("ALTER TABLE payments MODIFY payment_type ENUM('pix','pix_asaas','pix_mercadopago','mercadopago','cartao_debito','cartao_credito','dinheiro') NOT NULL");
    await add('sales', 'mp_charge_id', 'INT NULL');
    await query(fs.readFileSync(path.join(__dirname, '../sql/mercadopago.sql'), 'utf8'));
    // Cobranças anteriores mantêm seu contrato de Payments e seus corpos/chaves originais.
    await add('mp_charges', 'api_version', "VARCHAR(10) NOT NULL DEFAULT 'payments'");
    await add('mp_destinations', 'bank_name', 'VARCHAR(100) NULL');
    await query(fs.readFileSync(path.join(__dirname, '../sql/mercadopago-split.sql'), 'utf8'));
    for (const [column, definition] of Object.entries({
      connection_id: 'INT NULL', seller_id: 'VARCHAR(30) NULL', provider_preference_id: 'VARCHAR(100) NULL',
      commission_cents: 'BIGINT NULL', plan_code: 'VARCHAR(20) NULL', review_reason: 'VARCHAR(255) NULL',
      last_checked_at: 'DATETIME NULL',
    })) await add('mp_charges', column, definition);
    await add('mp_subscriptions', 'last_checked_at', 'DATETIME NULL');
    await query("ALTER TABLE payments MODIFY payment_type ENUM('pix','pix_asaas','pix_mercadopago','mercadopago','cartao_debito','cartao_credito','dinheiro') NOT NULL");
    await add('payments', 'external_id', 'VARCHAR(255) NULL');
    await add('sales_products', 'unit_price', 'DECIMAL(12,2) NULL');
    await query('UPDATE sales_products sp JOIN products p ON p.id = sp.product_id SET sp.unit_price = p.value WHERE sp.unit_price IS NULL');
    await query('ALTER TABLE sales_products MODIFY unit_price DECIMAL(12,2) NOT NULL DEFAULT 0');
    const indexes = await query("SHOW INDEX FROM payments WHERE Key_name = 'uq_payments_external_id'");
    if (!indexes.length) await query('ALTER TABLE payments ADD UNIQUE KEY uq_payments_external_id (external_id)');
    await query(fs.readFileSync(path.join(__dirname, '../sql/appointment-status-view.sql'), 'utf8'));
    await query(fs.readFileSync(path.join(__dirname, '../sql/reference-data.sql'), 'utf8'));
    await query('CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(100) PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    await query("INSERT IGNORE INTO schema_migrations(version) VALUES ('20261024_schema_payments')");
    await query("INSERT IGNORE INTO schema_migrations(version) VALUES ('20261024_mercadopago_payouts')");
    await query("INSERT IGNORE INTO schema_migrations(version) VALUES ('20261024_mercadopago_orders')");
    await query("INSERT IGNORE INTO schema_migrations(version) VALUES ('20261024_receiving_account')");
    await query("INSERT IGNORE INTO schema_migrations(version) VALUES ('20261025_mercadopago_split_plans')");
    console.log('Schema atualizado; dados existentes preservados.');
  } finally {
    await query("SELECT RELEASE_LOCK('agendaspro_schema')").catch(() => {});
    conn.end();
  }
}

if (require.main === module) migrate().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = migrate;
