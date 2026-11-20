process.env.NODE_ENV = 'test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Modo Facebook Login for Business do provider da Instagram. A Graph API é um stub HTTP local (nunca a real);
// tokens e segredos são falsos.
const provider = require('../../services/instagram/provider');
const { ProviderError } = require('../../services/integrations/providerError');

const KEYS = ['INSTAGRAM_LOGIN_MODE', 'INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET', 'INSTAGRAM_FB_CONFIG_ID', 'INSTAGRAM_FB_OAUTH_URL',
  'INSTAGRAM_FB_GRAPH_URL', 'INSTAGRAM_GRAPH_URL', 'INSTAGRAM_GRAPH_VERSION', 'INSTAGRAM_HTTP_TIMEOUT_MS'];
const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
const FB_TOKEN = 'fb:17841400000000001:PAGE-TOKEN:com:dois';
const REDIRECT = 'https://app.example.test/integracoes/instagram';

let server;
let stubUrl;
let mode = 'ok';
const calls = [];
const json = (res, status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
const fail = (res, message) => json(res, 400, { error: { code: 100, type: 'OAuthException', message } });
const USER_TOKENS = ['curto-usuario', 'longo-usuario'];

function handle(res, url) {
  const token = url.searchParams.get('access_token');
  const grant = url.searchParams.get('grant_type');
  calls.push({ path: url.pathname, grant });
  if (url.pathname === '/v27.0/oauth/access_token') {
    if (grant === 'fb_exchange_token') {
      if (mode === 'sem-troca' || url.searchParams.get('fb_exchange_token') !== 'curto-usuario') return fail(res, 'troca recusada');
      return json(res, 200, { access_token: 'longo-usuario' });
    }
    return url.searchParams.get('code') === 'codigo-bom' ? json(res, 200, { access_token: 'curto-usuario' }) : fail(res, 'codigo ruim');
  }
  if (url.pathname === '/v27.0/me') {
    if (token === 'IGTOKEN') return json(res, 200, { user_id: '17841400000000001', username: 'studio.teste', name: 'Studio Teste', account_type: 'BUSINESS', followers_count: 1000 });
    if (!USER_TOKENS.includes(token)) return fail(res, 'token');
    return json(res, 200, { id: '1122334455' });
  }
  if (url.pathname === '/v27.0/me/accounts') {
    if (!USER_TOKENS.includes(token)) return fail(res, 'token');
    const semIg = { id: 'p0', name: 'Sem IG', access_token: 'PAGE-TOKEN:sem-ig' };
    const comIg = { id: 'p1', name: 'Loja', access_token: 'PAGE-TOKEN:com:dois', instagram_business_account: { id: '17841400000000001', username: 'studio.teste' } };
    return json(res, 200, { data: mode === 'sem-ig' ? [semIg] : [semIg, comIg] });
  }
  if (url.pathname === '/v27.0/me/permissions') {
    return json(res, 200, { data: [{ permission: 'instagram_basic', status: 'granted' }, { permission: 'pages_show_list', status: 'declined' }] });
  }
  if (url.pathname === '/v27.0/17841400000000001') {
    if (token !== 'PAGE-TOKEN:com:dois') return fail(res, 'token');
    return json(res, 200, { id: '17841400000000001', username: 'studio.teste', name: 'Studio Teste', profile_picture_url: 'https://cdn.example.test/p.jpg', followers_count: 1000, follows_count: 50, media_count: 10 });
  }
  if (url.pathname === '/v27.0/17841400000000001/media') {
    if (token !== 'PAGE-TOKEN:com:dois') return fail(res, 'token');
    return json(res, 200, { data: [{ id: '179000000000001', caption: 'Oi', media_type: 'IMAGE', media_product_type: 'FEED' }] });
  }
  return json(res, 404, { error: { code: 803, message: 'nao existe' } });
}

// Ambiente de cada teste: modo facebook, bases apontando para o stub, variáveis de modo removidas antes.
// Valor undefined em vars remove a variável (process.env não aceita undefined).
function setEnv(vars = {}) {
  for (const key of KEYS) delete process.env[key];
  const merged = { INSTAGRAM_LOGIN_MODE: 'facebook', INSTAGRAM_APP_ID: '1234567890', INSTAGRAM_APP_SECRET: 'segredo-falso',
    INSTAGRAM_FB_GRAPH_URL: stubUrl, INSTAGRAM_GRAPH_URL: stubUrl, ...vars };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

before(async () => {
  server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => handle(res, new URL(req.url, 'http://stub')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  stubUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await new Promise(resolve => server.close(resolve));
});

test('parseToken: fb:<igId>:<token> divide só nos dois primeiros ":"; token legado vai inteiro', () => {
  assert.deepEqual(provider.parseToken('fb:17841:ab:cd'), { fb: true, igId: '17841', accessToken: 'ab:cd' });
  assert.deepEqual(provider.parseToken('IGQVJ-legado'), { fb: false, accessToken: 'IGQVJ-legado' });
  for (const malformed of ['fb:', 'fb:17841', 'fb::token']) {
    assert.throws(() => provider.parseToken(malformed), error => error instanceof ProviderError && error.kind === 'auth');
  }
  assert.deepEqual(provider.FB_SCOPES, ['instagram_basic', 'instagram_manage_insights', 'pages_show_list', 'pages_read_engagement', 'business_management']);
});

test('authorizeUrl modo facebook: diálogo com scope quando não há config_id', () => {
  setEnv();
  const url = new URL(provider.authorizeUrl({ redirectUri: REDIRECT, state: 'estado-1' }));
  assert.equal(url.origin, 'https://www.facebook.com');
  assert.equal(url.pathname, '/v27.0/dialog/oauth');
  assert.equal(url.searchParams.get('client_id'), '1234567890');
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(url.searchParams.get('state'), 'estado-1');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), provider.FB_SCOPES.join(','));
  assert.equal(url.searchParams.has('config_id'), false);
});

test('authorizeUrl modo facebook: com INSTAGRAM_FB_CONFIG_ID envia config_id e não envia scope', () => {
  setEnv({ INSTAGRAM_FB_CONFIG_ID: 'cfg-123', INSTAGRAM_FB_OAUTH_URL: 'http://oauth.stub.test' });
  const url = new URL(provider.authorizeUrl({ redirectUri: REDIRECT, state: 'estado-2' }));
  assert.equal(url.origin, 'http://oauth.stub.test');
  assert.equal(url.searchParams.get('config_id'), 'cfg-123');
  assert.equal(url.searchParams.has('scope'), false);
  assert.equal(url.searchParams.get('state'), 'estado-2');
});

test('authorizeUrl modo instagram (padrão) segue como antes', () => {
  setEnv({ INSTAGRAM_LOGIN_MODE: undefined });
  const url = new URL(provider.authorizeUrl({ redirectUri: REDIRECT, state: 'estado-3' }));
  assert.equal(url.origin + url.pathname, 'https://www.instagram.com/oauth/authorize');
  assert.equal(url.searchParams.get('scope'), 'instagram_business_basic,instagram_business_manage_insights');
  assert.equal(provider.loginMode(), 'instagram');
});

test('exchangeCode modo facebook: retorna fb:<ig>:<pageToken> e appUserId = id do /me', async () => {
  setEnv();
  calls.length = 0;
  mode = 'ok';
  const out = await provider.exchangeCode({ code: 'codigo-bom', redirectUri: REDIRECT });
  assert.equal(out.accessToken, FB_TOKEN);
  assert.equal(out.appUserId, '1122334455');
  assert.deepEqual(out.permissions, ['instagram_basic']);
  assert.ok(calls.some(call => call.grant === 'fb_exchange_token'), 'troca para token longo de usuário');
  assert.ok(calls.some(call => call.path === '/v27.0/me/accounts'));
});

test('exchangeCode modo facebook: troca longa recusada segue com o token curto', async () => {
  setEnv();
  mode = 'sem-troca';
  try {
    const out = await provider.exchangeCode({ code: 'codigo-bom', redirectUri: REDIRECT });
    assert.equal(out.accessToken, FB_TOKEN);
  } finally { mode = 'ok'; }
});

test('exchangeCode modo facebook: sem Página com conta do Instagram = no_instagram_business_account', async () => {
  setEnv();
  mode = 'sem-ig';
  try {
    await assert.rejects(provider.exchangeCode({ code: 'codigo-bom', redirectUri: REDIRECT }), error => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'bad_request');
      assert.equal(error.providerCode, 'no_instagram_business_account');
      return true;
    });
  } finally { mode = 'ok'; }
});

