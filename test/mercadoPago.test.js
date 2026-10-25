const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rules = require('../utils/mercadoPago');
const config = require('../config/mercadopago');

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
test('aceite e processamento do payout não significam crédito no destino', () => {
  assert.equal(rules.payoutState({ status: 'approved' }), 'pending');
  assert.equal(rules.payoutState({ status: 'success', status_detail: 'in_progress' }), 'pending');
  assert.equal(rules.payoutState({ status: 'success', status_detail: 'accredited' }), 'paid');
  assert.equal(rules.payoutState({ status: 'refunded', status_detail: 'refunded' }), 'needs_review');
});
test('produção assina os bytes exatos com Ed25519 e testes enviam o header explícito', () => {
  const names = ['MP_ENV', 'MP_ACCESS_TOKEN', 'MP_COLLECTOR_ID', 'MP_PAYOUTS_ENABLED', 'MP_PRIVATE_KEY_PATH'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agendaspro-mp-sign-'));
  const keyPath = path.join(dir, 'test-private.pem');
  try {
    process.env.MP_ACCESS_TOKEN = 'unit-test'; process.env.MP_COLLECTOR_ID = '123'; process.env.MP_PAYOUTS_ENABLED = 'true';
    process.env.MP_ENV = 'test';
    assert.equal(config.payoutHeaders('{}')['X-test-token'], 'true');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }));
    process.env.MP_ENV = 'production'; process.env.MP_PRIVATE_KEY_PATH = keyPath;
    const body = '{"amount":94.01}';
    const headers = config.payoutHeaders(body);
    assert.equal(headers['X-enforce-signature'], 'true');
    assert.equal(crypto.verify(null, Buffer.from(body), publicKey, Buffer.from(headers['X-signature'], 'base64')), true);
    assert.equal(crypto.verify(null, Buffer.from(body + ' '), publicKey, Buffer.from(headers['X-signature'], 'base64')), false);
    process.env.MP_PAYOUTS_ENABLED = 'false';
    assert.throws(() => config.payoutHeaders(body), /desativados/);
  } finally {
    for (const name of names) original[name] === undefined ? delete process.env[name] : process.env[name] = original[name];
    fs.unlinkSync(keyPath);
    fs.rmdirSync(dir);
  }
});
