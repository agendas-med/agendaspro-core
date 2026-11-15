const crypto = require('node:crypto');

// manage_token do agendamento público: "v1.<public_id>.<exp unix s>.<HMAC-SHA256 base64url>".
// - segredo: PUBLIC_BOOKING_TOKEN_SECRET (mín. 32 caracteres); sem ele o fluxo falha fechado;
// - comparação em tempo constante (timingSafeEqual);
// - exp fica gravado em public_bookings.token_expires_at: um reenvio idempotente devolve o mesmo token.
// O token não carrega dado pessoal; public_id é aleatório (não sequencial).
const VERSION = 'v1';
const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{16,32}$/;
const SIG_RE = /^[A-Za-z0-9_-]{43}$/;

function secret() {
  const value = process.env.PUBLIC_BOOKING_TOKEN_SECRET;
  if (!value || value.length < 32) {
    throw Object.assign(new Error('Agendamento online indisponível.'), { status: 503, code: 'service_unavailable', internalReason: 'token_secret_missing' });
  }
  return value;
}

function ttlDays() {
  const days = Number(process.env.PUBLIC_BOOKING_TOKEN_TTL_DAYS);
  return Number.isFinite(days) && days >= 1 && days <= 365 ? days : 90;
}

const sign = (publicId, exp) => crypto.createHmac('sha256', secret()).update(`${VERSION}.${publicId}.${exp}`).digest('base64url');

function newPublicId() {
  return crypto.randomBytes(16).toString('base64url').slice(0, 22);
}

function expiryFromNow(now = Date.now()) {
  return new Date(Math.floor(now / 1000) * 1000 + ttlDays() * 86400 * 1000);
}

function issue(publicId, expiresAt) {
  const exp = Math.floor(new Date(expiresAt).getTime() / 1000);
  return `${VERSION}.${publicId}.${exp}.${sign(publicId, exp)}`;
}

// Retorna { publicId, expired } ou null (formato/assinatura inválidos).
function verify(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 120) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const [, publicId, expText, sig] = parts;
  if (!PUBLIC_ID_RE.test(publicId) || !/^\d{9,11}$/.test(expText) || !SIG_RE.test(sig)) return null;
  const expected = Buffer.from(sign(publicId, Number(expText)));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  return { publicId, expired: Number(expText) * 1000 <= now };
}

module.exports = { issue, verify, newPublicId, expiryFromNow, ttlDays };
