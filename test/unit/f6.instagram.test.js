process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const metrics = require('../../services/instagram/metrics');
const provider = require('../../services/instagram/provider');
const attribution = require('../../services/attributionService');

test('engajamento: total_interactions / alcance; sem alcance usa seguidores; sem dados = null', () => {
  assert.deepEqual(metrics.engagement({ total_interactions: 30, reach: 200, like_count: 1 }, 1000), { interactions: 30, engagement_rate: 0.15, engagement_basis: 'reach' });
  assert.deepEqual(metrics.engagement({ like_count: 10, comments_count: 5 }, 1000), { interactions: 15, engagement_rate: 0.015, engagement_basis: 'followers' });
  assert.deepEqual(metrics.engagement({}, 1000), { interactions: null, engagement_rate: null, engagement_basis: null });
  assert.equal(metrics.engagement({ like_count: 3 }, 0).engagement_rate, null);
});

test('resumo e comparativo da conta', () => {
  const posts = [
    { media_id: 'a', total_interactions: 30, reach: 200, media_type: 'IMAGE' },
    { media_id: 'b', total_interactions: 10, reach: 200, media_type: 'IMAGE' },
    { media_id: 'c', total_interactions: 60, reach: 200, media_type: 'VIDEO', media_product_type: 'REELS' },
  ];
  const summary = metrics.summary(posts, 1000);
  assert.equal(summary.engagement_rate, 0.1667);
  assert.equal(summary.engagement_basis, 'reach');
  const mixed = metrics.summary([{ like_count: 10 }, { total_interactions: 20, reach: 100 }], 1000);
  assert.equal(mixed.engagement_basis, 'followers', 'alcance parcial cai para seguidores');
  assert.equal(mixed.engagement_rate, 0.015);
  const cmp = metrics.compare(posts, 1000);
  assert.deepEqual(cmp.top, ['c', 'a', 'b']);
  assert.deepEqual(cmp.by_type.map(t => t.type).sort(), ['IMAGE', 'REELS']);
  assert.deepEqual(metrics.funnel({ visits: 3, bookings: 1 }).visit_to_booking_rate, 0.3333);
  assert.equal(metrics.funnel({ visits: 0, bookings: 0 }).visit_to_booking_rate, null);
});

test('provider: classificação dos erros da Meta sem vazar URL/token', () => {
  const axiosError = (status, error, headers = {}) => ({ response: { status, data: { error }, headers }, config: { url: 'https://graph/me?access_token=SEGREDO' } });
  assert.equal(provider.normalize(axiosError(400, { code: 190 })).kind, 'auth');
  for (const code of [4, 17, 32, 613]) assert.equal(provider.normalize(axiosError(400, { code })).kind, 'rate_limit');
  const limited = provider.normalize(axiosError(429, {}, { 'retry-after': '120' }));
  assert.deepEqual([limited.kind, limited.retryAfterSec, limited.retryable], ['rate_limit', 120, true]);
  assert.equal(provider.normalize(axiosError(503, {})).kind, 'unavailable');
  assert.equal(provider.normalize({ code: 'ECONNRESET' }).kind, 'unavailable');
  const bad = provider.normalize(axiosError(400, { code: 100 }));
  assert.equal(bad.kind, 'bad_request');
  assert.ok(!JSON.stringify({ ...bad, message: bad.message }).includes('SEGREDO'));
  assert.deepEqual(provider.mediaMetrics('STORY'), ['reach', 'views', 'shares', 'total_interactions']);
  assert.ok(!provider.mediaMetrics('FEED').includes('impressions'));
});

test('signed_request da Meta: HMAC-SHA256 do payload com o app secret', () => {
  process.env.INSTAGRAM_APP_SECRET = crypto.randomBytes(16).toString('hex');
  const { parseSignedRequest } = require('../../routes/instagramMeta');
  const body = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', issued_at: 1, user_id: '42' })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.INSTAGRAM_APP_SECRET).update(body).digest('base64url');
  assert.equal(parseSignedRequest(`${sig}.${body}`).user_id, '42');
  assert.equal(parseSignedRequest(`${sig.slice(0, -2)}AA.${body}`), null);
  assert.equal(parseSignedRequest(`${sig}.${body}.x`), null);
  const noAlg = Buffer.from(JSON.stringify({ user_id: '42' })).toString('base64url');
  assert.equal(parseSignedRequest(`${crypto.createHmac('sha256', process.env.INSTAGRAM_APP_SECRET).update(noAlg).digest('base64url')}.${noAlg}`), null);
  delete process.env.INSTAGRAM_APP_SECRET;
  assert.equal(parseSignedRequest(`${sig}.${body}`), null, 'sem segredo configurado nada é aceito');
});

test('UTM: normaliza (minúsculas, sem caracteres fora da allowlist) e monta link da página pública', () => {
  assert.deepEqual(attribution.normalize({ utm_source: ' Instagram ', utm_campaign: 'Black Friday!', extra: 'x' }), { utm_source: 'instagram', utm_medium: '', utm_campaign: 'blackfriday', utm_content: '' });
  process.env.PUBLIC_SITE_URL = 'https://site.example.test/';
  assert.equal(attribution.pageUrl('studio', { utm_source: 'instagram', utm_medium: 'bio', utm_campaign: 'perfil', utm_content: '' }), 'https://site.example.test/b/studio?utm_source=instagram&utm_medium=bio&utm_campaign=perfil');
  delete process.env.PUBLIC_SITE_URL;
});
