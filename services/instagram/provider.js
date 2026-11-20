const axios = require('axios');
const { ProviderError } = require('../integrations/providerError');

// Cliente da Instagram API with Instagram Login (graph.instagram.com) e, com INSTAGRAM_LOGIN_MODE=facebook,
// Instagram API with Facebook Login for Business (graph.facebook.com). Bases configuráveis por env:
// os testes apontam para um stub HTTP local. NENHUMA chamada real foi exercitada neste repositório.
// Tokens só trafegam na requisição; erros são normalizados sem URL/query (que contém o token).
const env = (name, fallback) => (process.env[name] || fallback).replace(/\/+$/, '');
const oauthUrl = () => env('INSTAGRAM_OAUTH_URL', 'https://www.instagram.com/oauth/authorize');
const apiUrl = () => env('INSTAGRAM_API_URL', 'https://api.instagram.com');
const graphRoot = () => env('INSTAGRAM_GRAPH_URL', 'https://graph.instagram.com');
const version = () => process.env.INSTAGRAM_GRAPH_VERSION || 'v27.0';
const graphUrl = () => `${graphRoot()}/${version()}`;
const fbOauthUrl = () => env('INSTAGRAM_FB_OAUTH_URL', 'https://www.facebook.com');
const fbGraphUrl = () => `${env('INSTAGRAM_FB_GRAPH_URL', 'https://graph.facebook.com')}/${version()}`;
const loginMode = () => ((process.env.INSTAGRAM_LOGIN_MODE || 'instagram').trim().toLowerCase() === 'facebook' ? 'facebook' : 'instagram');
const TIMEOUT = () => Number(process.env.INSTAGRAM_HTTP_TIMEOUT_MS) || 10000;

const SCOPES = ['instagram_business_basic', 'instagram_business_manage_insights'];
const FB_SCOPES = ['instagram_basic', 'instagram_manage_insights', 'pages_show_list', 'pages_read_engagement', 'business_management'];
const activeScopes = () => (loginMode() === 'facebook' ? FB_SCOPES : SCOPES);
const FB_LONG_TTL_SEC = 365 * 24 * 3600; // token de Página vindo de token longo de usuário não expira; revogação = erro 190
const PROFILE_FIELDS = 'user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count';
const FB_PROFILE_FIELDS = 'id,username,name,profile_picture_url,followers_count,follows_count,media_count';
const MEDIA_FIELDS = 'id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count';

function configured() {
  return !!(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET);
}

function appSecret() {
  const secret = process.env.INSTAGRAM_APP_SECRET;
  if (!secret) throw new ProviderError('Instagram não configurado.', { kind: 'bad_request', providerCode: 'not_configured' });
  return secret;
}

// Token novo do modo Facebook: 'fb:<igId>:<accessToken>'. O formato (não o modo) decide as chamadas de API.
const isFbToken = token => String(token || '').startsWith('fb:');
function parseToken(token) {
  if (!isFbToken(token)) return { fb: false, accessToken: token };
  const rest = String(token).slice(3);
  const cut = rest.indexOf(':');
  const igId = cut > 0 ? rest.slice(0, cut) : '';
  const accessToken = cut > 0 ? rest.slice(cut + 1) : '';
  if (!igId || !accessToken) throw new ProviderError('Token do Instagram inválido ou expirado.', { kind: 'auth', providerCode: 'malformed_token' });
  return { fb: true, igId, accessToken };
}
// Nó do usuário: fb -> graph.facebook.com/<ver>/<igId>; ig -> graph.instagram.com/<ver>/me (comportamento atual).
const nodeOf = p => (p.fb ? `${fbGraphUrl()}/${encodeURIComponent(p.igId)}` : `${graphUrl()}/me`);

// Meta: 190 = token inválido/expirado; 4/17/32/613 (ou HTTP 429) = limite de uso; 5xx/rede = indisponível.
const RATE_CODES = new Set([4, 17, 32, 613]);
function normalize(error) {
  if (error instanceof ProviderError) return error;
  const status = error?.response?.status || null;
  const body = error?.response?.data?.error || {};
  const code = Number.isFinite(Number(body.code)) ? Number(body.code) : null;
  const providerCode = code !== null ? String(code) : (typeof body.type === 'string' ? body.type : null);
  if (code === 190 || body.type === 'OAuthException' && status === 401) return new ProviderError('Token do Instagram inválido ou expirado.', { kind: 'auth', providerCode, httpStatus: status });
  if (RATE_CODES.has(code) || status === 429) {
    const retryAfter = Number(error?.response?.headers?.['retry-after']) || null;
    return new ProviderError('Limite de uso da API do Instagram atingido.', { kind: 'rate_limit', providerCode, httpStatus: status, retryAfterSec: retryAfter });
  }
  if (!status || status >= 500) return new ProviderError('API do Instagram indisponível.', { kind: 'unavailable', providerCode, httpStatus: status });
  if (status === 404) return new ProviderError('Recurso não encontrado no Instagram.', { kind: 'not_found', providerCode, httpStatus: status });
  return new ProviderError('Requisição recusada pela API do Instagram.', { kind: 'bad_request', providerCode, httpStatus: status });
}

