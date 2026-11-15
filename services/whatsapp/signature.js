const crypto = require('node:crypto');
const { safeEqual } = require('../../utils/crypto');

// Assinatura dos webhooks da Meta: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(corpo cru, app secret).
// Sempre sobre os bytes recebidos (antes de qualquer JSON.parse); comparação em tempo constante.
function expectedSignature(rawBody, appSecret) {
  return `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

function verifySignature(rawBody, header, appSecret = process.env.META_APP_SECRET) {
  if (!appSecret || appSecret.length < 16) return false;
  if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') return false;
  if (typeof header !== 'string' || !/^sha256=[0-9a-f]{64}$/i.test(header.trim())) return false;
  return safeEqual(header.trim().toLowerCase(), expectedSignature(rawBody, appSecret));
}

// GET de verificação do webhook (hub.mode=subscribe, hub.verify_token, hub.challenge).
function verifyChallenge(query, verifyToken = process.env.META_VERIFY_TOKEN) {
  if (!verifyToken) return null;
  if (query?.['hub.mode'] !== 'subscribe') return null;
  if (!safeEqual(String(query['hub.verify_token'] || ''), verifyToken)) return null;
  const challenge = String(query['hub.challenge'] || '');
  return /^[A-Za-z0-9_-]{1,128}$/.test(challenge) ? challenge : null;
}

module.exports = { verifySignature, expectedSignature, verifyChallenge };
