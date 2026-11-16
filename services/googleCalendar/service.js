const crypto = require('node:crypto');
const functions = require('../../utils/functions');
const { encrypt, decrypt, randomToken } = require('../../utils/crypto');
const { resolveTimezone } = require('../../utils/time');
const oauthState = require('../integrations/oauthState');
const provider = require('./provider');

// Google Agenda (F6, Premium "google_calendar"): conexão OAuth2 + PKCE por empresa, calendários
// vinculados (push/busy) e utilitários comuns. A sincronização (jobs) está em ./sync.
const PROVIDER = 'google_calendar';
const REDIRECT_ENV = 'GOOGLE_CALENDAR_REDIRECT_URIS';
const FEATURE = 'google_calendar';
const APP_CALENDAR_SUMMARY = 'AgendasPRO';
const q = (sql, params = []) => functions.executeSql(sql, params);
const { codedError } = oauthState;
const iso = value => (value ? new Date(value).toISOString() : null);
const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');

function configured() {
  return provider.configured() && oauthState.allowedRedirects(REDIRECT_ENV).length > 0;
}

function assertConfigured() {
  if (!configured()) throw codedError(503, 'integration_not_configured', 'Integração com o Google Agenda não configurada no servidor.');
}

async function accountOf(companyId) {
  const [row] = await q('SELECT * FROM google_calendar_accounts WHERE company_id = ?', [companyId]);
  return row || null;
}

async function requireAccount(companyId) {
  const row = await accountOf(companyId);
  if (!row) throw codedError(404, 'integration_not_connected', 'Google Agenda não conectado.');
  return row;
}

async function companyTimezone(companyId) {
  const [row] = await q('SELECT timezone FROM companies WHERE id = ?', [companyId]);
  return resolveTimezone(row?.timezone);
}

function linkView(row) {
  return {
    id: row.id, role: row.role, professional_id: row.professional_id, calendar_id: row.calendar_id, calendar_summary: row.calendar_summary,
    created_by_app: !!row.created_by_app, last_sync_at: iso(row.last_sync_at), last_full_sync_at: iso(row.last_full_sync_at),
    push_channel_active: !!(row.channel_id && row.channel_expires_at && new Date(row.channel_expires_at) > new Date()),
  };
}

async function listLinks(companyId) {
  const rows = await q('SELECT * FROM google_calendar_links WHERE company_id = ? ORDER BY role, pro_key, id', [companyId]);
  return rows.map(linkView);
}

async function status(companyId) {
  const row = await accountOf(companyId);
  return {
    configured: configured(),
    connected: !!row,
    account: row ? {
      email: row.account_email, status: row.status, scopes: row.scopes ? row.scopes.split(' ') : [],
      connected_at: iso(row.connected_at), last_push_at: iso(row.last_push_at), last_error_code: row.last_error_code,
    } : null,
    links: row ? await listLinks(companyId) : [],
  };
}

async function startConnect({ companyId, userId, redirectUri }) {
  assertConfigured();
  const uri = oauthState.resolveRedirectUri(REDIRECT_ENV, redirectUri);
  const { verifier, challenge } = oauthState.pkcePair();
  const state = await oauthState.issue({ provider: PROVIDER, companyId, userId, redirectUri: uri, codeVerifier: verifier });
  return { authorize_url: provider.authorizeUrl({ redirectUri: uri, state, codeChallenge: challenge }), state, redirect_uri: uri, expires_in: oauthState.TTL_SEC, scopes: provider.scopes() };
}

function oauthFailure(error, providerCode) {
  if (error?.code && error.status) return error;
  return codedError(502, 'google_calendar_oauth_failed', 'Não foi possível concluir a conexão com o Google Agenda. Tente novamente.', { provider_code: providerCode || error?.providerCode || null });
}

// Remove tudo o que veio/foi para o Google (local): bloqueios importados, mapeamentos e vínculos.
async function purgeLocal(companyId) {
  await q("DELETE FROM time_blocks WHERE company_id = ? AND source = 'google'", [companyId]);
  await q('DELETE FROM google_calendar_events WHERE company_id = ?', [companyId]);
  await q('DELETE FROM google_calendar_links WHERE company_id = ?', [companyId]);
}