async function call(config) {
  try {
    const response = await axios({ timeout: TIMEOUT(), ...config });
    return response.data;
  } catch (error) {
    throw normalize(error);
  }
}

function authorizeUrl({ redirectUri, state }) {
  if (loginMode() === 'facebook') {
    const fb = { client_id: process.env.INSTAGRAM_APP_ID || '', redirect_uri: redirectUri, state, response_type: 'code' };
    // Com configuração de login (config_id) os escopos vêm dela: não se envia scope junto.
    if (process.env.INSTAGRAM_FB_CONFIG_ID) fb.config_id = process.env.INSTAGRAM_FB_CONFIG_ID;
    else fb.scope = FB_SCOPES.join(',');
    return `${fbOauthUrl()}/${version()}/dialog/oauth?${new URLSearchParams(fb).toString()}`;
  }
  const params = new URLSearchParams({ client_id: process.env.INSTAGRAM_APP_ID || '', redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(','), state });
  return `${oauthUrl()}?${params.toString()}`;
}

// Facebook Login for Business: código -> token curto -> token longo de usuário -> Página com conta do Instagram.
async function exchangeFacebookCode({ code, redirectUri }) {
  const graph = fbGraphUrl();
  const clientId = process.env.INSTAGRAM_APP_ID || '';
  const secret = appSecret();
  const shortData = await call({ method: 'get', url: `${graph}/oauth/access_token`, params: { client_id: clientId, client_secret: secret, redirect_uri: redirectUri, code } });
  const shortToken = shortData?.access_token;
  if (!shortToken) throw new ProviderError('Resposta de token inválida do Instagram.', { kind: 'bad_request', providerCode: 'invalid_token_response' });
  let userToken = shortToken;
  try {
    const longData = await call({ method: 'get', url: `${graph}/oauth/access_token`, params: { grant_type: 'fb_exchange_token', client_id: clientId, client_secret: secret, fb_exchange_token: shortToken } });
    if (longData?.access_token) userToken = longData.access_token;
  } catch (error) { if (error.kind !== 'bad_request') throw error; } // sem troca: segue com o token curto
  const me = await call({ method: 'get', url: `${graph}/me`, params: { fields: 'id', access_token: userToken } });
  if (!me?.id) throw new ProviderError('Resposta de token inválida do Instagram.', { kind: 'bad_request', providerCode: 'invalid_token_response' });
  const accounts = await call({ method: 'get', url: `${graph}/me/accounts`, params: { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: 100, access_token: userToken } });
  const page = (Array.isArray(accounts?.data) ? accounts.data : []).find(item => item?.instagram_business_account?.id && item?.access_token);
  if (!page) throw new ProviderError('Nenhuma conta profissional do Instagram ligada a uma Página do Facebook foi autorizada.', { kind: 'bad_request', providerCode: 'no_instagram_business_account' });
  let permissions = [];
  try {
    const perms = await call({ method: 'get', url: `${graph}/me/permissions`, params: { access_token: userToken } });
    permissions = (Array.isArray(perms?.data) ? perms.data : []).filter(item => item?.status === 'granted').map(item => item.permission).filter(Boolean);
  } catch { permissions = []; }
  return { accessToken: `fb:${page.instagram_business_account.id}:${page.access_token}`, appUserId: String(me.id), permissions };
}

