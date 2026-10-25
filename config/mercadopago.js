
function settings() {
  const environment = process.env.MP_ENV || 'test';
  if (!['test', 'production'].includes(environment)) throw new Error('MP_ENV deve ser test ou production.');
  const commissionBps = Number(process.env.MP_COMMISSION_BPS || '500');
  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10000) throw new Error('MP_COMMISSION_BPS inválido.');
  return {
    environment, commissionBps,
    clientId: process.env.MP_CLIENT_ID,
    clientSecret: process.env.MP_CLIENT_SECRET,
    redirectUri: process.env.MP_OAUTH_REDIRECT_URI,
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

function payoutHeaders() { throw new Error('Payouts desativado: os novos pagamentos utilizam split 1:1.'); }

module.exports = { settings, requireCredentials, payoutHeaders, provider: () => process.env.PAYMENT_PROVIDER || 'mercadopago' };
