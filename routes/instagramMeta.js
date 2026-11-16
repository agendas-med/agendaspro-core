const express = require('express');
const crypto = require('node:crypto');
const functions = require('../utils/functions');
const { sha256 } = require('../utils/crypto');
const instagram = require('../services/instagram/service');

// F6: callbacks da Meta para o app do Instagram (servidor a servidor, form-encoded signed_request).
//   POST /webhook/instagram/deauthorize   -> remove a conexão do usuário (200 vazio)
//   POST /webhook/instagram/data-deletion -> remove e responde { url, confirmation_code }
//   GET  /webhook/instagram/deletion-status/:code -> status público do pedido (sem dados pessoais)
// signed_request = base64url(assinatura).base64url(payload); assinatura = HMAC-SHA256(payload, INSTAGRAM_APP_SECRET).
// Idempotente: o código de confirmação é derivado do próprio signed_request (UNIQUE).
const router = express.Router();
router.use(express.urlencoded({ extended: false, limit: '16kb' }));

function parseSignedRequest(value) {
  const secret = process.env.INSTAGRAM_APP_SECRET;
  if (!secret || typeof value !== 'string' || value.length > 8192) return null;
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const [sigPart, payloadPart] = parts;
  const expected = crypto.createHmac('sha256', secret).update(payloadPart).digest();
  const received = Buffer.from(sigPart, 'base64url');
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    if (String(payload.algorithm || '').toUpperCase() !== 'HMAC-SHA256' || !payload.user_id) return null;
    return payload;
  } catch {
    return null;
  }
}

async function handleRequest(req, kind) {
  const payload = parseSignedRequest(req.body?.signed_request);
  if (!payload) return null;
  const code = crypto.createHash('sha256').update(`${kind}:${req.body.signed_request}`).digest('base64url').slice(0, 22);
  const [existing] = await functions.executeSql('SELECT confirmation_code FROM instagram_deletion_requests WHERE confirmation_code = ?', [code]);
  if (existing) return code;
  const removed = await instagram.removeByMetaUser(payload.user_id);
  await functions.executeSql('INSERT IGNORE INTO instagram_deletion_requests (confirmation_code, user_hash, kind, accounts_removed) VALUES (?, ?, ?, ?)',
    [code, sha256(`ig:${payload.user_id}`), kind, removed]);
  return code;
}

function statusUrl(req, code) {
  const base = (process.env.INSTAGRAM_DELETION_STATUS_URL || `${(process.env.PUBLIC_API_URL || '').replace(/\/+$/, '')}/webhook/instagram/deletion-status`).replace(/\/+$/, '');
  return `${base}/${code}`;
}

router.post('/deauthorize', async (req, res) => {
  try {
    const code = await handleRequest(req, 'deauthorize');
    if (!code) return res.status(400).send({ error: { code: 'invalid_signed_request', message: 'Assinatura inválida.' } });
    return res.status(200).send({ ok: true });
  } catch (error) {
    console.error('[instagram] Falha no callback de desautorização:', error?.code || error?.message);
    return res.status(500).send({ error: { code: 'internal_error', message: 'Erro interno.' } });
  }
});

router.post('/data-deletion', async (req, res) => {
  try {
    const code = await handleRequest(req, 'deletion');
    if (!code) return res.status(400).send({ error: { code: 'invalid_signed_request', message: 'Assinatura inválida.' } });
    return res.status(200).json({ url: statusUrl(req, code), confirmation_code: code });
  } catch (error) {
    console.error('[instagram] Falha no callback de exclusão de dados:', error?.code || error?.message);
    return res.status(500).send({ error: { code: 'internal_error', message: 'Erro interno.' } });
  }
});

router.get('/deletion-status/:code', async (req, res) => {
  if (!/^[A-Za-z0-9_-]{22}$/.test(req.params.code)) return res.status(404).send({ error: { code: 'not_found', message: 'Pedido não encontrado.' } });
  const [row] = await functions.executeSql('SELECT confirmation_code, kind, status, created_at FROM instagram_deletion_requests WHERE confirmation_code = ?', [req.params.code]).catch(() => []);
  if (!row) return res.status(404).send({ error: { code: 'not_found', message: 'Pedido não encontrado.' } });
  return res.send({ data: { confirmation_code: row.confirmation_code, kind: row.kind, status: row.status, processed_at: new Date(row.created_at).toISOString(),
    message: 'Os dados do Instagram vinculados a esta conta foram removidos do AgendasPRO.' } });
});

module.exports = router;
module.exports.parseSignedRequest = parseSignedRequest;