test('longLivedToken e refreshToken com token fb: não fazem rede', async () => {
  setEnv();
  calls.length = 0;
  const longa = await provider.longLivedToken(FB_TOKEN);
  const renovada = await provider.refreshToken(FB_TOKEN);
  assert.deepEqual(longa, { accessToken: FB_TOKEN, expiresIn: 365 * 24 * 3600 });
  assert.deepEqual(renovada, { accessToken: FB_TOKEN, expiresIn: 365 * 24 * 3600 });
  assert.equal(calls.length, 0, 'nenhuma chamada HTTP');
});

test('profile modo facebook chama /<igId> e devolve user_id e account_type', async () => {
  setEnv();
  calls.length = 0;
  const me = await provider.profile(FB_TOKEN);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/v27.0/17841400000000001');
  assert.equal(me.user_id, '17841400000000001');
  assert.equal(me.account_type, 'BUSINESS');
  assert.equal(me.username, 'studio.teste');
  assert.equal(me.followers_count, 1000);
});

test('formato decide a API: token legado do Instagram continua em /me, mesmo com modo facebook', async () => {
  setEnv();
  calls.length = 0;
  const me = await provider.profile('IGTOKEN');
  assert.equal(calls[0].path, '/v27.0/me');
  assert.equal(me.user_id, '17841400000000001');
});

test('mediaPage modo facebook usa /<igId>/media', async () => {
  setEnv();
  calls.length = 0;
  const page = await provider.mediaPage(FB_TOKEN, { limit: 25 });
  assert.equal(calls[0].path, '/v27.0/17841400000000001/media');
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, '179000000000001');
});
