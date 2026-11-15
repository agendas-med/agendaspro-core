// Cifra (AES-256-GCM, APP_ENCRYPTION_KEY) as chaves Asaas ainda gravadas em texto puro.
// Idempotente: valores já com prefixo "enc:v1:" são ignorados. Não imprime segredos.
// Uso: node scripts/encrypt-secrets.js [--dry-run]
require('../config/env');
const { pool } = require('../mysql');
const { encrypt, isEncrypted, decrypt } = require('../utils/crypto');

const TARGETS = [
  { table: 'companies', key: 'id' },
  { table: 'asaas_wallets', key: 'document' },
];

function query(sql, params = []) {
  return new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  // Falha cedo se a chave estiver ausente ou inválida (antes de tocar no banco).
  decrypt(encrypt('self-test'));
  for (const { table, key } of TARGETS) {
    const rows = await query('SELECT ?? AS k, asaas_api_key AS v FROM ?? WHERE asaas_api_key IS NOT NULL AND asaas_api_key <> \'\'', [key, table]);
    const pending = rows.filter(row => !isEncrypted(row.v));
    for (const row of pending) {
      if (dryRun) continue;
      // Só atualiza se o valor não mudou desde a leitura (evita corrida com gravações novas).
      await query('UPDATE ?? SET asaas_api_key = ? WHERE ?? = ? AND asaas_api_key = ?', [table, encrypt(row.v), key, row.k, row.v]);
    }
    console.log(`${table}: ${rows.length} com chave, ${pending.length} ${dryRun ? 'a cifrar (dry-run)' : 'cifradas agora'}.`);
  }
}

main()
  .then(() => pool.end(() => process.exit(0)))
  .catch(error => {
    console.error('Falha ao cifrar segredos:', error.message);
    process.exit(1);
  });
