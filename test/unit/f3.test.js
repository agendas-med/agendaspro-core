process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.PUBLIC_BOOKING_TOKEN_SECRET = crypto.randomBytes(32).toString('base64url');
const tokens = require('../../services/publicTokens');
const turnstile = require('../../services/turnstileService');
const { daySlots, dateRange } = require('../../utils/slots');
const { isValidSlug, slugify, withSuffix } = require('../../utils/slug');

test('manage_token: emite, verifica, detecta adulteração e expiração', () => {
  const id = tokens.newPublicId();
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  const exp = new Date(Date.now() + 3600 * 1000);
  const token = tokens.issue(id, exp);
  assert.deepEqual(tokens.verify(token), { publicId: id, expired: false });
  assert.equal(tokens.issue(id, exp), token, 'determinístico (reenvio idempotente devolve o mesmo token)');

  const parts = token.split('.');
  const flip = s => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
  assert.equal(tokens.verify([parts[0], flip(parts[1]), parts[2], parts[3]].join('.')), null, 'public_id trocado');
  assert.equal(tokens.verify([parts[0], parts[1], String(Number(parts[2]) + 999999), parts[3]].join('.')), null, 'exp estendido');
  assert.equal(tokens.verify([parts[0], parts[1], parts[2], flip(parts[3])].join('.')), null, 'assinatura');
  assert.equal(tokens.verify('v2.' + parts.slice(1).join('.')), null);
  assert.equal(tokens.verify('lixo'), null);
  assert.equal(tokens.verify('x'.repeat(500)), null);

  const old = tokens.issue(id, new Date(Date.now() - 1000));
  assert.deepEqual(tokens.verify(old), { publicId: id, expired: true });

  const saved = process.env.PUBLIC_BOOKING_TOKEN_SECRET;
  process.env.PUBLIC_BOOKING_TOKEN_SECRET = 'curto';
  assert.throws(() => tokens.issue(id, exp), e => e.status === 503 && e.code === 'service_unavailable');
  process.env.PUBLIC_BOOKING_TOKEN_SECRET = crypto.randomBytes(32).toString('base64url');
  assert.equal(tokens.verify(token), null, 'outro segredo invalida');
  process.env.PUBLIC_BOOKING_TOKEN_SECRET = saved;
});

test('slots: expediente, ocupados, bloqueios, antecedência e qualquer profissional', () => {
  const { wallMinutes } = require('../../utils/time');
  const date = '2027-03-10'; // quarta (3)
  const m = t => wallMinutes(`${date} ${t}`);
  const rules = [
    { professional_id: 1, weekday: 3, start_time: '09:00', end_time: '11:00' },
    { professional_id: 2, weekday: 3, start_time: '10:00', end_time: '11:00' },
    { professional_id: 2, weekday: 4, start_time: '08:00', end_time: '18:00' },
  ];
  const busy = [{ professional_id: 1, start: m('09:30'), end: m('10:00') }];
  const blocks = [{ professional_id: null, start: m('10:30'), end: m('11:00') }];
  const slots = daySlots({ date, professionals: [1, 2], duration: 30, step: 30, minStart: m('09:00'), rules, busy, blocks });
  assert.deepEqual(slots, [
    { start: '09:00', professional_id: 1 },
    { start: '10:00', professional_id: 1 },
    { start: '10:00', professional_id: 2 },
  ]);
  const later = daySlots({ date, professionals: [1], duration: 60, step: 30, minStart: m('09:31'), rules, busy: [], blocks: [] });
  assert.deepEqual(later.map(s => s.start), ['10:00']);
  assert.deepEqual(dateRange('2027-02-27', '2027-03-02'), ['2027-02-27', '2027-02-28', '2027-03-01', '2027-03-02']);
});

test('slug: validação, reservados e geração', () => {
  assert.equal(isValidSlug('barbearia-do-ze'), true);
  for (const bad of ['ab', '-abc', 'abc-', 'a--b', 'ABC', 'admin', 'com espaco', 'x'.repeat(61), 1]) assert.equal(isValidSlug(bad), false, String(bad));
  assert.equal(slugify('Salão da Márcia & Cia!'), 'salao-da-marcia-cia');
  assert.equal(slugify('Admin'), 'negocio-admin');
  assert.equal(slugify('!!'), 'negocio');
  assert.match(withSuffix('salao'), /^salao-[0-9a-f]{5}$/);
  assert.ok(isValidSlug(withSuffix(slugify('Á'.repeat(80)))));
});

test('turnstile: fail closed em produção, bypass só explícito fora de produção', async () => {
  const env = { ...process.env };
  const restore = () => { for (const k of ['NODE_ENV', 'TURNSTILE_ENABLED', 'TURNSTILE_DEV_BYPASS', 'TURNSTILE_SECRET_KEY']) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; } };
  try {
    Object.assign(process.env, { NODE_ENV: 'production', TURNSTILE_ENABLED: 'false', TURNSTILE_DEV_BYPASS: 'true' });
    delete process.env.TURNSTILE_SECRET_KEY;
    assert.equal(turnstile.mode(), 'verify', 'produção ignora bypass');
    await assert.rejects(turnstile.verify('tok'), e => e.status === 503 && e.code === 'service_unavailable');

    process.env.TURNSTILE_SECRET_KEY = 'segredo-de-teste';
    await assert.rejects(turnstile.verify(''), e => e.code === 'turnstile_failed');
    await assert.rejects(turnstile.verify('tok', null, { post: async () => ({ data: { success: false } }) }), e => e.code === 'turnstile_failed');
    await assert.rejects(turnstile.verify('tok', null, { post: async () => { throw new Error('rede'); } }), e => e.status === 503);
    let sentBody;
    assert.deepEqual(await turnstile.verify('tok', '203.0.113.9', { post: async (url, body) => { sentBody = body; return { data: { success: true } }; } }), { success: true });
    assert.match(sentBody, /remoteip=203\.0\.113\.9/);

    Object.assign(process.env, { NODE_ENV: 'development', TURNSTILE_ENABLED: 'false' });
    delete process.env.TURNSTILE_DEV_BYPASS;
    assert.equal(turnstile.mode(), 'verify', 'só TURNSTILE_ENABLED=false não basta');
    process.env.TURNSTILE_DEV_BYPASS = 'true';
    assert.equal(turnstile.mode(), 'bypass');
  } finally {
    restore();
  }
});

test('status derivado e telefone normalizado', () => {
  const svc = require('../../services/publicBookingService');
  assert.equal(svc.normalizePhone('+55 (11) 98888-7777'), '11988887777');
  assert.equal(svc.normalizePhone('1133334444'), '1133334444');
  assert.equal(svc.normalizePhone('123'), null);
  const s = row => svc.deriveStatus({ canceled: 0, payment_status: 'isento', hold_expired: 0, ...row });
  assert.deepEqual(s({}), { status: 'confirmed' });
  assert.deepEqual(s({ payment_status: 'pendente' }), { status: 'pending_payment' });
  assert.deepEqual(s({ payment_status: 'pendente', hold_expired: 1 }), { status: 'cancelled', reason: 'payment_expired' });
  assert.deepEqual(s({ canceled: 1, cancel_reason: 'customer' }), { status: 'cancelled', reason: 'customer' });
  assert.deepEqual(s({ canceled: 1 }), { status: 'cancelled', reason: 'company' });
  assert.deepEqual(s({ checkin: new Date() }), { status: 'completed' });
});
