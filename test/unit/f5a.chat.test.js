const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const chat = require('../../services/publicChatService');

const withSecret = fn => () => {
  process.env.PUBLIC_CHAT_TOKEN_SECRET = crypto.randomBytes(24).toString('hex');
  try { return fn(); } finally { delete process.env.PUBLIC_CHAT_TOKEN_SECRET; }
};
const ID = 'a'.repeat(32);

test('token de sessão: assinatura, expiração e adulteração', withSecret(() => {
  const exp = Date.now() + 60000;
  const token = chat.issueToken(ID, exp);
  assert.deepEqual(chat.readToken(token), { publicId: ID, expMs: exp });
  assert.deepEqual(chat.readToken(token, exp + 1), { expired: true });
  assert.equal(chat.readToken(token.replace(ID, 'b'.repeat(32))), null);
  assert.equal(chat.readToken(`${token}x`), null);
  assert.equal(chat.readToken('cs1.x.y.z'), null);
  process.env.PUBLIC_CHAT_TOKEN_SECRET = 'outro';
  assert.equal(chat.readToken(token), null);
}));

test('sem segredo próprio deriva do segredo dos links públicos; sem nenhum, 503', () => {
  delete process.env.PUBLIC_CHAT_TOKEN_SECRET;
  const prev = process.env.PUBLIC_BOOKING_TOKEN_SECRET;
  delete process.env.PUBLIC_BOOKING_TOKEN_SECRET;
  try {
    assert.throws(() => chat.issueToken(ID, Date.now() + 1000), e => e.status === 503);
    process.env.PUBLIC_BOOKING_TOKEN_SECRET = 'segredo-de-teste';
    const token = chat.issueToken(ID, Date.now() + 1000);
    assert.ok(chat.readToken(token));
  } finally {
    if (prev === undefined) delete process.env.PUBLIC_BOOKING_TOKEN_SECRET; else process.env.PUBLIC_BOOKING_TOKEN_SECRET = prev;
  }
});

test('config: padrões e tetos', () => {
  const c = chat.config();
  assert.equal(c.maxMessages, 20);
  assert.equal(c.maxChars, 500);
  process.env.PUBLIC_CHAT_MESSAGE_MAX_CHARS = '99999';
  process.env.PUBLIC_CHAT_MAX_OUTPUT_TOKENS = '5000';
  try {
    assert.equal(chat.config().maxChars, 2000);
    assert.equal(chat.config().maxOutputTokens, 400);
  } finally { delete process.env.PUBLIC_CHAT_MESSAGE_MAX_CHARS; delete process.env.PUBLIC_CHAT_MAX_OUTPUT_TOKENS; }
  assert.equal(chat.enabled(), false);
});

test('dica proativa é determinística', () => {
  const session = { lead_captured_at: null };
  assert.equal(chat.proactiveHint({ audience: 'business', session, intent: 'plans', turn: 1 }).type, 'signup');
  assert.equal(chat.proactiveHint({ audience: 'business', session, intent: 'features', turn: 1 }), null);
  assert.equal(chat.proactiveHint({ audience: 'business', session, intent: 'features', turn: 3 }).type, 'lead_form');
  assert.equal(chat.proactiveHint({ audience: 'business', session: { lead_captured_at: new Date() }, intent: 'features', turn: 5 }), null);
  const biz = { company: { name: 'Clínica', slug: 'clinica' } };
  assert.equal(chat.proactiveHint({ audience: 'customer', session, biz, intent: 'manage', turn: 1 }).type, 'booking_link');
  assert.equal(chat.proactiveHint({ audience: 'customer', session, biz, intent: 'availability', turn: 1 }), null);
  assert.equal(chat.proactiveHint({ audience: 'customer', session, intent: 'manage', turn: 1 }), null);
});

test('dica proativa: url só da allowlist', () => {
  const prev = { site: process.env.PUBLIC_SITE_URL, app: process.env.URL_SITE };
  process.env.PUBLIC_SITE_URL = 'https://site.example.test';
  process.env.URL_SITE = 'https://app.example.test';
  try {
    const session = { lead_captured_at: null };
    const signup = chat.proactiveHint({ audience: 'business', session, intent: 'plans', turn: 1, data: { signup_url: 'https://app.example.test/registro' } });
    assert.equal(signup.url, 'https://app.example.test/registro');
    assert.equal(chat.proactiveHint({ audience: 'business', session, intent: 'plans', turn: 1, data: { signup_url: 'https://evil.example.com/x' } }).url, undefined);
    assert.equal(chat.proactiveHint({ audience: 'business', session, intent: 'plans', turn: 1, data: { signup_url: 'javascript:alert(1)' } }).url, undefined);
    assert.equal(chat.proactiveHint({ audience: 'business', session, intent: 'features', turn: 3 }).url, undefined);
    const biz = { company: { name: 'Clínica', slug: 'clinica' } };
    assert.equal(chat.proactiveHint({ audience: 'customer', session, biz, intent: 'manage', turn: 1 }).url, 'https://site.example.test/b/clinica');
    delete process.env.PUBLIC_SITE_URL;
    assert.equal(chat.proactiveHint({ audience: 'customer', session, biz, intent: 'manage', turn: 1 }).url, undefined, 'url relativa não sai');
  } finally {
    for (const [k, v] of [['PUBLIC_SITE_URL', prev.site], ['URL_SITE', prev.app]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('resumo acumula assuntos e ignora social', () => {
  assert.equal(chat.nextSummary(null, 'greeting'), null);
  const s1 = chat.nextSummary(null, 'plans');
  assert.equal(s1, 'Assuntos: plans');
  assert.equal(chat.nextSummary(chat.nextSummary(s1, 'features'), 'plans'), 'Assuntos: plans, features');
  assert.ok(chat.AI_INTENTS.includes('refuse') && chat.AI_INTENTS.includes('handoff'));
});
