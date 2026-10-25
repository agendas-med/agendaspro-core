const crypto = require('node:crypto');
const Joi = require('joi');

function cents(value) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) throw new Error('Valor monetário inválido.');
  const result = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Valor monetário inválido.');
  return result;
}
function validDocument(value) {
  if (!/^\d{11}$|^\d{14}$/.test(value) || /^(\d)\1+$/.test(value)) return false;
  const cpf = value.length === 11;
  for (let digit = value.length - 2; digit < value.length; digit++) {
    let weight = cpf ? digit + 1 : digit - 7;
    let sum = 0;
    for (let index = 0; index < digit; index++) {
      sum += Number(value[index]) * weight--;
      if (!cpf && weight < 2) weight = 9;
    }
    const check = cpf ? (sum * 10 % 11) % 10 : (sum % 11 < 2 ? 0 : 11 - sum % 11);
    if (check !== Number(value[digit])) return false;
  }
  return true;
}
function destination(input) {
  const { error, value } = Joi.object({
    holder_name: Joi.string().trim().min(3).max(150).required(),
    holder_document: Joi.string().replace(/\D/g, '').required(),
    bank_name: Joi.string().trim().max(100).allow('', null).default(null),
    pix_key_type: Joi.string().valid('CPF', 'CNPJ', 'EMAIL', 'PHONE', 'PIX_CODE').required(),
    pix_key: Joi.string().trim().max(255).required(),
  }).validate(input);
  if (error) throw new Error('Dados do destinatário inválidos.');
  if (!validDocument(value.holder_document)) throw new Error('CPF/CNPJ do titular inválido.');
  if (['CPF', 'CNPJ'].includes(value.pix_key_type)) {
    value.pix_key = value.pix_key.replace(/\D/g, '');
    if (value.pix_key.length !== (value.pix_key_type === 'CPF' ? 11 : 14) || value.pix_key !== value.holder_document) throw new Error('A chave deve pertencer ao titular cadastrado.');
  } else if (value.pix_key_type === 'EMAIL') {
    if (Joi.string().email({ tlds: { allow: false } }).validate(value.pix_key).error) throw new Error('Chave de e-mail inválida.');
    value.pix_key = value.pix_key.toLowerCase();
  } else if (value.pix_key_type === 'PHONE' && !/^\+55\d{10,11}$/.test(value.pix_key)) throw new Error('Telefone Pix deve incluir +55 e DDD.');
  else if (value.pix_key_type === 'PIX_CODE' && !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value.pix_key)) throw new Error('Chave aleatória inválida.');
  return value;
}
function payoutAmounts(payment, charge) {
  const gross = Number(charge.amount_cents);
  if (payment.transaction_details?.net_received_amount === undefined) throw new Error('Valor líquido ainda não confirmado pelo provedor; o repasse permanece pendente.');
  const net = cents(payment.transaction_details?.net_received_amount);
  const commission = Math.round(gross * Number(charge.commission_bps) / 10000);
  if (net > gross || net - commission < 100) throw new Error('Repasse líquido deve ser de pelo menos R$ 1 e as taxas precisam estar disponíveis.');
  return { gross, providerFee: gross - net, commission, payout: net - commission };
}
function validatePayment(payment, charge, settings) {
  if (String(payment.id) !== String(charge.provider_payment_id) || payment.external_reference !== charge.external_reference ||
      payment.payment_method_id !== 'pix' || payment.currency_id !== 'BRL' || cents(payment.transaction_amount) !== Number(charge.amount_cents) ||
      String(payment.collector_id) !== settings.collectorId || typeof payment.live_mode !== 'boolean' || payment.live_mode !== (charge.environment === 'production')) {
    throw new Error('Pagamento não corresponde à cobrança, valor, conta ou ambiente esperado.');
  }
}
function verifySignature(req, secret) {
  const dataId = req.query['data.id'];
  const requestId = req.headers['x-request-id'];
  const signature = req.headers['x-signature'];
  if (!secret || typeof dataId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(dataId) || typeof requestId !== 'string' || typeof signature !== 'string') return false;
  if (req.body?.data?.id !== undefined && String(req.body.data.id) !== dataId) return false;
  const parts = Object.fromEntries(signature.split(',').map(part => part.trim().split('=')));
  if (!/^\d+$/.test(parts.ts || '') || !/^[a-f\d]{64}$/i.test(parts.v1 || '')) return false;
  const digest = crypto.createHmac('sha256', secret).update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${parts.ts};`).digest();
  return crypto.timingSafeEqual(digest, Buffer.from(parts.v1, 'hex'));
}
function payoutState(transaction) {
  if (transaction.status === 'success' && transaction.status_detail === 'accredited') return 'paid';
  if (['refunded', 'canceled', 'rejected', 'error'].includes(transaction.status) || transaction.status_detail === 'partially_refunded') return 'needs_review';
  return 'pending';
}
module.exports = { cents, validDocument, destination, payoutAmounts, validatePayment, verifySignature, payoutState };
