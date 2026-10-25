const fs = require('node:fs');
const crypto = require('node:crypto');

function settings() {
  const environment = process.env.MP_ENV || 'test';
  if (!['test', 'production'].includes(environment)) throw new Error('MP_ENV deve ser test ou production.');
  const commissionBps = Number(process.env.MP_COMMISSION_BPS || '500');
  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10000) throw new Error('MP_COMMISSION_BPS inválido.');
  return {
    environment, commissionBps,
    accessToken: process.env.MP_ACCESS_TOKEN,
    collectorId: process.env.MP_COLLECTOR_ID,
    webhookSecret: process.env.MP_WEBHOOK_SECRET,
    webhookUrl: process.env.MP_WEBHOOK_URL,
    payoutWebhookUrl: process.env.MP_PAYOUT_WEBHOOK_URL,
    payoutsEnabled: process.env.MP_PAYOUTS_ENABLED === 'true',
  };
}

function requireCredentials() {
  const config = settings();
  if (!config.accessToken || !/^\d+$/.test(config.collectorId || '')) throw new Error('Configure MP_ACCESS_TOKEN e MP_COLLECTOR_ID no backend.');
  return config;
}

function payoutHeaders(body) {
  const config = requireCredentials();
  if (!config.payoutsEnabled) throw new Error('Repasses desativados. Configure MP_PAYOUTS_ENABLED após habilitar Payouts na conta.');
  if (config.environment === 'test') return { 'X-test-token': 'true', 'X-enforce-signature': 'false' };
  if (!process.env.MP_PRIVATE_KEY_PATH) throw new Error('Configure MP_PRIVATE_KEY_PATH para assinar os repasses em produção.');
  const key = crypto.createPrivateKey(fs.readFileSync(process.env.MP_PRIVATE_KEY_PATH));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('A chave de Payouts deve ser Ed25519.');
  return { 'X-test-token': 'false', 'X-enforce-signature': 'true', 'X-signature': crypto.sign(null, Buffer.from(body), key).toString('base64') };
}

module.exports = { settings, requireCredentials, payoutHeaders, provider: () => process.env.PAYMENT_PROVIDER || 'mercadopago' };