async function completeConnect({ companyId, userId, code, state }) {
  assertConfigured();
  const { redirectUri, codeVerifier } = await oauthState.consume(state, { provider: PROVIDER, companyId, userId });
  let tokens;
  try {
    tokens = await provider.exchangeCode({ code, redirectUri, codeVerifier });
  } catch (error) {
    throw oauthFailure(error);
  }
  const existing = await accountOf(companyId);
  const email = provider.emailFromIdToken(tokens.idToken);
  // Sem refresh token (o Google só devolve no primeiro consentimento ou com prompt=consent): reaproveita
  // o anterior se for a mesma conta; senão a conexão não serve para sincronização em segundo plano.
  const sameAccount = existing && (!email || !existing.account_email || existing.account_email === email);
  const refreshEnc = tokens.refreshToken ? encrypt(tokens.refreshToken) : (sameAccount ? existing.refresh_token_enc : null);
  if (!refreshEnc) throw oauthFailure(null, 'no_refresh_token');
  if (existing && !sameAccount) await purgeLocal(companyId); // trocou de conta Google: vínculos antigos não valem
  await q(
    `INSERT INTO google_calendar_accounts (company_id, account_email, refresh_token_enc, access_token_enc, access_expires_at, scopes, status, last_error_code, connected_by_user_id, connected_at)
     VALUES (?, ?, ?, ?, NOW() + INTERVAL ? SECOND, ?, 'active', NULL, ?, NOW())
     ON DUPLICATE KEY UPDATE account_email = VALUES(account_email), refresh_token_enc = VALUES(refresh_token_enc), access_token_enc = VALUES(access_token_enc),
       access_expires_at = VALUES(access_expires_at), scopes = VALUES(scopes), status = 'active', last_error_code = NULL,
       connected_by_user_id = VALUES(connected_by_user_id), connected_at = NOW()`,
    [companyId, email, refreshEnc, encrypt(tokens.accessToken), Math.max(60, tokens.expiresIn - 60), tokens.scopes.join(' ').slice(0, 500) || null, userId],
  );
  // Calendário padrão do app (push). Falha aqui não desfaz a conexão: o painel pode vincular depois.
  const account = await accountOf(companyId);
  const [push] = await q("SELECT id FROM google_calendar_links WHERE company_id = ? AND role = 'push' AND pro_key = 0", [companyId]);
  if (!push) {
    try {
      await createAppCalendarLink(account, { professionalId: null });
    } catch (error) {
      if (!error.kind) throw error;
      await q('UPDATE google_calendar_accounts SET last_error_code = ? WHERE id = ?', [`create_calendar:${error.providerCode || error.kind}`.slice(0, 60), account.id]);
    }
  }
  await require('./sync').enqueuePush(companyId, { soon: true });
  return status(companyId);
}

// Access token válido (renova com o refresh token). invalid_grant -> reauth_required (sem retry).
async function accessToken(account) {
  if (account.status === 'reauth_required') throw codedError(409, 'google_calendar_reauth_required', 'A conexão com o Google Agenda expirou. Conecte novamente.');
  if (account.access_token_enc && account.access_expires_at && new Date(account.access_expires_at).getTime() > Date.now() + 60000) {
    return decrypt(account.access_token_enc);
  }
  try {
    const tokens = await provider.refreshAccessToken(decrypt(account.refresh_token_enc));
    await q(
      `UPDATE google_calendar_accounts SET access_token_enc = ?, access_expires_at = NOW() + INTERVAL ? SECOND,
         refresh_token_enc = COALESCE(?, refresh_token_enc), last_error_code = NULL WHERE id = ?`,
      [encrypt(tokens.accessToken), Math.max(60, tokens.expiresIn - 60), tokens.refreshToken ? encrypt(tokens.refreshToken) : null, account.id],
    );
    return tokens.accessToken;
  } catch (error) {
    throw await mapProviderError(account, error);
  }
}

async function markReauth(account, providerCode) {
  await q("UPDATE google_calendar_accounts SET status = 'reauth_required', access_token_enc = NULL, last_error_code = ? WHERE id = ?", [String(providerCode || 'auth').slice(0, 60), account.id]);
}

