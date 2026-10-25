const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rules = require('../utils/mercadoPago');
const config = require('../config/mercadopago');
const orders = require('../utils/mercadoPagoOrders');

test('Orders valida o valor pago e só confirma a transação Pix acreditada', () => {
  const order = { id: 'ORD123', user_id: '123', external_reference: 'AGP123', country_code: 'BRA', total_amount: '100.00', total_paid_amount: '100.00',
    status: 'processed', status_detail: 'accredited', transactions: { payments: [{ amount: '100.00', status: 'processed', status_detail: 'accredited', payment_method: { id: 'pix', type: 'bank_transfer' } }] } };
  const account = { tags: ['test_user'] };
  const result = orders.normalize(order, account);
  assert.equal(result.status, 'approved'); assert.equal(result.live_mode, false);
  assert.equal(result.transaction_details.net_received_amount, undefined);
  assert.equal(result.money_release_status, 'pending');
  assert.throws(() => orders.normalize({ ...order, total_paid_amount: '99.00' }, account));
  assert.equal(orders.normalize({ ...order, status: 'action_required' }, account).status, 'pending');
  assert.equal(orders.normalize({ ...order, transactions: { ...order.transactions, chargebacks: [{ id: 'CBK123' }] } }, account).status, 'in_mediation');
});
test('relatório exige order, referência, moeda, bruto e um único crédito liberado', () => {
  const header = 'ORDER_MP;EXTERNAL_REFERENCE;RECORD_TYPE;DESCRIPTION;NET_CREDIT_AMOUNT;NET_DEBIT_AMOUNT;GROSS_AMOUNT;CURRENCY;PAYMENT_METHOD';
  const row = 'ORD123;AGP123;release;payment;99.01;0;100.00;BRL;pix';
  const order = { id: 'ORD123', external_reference: 'AGP123', total_amount: '100.00' };
  assert.equal(orders.releasedAmount(`${header}\n${row}`, order), 99.01);
  assert.equal(orders.releasedAmount(`${header}\n${row}`, { ...order, id: 'ORD124' }), null);
  assert.throws(() => orders.releasedAmount(`${header}\n${row}\n${row}`, order));
  assert.throws(() => orders.releasedAmount(`${header}\n${row.replace('BRL', 'USD')}`, order));
  assert.throws(() => orders.releasedAmount(`${header}\n${row.replace('99.01', '101.00')}`, order));
  assert.throws(() => orders.parseReport('EXTERNAL_REFERENCE;NET_CREDIT_AMOUNT\nAGP123;100'));
  assert.equal(orders.releasedAmount(`${header}\n${row.replace('payment', '"payment"')}`, order), 99.01);
});

test('comissão usa centavos e taxa efetiva; líquido desconhecido bloqueia o repasse', () => {
  assert.deepEqual(rules.payoutAmounts({ transaction_details: { net_received_amount: 99.01 } }, { amount_cents: 10000, commission_bps: 500 }),
    { gross: 10000, providerFee: 99, commission: 500, payout: 9401 });
  assert.throws(() => rules.payoutAmounts({}, { amount_cents: 10000, commission_bps: 500 }));
  assert.throws(() => rules.payoutAmounts({ transaction_details: { net_received_amount: 1 } }, { amount_cents: 100, commission_bps: 500 }));
  assert.throws(() => rules.cents(-1));
  assert.throws(() => rules.cents('abc'));
});
test('destinatário valida dígitos e titularidade de CPF/CNPJ e formatos Pix', () => {
  assert.equal(rules.validDocument('52998224725'), true);
  assert.equal(rules.validDocument('11222333000181'), true);
  assert.equal(rules.validDocument('12345678901'), false);
  assert.throws(() => rules.destination({ holder_name: 'Pessoa', holder_document: '52998224725', pix_key_type: 'CPF', pix_key: '11111111111' }));
  assert.throws(() => rules.destination({ holder_name: 'Pessoa', holder_document: '52998224725', pix_key_type: 'PHONE', pix_key: '11999999999' }));
});
test('webhook valida assinatura e vincula o ID assinado ao corpo recebido', () => {
  const secret = 'test-secret';
  const req = { query: { 'data.id': '123' }, body: { data: { id: '123' } }, headers: { 'x-request-id': 'request-1' } };
  const digest = crypto.createHmac('sha256', secret).update('id:123;request-id:request-1;ts:1781009491;').digest('hex');
  req.headers['x-signature'] = `ts=1781009491,v1=${digest}`;
  assert.equal(rules.verifySignature(req, secret), true);
  req.body.data.id = '124';
  assert.equal(rules.verifySignature(req, secret), false);
  assert.equal(rules.verifySignature(req, ''), false);
});
test('assinatura Orders usa ID alfanumérico em minúsculas no manifesto', () => {
  const secret = 'orders-secret';
  const req = { query: { 'data.id': 'ORD123ABC' }, body: { type: 'order', data: { id: 'ORD123ABC' } }, headers: { 'x-request-id': 'order-request' } };
  const digest = crypto.createHmac('sha256', secret).update('id:ord123abc;request-id:order-request;ts:1781009491;').digest('hex');
  req.headers['x-signature'] = `ts=1781009491,v1=${digest}`;
  assert.equal(rules.verifySignature(req, secret), true);
});
test('aceite e processamento do payout não significam crédito no destino', () => {
  assert.equal(rules.payoutState({ status: 'approved' }), 'pending');
  assert.equal(rules.payoutState({ status: 'success', status_detail: 'in_progress' }), 'pending');
  assert.equal(rules.payoutState({ status: 'success', status_detail: 'accredited' }), 'paid');
  assert.equal(rules.payoutState({ status: 'refunded', status_detail: 'refunded' }), 'needs_review');
});
test('payouts permanecem bloqueados mesmo com a flag antiga ativada', () => {
  process.env.MP_PAYOUTS_ENABLED = 'true';
  assert.throws(() => config.payoutHeaders('{}'), /Payouts desativado/);
});
