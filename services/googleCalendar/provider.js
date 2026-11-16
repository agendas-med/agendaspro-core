const axios = require('axios');
const { ProviderError } = require('../integrations/providerError');

// Cliente OAuth2 + Calendar API v3 do Google. Bases configuráveis por env: os testes apontam para um
// stub HTTP local. NENHUMA chamada real ao Google foi exercitada neste repositório.
// Tokens só trafegam em headers/corpo; erros são normalizados sem URL, query ou corpo bruto.
const env = (name, fallback) => (process.env[name] || fallback).replace(/\/+$/, '');
const authUrl = () => env('GOOGLE_OAUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth');
const tokenUrl = () => env('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token');
const revokeUrl = () => env('GOOGLE_REVOKE_URL', 'https://oauth2.googleapis.com/revoke');
const apiUrl = () => env('GOOGLE_CALENDAR_API_URL', 'https://www.googleapis.com/calendar/v3');
const TIMEOUT = () => Number(process.env.GOOGLE_CALENDAR_HTTP_TIMEOUT_MS) || 10000;

// Escopos mínimos: criar/gerir só o calendário secundário do app e seus eventos; ler livre/ocupado
// (eventos) dos calendários escolhidos como "ocupado"; listar calendários para o usuário escolher.
const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/calendar.app.created',
  'https://www.googleapis.com/auth/calendar.events.freebusy',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'openid',
  'email',
];
const scopes = () => (process.env.GOOGLE_CALENDAR_SCOPES ? process.env.GOOGLE_CALENDAR_SCOPES.split(/[\s,]+/).filter(Boolean) : DEFAULT_SCOPES);

function configured() {
  return !!(process.env.GOOGLE_CALENDAR_CLIENT_ID && process.env.GOOGLE_CALENDAR_CLIENT_SECRET);
}

function credentials() {
  if (!configured()) throw new ProviderError('Google Agenda não configurado.', { kind: 'bad_request', providerCode: 'not_configured' });
  return { client_id: process.env.GOOGLE_CALENDAR_CLIENT_ID, client_secret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET };
}

// OAuth: invalid_grant (refresh revogado/expirado) = reautenticar. API: 401 = token inválido;
// 403/429 com rateLimitExceeded/userRateLimitExceeded = limite; 410 = syncToken expirado (full resync).
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);
function normalize(error) {
  if (error instanceof ProviderError) return error;
  const status = error?.response?.status || null;
  const data = error?.response?.data || {};
  const oauthCode = typeof data.error === 'string' ? data.error : null;
  const reason = data?.error?.errors?.[0]?.reason || data?.error?.status || null;
  const providerCode = oauthCode || (typeof reason === 'string' ? reason : null);
  if (oauthCode === 'invalid_grant' || oauthCode === 'unauthorized_client' || status === 401) {
    return new ProviderError('Autorização do Google inválida ou revogada.', { kind: 'auth', providerCode, httpStatus: status });
  }
  if (status === 429 || (status === 403 && RATE_REASONS.has(reason))) {
    const retryAfter = Number(error?.response?.headers?.['retry-after']) || null;
    return new ProviderError('Limite de uso da API do Google atingido.', { kind: 'rate_limit', providerCode, httpStatus: status, retryAfterSec: retryAfter });
  }
  if (!status || status >= 500) return new ProviderError('API do Google indisponível.', { kind: 'unavailable', providerCode, httpStatus: status });
  if (status === 410) return new ProviderError('Token de sincronização expirado.', { kind: 'gone', providerCode, httpStatus: status });
  if (status === 404) return new ProviderError('Recurso não encontrado no Google.', { kind: 'not_found', providerCode, httpStatus: status });
  if (status === 409) return new ProviderError('Recurso já existe no Google.', { kind: 'conflict', providerCode, httpStatus: status });
  return new ProviderError('Requisição recusada pela API do Google.', { kind: 'bad_request', providerCode, httpStatus: status });
}

async function call(config) {
  try {
    const response = await axios({ timeout: TIMEOUT(), ...config });
    return response.data;
  } catch (error) {
    throw normalize(error);
  }
}

const form = body => ({ data: new URLSearchParams(body).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
const bearer = token => ({ Authorization: `Bearer ${token}` });
const enc = encodeURIComponent;

function authorizeUrl({ redirectUri, state, codeChallenge }) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CALENDAR_CLIENT_ID || '', redirect_uri: redirectUri, response_type: 'code', scope: scopes().join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state, code_challenge: codeChallenge, code_challenge_method: 'S256',
  });
  return `${authUrl()}?${params.toString()}`;
}

function tokenResult(data) {
  if (!data?.access_token) throw new ProviderError('Resposta de token inválida do Google.', { kind: 'bad_request', providerCode: 'invalid_token_response' });
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresIn: Number(data.expires_in) || 3600,
    scopes: String(data.scope || '').split(' ').filter(Boolean),
    idToken: data.id_token || null,
  };
}

