const functions = require('../../utils/functions');
const plans = require('../plansService');
const provider = require('./provider');
const outbound = require('./outbound');

// Caixa de entrada do painel. Tudo filtrado pelo company_id da sessão:
// conversas = só as que estão com a empresa agora; mensagens = só as gravadas com a empresa.
const busy = () => Object.assign(new Error('Conversa não encontrada.'), { status: 404, code: 'conversation_not_found' });

const WINDOW_SQL = `(c.last_inbound_at >= NOW() - INTERVAL ${outbound.WINDOW_HOURS} HOUR)`;

function presentConversation(row) {
  return {
    id: row.id,
    contact: { wa_id: row.wa_id, name: row.profile_name || null, opted_out: !!row.opted_out_at },
    mode: row.mode,
    state: row.state,
    assigned_user_id: row.assigned_user_id || null,
    handoff_at: row.handoff_at_wall || null,
    last_inbound_at: row.last_inbound_wall || null,
    last_message_at: row.last_message_wall || null,
    window_open: Number(row.window_open) === 1,
    last_message: row.last_body !== undefined ? { body: row.last_body, direction: row.last_direction, author: row.last_author } : null,
    unread_count: Number(row.unread_count) || 0,
  };
}

// Não lidas (follow-up 1): recebidas acima do marcador da conversa (compartilhado pela equipe).
const UNREAD_SQL = `(SELECT COUNT(*) FROM whatsapp_messages u WHERE u.conversation_id = c.id AND u.company_id = c.company_id
  AND u.direction = 'in' AND u.id > COALESCE(c.last_read_message_id, 0))`;

const CONV_FIELDS = `c.id, c.mode, c.state, c.assigned_user_id, ct.wa_id, ct.profile_name, ct.opted_out_at, ${WINDOW_SQL} AS window_open, ${UNREAD_SQL} AS unread_count,
  DATE_FORMAT(c.handoff_at, '%Y-%m-%d %H:%i:%s') AS handoff_at_wall, DATE_FORMAT(c.last_inbound_at, '%Y-%m-%d %H:%i:%s') AS last_inbound_wall,
  DATE_FORMAT(c.last_message_at, '%Y-%m-%d %H:%i:%s') AS last_message_wall`;

// Filtros de servidor (follow-up 1): aguardando = com humano e sem atendente; assumidas = com
// humano e com atendente; opted_out = contato pediu PARAR.
const FILTERS = {
  waiting: "c.mode = 'human' AND c.assigned_user_id IS NULL",
  assumed: "c.mode = 'human' AND c.assigned_user_id IS NOT NULL",
  opted_out: 'ct.opted_out_at IS NOT NULL',
};

