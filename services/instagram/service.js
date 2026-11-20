const functions = require('../../utils/functions');
const { encrypt, decrypt } = require('../../utils/crypto');
const { wallClock, resolveTimezone } = require('../../utils/time');
const oauthState = require('../integrations/oauthState');
const provider = require('./provider');
const metrics = require('./metrics');

// Instagram (F6): conexão OAuth por empresa, cache em banco com TTL, insights e série diária.
// Estado derivado do tempo (cache vencido, token perto de expirar) é calculado na leitura; o tick
// horário só renova token e grava o snapshot do dia (Premium).
const PROVIDER = 'instagram';
const REDIRECT_ENV = 'INSTAGRAM_REDIRECT_URIS';
const q = (sql, params = []) => functions.executeSql(sql, params);
const { codedError } = oauthState;

const cacheTtlMin = () => Number(process.env.INSTAGRAM_CACHE_TTL_MIN) || 30;
const insightsTtlMin = () => Number(process.env.INSTAGRAM_INSIGHTS_TTL_MIN) || 360;
const maxPosts = () => Math.min(Number(process.env.INSTAGRAM_MAX_POSTS) || 50, 100);
const RATE_LIMIT_PAUSE_MIN = 15;

function configured() {
  return provider.configured() && oauthState.allowedRedirects(REDIRECT_ENV).length > 0;
}

function assertConfigured() {
  if (!configured()) throw codedError(503, 'integration_not_configured', 'Integração com o Instagram não configurada no servidor.');
}

async function accountOf(companyId) {
  const [row] = await q('SELECT * FROM instagram_accounts WHERE company_id = ?', [companyId]);
  return row || null;
}

const iso = value => (value ? new Date(value).toISOString() : null);
const fresh = (value, minutes) => !!value && Date.now() - new Date(value).getTime() < minutes * 60000;

// Visão pública da conta (nunca inclui token).
function accountView(row) {
  if (!row) return null;
  return {
    ig_user_id: row.ig_user_id, username: row.username, name: row.name, account_type: row.account_type,
    profile_picture_url: row.profile_picture_url, followers_count: row.followers_count, follows_count: row.follows_count, media_count: row.media_count,
    status: row.status, scopes: row.scopes ? row.scopes.split(',') : [], connected_at: iso(row.connected_at),
    token_expires_at: iso(row.token_expires_at), profile_synced_at: iso(row.profile_synced_at), media_synced_at: iso(row.media_synced_at),
    rate_limited_until: row.rate_limited_until && new Date(row.rate_limited_until) > new Date() ? iso(row.rate_limited_until) : null,
  };
}

async function status(companyId) {
  const row = await accountOf(companyId);
  return { configured: configured(), connected: !!row, account: accountView(row) };
}

async function startConnect({ companyId, userId, redirectUri }) {
  assertConfigured();
  const uri = oauthState.resolveRedirectUri(REDIRECT_ENV, redirectUri);
  const state = await oauthState.issue({ provider: PROVIDER, companyId, userId, redirectUri: uri });
  return { authorize_url: provider.authorizeUrl({ redirectUri: uri, state }), state, redirect_uri: uri, expires_in: oauthState.TTL_SEC, scopes: provider.activeScopes() };
}

function oauthFailure(error) {
  if (error?.code) return error;
  return codedError(502, 'instagram_oauth_failed', 'Não foi possível concluir a conexão com o Instagram. Tente novamente.', { provider_code: error?.providerCode || null });
}