async function exchangeCode({ code, redirectUri, codeVerifier }) {
  const data = await call({ method: 'post', url: tokenUrl(), ...form({ ...credentials(), grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier }) });
  return tokenResult(data);
}

async function refreshAccessToken(refreshToken) {
  const data = await call({ method: 'post', url: tokenUrl(), ...form({ ...credentials(), grant_type: 'refresh_token', refresh_token: refreshToken }) });
  return tokenResult(data);
}

// Revogação best-effort (desconectar). Falha não impede apagar os dados locais.
async function revoke(token) {
  await call({ method: 'post', url: revokeUrl(), ...form({ token }) });
}

// E-mail da conta a partir do id_token recebido direto do endpoint de token (canal TLS com o Google;
// sem verificação de assinatura porque não é usado para autenticação, só para exibir a conta).
function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email.slice(0, 255) : null;
  } catch {
    return null;
  }
}

async function listCalendars(token) {
  const items = [];
  let pageToken;
  for (let page = 0; page < 10; page++) {
    const data = await call({ method: 'get', url: `${apiUrl()}/users/me/calendarList`, headers: bearer(token), params: { maxResults: 250, pageToken } });
    items.push(...(data?.items || []));
    pageToken = data?.nextPageToken;
    if (!pageToken) break;
  }
  return items.map(c => ({ id: c.id, summary: c.summaryOverride || c.summary || c.id, primary: !!c.primary, access_role: c.accessRole || null, time_zone: c.timeZone || null }));
}

async function createCalendar(token, { summary, timeZone }) {
  const data = await call({ method: 'post', url: `${apiUrl()}/calendars`, headers: bearer(token), data: { summary, timeZone } });
  return { id: data.id, summary: data.summary || summary };
}

async function deleteCalendar(token, calendarId) {
  try {
    await call({ method: 'delete', url: `${apiUrl()}/calendars/${enc(calendarId)}`, headers: bearer(token) });
  } catch (error) {
    if (error.kind === 'not_found' || error.kind === 'gone') return;
    throw error;
  }
}

async function insertEvent(token, calendarId, event) {
  return call({ method: 'post', url: `${apiUrl()}/calendars/${enc(calendarId)}/events`, headers: bearer(token), params: { sendUpdates: 'none' }, data: event });
}

async function updateEvent(token, calendarId, eventId, event) {
  return call({ method: 'put', url: `${apiUrl()}/calendars/${enc(calendarId)}/events/${enc(eventId)}`, headers: bearer(token), params: { sendUpdates: 'none' }, data: event });
}

async function deleteEvent(token, calendarId, eventId) {
  try {
    await call({ method: 'delete', url: `${apiUrl()}/calendars/${enc(calendarId)}/events/${enc(eventId)}`, headers: bearer(token), params: { sendUpdates: 'none' } });
  } catch (error) {
    if (error.kind === 'not_found' || error.kind === 'gone') return; // já não existe: idempotente
    throw error;
  }
}

// Uma página de events.list. Com syncToken não envia timeMin/orderBy (incompatíveis na API).
async function listEventsPage(token, calendarId, { syncToken, timeMin, pageToken }) {
  const params = { singleEvents: true, showDeleted: true, maxResults: 250, pageToken };
  if (syncToken) params.syncToken = syncToken;
  else params.timeMin = timeMin;
  const data = await call({ method: 'get', url: `${apiUrl()}/calendars/${enc(calendarId)}/events`, headers: bearer(token), params });
  return { items: data?.items || [], nextPageToken: data?.nextPageToken || null, nextSyncToken: data?.nextSyncToken || null };
}

async function watch(token, calendarId, { id, address, channelToken, ttlSec }) {
  const data = await call({
    method: 'post', url: `${apiUrl()}/calendars/${enc(calendarId)}/events/watch`, headers: bearer(token),
    data: { id, type: 'web_hook', address, token: channelToken, params: { ttl: String(ttlSec) } },
  });
  return { resourceId: data?.resourceId || null, expiration: data?.expiration ? new Date(Number(data.expiration)) : null };
}

async function stopChannel(token, { id, resourceId }) {
  try {
    await call({ method: 'post', url: `${apiUrl()}/channels/stop`, headers: bearer(token), data: { id, resourceId } });
  } catch (error) {
    if (error.kind === 'not_found') return;
    throw error;
  }
}

module.exports = {
  configured, scopes, normalize, authorizeUrl, exchangeCode, refreshAccessToken, revoke, emailFromIdToken,
  listCalendars, createCalendar, deleteCalendar, insertEvent, updateEvent, deleteEvent, listEventsPage, watch, stopChannel,
};
