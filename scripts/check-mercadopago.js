require('dotenv').config();
const config = require('../config/mercadopago');
async function check() {
  const settings = config.settings();
  if (!settings.accessToken) throw new Error('Preencha MP_ACCESS_TOKEN no .env.');
  const { data } = await require('../services/mercadoPagoService').client.request({ method: 'GET', url: '/users/me',
    headers: { Authorization: `Bearer ${settings.accessToken}` } });
  console.log(JSON.stringify({ collector_id: String(data.id), environment: settings.environment,
    account_is_test: Array.isArray(data.tags) ? data.tags.includes('test_user') : null,
    site_id: data.site_id,
    collector_matches: String(data.id) === settings.collectorId,
    mode: 'split_1_1', oauth_configured: !!(settings.clientId && settings.clientSecret && settings.redirectUri && process.env.MP_TOKEN_ENCRYPTION_KEY),
    plans: [{ code: 'free', monthly_brl: 0, commission_percent: 5 }, { code: 'premium', monthly_brl: 49.90, commission_percent: 1 }] }, null, 2));
  console.log('Consulta de credencial concluída. Valide também o OAuth de um vendedor e o primeiro pagamento com comissão.');
}
if (require.main === module) check().catch(error => {
  console.error(error.response?.status ? `Mercado Pago retornou HTTP ${error.response.status}.` : error.message);
  process.exitCode = 1;
});
module.exports = check;