// Erro do provedor -> erro HTTP do painel (e marca reauth quando é o caso).
async function mapProviderError(account, error) {
  if (!error?.kind) return error;
  if (error.kind === 'auth') {
    await markReauth(account, error.providerCode);
    return Object.assign(codedError(409, 'google_calendar_reauth_required', 'A conexão com o Google Agenda expirou. Conecte novamente.'), { kind: 'auth' });
  }
  if (error.kind === 'rate_limit') return Object.assign(codedError(429, 'google_calendar_rate_limited', 'Limite de uso da API do Google atingido. Tente mais tarde.'), { kind: 'rate_limit', retryable: true });
  if (error.kind === 'not_found') return Object.assign(codedError(404, 'calendar_not_found', 'Calendário não encontrado na conta Google conectada.'), { kind: 'not_found' });
  return Object.assign(codedError(502, 'google_calendar_unavailable', 'API do Google Agenda indisponível no momento.', { provider_code: error.providerCode || null }), { kind: error.kind, retryable: !!error.retryable });
}

// Executa fn(token) com a conta da empresa; erros já mapeados para o painel.
async function withAccount(companyId, fn) {
  const account = await requireAccount(companyId);
  const token = await accessToken(account);
  try {
    return await fn(token, account);
  } catch (error) {
    throw await mapProviderError(account, error);
  }
}

async function calendars(companyId) {
  return withAccount(companyId, token => provider.listCalendars(token));
}

async function createAppCalendarLink(account, { professionalId }) {
  const token = await accessToken(account);
  let name = APP_CALENDAR_SUMMARY;
  if (professionalId) {
    const [pro] = await q('SELECT name FROM professionals WHERE id = ? AND company_id = ?', [professionalId, account.company_id]);
    name = `${APP_CALENDAR_SUMMARY} · ${pro?.name || professionalId}`.slice(0, 200);
  }
  const cal = await provider.createCalendar(token, { summary: name, timeZone: await companyTimezone(account.company_id) });
  const result = await q(
    `INSERT INTO google_calendar_links (company_id, account_id, role, professional_id, calendar_id, calendar_summary, created_by_app) VALUES (?, ?, 'push', ?, ?, ?, 1)`,
    [account.company_id, account.id, professionalId || null, cal.id, cal.summary],
  );
  return result.insertId;
}

async function assertProfessional(companyId, professionalId) {
  if (!professionalId) return;
  const [pro] = await q('SELECT id FROM professionals WHERE id = ? AND company_id = ?', [professionalId, companyId]);
  if (!pro) throw codedError(404, 'professional_not_found', 'Profissional não encontrado.');
}

// Vincula calendário. push: um por profissional (ou o padrão da empresa); create_app_calendar cria um
// calendário secundário do app. busy: calendário da conta cujos eventos ocupados bloqueiam horários.
async function addLink(companyId, { role, calendar_id: calendarId, professional_id: professionalId = null, create_app_calendar: createApp = false }) {
  const account = await requireAccount(companyId);
  await assertProfessional(companyId, professionalId);
  const proKey = professionalId || 0;
  const existing = await q('SELECT id, role, pro_key, calendar_id FROM google_calendar_links WHERE company_id = ?', [companyId]);
  if (role === 'push') {
    if (existing.some(l => l.role === 'push' && Number(l.pro_key) === Number(proKey))) {
      throw codedError(409, 'calendar_link_conflict', 'Já existe um calendário de destino para este profissional. Remova-o antes.');
    }
  }
  let linkId;
  if (role === 'push' && createApp) {
    try {
      linkId = await createAppCalendarLink(account, { professionalId });
    } catch (error) {
      throw await mapProviderError(account, error);
    }
  } else {
    // Anti-eco: o mesmo calendário não pode ser destino (push) e origem de bloqueios (busy).
    if (existing.some(l => l.calendar_id === calendarId && l.role !== role)) {
      throw codedError(409, 'calendar_link_conflict', 'Este calendário já é usado no outro sentido da sincronização.');
    }
    if (existing.some(l => l.calendar_id === calendarId && l.role === role && Number(l.pro_key) === Number(proKey))) {
      throw codedError(409, 'calendar_link_conflict', 'Calendário já vinculado.');
    }
    const list = await withAccount(companyId, token => provider.listCalendars(token));
    const cal = list.find(c => c.id === calendarId);
    if (!cal) throw codedError(404, 'calendar_not_found', 'Calendário não encontrado na conta Google conectada.');
    if (role === 'push' && !['owner', 'writer'].includes(cal.access_role)) {
      throw codedError(409, 'calendar_link_conflict', 'Sem permissão de escrita neste calendário. Use o calendário criado pelo AgendasPRO.');
    }
    const result = await q(
      'INSERT INTO google_calendar_links (company_id, account_id, role, professional_id, calendar_id, calendar_summary, created_by_app) VALUES (?, ?, ?, ?, ?, ?, 0)',
      [companyId, account.id, role, professionalId || null, calendarId, String(cal.summary || '').slice(0, 255) || null],
    );
    linkId = result.insertId;
  }
  const sync = require('./sync');
  if (role === 'push') await sync.enqueuePush(companyId, { soon: true });
  else await sync.enqueuePull(linkId, { soon: true });
  const [row] = await q('SELECT * FROM google_calendar_links WHERE id = ?', [linkId]);
  return linkView(row);
}

