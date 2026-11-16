const axios = require('axios');
const { ProviderError } = require('../integrations/providerError');

// Cliente da Instagram API with Instagram Login (graph.instagram.com). Bases configuráveis por env:
// os testes apontam para um stub HTTP local. NENHUMA chamada real foi exercitada neste repositório.
// Tokens só trafegam na requisição; erros são normalizados sem URL/query (que contém o token).
const env = (name, fallback) => (process.env[name] || fallback).replace(/\/+$/, '');
const oauthUrl = () => env('INSTAGRAM_OAUTH_URL', 'https://www.instagram.com/oauth/authorize');
const apiUrl = () => env('INSTAGRAM_API_URL', 'https://api.instagram.com');
const graphRoot = () => env('INSTAGRAM_GRAPH_URL', 'https://graph.instagram.com');
const graphUrl = () => `${graphRoot()}/${process.env.INSTAGRAM_GRAPH_VERSION || 'v27.0'}`;
const TIMEOUT = () => Number(process.env.INSTAGRAM_HTTP_TIMEOUT_MS) || 10000;

const SCOPES = ['instagram_business_basic', 'instagram_business_manage_insights'];
const PROFILE_FIELDS = 'user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count';
const MEDIA_FIELDS = 'id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count';

function configured() {
  return !!(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET);
}

function appSecret() {
  const secret = process.env.INSTAGRAM_APP_SECRET;
  if (!secret) throw new ProviderError('Instagram não configurado.', { kind: 'bad_request', providerCode: 'not_configured' });
  return secret;
}

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
  const params = new URLSearchParams({ client_id: process.env.INSTAGRAM_APP_ID || '', redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(','), state });
  return `${oauthUrl()}?${params.toString()}`;
}

// code -> token curto -> token longo (~60 dias).
async function exchangeCode({ code, redirectUri }) {
  const form = new URLSearchParams({ client_id: process.env.INSTAGRAM_APP_ID || '', client_secret: appSecret(), grant_type: 'authorization_code', redirect_uri: redirectUri, code });
  const data = await call({ method: 'post', url: `${apiUrl()}/oauth/access_token`, data: form.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const item = Array.isArray(data?.data) ? data.data[0] : data;
  if (!item?.access_token) throw new ProviderError('Resposta de token inválida do Instagram.', { kind: 'bad_request', providerCode: 'invalid_token_response' });
  const permissions = Array.isArray(item.permissions) ? item.permissions : String(item.permissions || '').split(',').filter(Boolean);
  return { accessToken: item.access_token, appUserId: item.user_id !== undefined ? String(item.user_id) : null, permissions };
}

async function longLivedToken(shortToken) {
  const data = await call({ method: 'get', url: `${graphRoot()}/access_token`, params: { grant_type: 'ig_exchange_token', client_secret: appSecret(), access_token: shortToken } });
  if (!data?.access_token) throw new ProviderError('Resposta de token inválida do Instagram.', { kind: 'bad_request', providerCode: 'invalid_token_response' });
  return { accessToken: data.access_token, expiresIn: Number(data.expires_in) || 60 * 24 * 3600 };
}

// Renova token longo (exige ≥ 24 h de idade e ainda válido).
async function refreshToken(token) {
  const data = await call({ method: 'get', url: `${graphRoot()}/refresh_access_token`, params: { grant_type: 'ig_refresh_token', access_token: token } });
  if (!data?.access_token) throw new ProviderError('Resposta de token inválida do Instagram.', { kind: 'bad_request', providerCode: 'invalid_token_response' });
  return { accessToken: data.access_token, expiresIn: Number(data.expires_in) || 60 * 24 * 3600 };
}

async function profile(token) {
  return call({ method: 'get', url: `${graphUrl()}/me`, params: { fields: PROFILE_FIELDS, access_token: token } });
}

// Uma página de mídia (paginação por cursor "after").
async function mediaPage(token, { limit = 25, after = null } = {}) {
  const params = { fields: MEDIA_FIELDS, limit, access_token: token };
  if (after) params.after = after;
  const data = await call({ method: 'get', url: `${graphUrl()}/me/media`, params });
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
  const metrics = mediaMetrics(productType);
  const url = `${graphUrl()}/${encodeURIComponent(mediaId)}/insights`;
  try {
    return insightValues(await call({ method: 'get', url, params: { metric: metrics.join(','), access_token: token } }));
  } catch (error) {
    if (error.kind !== 'bad_request') throw error;
    const out = {};
    for (const metric of metrics) {
      try { Object.assign(out, insightValues(await call({ method: 'get', url, params: { metric, access_token: token } }))); } catch (inner) { if (inner.kind !== 'bad_request') throw inner; }
    }
    return out;
  }
}

const ACCOUNT_METRICS = ['reach', 'views', 'accounts_engaged', 'total_interactions', 'profile_links_taps'];
// Totais do período (period=day + metric_type=total_value; since/until em UNIX, janela ≤ 30 dias).
async function accountInsights(token, { since, until }) {
  const params = { metric: ACCOUNT_METRICS.join(','), period: 'day', metric_type: 'total_value', since, until, access_token: token };
  try {
    return insightValues(await call({ method: 'get', url: `${graphUrl()}/me/insights`, params }));
  } catch (error) {
    if (error.kind !== 'bad_request') throw error;
    const out = {};
    for (const metric of ACCOUNT_METRICS) {
      try { Object.assign(out, insightValues(await call({ method: 'get', url: `${graphUrl()}/me/insights`, params: { ...params, metric } }))); } catch (inner) { if (inner.kind !== 'bad_request') throw inner; }
    }
    return out;
  }
}

module.exports = { configured, authorizeUrl, exchangeCode, longLivedToken, refreshToken, profile, mediaPage, mediaInsights, accountInsights, mediaMetrics, normalize, SCOPES, ACCOUNT_METRICS };