async function listConversations(companyId, { mode, assigned_to_me: mine, filter, userId, limit = 50, offset = 0 } = {}) {
  const where = ['c.company_id = ?'];
  const params = [companyId];
  if (mode) { where.push('c.mode = ?'); params.push(mode); }
  if (mine) { where.push('c.assigned_user_id = ?'); params.push(userId); }
  if (filter && FILTERS[filter]) where.push(`(${FILTERS[filter]})`);
  const rows = await functions.executeSql(`SELECT ${CONV_FIELDS},
      (SELECT m.body FROM whatsapp_messages m WHERE m.conversation_id = c.id AND m.company_id = c.company_id ORDER BY m.id DESC LIMIT 1) AS last_body,
      (SELECT m.direction FROM whatsapp_messages m WHERE m.conversation_id = c.id AND m.company_id = c.company_id ORDER BY m.id DESC LIMIT 1) AS last_direction,
      (SELECT m.author FROM whatsapp_messages m WHERE m.conversation_id = c.id AND m.company_id = c.company_id ORDER BY m.id DESC LIMIT 1) AS last_author
    FROM whatsapp_conversations c JOIN whatsapp_contacts ct ON ct.id = c.contact_id
    WHERE ${where.join(' AND ')} ORDER BY c.mode = 'human' DESC, c.last_message_at DESC, c.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return rows.map(presentConversation);
}

// Contagens para abas/badges (follow-up 1). "mine" = assumidas pelo usuário da sessão.
async function summary(companyId, userId) {
  const [row] = await functions.executeSql(`SELECT COUNT(*) AS total, SUM(x.mode = 'bot') AS bot, SUM(x.mode = 'human') AS human,
      SUM(x.mode = 'human' AND x.assigned_user_id IS NULL) AS waiting, SUM(x.mode = 'human' AND x.assigned_user_id IS NOT NULL) AS assumed,
      SUM(x.assigned_user_id <=> ?) AS mine, SUM(x.opted_out) AS opted_out,
      SUM(x.unread_count > 0) AS unread_conversations, SUM(x.unread_count) AS unread_messages
    FROM (SELECT c.mode, c.assigned_user_id, ct.opted_out_at IS NOT NULL AS opted_out, ${UNREAD_SQL} AS unread_count
      FROM whatsapp_conversations c JOIN whatsapp_contacts ct ON ct.id = c.contact_id WHERE c.company_id = ?) x`, [userId, companyId]);
  const n = key => Number(row?.[key]) || 0;
  return {
    total: n('total'), bot: n('bot'), human: n('human'), waiting: n('waiting'), assumed: n('assumed'), mine: n('mine'),
    opted_out: n('opted_out'), unread_conversations: n('unread_conversations'), unread_messages: n('unread_messages'),
  };
}

// Marca como lida até a última mensagem atual (nunca volta o marcador).
async function markRead(companyId, conversationId) {
  await getConversation(companyId, conversationId);
  await functions.executeSql(`UPDATE whatsapp_conversations c SET c.last_read_message_id = GREATEST(COALESCE(c.last_read_message_id, 0),
      COALESCE((SELECT MAX(m.id) FROM whatsapp_messages m WHERE m.conversation_id = c.id AND m.company_id = c.company_id), 0))
    WHERE c.id = ? AND c.company_id = ?`, [conversationId, companyId]);
  return getConversation(companyId, conversationId);
}

async function getConversation(companyId, id) {
  const [row] = await functions.executeSql(`SELECT ${CONV_FIELDS} FROM whatsapp_conversations c JOIN whatsapp_contacts ct ON ct.id = c.contact_id
    WHERE c.id = ? AND c.company_id = ?`, [id, companyId]);
  if (!row) throw busy();
  return presentConversation(row);
}

async function listMessages(companyId, conversationId, { before_id: beforeId, limit = 50 } = {}) {
  await getConversation(companyId, conversationId);
  const rows = await functions.executeSql(`SELECT id, direction, author, user_id, type, body, template_name, status, error_code,
      DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at, DATE_FORMAT(status_at, '%Y-%m-%d %H:%i:%s') AS status_at
    FROM whatsapp_messages WHERE conversation_id = ? AND company_id = ?${beforeId ? ' AND id < ?' : ''} ORDER BY id DESC LIMIT ?`,
  beforeId ? [conversationId, companyId, beforeId, limit] : [conversationId, companyId, limit]);
  return rows.reverse();
}

async function assume(companyId, conversationId, userId) {
  const result = await functions.executeSql(`UPDATE whatsapp_conversations SET mode = 'human', assigned_user_id = ?, handoff_at = NOW()
    WHERE id = ? AND company_id = ?`, [userId, conversationId, companyId]);
  if (!result.affectedRows) throw busy();
  return getConversation(companyId, conversationId);
}

async function release(companyId, conversationId) {
  const result = await functions.executeSql(`UPDATE whatsapp_conversations SET mode = 'bot', assigned_user_id = NULL, handoff_at = NULL, state = 'menu'
    WHERE id = ? AND company_id = ?`, [conversationId, companyId]);
  if (!result.affectedRows) throw busy();
  return getConversation(companyId, conversationId);
}

async function send(companyId, conversationId, userId, body) {
  const result = await outbound.agentSend({ companyId, conversationId, userId, text: body.text, template: body.template ? { name: body.template, params: body.params || [] } : null });
  // Atendente falou: a conversa fica com o humano (o bot não responde por cima).
  await functions.executeSql(`UPDATE whatsapp_conversations SET mode = 'human', assigned_user_id = COALESCE(assigned_user_id, ?), handoff_at = COALESCE(handoff_at, NOW())
    WHERE id = ? AND company_id = ?`, [userId, conversationId, companyId]);
  await markRead(companyId, conversationId); // quem responde leu a conversa
  const [row] = await functions.executeSql(`SELECT id, direction, author, user_id, type, body, template_name, status, error_code,
      DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at FROM whatsapp_messages WHERE id = ? AND company_id = ?`, [result.id, companyId]);
  return row;
}

async function templates() {
  return functions.executeSql(`SELECT name, language, category, purpose, body_preview, param_count, status,
    DATE_FORMAT(synced_at, '%Y-%m-%d %H:%i:%s') AS synced_at FROM whatsapp_templates ORDER BY purpose, name`);
}

async function usage(companyId, period = plans.monthPeriod()) {
  const ent = await plans.entitlement(companyId);
  const [counter] = await functions.executeSql('SELECT used FROM usage_counters WHERE company_id = ? AND metric = ? AND period = ?', [companyId, outbound.QUOTA, period]);
  const [stats] = await functions.executeSql(`SELECT
      SUM(direction = 'in') AS inbound, SUM(direction = 'out' AND author = 'bot') AS bot,
      SUM(direction = 'out' AND billable = 1) AS billable, SUM(direction = 'out' AND status = 'failed') AS failed,
      SUM(direction = 'out' AND status IN ('delivered','read')) AS delivered, SUM(direction = 'out' AND status = 'read') AS readed
    FROM whatsapp_messages WHERE company_id = ? AND DATE_FORMAT(created_at, '%Y-%m') = ?`, [companyId, period]);
  const [aiRow] = await functions.executeSql("SELECT COALESCE(SUM(tokens_used), 0) AS tokens, COALESCE(SUM(calls), 0) AS calls FROM ai_usage_daily WHERE company_id = ? AND DATE_FORMAT(day, '%Y-%m') = ?", [companyId, period]);
  const limit = ent.features?.[outbound.QUOTA];
  return {
    period,
    plan: ent.plan_code,
    messages: { used: Number(counter?.used) || 0, limit: limit === null || limit === undefined ? null : Number(limit) },
    breakdown: {
      inbound: Number(stats?.inbound) || 0, bot_replies: Number(stats?.bot) || 0, billable: Number(stats?.billable) || 0,
      delivered: Number(stats?.delivered) || 0, read: Number(stats?.readed) || 0, failed: Number(stats?.failed) || 0,
    },
    ai: { tokens: Number(aiRow.tokens) || 0, calls: Number(aiRow.calls) || 0, daily_limit: Number(ent.features?.whatsapp_ai_daily_tokens ?? 0) || 0 },
  };
}

async function status(companyId) {
  const [company] = await functions.executeSql('SELECT slug, public_page_enabled FROM companies WHERE id = ?', [companyId]);
  const [settings] = await functions.executeSql('SELECT bot_enabled, ai_enabled, welcome_text, ai_daily_token_limit FROM whatsapp_settings WHERE company_id = ?', [companyId]);
  const account = provider.cloudEnabled() ? await provider.platformAccount() : null;
  const digits = String(account?.display_phone || '').replace(/\D/g, '');
  const [today] = await functions.executeSql("SELECT tokens_used FROM ai_usage_daily WHERE company_id = ? AND day = DATE(NOW())", [companyId]);
  return {
    enabled: provider.cloudEnabled(),
    display_phone: account?.display_phone || null,
    // Link para a página/divulgação: abre a conversa já identificando a empresa pelo slug.
    wa_link: digits && company?.slug ? `https://wa.me/${digits}?text=${encodeURIComponent(`Agendar ${company.slug}`)}` : null,
    booking_ready: Number(company?.public_page_enabled) === 1,
    settings: {
      bot_enabled: settings ? Number(settings.bot_enabled) === 1 : true,
      ai_enabled: settings ? Number(settings.ai_enabled) === 1 : true,
      welcome_text: settings?.welcome_text || null,
      ai_daily_token_limit: settings?.ai_daily_token_limit ?? null,
    },
    ai_tokens_today: Number(today?.tokens_used) || 0,
  };
}

