const crypto = require('node:crypto');
const functions = require('../../utils/functions');
const { encrypt, decrypt, randomToken } = require('../../utils/crypto');

// State OAuth (F6): base64url(JSON{p,c,u,n,exp}).HMAC-SHA256 com OAUTH_STATE_SECRET.
// O nonce fica em oauth_states (uso único, expira em 10 min) junto com a redirect_uri usada e o
// code_verifier PKCE cifrado. O callback exige provedor, empresa e usuário iguais aos da sessão.
const TTL_SEC = 10 * 60;

function codedError(status, code, message, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (details) error.details = details;
  return error;
}

function secret() {
  const own = process.env.OAUTH_STATE_SECRET;
  if (own && own.length >= 16) return own;
  // Sem segredo próprio: deriva de APP_ENCRYPTION_KEY (rótulo fixo), nunca usa a chave crua.
  const base = process.env.APP_ENCRYPTION_KEY;
  if (!base) throw new Error('OAUTH_STATE_SECRET (ou APP_ENCRYPTION_KEY) não configurado.');
  return crypto.createHmac('sha256', base).update('agendaspro:oauth-state:v1').digest('hex');
}

function sign(body) {
  return crypto.createHmac('sha256', secret()).update(body).digest('base64url');
}

function encodeState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

// Só verifica assinatura/expiração/forma (sem banco). Lança oauth_state_invalid.
function decodeState(state, { now = Date.now() } = {}) {
  const invalid = () => codedError(400, 'oauth_state_invalid', 'Autorização inválida ou expirada. Conecte novamente.');
  if (typeof state !== 'string' || state.length > 600 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(state)) throw invalid();
  const [body, mac] = state.split('.');
  const expected = sign(body);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw invalid();
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw invalid(); }
  if (!payload || typeof payload.n !== 'string' || !Number.isFinite(payload.exp) || payload.exp * 1000 < now) throw invalid();
  return payload;
}

// Allowlist de redirect_uri por provedor (env com lista separada por vírgula). Sem pedido explícito,
// usa a primeira. Exige https (exceto localhost para desenvolvimento).
function allowedRedirects(envName) {
  return String(process.env[envName] || '').split(',').map(item => item.trim()).filter(Boolean)
    .filter(uri => /^https:\/\//.test(uri) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(uri));
}

function resolveRedirectUri(envName, requested) {
  const list = allowedRedirects(envName);
  if (!list.length) throw codedError(503, 'integration_not_configured', 'Integração não configurada no servidor.');
  if (!requested) return list[0];
  if (!list.includes(requested)) throw codedError(400, 'redirect_uri_not_allowed', 'redirect_uri não permitida.');
  return requested;
}

async function issue({ provider, companyId, userId, redirectUri, codeVerifier = null }, { query = functions.executeSql.bind(functions) } = {}) {
  const nonce = randomToken(32); // 43 caracteres base64url
  const exp = Math.floor(Date.now() / 1000) + TTL_SEC;
  await query('DELETE FROM oauth_states WHERE expires_at < NOW() - INTERVAL 1 DAY', []);
  await query(
    `INSERT INTO oauth_states (nonce, provider, company_id, user_id, redirect_uri, code_verifier_enc, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW() + INTERVAL ? SECOND)`,
    [nonce, provider, companyId, userId, redirectUri, codeVerifier ? encrypt(codeVerifier) : null, TTL_SEC],
  );
  return encodeState({ p: provider, c: Number(companyId), u: Number(userId), n: nonce, exp });
}

// Consome o state (uso único). Retorna { redirectUri, codeVerifier }.
async function consume(state, { provider, companyId, userId }, { query = functions.executeSql.bind(functions) } = {}) {
  const payload = decodeState(state);
  if (payload.p !== provider || Number(payload.c) !== Number(companyId) || Number(payload.u) !== Number(userId)) {
    throw codedError(400, 'oauth_state_invalid', 'Autorização inválida ou expirada. Conecte novamente.');
  }
  const result = await query(
    `UPDATE oauth_states SET used_at = NOW()
      WHERE nonce = ? AND provider = ? AND company_id = ? AND user_id = ? AND used_at IS NULL AND expires_at > NOW()`,
    [payload.n, provider, companyId, userId],
  );
  if (!result || result.affectedRows !== 1) throw codedError(400, 'oauth_state_invalid', 'Autorização inválida ou expirada. Conecte novamente.');
  const rows = await query('SELECT redirect_uri, code_verifier_enc FROM oauth_states WHERE nonce = ?', [payload.n]);
  const row = rows[0];
  return { redirectUri: row.redirect_uri, codeVerifier: row.code_verifier_enc ? decrypt(row.code_verifier_enc) : null };
}

// PKCE (S256).
function pkcePair() {
  const verifier = randomToken(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

module.exports = { issue, consume, encodeState, decodeState, resolveRedirectUri, allowedRedirects, pkcePair, codedError, TTL_SEC };
