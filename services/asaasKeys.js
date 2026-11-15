const functions = require('../utils/functions');
const { decrypt } = require('../utils/crypto');

// Único ponto de leitura da apiKey Asaas da empresa: decifra (ou aceita legado em texto puro).
// A chave nunca deve sair da API.
async function getCompanyAsaasKey(companyId) {
  const rows = await functions.executeSql('SELECT asaas_api_key FROM companies WHERE id = ?', [companyId]);
  return rows[0]?.asaas_api_key ? decrypt(rows[0].asaas_api_key) : null;
}

module.exports = { getCompanyAsaasKey, decryptKey: value => (value ? decrypt(value) : null) };