async function updateConfig(companyId, body) {
  const current = (await status(companyId)).settings;
  const next = { ...current, ...body };
  await functions.executeSql(`INSERT INTO whatsapp_settings (company_id, bot_enabled, ai_enabled, welcome_text, ai_daily_token_limit) VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE bot_enabled = VALUES(bot_enabled), ai_enabled = VALUES(ai_enabled), welcome_text = VALUES(welcome_text), ai_daily_token_limit = VALUES(ai_daily_token_limit)`,
  [companyId, next.bot_enabled ? 1 : 0, next.ai_enabled ? 1 : 0, next.welcome_text || null, next.ai_daily_token_limit ?? null]);
  return status(companyId);
}

// Sincroniza o status de aprovação dos modelos com a Meta (rota interna).
async function syncTemplates() {
  const account = await provider.platformAccount();
  const remote = await provider.listTemplates(account);
  const map = { APPROVED: 'approved', REJECTED: 'rejected', PENDING: 'pending', IN_APPEAL: 'pending', PAUSED: 'disabled', DISABLED: 'disabled' };
  let updated = 0;
  for (const tpl of remote) {
    const statusValue = map[String(tpl.status || '').toUpperCase()];
    if (!statusValue || !tpl.name) continue;
    const result = await functions.executeSql('UPDATE whatsapp_templates SET status = ?, synced_at = NOW() WHERE name = ? AND language = ?',
      [statusValue, String(tpl.name).slice(0, 80), String(tpl.language || 'pt_BR').slice(0, 10)]);
    updated += result.affectedRows;
  }
  return { remote: remote.length, updated };
}

module.exports = { listConversations, summary, markRead, getConversation, listMessages, assume, release, send, templates, usage, status, updateConfig, syncTemplates };
