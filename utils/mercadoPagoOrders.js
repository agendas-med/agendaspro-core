const { cents } = require('./mercadoPago');

function normalize(order, account) {
  const payments = order.transactions?.payments || [];
  if (payments.length > 1) throw new Error('Esta integração exige uma transação Pix por order.');
  const payment = payments[0] || {};
  const method = payment.payment_method || {};
  let status = 'pending';
  if (order.status === 'processed' && order.status_detail === 'accredited' && payment.status === 'processed' && payment.status_detail === 'accredited') status = 'approved';
  if (['canceled', 'cancelled', 'expired', 'failed'].includes(order.status)) status = order.status === 'failed' ? 'rejected' : 'cancelled';
  if (order.transactions?.chargebacks?.length || order.status === 'in_mediation') status = 'in_mediation';
  const refunds = order.transactions?.refunds || [];
  const refunded = refunds.reduce((sum, refund) => sum + cents(refund.amount), 0);
  if (order.status === 'refunded' || order.status_detail === 'partially_refunded' || refunded) status = 'refunded';
  if (status === 'approved' && (cents(order.total_paid_amount) !== cents(order.total_amount) || cents(payment.amount) !== cents(order.total_amount))) throw new Error('Total efetivamente pago difere do total da order.');
  return {
    id: order.id, external_reference: order.external_reference, collector_id: order.user_id,
    live_mode: !account.tags.includes('test_user'), currency_id: order.country_code === 'BRA' ? 'BRL' : null,
    payment_method_id: method.type === 'bank_transfer' ? method.id : null,
    transaction_amount: order.total_amount, transaction_amount_refunded: refunded / 100 || (status === 'refunded' ? Number(order.total_amount) : 0),
    status, date_of_expiration: payment.date_of_expiration,
    money_release_status: 'pending', transaction_details: {},
    point_of_interaction: { transaction_data: { qr_code: method.qr_code, qr_code_base64: method.qr_code_base64, ticket_url: method.ticket_url } },
  };
}

// CSV com aspas, delimitador , ou ; e linhas múltiplas em campos citados.
function parseReport(csv) {
  if (typeof csv !== 'string' || csv.length > 20 * 1024 * 1024) throw new Error('Relatório de liberação inválido.');
  csv = csv.replace(/^\uFEFF/, '');
  const first = csv.split(/\r?\n/, 1)[0];
  const delimiter = first.includes(';') ? ';' : ',';
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i <= csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') {
      if (quoted && csv[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (ch === delimiter || ch === '\n' || ch === undefined)) {
      row.push(field.replace(/\r$/, '')); field = '';
      if (ch !== delimiter) { if (row.some(Boolean)) rows.push(row); row = []; }
    } else if (ch !== undefined) field += ch;
  }
  if (quoted || rows.length < 1) throw new Error('CSV incompleto.');
  const headers = rows.shift();
  const required = ['ORDER_MP', 'EXTERNAL_REFERENCE', 'RECORD_TYPE', 'DESCRIPTION', 'NET_CREDIT_AMOUNT', 'NET_DEBIT_AMOUNT', 'GROSS_AMOUNT', 'CURRENCY', 'PAYMENT_METHOD'];
  if (new Set(headers).size !== headers.length || required.some(name => !headers.includes(name))) throw new Error('Configure as colunas obrigatórias do relatório de liberação, incluindo ORDER_MP e CURRENCY.');
  return rows.map(values => {
    if (values.length !== headers.length) throw new Error('Linha de relatório inválida.');
    return Object.fromEntries(headers.map((name, index) => [name, values[index]]));
  });
}
function releasedAmount(csv, order) {
  const matching = parseReport(csv).filter(row => row.ORDER_MP === order.id && row.EXTERNAL_REFERENCE === order.external_reference);
  if (!matching.length) return null;
  if (matching.length !== 1) throw new Error('Há múltiplos movimentos para esta order. Revisão financeira necessária.');
  const row = matching[0];
  if (row.RECORD_TYPE !== 'release' || row.DESCRIPTION !== 'payment' || row.CURRENCY !== 'BRL' || row.PAYMENT_METHOD !== 'pix' ||
      cents(row.NET_DEBIT_AMOUNT) !== 0 || cents(row.GROSS_AMOUNT) !== cents(order.total_amount) || cents(row.NET_CREDIT_AMOUNT) > cents(order.total_amount) || cents(row.NET_CREDIT_AMOUNT) < 1) {
    throw new Error('Movimento não comprova a liberação líquida desta cobrança Pix.');
  }
  return cents(row.NET_CREDIT_AMOUNT) / 100;
}
module.exports = { normalize, parseReport, releasedAmount };
