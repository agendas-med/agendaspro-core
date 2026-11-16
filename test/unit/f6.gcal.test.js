process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const mapping = require('../../services/googleCalendar/mapping');
const provider = require('../../services/googleCalendar/provider');

test('id do evento: base32hex determinístico, distinto por empresa/agendamento', () => {
  const a = mapping.eventId(1, 10);
  assert.match(a, /^[a-v0-9]{5,1024}$/);
  assert.equal(a, mapping.eventId(1, 10));
  assert.notEqual(a, mapping.eventId(1, 11));
  assert.notEqual(a, mapping.eventId(2, 10));
  assert.equal(mapping.base32hex(Buffer.from([0xff])), 'vs');
});

test('corpo do evento: minimizado (primeiro nome, serviços), horário de parede + fuso, marca anti-eco', () => {
  const body = mapping.eventBody({ id: 7, customer_name: 'Maria Souza Lima', date: '2027-03-10 23:30', duration: 60, services: ['Corte', 'Barba'], professional_name: 'Ana' }, { timeZone: 'America/Sao_Paulo' });
  assert.equal(body.summary, 'Maria · Corte, Barba');
  assert.deepEqual(body.start, { dateTime: '2027-03-10T23:30:00', timeZone: 'America/Sao_Paulo' });
  assert.deepEqual(body.end, { dateTime: '2027-03-11T00:30:00', timeZone: 'America/Sao_Paulo' });
  assert.equal(body.extendedProperties.private.agendaspro, '1');
  assert.ok(!JSON.stringify(body).includes('Souza'), 'sobrenome não vai para o Google');
  assert.equal(mapping.eventBody({ id: 1, customer_name: '', date: '2027-03-10 10:00', duration: 0 }, {}).end.dateTime, '2027-03-10T10:30:00');
  const h1 = mapping.contentHash(body, 'cal-a');
  assert.equal(h1, mapping.contentHash(body, 'cal-a'));
  assert.notEqual(h1, mapping.contentHash(body, 'cal-b'));
});

test('eventos importados: só ocupados reais viram bloqueio', () => {
  const timed = { id: 'e1', start: { dateTime: '2027-03-10T13:00:00Z' }, end: { dateTime: '2027-03-10T14:00:00Z' } };
  assert.equal(mapping.busyInterval(timed).allDay, false);
  assert.equal(mapping.busyInterval({ ...timed, status: 'cancelled' }).skip, 'cancelled');
  assert.equal(mapping.busyInterval({ ...timed, transparency: 'transparent' }).skip, 'free');
  assert.equal(mapping.busyInterval({ ...timed, attendees: [{ self: true, responseStatus: 'declined' }] }).skip, 'declined');
  assert.equal(mapping.busyInterval({ ...timed, extendedProperties: { private: { agendaspro: '1' } } }).skip, 'own');
  assert.equal(mapping.busyInterval(timed, { ownEventIds: new Set(['e1']) }).skip, 'own');
  assert.equal(mapping.busyInterval({ id: 'x', start: {}, end: {} }).skip, 'invalid');
  const allDay = mapping.busyInterval({ id: 'd', start: { date: '2027-03-12' }, end: { date: '2027-03-13' } });
  assert.deepEqual([allDay.allDay, mapping.toCompanyWall(allDay.start, 'America/Sao_Paulo', true)], [true, '2027-03-12 00:00']);
  assert.equal(mapping.toCompanyWall('2027-03-10T13:00:00Z', 'America/Sao_Paulo', false), '2027-03-10 10:00');
});

test('provider: classificação dos erros do Google sem vazar token', () => {
  const err = (status, data, headers = {}) => ({ response: { status, data, headers }, config: { headers: { Authorization: 'Bearer SEGREDO' } } });
  assert.equal(provider.normalize(err(400, { error: 'invalid_grant' })).kind, 'auth');
  assert.equal(provider.normalize(err(401, { error: { errors: [{ reason: 'authError' }] } })).kind, 'auth');
  assert.equal(provider.normalize(err(403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } })).kind, 'rate_limit');
  assert.equal(provider.normalize(err(429, {}, { 'retry-after': '30' })).retryAfterSec, 30);
  assert.equal(provider.normalize(err(403, { error: { errors: [{ reason: 'forbidden' }] } })).kind, 'bad_request');
  assert.equal(provider.normalize(err(410, { error: { errors: [{ reason: 'fullSyncRequired' }] } })).kind, 'gone');
  assert.equal(provider.normalize(err(409, {})).kind, 'conflict');
  assert.equal(provider.normalize(err(404, {})).kind, 'not_found');
  assert.equal(provider.normalize({ code: 'ETIMEDOUT' }).kind, 'unavailable');
  assert.ok(!JSON.stringify({ ...provider.normalize(err(500, {})), m: provider.normalize(err(500, {})).message }).includes('SEGREDO'));
});

test('provider: URL de autorização com PKCE S256, offline e escopos mínimos', () => {
  process.env.GOOGLE_CALENDAR_CLIENT_ID = 'cliente-teste.apps.googleusercontent.com';
  const url = new URL(provider.authorizeUrl({ redirectUri: 'https://app.example.test/cb', state: 's.t', codeChallenge: 'desafio' }));
  assert.equal(url.searchParams.get('code_challenge'), 'desafio');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  const scopes = url.searchParams.get('scope').split(' ');
  assert.ok(scopes.includes('https://www.googleapis.com/auth/calendar.app.created'));
  assert.ok(!scopes.includes('https://www.googleapis.com/auth/calendar'), 'sem escopo amplo');
  delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const idToken = `x.${Buffer.from(JSON.stringify({ email: 'conta@example.test' })).toString('base64url')}.y`;
  assert.equal(provider.emailFromIdToken(idToken), 'conta@example.test');
  assert.equal(provider.emailFromIdToken('lixo'), null);
});
