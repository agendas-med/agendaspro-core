require('../config/env');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql');
const { promisify } = require('node:util');
const { resolveDatabaseConfig } = require('../config/database');

// Runner de migrations versionadas, sem multipleStatements.
// - sql/migrations/NNN_nome.sql, aplicadas em ordem e registradas em schema_migrations.
// - 001_baseline só roda em banco vazio; bancos migrados pelo script antigo
//   (versão '20261024_schema_payments') recebem o baseline como já aplicado.
// - legacyRepair() reproduz, de forma idempotente, os ajustes do script antigo para bancos
//   antigos que ainda não os tenham. DDL faz commit implícito: cada passo é repetível.
const MIGRATIONS_DIR = path.join(__dirname, '../sql/migrations');
const LEGACY_VERSION = '20261024_schema_payments';

// Divide um arquivo SQL em instruções, respeitando aspas e comentários.
// Comentários condicionais /*! ... */ são mantidos (o mysqldump depende deles).
function splitStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-' && /\s/.test(sql[i + 2] || ' ')) {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '#') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      if (sql[i + 2] === '!') current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '\\' && ch !== '`') { j += 2; continue; }
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j += 2; continue; }
          break;
        }
        j++;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function listMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(file => /^\d{3}_[\w-]+\.sql$/.test(file))
    .sort()
    .map(file => ({ version: file.replace(/\.sql$/, ''), file: path.join(MIGRATIONS_DIR, file) }));
}

async function runFile(query, file) {
  for (const statement of splitStatements(fs.readFileSync(file, 'utf8'))) await query(statement);
}

async function legacyRepair(query) {
  const add = async (table, column, definition) => {
    const rows = await query('SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
    if (!rows.length) await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  };
  await query(`CREATE TABLE IF NOT EXISTS asaas_wallets (
    document VARCHAR(20) PRIMARY KEY, asaas_api_key TEXT NOT NULL,
    asaas_wallet_id VARCHAR(100) NOT NULL, asaas_status VARCHAR(20) DEFAULT 'PENDING'
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  for (const [column, definition] of Object.entries({
    document: 'VARCHAR(20) NULL', email: 'VARCHAR(100) NULL', phone: 'VARCHAR(20) NULL',
    address_number: 'VARCHAR(20) NULL', complement: 'VARCHAR(100) NULL',
    asaas_wallet_id: 'VARCHAR(255) NULL', asaas_api_key: 'TEXT NULL',
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
  await query("ALTER TABLE payments MODIFY payment_type ENUM('pix','pix_asaas','cartao_debito','cartao_credito','dinheiro') NOT NULL");
  await add('payments', 'external_id', 'VARCHAR(255) NULL');
  await add('sales_products', 'unit_price', 'DECIMAL(12,2) NULL');
  await query('UPDATE sales_products sp JOIN products p ON p.id = sp.product_id SET sp.unit_price = p.value WHERE sp.unit_price IS NULL');
  await query('ALTER TABLE sales_products MODIFY unit_price DECIMAL(12,2) NOT NULL DEFAULT 0');
  const indexes = await query("SHOW INDEX FROM payments WHERE Key_name = 'uq_payments_external_id'");
  if (!indexes.length) await query('ALTER TABLE payments ADD UNIQUE KEY uq_payments_external_id (external_id)');
}

async function migrate({ log = console.log } = {}) {
  // MYSQL_* explícitas ou URL de add-on (JAWSDB_MARIA_URL/DATABASE_URL); ver config/database.js.
  const { host, port, user, password, database } = resolveDatabaseConfig();
  const conn = mysql.createConnection({
    host, port, user, password, database, multipleStatements: false, charset: 'utf8mb4',
  });
  const query = promisify(conn.query).bind(conn);
  const started = Date.now();
  try {
    const [lock] = await query("SELECT GET_LOCK('agendaspro_schema', 30) AS acquired");
    if (!lock.acquired) throw new Error('Outra migração está em execução.');
    const existingTables = (await query("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'")).length;
    await query('CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(100) PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    const applied = new Set((await query('SELECT version FROM schema_migrations')).map(row => row.version));
    const migrations = listMigrations();
    const [baseline, ...rest] = migrations;
    if (!applied.has(baseline.version)) {
      if (!existingTables) {
        await runFile(query, baseline.file);
        log(`Migration aplicada: ${baseline.version}`);
      }
      // Banco antigo (com tabelas ou com a versão do script anterior): baseline já existe.
      await query('INSERT IGNORE INTO schema_migrations(version) VALUES (?)', [baseline.version]);
    }
    await legacyRepair(query);
    for (const migration of rest) {
      if (applied.has(migration.version)) continue;
      await runFile(query, migration.file);
      await query('INSERT IGNORE INTO schema_migrations(version) VALUES (?)', [migration.version]);
      log(`Migration aplicada: ${migration.version}`);
    }
    // Objetos repetíveis: a view usa a.* e precisa ser recriada após alterações em appointments.
    await runFile(query, path.join(__dirname, '../sql/appointment-status-view.sql'));
    await runFile(query, path.join(__dirname, '../sql/reference-data.sql'));
    await query('INSERT IGNORE INTO schema_migrations(version) VALUES (?)', [LEGACY_VERSION]);
    log(`Schema atualizado; dados existentes preservados (${Date.now() - started} ms).`);
  } finally {
    await query("SELECT RELEASE_LOCK('agendaspro_schema')").catch(() => {});
    conn.end();
  }
}

if (require.main === module) migrate().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = migrate;
module.exports.splitStatements = splitStatements;
