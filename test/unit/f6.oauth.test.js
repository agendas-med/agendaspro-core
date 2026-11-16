process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.APP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.OAUTH_STATE_SECRET = crypto.randomBytes(24).toString('hex');

const oauthState = require('../../services/integrations/oauthState');

// Banco falso mínimo para oauth_states (só as consultas usadas pelo módulo).
function fakeDb() {
  const rows = new Map();
  const query = async (sql, params) => {
    if (sql.startsWith('DELETE')) return { affectedRows: 0 };
    if (sql.startsWith('INSERT INTO oauth_states')) {
      const [nonce, provider, companyId, userId, redirectUri, verifier, ttl] = params;
      rows.set(nonce, { nonce, provider, company_id: companyId, user_id: userId, redirect_uri: redirectUri, code_verifier_enc: verifier, expires: Date.now() + ttl * 1000, used: false });
      return { affectedRows: 1 };
    }
    if (sql.startsWith('UPDATE oauth_states')) {
      const [nonce, provider, companyId, userId] = params;
      const row = rows.get(nonce);
      if (!row || row.used || row.provider !== provider || row.company_id !== companyId || row.user_id !== userId || row.expires < Date.now()) return { affectedRows: 0 };
      row.used = true;
      return { affectedRows: 1 };
    }
    if (sql.startsWith('SELECT')) return [rows.get(params[0])].filter(Boolean);
    throw new Error(`consulta inesperada: ${sql}`);
  };
  return { rows, query };
}

test('state: emite, consome uma única vez e devolve redirect + verifier', async () => {
  const db = fakeDb();
  const state = await oauthState.issue({ provider: 'instagram', companyId: 7, userId: 3, redirectUri: 'https://app.example/cb', codeVerifier: 'v-123' }, { query: db.query });
  const stored = [...db.rows.values()][0];
  assert.notEqual(stored.code_verifier_enc, 'v-123', 'verifier cifrado em repouso');
  const out = await oauthState.consume(state, { provider: 'instagram', companyId: 7, userId: 3 }, { query: db.query });
  assert.deepEqual(out, { redirectUri: 'https://app.example/cb', codeVerifier: 'v-123' });
  await assert.rejects(oauthState.consume(state, { provider: 'instagram', companyId: 7, userId: 3 }, { query: db.query }), { code: 'oauth_state_invalid' });
});

test('state: outra empresa/usuário/provedor é rejeitado (anti-CSRF)', async () => {
  const db = fakeDb();
  const state = await oauthState.issue({ provider: 'instagram', companyId: 7, userId: 3, redirectUri: 'https://app.example/cb' }, { query: db.query });
  for (const ctx of [{ provider: 'instagram', companyId: 8, userId: 3 }, { provider: 'instagram', companyId: 7, userId: 4 }, { provider: 'google_calendar', companyId: 7, userId: 3 }]) {
    await assert.rejects(oauthState.consume(state, ctx, { query: db.query }), { code: 'oauth_state_invalid', status: 400 });
  }
});

test('state: assinatura adulterada, lixo e expirado são rejeitados', () => {
  const good = oauthState.encodeState({ p: 'instagram', c: 1, u: 1, n: 'x'.repeat(43), exp: Math.floor(Date.now() / 1000) + 60 });
  const [body, mac] = good.split('.');
  const forged = Buffer.from(JSON.stringify({ p: 'instagram', c: 2, u: 1, n: 'x'.repeat(43), exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
  assert.throws(() => oauthState.decodeState(`${forged}.${mac}`), { code: 'oauth_state_invalid' });
  assert.throws(() => oauthState.decodeState('nada'), { code: 'oauth_state_invalid' });
  assert.throws(() => oauthState.decodeState(undefined), { code: 'oauth_state_invalid' });
  assert.equal(oauthState.decodeState(`${body}.${mac}`).c, 1);
  const expired = oauthState.encodeState({ p: 'instagram', c: 1, u: 1, n: 'y', exp: Math.floor(Date.now() / 1000) - 1 });
  assert.throws(() => oauthState.decodeState(expired), { code: 'oauth_state_invalid' });
});

test('redirect_uri: allowlist, https obrigatório (exceto localhost) e não configurado', () => {
  process.env.TEST_REDIRECTS = 'https://app.example/integracoes/instagram, http://evil.example/cb, http://localhost:5173/cb';
  assert.deepEqual(oauthState.allowedRedirects('TEST_REDIRECTS'), ['https://app.example/integracoes/instagram', 'http://localhost:5173/cb']);
  assert.equal(oauthState.resolveRedirectUri('TEST_REDIRECTS'), 'https://app.example/integracoes/instagram');
  assert.equal(oauthState.resolveRedirectUri('TEST_REDIRECTS', 'http://localhost:5173/cb'), 'http://localhost:5173/cb');
  assert.throws(() => oauthState.resolveRedirectUri('TEST_REDIRECTS', 'http://evil.example/cb'), { code: 'redirect_uri_not_allowed' });
  assert.throws(() => oauthState.resolveRedirectUri('TEST_REDIRECTS_MISSING'), { code: 'integration_not_configured', status: 503 });
});

test('pkce: challenge S256 do verifier', () => {
  const { verifier, challenge } = oauthState.pkcePair();
  assert.ok(verifier.length >= 43);
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
});