async function completeConnect({ companyId, userId, code, state }) {
  assertConfigured();
  const { redirectUri } = await oauthState.consume(state, { provider: PROVIDER, companyId, userId });
  const cleanCode = String(code).replace(/#_$/, '');
  let short; let long; let me;
  try {
    short = await provider.exchangeCode({ code: cleanCode, redirectUri });
    long = await provider.longLivedToken(short.accessToken);
    me = await provider.profile(long.accessToken);
  } catch (error) {
    throw oauthFailure(error);
  }
  const igUserId = String(me?.user_id || me?.id || short.appUserId || '');
  if (!igUserId) throw oauthFailure(null);
  const expiresAt = new Date(Date.now() + long.expiresIn * 1000);
  const existing = await accountOf(companyId);
  if (existing && existing.ig_user_id !== igUserId) await purgeCache(companyId); // trocou de conta: não mistura séries
  await q(
    `INSERT INTO instagram_accounts (company_id, ig_user_id, app_user_id, username, name, account_type, profile_picture_url, followers_count, follows_count, media_count,
       access_token_enc, token_expires_at, token_refreshed_at, scopes, status, last_error_code, rate_limited_until, connected_by_user_id, connected_at, profile_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 'active', NULL, NULL, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE ig_user_id = VALUES(ig_user_id), app_user_id = VALUES(app_user_id), username = VALUES(username), name = VALUES(name),
       account_type = VALUES(account_type), profile_picture_url = VALUES(profile_picture_url), followers_count = VALUES(followers_count),
       follows_count = VALUES(follows_count), media_count = VALUES(media_count), access_token_enc = VALUES(access_token_enc),
       token_expires_at = VALUES(token_expires_at), token_refreshed_at = NOW(), scopes = VALUES(scopes), status = 'active', last_error_code = NULL,
       rate_limited_until = NULL, connected_by_user_id = VALUES(connected_by_user_id), connected_at = NOW(), profile_synced_at = NOW()`,
    [companyId, igUserId, short.appUserId, me.username || null, me.name || null, me.account_type || null, me.profile_picture_url || null,
      me.followers_count ?? null, me.follows_count ?? null, me.media_count ?? null, encrypt(long.accessToken), expiresAt,
      (short.permissions || []).join(',').slice(0, 500) || null, userId],
  );
  return status(companyId);
}

async function purgeCache(companyId) {
  await q('DELETE FROM instagram_media WHERE company_id = ?', [companyId]);
  await q('DELETE FROM instagram_snapshots WHERE company_id = ?', [companyId]);
}

// Desconectar = apagar token, perfil, posts e série. Links UTM e visitas (dados da própria empresa) ficam.
// A API with Instagram Login não tem endpoint de revogação documentado: o usuário remove o app em
// Configurações > Apps e sites do Instagram (o callback de desautorização limpa o que restar).
async function disconnect(companyId) {
  const result = await q('DELETE FROM instagram_accounts WHERE company_id = ?', [companyId]);
  await purgeCache(companyId);
  await q("DELETE FROM oauth_states WHERE company_id = ? AND provider = ?", [companyId, PROVIDER]);
  return { disconnected: result.affectedRows > 0 };
}

// Executa chamada com o token da conta, tratando reauth e limite de uso.
async function withToken(row, fn) {
  if (row.status === 'reauth_required') throw codedError(409, 'instagram_reauth_required', 'A conexão com o Instagram expirou. Conecte novamente.');
  if (row.rate_limited_until && new Date(row.rate_limited_until) > new Date()) {
    throw codedError(429, 'instagram_rate_limited', 'Limite de uso da API do Instagram atingido. Tente mais tarde.', { retry_at: iso(row.rate_limited_until) });
  }
  try {
    return await fn(decrypt(row.access_token_enc));
  } catch (error) {
    if (error.kind === 'auth') {
      await q("UPDATE instagram_accounts SET status = 'reauth_required', last_error_code = ? WHERE id = ?", [error.providerCode || 'auth', row.id]);
      throw codedError(409, 'instagram_reauth_required', 'A conexão com o Instagram expirou. Conecte novamente.');
    }
    if (error.kind === 'rate_limit') {
      const pauseMin = Math.max(RATE_LIMIT_PAUSE_MIN, Math.ceil((error.retryAfterSec || 0) / 60));
      await q('UPDATE instagram_accounts SET rate_limited_until = NOW() + INTERVAL ? MINUTE, last_error_code = ? WHERE id = ?', [pauseMin, error.providerCode || 'rate_limit', row.id]);
      throw codedError(429, 'instagram_rate_limited', 'Limite de uso da API do Instagram atingido. Tente mais tarde.');
    }
    if (error.kind) throw codedError(502, 'instagram_unavailable', 'API do Instagram indisponível no momento.', { provider_code: error.providerCode || null });
    throw error;
  }
}

async function requireAccount(companyId) {
  const row = await accountOf(companyId);
  if (!row) throw codedError(404, 'integration_not_connected', 'Instagram não conectado.');
  return row;
}

// Cache: devolve o que há no banco com stale=true quando a API falha por limite/indisponibilidade.
const SOFT_FAIL = new Set(['instagram_rate_limited', 'instagram_unavailable']);

async function syncProfile(row) {
  const me = await withToken(row, token => provider.profile(token));
  await q(`UPDATE instagram_accounts SET username = ?, name = ?, account_type = ?, profile_picture_url = ?, followers_count = ?, follows_count = ?,
             media_count = ?, profile_synced_at = NOW(), last_error_code = NULL WHERE id = ?`,
  [me.username || row.username, me.name || null, me.account_type || null, me.profile_picture_url || null, me.followers_count ?? null, me.follows_count ?? null, me.media_count ?? null, row.id]);
  return accountOf(row.company_id);
}

async function syncMedia(row, wanted) {
  const items = [];
  let after = null;
  await withToken(row, async token => {
    do {
      const page = await provider.mediaPage(token, { limit: Math.min(25, wanted - items.length), after });
      items.push(...page.items);
      after = page.after;
    } while (after && items.length < wanted);
  });
  for (const item of items.slice(0, wanted)) {
    await q(`INSERT INTO instagram_media (company_id, media_id, caption, media_type, media_product_type, permalink, thumbnail_url, posted_at, like_count, comments_count, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE caption = VALUES(caption), media_type = VALUES(media_type), media_product_type = VALUES(media_product_type),
               permalink = VALUES(permalink), thumbnail_url = VALUES(thumbnail_url), posted_at = VALUES(posted_at), like_count = VALUES(like_count),
               comments_count = VALUES(comments_count), fetched_at = NOW()`,
    [row.company_id, String(item.id), item.caption ? String(item.caption).slice(0, 2200) : null, item.media_type || null, item.media_product_type || null,
      item.permalink || null, item.thumbnail_url || (item.media_type === 'IMAGE' ? item.media_url : null) || null,
      item.timestamp ? new Date(item.timestamp) : null, item.like_count ?? null, item.comments_count ?? null]);
  }
  await q('UPDATE instagram_accounts SET media_synced_at = NOW() WHERE id = ?', [row.id]);
}

function postView(post, followers) {
  return {
    media_id: post.media_id, caption: post.caption, media_type: post.media_type, media_product_type: post.media_product_type,
    permalink: post.permalink, thumbnail_url: post.thumbnail_url, posted_at: iso(post.posted_at),
    like_count: post.like_count, comments_count: post.comments_count,
    insights: post.insights_at ? { reach: post.reach, views: post.views, saved: post.saved, shares: post.shares, total_interactions: post.total_interactions, fetched_at: iso(post.insights_at) } : null,
    ...metrics.engagement(post, followers),
  };
}

function postsLimit(ent) {
  const limit = ent?.features?.instagram_posts_limit;
  return Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), maxPosts()) : maxPosts();
}