async function stopLinkChannel(account, link) {
  if (!link.channel_id || !link.channel_resource_id) return;
  try {
    const token = await accessToken(account);
    await provider.stopChannel(token, { id: link.channel_id, resourceId: link.channel_resource_id });
  } catch {
    // best-effort: o canal expira sozinho (TTL) e notificações de canal desconhecido são ignoradas
  }
}

// Desvincula. busy: para o canal e apaga os bloqueios importados dele. push: os eventos já exportados
// ficam no Google; se ainda houver outro destino, a próxima reconciliação os move para ele; se era o
// último destino, a exportação para (mapeamentos apagados, eventos ficam no calendário).
async function removeLink(companyId, linkId) {
  const [link] = await q('SELECT * FROM google_calendar_links WHERE id = ? AND company_id = ?', [linkId, companyId]);
  if (!link) throw codedError(404, 'calendar_link_not_found', 'Vínculo não encontrado.');
  const account = await accountOf(companyId);
  if (link.role === 'busy') {
    if (account) await stopLinkChannel(account, link);
    await q("DELETE FROM time_blocks WHERE company_id = ? AND source = 'google' AND link_id = ?", [companyId, link.id]);
  }
  await q('DELETE FROM google_calendar_links WHERE id = ? AND company_id = ?', [link.id, companyId]);
  if (link.role === 'push') {
    const [{ n }] = await q("SELECT COUNT(*) AS n FROM google_calendar_links WHERE company_id = ? AND role = 'push'", [companyId]);
    if (Number(n) === 0) await q('DELETE FROM google_calendar_events WHERE company_id = ?', [companyId]);
    else await require('./sync').enqueuePush(companyId, { soon: true });
  }
  return { deleted: true };
}

// Desconectar (LGPD): para canais, opcionalmente apaga os calendários criados pelo app, revoga o
// token no Google (best-effort) e apaga conta, vínculos, mapeamentos e bloqueios importados.
// Sem remove_app_calendars, os eventos exportados ficam na conta Google do usuário (dado dele).
async function disconnect(companyId, { remove_app_calendars: removeCalendars = false } = {}) {
  const account = await accountOf(companyId);
  const result = { disconnected: !!account, revoked: false, removed_calendars: 0 };
  if (account) {
    const links = await q('SELECT * FROM google_calendar_links WHERE company_id = ?', [companyId]);
    for (const link of links) if (link.role === 'busy') await stopLinkChannel(account, link);
    if (account.status === 'active') {
      try {
        const token = await accessToken(account);
        if (removeCalendars) {
          for (const link of links.filter(l => l.role === 'push' && l.created_by_app)) {
            try { await provider.deleteCalendar(token, link.calendar_id); result.removed_calendars++; } catch { /* best-effort */ }
          }
        }
      } catch { /* sem token válido: segue apagando localmente */ }
    }
    try {
      await provider.revoke(decrypt(account.refresh_token_enc));
      result.revoked = true;
    } catch { /* best-effort: o usuário pode revogar em myaccount.google.com/permissions */ }
  }
  await purgeLocal(companyId);
  await q('DELETE FROM google_calendar_accounts WHERE company_id = ?', [companyId]);
  await q('DELETE FROM oauth_states WHERE company_id = ? AND provider = ?', [companyId, PROVIDER]);
  return result;
}

module.exports = {
  PROVIDER, FEATURE, configured, status, startConnect, completeConnect, disconnect, calendars, listLinks, addLink, removeLink,
  accountOf, accessToken, mapProviderError, markReauth, companyTimezone, sha256, randomToken, linkView,
};