// code -> token curto -> token longo (~60 dias).
async function exchangeCode({ code, redirectUri }) {
  if (loginMode() === 'facebook') return exchangeFacebookCode({ code, redirectUri });
  const form = new URLSearchParams({ client_id: process.env.INSTAGRAM_APP_ID || '', client_secret: appSecret(), grant_type: 'authorization_code', redirect_uri: redirectUri, code });
  const data = await call({ method: 'post', url: `${apiUrl()}/oauth/access_token`, data: form.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const item = Array.isArray(data?.data) ? data.data[0] : data;
  if (!item?.access_token) throw new ProviderError('Resposta de token inválida do Instagram.', { kind: 'bad_request', providerCode: 'invalid_token_response' });
  const permissions = Array.isArray(item.permissions) ? item.permissions : String(item.permissions || '').split(',').filter(Boolean);
  return { accessToken: item.access_token, appUserId: item.user_id !== undefined ? String(item.user_id) : null, permissions };
}

async function longLivedToken(shortToken) {
  if (isFbToken(shortToken)) return { accessToken: shortToken, expiresIn: FB_LONG_TTL_SEC }; // já é longo: sem rede
  const data = await call({ method: 'get', url: `${graphRoot()}/access_token`, params: { grant_type: 'ig_exchange_token', client_secret: appSecret(), access_token: shortToken } });
  if (!data?.access_token) throw new ProviderError('Resposta de token inválida do Instagram.', { kind: 'bad_request', providerCode: 'invalid_token_response' });
  return { accessToken: data.access_token, expiresIn: Number(data.expires_in) || 60 * 24 * 3600 };
}

// Renova token longo (exige ≥ 24 h de idade e ainda válido).
async function refreshToken(token) {
  if (isFbToken(token)) return { accessToken: token, expiresIn: FB_LONG_TTL_SEC }; // sem rede (ver FB_LONG_TTL_SEC)
  const data = await call({ method: 'get', url: `${graphRoot()}/refresh_access_token`, params: { grant_type: 'ig_refresh_token', access_token: token } });
  if (!data?.access_token) throw new ProviderError('Resposta de token inválida do Instagram.', { kind: 'bad_request', providerCode: 'invalid_token_response' });
  return { accessToken: data.access_token, expiresIn: Number(data.expires_in) || 60 * 24 * 3600 };
}

async function profile(token) {
  const p = parseToken(token);
  const data = await call({ method: 'get', url: nodeOf(p), params: { fields: p.fb ? FB_PROFILE_FIELDS : PROFILE_FIELDS, access_token: p.accessToken } });
  return p.fb ? { ...data, user_id: String(data?.id || p.igId), account_type: 'BUSINESS' } : data;
}

// Uma página de mídia (paginação por cursor "after").
async function mediaPage(token, { limit = 25, after = null } = {}) {
  const p = parseToken(token);
  const params = { fields: MEDIA_FIELDS, limit, access_token: p.accessToken };
  if (after) params.after = after;
  const data = await call({ method: 'get', url: `${nodeOf(p)}/media`, params });
  return { items: Array.isArray(data?.data) ? data.data : [], after: data?.paging?.next ? data?.paging?.cursors?.after || null : null };
}

// Métricas por tipo (impressions foi descontinuada; álbum filho não tem insights).
function mediaMetrics(productType) {
  if (productType === 'STORY') return ['reach', 'views', 'shares', 'total_interactions'];
  return ['reach', 'views', 'saved', 'shares', 'likes', 'comments', 'total_interactions'];
}

function insightValues(data) {
  const out = {};
  for (const item of Array.isArray(data?.data) ? data.data : []) {
    const value = item?.total_value?.value ?? item?.values?.[0]?.value;
    if (item?.name && Number.isFinite(Number(value))) out[item.name] = Number(value);
  }
  return out;
}

// Se a chamada conjunta for recusada (métrica não suportada para o tipo), tenta uma a uma.
async function mediaInsights(token, mediaId, productType) {
  const p = parseToken(token);
  const metrics = mediaMetrics(productType);
  const url = `${p.fb ? fbGraphUrl() : graphUrl()}/${encodeURIComponent(mediaId)}/insights`;
  try {
    return insightValues(await call({ method: 'get', url, params: { metric: metrics.join(','), access_token: p.accessToken } }));
  } catch (error) {
    if (error.kind !== 'bad_request') throw error;
    const out = {};
    for (const metric of metrics) {
      try { Object.assign(out, insightValues(await call({ method: 'get', url, params: { metric, access_token: p.accessToken } }))); } catch (inner) { if (inner.kind !== 'bad_request') throw inner; }
    }
    return out;
  }
}

const ACCOUNT_METRICS = ['reach', 'views', 'accounts_engaged', 'total_interactions', 'profile_links_taps'];
// Totais do período (period=day + metric_type=total_value; since/until em UNIX, janela ≤ 30 dias).
async function accountInsights(token, { since, until }) {
  const p = parseToken(token);
  const url = `${nodeOf(p)}/insights`;
  const params = { metric: ACCOUNT_METRICS.join(','), period: 'day', metric_type: 'total_value', since, until, access_token: p.accessToken };
  try {
    return insightValues(await call({ method: 'get', url, params }));
  } catch (error) {
    if (error.kind !== 'bad_request') throw error;
    const out = {};
    for (const metric of ACCOUNT_METRICS) {
      try { Object.assign(out, insightValues(await call({ method: 'get', url, params: { ...params, metric } }))); } catch (inner) { if (inner.kind !== 'bad_request') throw inner; }
    }
    return out;
  }
}

module.exports = { configured, authorizeUrl, exchangeCode, longLivedToken, refreshToken, profile, mediaPage, mediaInsights, accountInsights, mediaMetrics, normalize, SCOPES, FB_SCOPES, activeScopes, parseToken, loginMode, ACCOUNT_METRICS };