// GET overview/posts: cache com TTL; refresh=true força (respeitando pausa por limite de uso).
async function loadPosts(companyId, { ent, refresh = false } = {}) {
  let row = await requireAccount(companyId);
  const cap = postsLimit(ent);
  let stale = false;
  if (refresh || !fresh(row.profile_synced_at, cacheTtlMin())) {
    try { row = await syncProfile(row); } catch (error) { if (!SOFT_FAIL.has(error.code)) throw error; stale = true; }
  }
  if (refresh || !fresh(row.media_synced_at, cacheTtlMin())) {
    try { await syncMedia(row, cap); row = await accountOf(companyId); } catch (error) { if (!SOFT_FAIL.has(error.code)) throw error; stale = true; }
  }
  const posts = await q('SELECT * FROM instagram_media WHERE company_id = ? ORDER BY posted_at DESC, media_id DESC LIMIT ?', [companyId, cap]);
  return { row, posts, cap, stale };
}

async function overview(companyId, { ent, refresh } = {}) {
  const { row, posts, stale } = await loadPosts(companyId, { ent, refresh });
  return { account: accountView(row), engagement: metrics.summary(posts, row.followers_count), stale, premium: ent?.features?.instagram === true };
}

// Paginação sobre o cache: ?limit=&before=<media_id>. Free: no máximo 6 no total.
async function posts(companyId, { ent, refresh, limit = 12, before = null } = {}) {
  const { row, posts: all, cap, stale } = await loadPosts(companyId, { ent, refresh });
  let start = 0;
  if (before) { const index = all.findIndex(post => post.media_id === before); start = index >= 0 ? index + 1 : all.length; }
  const page = all.slice(start, start + Math.min(limit, cap));
  const next = start + page.length < all.length ? page[page.length - 1]?.media_id || null : null;
  return { items: page.map(post => postView(post, row.followers_count)), next_before: next, limit_total: cap, stale };
}

