const axios = require('axios');
const config = require('../config/mercadopago');
const orders = require('../utils/mercadoPagoOrders');
const client = axios.create({ baseURL: 'https://api.mercadopago.com', timeout: 15000, maxRedirects: 0, maxContentLength: 20 * 1024 * 1024 });

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

async function account() {
  const result = await request('GET', '/users/me');
  const settings = config.requireCredentials();
  if (String(result.id) !== settings.collectorId || result.site_id !== 'MLB' || !Array.isArray(result.tags) || result.tags.includes('test_user') !== (settings.environment === 'test')) {
    throw new Error('Credencial não corresponde à conta brasileira e ao ambiente configurado. Use a conta de teste no sandbox.');
  }
  return result;
}
async function release(order) {
  let file = process.env.MP_RELEASE_REPORT_FILE;
  if (!file) {
    const list = await request('GET', '/v1/account/bank_report/list');
    const reports = Array.isArray(list) ? list : list.results || [];
    file = reports.filter(report => String(report.user_id) === config.settings().collectorId && /\.csv$/i.test(report.file_name || ''))
      .sort((a, b) => String(b.date_created).localeCompare(String(a.date_created)))[0]?.file_name;
  }
  if (!file) return null;
  if (!/^[A-Za-z0-9_-]+\.csv$/i.test(file)) throw new Error('Nome de relatório de liberação inválido.');
  const csv = await request('GET', `/v1/account/bank_report/${encodeURIComponent(file)}`);
  return orders.releasedAmount(csv, order);
}

module.exports = {
  client,
  async createPix(body, key, api = 'orders') {
    if (api === 'payments') return request('POST', '/v1/payments', body, { 'X-Idempotency-Key': key });
    const owner = await account();
    const order = await request('POST', '/v1/orders', body, { 'X-Idempotency-Key': key });
    const original = JSON.parse(body);
    if ((order.user_id !== undefined && String(order.user_id) !== String(owner.id)) ||
        (order.external_reference !== undefined && order.external_reference !== original.external_reference) ||
        (order.total_amount !== undefined && require('../utils/mercadoPago').cents(order.total_amount) !== require('../utils/mercadoPago').cents(original.total_amount)) ||
        (order.country_code !== undefined && order.country_code !== 'BRA')) throw new Error('Order criada diverge da cobrança solicitada.');
    return orders.normalize(order, owner);
  },
  async getPayment(paymentId, api = 'orders') {
    if (api === 'payments') return request('GET', `/v1/payments/${id(paymentId)}`);
    const owner = await account();
    const order = await request('GET', `/v1/orders/${id(paymentId)}`);
    const payment = orders.normalize(order, owner);
    if (payment.status === 'approved') {
      try {
        const net = await release(order);
        if (net !== null) { payment.transaction_details.net_received_amount = net; payment.money_release_status = 'released'; }
      } catch { /* A cobrança pode ser confirmada; o repasse aguarda relatório verificável. */ }
    }
    return payment;
  },
  cancelPayment(paymentId, api = 'orders', key) {
    return api === 'payments' ? request('PUT', `/v1/payments/${id(paymentId)}`, { status: 'cancelled' }) :
      request('POST', `/v1/orders/${id(paymentId)}/cancel`, '{}', { 'X-Idempotency-Key': key });
  },
  createPayout(body, key) {
    // A mesma sequência de bytes é persistida, assinada e enviada em toda reexecução.
    return request('POST', '/v1/payouts', body, { ...config.payoutHeaders(body), 'X-Idempotency-Key': key });
  },
  getPayoutTransaction(payoutId, transactionId) {
    return request('GET', `/v1/payouts/${id(payoutId)}/transactions/${id(transactionId)}`, undefined,
      { 'X-test-token': String(config.settings().environment === 'test') });
  },
};
