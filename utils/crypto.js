const crypto = require('node:crypto');

// Segredos em repouso: AES-256-GCM com APP_ENCRYPTION_KEY (base64 de 32 bytes).
// Formato armazenado: "enc:v1:<iv b64>:<tag b64>:<cifra b64>". Valores sem o prefixo são
// legados em texto puro e continuam legíveis até rodar scripts/encrypt-secrets.js.
const PREFIX = 'enc:v1:';

function getKey() {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) throw new Error('APP_ENCRYPTION_KEY não configurada.');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY deve ser base64 de exatamente 32 bytes.');
  return key;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return plain;
  if (isEncrypted(plain)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), data].map(part => part.toString('base64')).join(':');
}

function decrypt(stored) {
  if (!isEncrypted(stored)) return stored; // legado em texto puro (ou vazio)
  const [iv, tag, data] = stored.slice(PREFIX.length).split(':').map(part => Buffer.from(part, 'base64'));
  if (!iv || !tag || !data || iv.length !== 12 || tag.length !== 16) throw new Error('Segredo cifrado em formato inválido.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// Comparação em tempo constante (evita vazamento por tempo de resposta).
function safeEqual(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(received).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b) && received.length === expected.length;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

module.exports = { encrypt, decrypt, isEncrypted, safeEqual, sha256, randomToken, PREFIX };
