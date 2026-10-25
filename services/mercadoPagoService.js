const axios = require('axios');
const config = require('../config/mercadopago');
const client = axios.create({ baseURL: 'https://api.mercadopago.com', timeout: 15000, maxRedirects: 0 });

async function request(method, path, data, headers = {}) {
  const settings = config.requireCredentials();
  const response = await client.request({ method, url: path, data,
    headers: { Authorization: `Bearer ${settings.accessToken}`, 'Content-Type': 'application/json', ...headers } });
  return response.data;
}
const id = value => {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(String(value))) throw new Error('Identificador Mercado Pago inválido.');
  return encodeURIComponent(value);
};

module.exports = {
  client,
  createPix: (body, key) => request('POST', '/v1/payments', body, { 'X-Idempotency-Key': key }),
  getPayment: paymentId => request('GET', `/v1/payments/${id(paymentId)}`),
  cancelPayment: paymentId => request('PUT', `/v1/payments/${id(paymentId)}`, { status: 'cancelled' }),
  createPayout(body, key) {
    // A mesma sequência de bytes é persistida, assinada e enviada em toda reexecução.
    return request('POST', '/v1/payouts', body, { ...config.payoutHeaders(body), 'X-Idempotency-Key': key });
  },
  getPayoutTransaction(payoutId, transactionId) {
    return request('GET', `/v1/payouts/${id(payoutId)}/transactions/${id(transactionId)}`, undefined,
      { 'X-test-token': String(config.settings().environment === 'test') });
  },
};