async function syncInsights(row, list) {
  await withToken(row, async token => {
    for (const post of list) {
      const values = await provider.mediaInsights(token, post.media_id, post.media_product_type);
      await q(`UPDATE instagram_media SET reach = ?, views = ?, saved = ?, shares = ?, total_interactions = ?, insights_at = NOW()
               WHERE company_id = ? AND media_id = ?`,
      [values.reach ?? null, values.views ?? null, values.saved ?? null, values.shares ?? null, values.total_interactions ?? null, row.company_id, post.media_id]);
    }
  });
  await q('UPDATE instagram_accounts SET insights_synced_at = NOW() WHERE id = ?', [row.id]);
}

function unixDay(date) { return Math.floor(date.getTime() / 1000); }

// Premium: insights por post + conta (últimos 28 dias) + série histórica + comparativo.
async function insights(companyId, { ent, refresh = false, days = 30 } = {}) {
  const { row, posts: list, stale: postsStale } = await loadPosts(companyId, { ent, refresh });
  let stale = postsStale;
  const due = list.filter(post => refresh || !fresh(post.insights_at, insightsTtlMin())).slice(0, 25);
  if (due.length) {
    try { await syncInsights(row, due); } catch (error) { if (!SOFT_FAIL.has(error.code)) throw error; stale = true; }
  }
  let account = null;
  try {
    const until = new Date();
    const since = new Date(until.getTime() - 28 * 86400000);
    account = await withToken(row, token => provider.accountInsights(token, { since: unixDay(since), until: unixDay(until) }));
  } catch (error) { if (!SOFT_FAIL.has(error.code)) throw error; stale = true; }
  const fresher = await q('SELECT * FROM instagram_media WHERE company_id = ? ORDER BY posted_at DESC, media_id DESC LIMIT ?', [companyId, list.length || 1]);
  const history = await q(`SELECT snapshot_date, followers_count, follows_count, media_count, reach, views, accounts_engaged, total_interactions, profile_links_taps
                           FROM instagram_snapshots WHERE company_id = ? AND snapshot_date >= CURDATE() - INTERVAL ? DAY ORDER BY snapshot_date`, [companyId, days]);
  return {
    account_insights: account ? { period_days: 28, ...account } : null,
    posts: fresher.map(post => postView(post, row.followers_count)),
    engagement: metrics.summary(fresher, row.followers_count),
    comparison: metrics.compare(fresher, row.followers_count),
    history: history.map(item => ({ ...item, snapshot_date: item.snapshot_date instanceof Date ? wallClock(item.snapshot_date).slice(0, 10) : String(item.snapshot_date).slice(0, 10) })),
    stale,
  };
}

// ---- Jobs (payload só com ids) ----

// Renova token longo quando faltam ≤ 7 dias (e ele tem ≥ 24 h). Expirado = reauth.
async function refreshTokenJob({ company_id: companyId }) {
  const row = await accountOf(companyId);
  if (!row || row.status !== 'active') return;
  if (row.token_expires_at && new Date(row.token_expires_at) <= new Date()) {
    await q("UPDATE instagram_accounts SET status = 'reauth_required', last_error_code = 'token_expired' WHERE id = ?", [row.id]);
    return;
  }
  try {
    const out = await provider.refreshToken(decrypt(row.access_token_enc));
    await q('UPDATE instagram_accounts SET access_token_enc = ?, token_expires_at = ?, token_refreshed_at = NOW(), last_error_code = NULL WHERE id = ?',
      [encrypt(out.accessToken), new Date(Date.now() + out.expiresIn * 1000), row.id]);
  } catch (error) {
    if (error.kind === 'auth') {
      await q("UPDATE instagram_accounts SET status = 'reauth_required', last_error_code = ? WHERE id = ?", [error.providerCode || 'auth', row.id]);
      return;
    }
    throw error; // limite/indisponível: o job tenta de novo com backoff
  }
}

// Snapshot diário (Premium): perfil + insights da conta do dia anterior, na data local da empresa.
async function snapshotJob({ company_id: companyId, date }) {
  const plans = require('../plansService');
  const ent = await plans.entitlement(companyId);
  if (ent.features.instagram !== true) return;
  let row = await accountOf(companyId);
  if (!row || row.status !== 'active') return;
  try {
    row = await syncProfile(row);
    const until = new Date();
    const since = new Date(until.getTime() - 86400000);
    const values = await withToken(row, token => provider.accountInsights(token, { since: unixDay(since), until: unixDay(until) }));
    await q(`INSERT INTO instagram_snapshots (company_id, snapshot_date, followers_count, follows_count, media_count, reach, views, accounts_engaged, total_interactions, profile_links_taps)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE followers_count = VALUES(followers_count), follows_count = VALUES(follows_count), media_count = VALUES(media_count),
               reach = VALUES(reach), views = VALUES(views), accounts_engaged = VALUES(accounts_engaged), total_interactions = VALUES(total_interactions),
               profile_links_taps = VALUES(profile_links_taps)`,
    [companyId, date, row.followers_count, row.follows_count, row.media_count, values.reach ?? null, values.views ?? null, values.accounts_engaged ?? null, values.total_interactions ?? null, values.profile_links_taps ?? null]);
  } catch (error) {
    if (error.code === 'instagram_reauth_required') return; // sem retry: depende do usuário reconectar
    throw error;
  }
}

async function enqueueRefreshes(jobs) {
  const rows = await q(`SELECT company_id FROM instagram_accounts WHERE status = 'active'
                         AND token_expires_at <= NOW() + INTERVAL 7 DAY AND token_refreshed_at <= NOW() - INTERVAL 1 DAY`);
  const bucket = new Date().toISOString().slice(0, 13);
  for (const row of rows) await jobs.enqueue('instagram_token_refresh', { company_id: row.company_id }, { dedupeKey: `ig_refresh:${row.company_id}:${bucket}`, maxAttempts: 3 });
}

async function enqueueSnapshots(jobs) {
  const rows = await q(`SELECT a.company_id, c.timezone FROM instagram_accounts a JOIN companies c ON c.id = a.company_id WHERE a.status = 'active'`);
  for (const row of rows) {
    const date = wallClock(new Date(), resolveTimezone(row.timezone)).slice(0, 10);
    // Entitlement é rechecado no job; dedupe por empresa+dia garante um snapshot diário.
    await jobs.enqueue('instagram_snapshot', { company_id: row.company_id, date }, { dedupeKey: `ig_snap:${row.company_id}:${date}`, maxAttempts: 4 });
  }
}

// ---- Callbacks da Meta (desautorização / exclusão de dados) ----

// Remove contas ligadas ao usuário do app (id escopado do app ou id do Instagram).
async function removeByMetaUser(userId) {
  const rows = await q('SELECT company_id FROM instagram_accounts WHERE app_user_id = ? OR ig_user_id = ?', [String(userId), String(userId)]);
  for (const row of rows) await disconnect(row.company_id);
  return rows.length;
}

module.exports = {
  PROVIDER, configured, status, startConnect, completeConnect, disconnect, overview, posts, insights,
  refreshTokenJob, snapshotJob, enqueueRefreshes, enqueueSnapshots, removeByMetaUser, accountOf, postsLimit, _purgeCache: purgeCache,
};
