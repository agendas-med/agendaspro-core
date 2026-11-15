const functions = require('../../utils/functions');
const plans = require('../plansService');
const provider = require('./provider');

// Saída única de mensagens WhatsApp (Cloud API). Toda mensagem passa aqui:
// - opt-out (plataforma inteira) bloqueia tudo, inclusive lembretes e confirmações;
// - janela de 24h: aberta (cliente escreveu nas últimas 24h) -> mensagem de sessão; fechada ->
//   só modelo aprovado; sem modelo -> não envia (quem chamou decide e-mail ou pular);
// - quota mensal (whatsapp_monthly_messages): conta mensagens iniciadas pela empresa (modelos,
//   lembretes, confirmações) e mensagens manuais do atendente (billable=1). Respostas do bot
//   dentro da janela de atendimento não contam (conversa de serviço não é cobrada pela Meta).
const QUOTA = 'whatsapp_monthly_messages';
const WINDOW_HOURS = 24;

class OutboundError extends Error {
  constructor(code, message, status = 409, details = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// Telefone cadastrado (10/11 dígitos nacionais ou já com 55) -> wa_id (55 + DDD + número).
function waIdFromPhone(tel) {
  let digits = String(tel || '').replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  return /^\d{12,15}$/.test(digits) ? digits : null;
}

// wa_id brasileiro -> 11 dígitos nacionais. A Meta pode entregar celular sem o 9 (12 dígitos):
// DDD + 8 dígitos começando em 6-9 vira DDD + 9 + 8 dígitos.
function nationalFromWaId(waId) {
  const digits = String(waId || '').replace(/\D/g, '');
  if (!digits.startsWith('55')) return null;
  const national = digits.slice(2);
  if (national.length === 11) return national;
  if (national.length === 10) return /^[6-9]/.test(national.slice(2)) ? `${national.slice(0, 2)}9${national.slice(2)}` : national;
  return null;
}

async function contactByWaId(waId, { create = false, profileName = null } = {}) {
  if (create) {
    await functions.executeSql(`INSERT INTO whatsapp_contacts (wa_id, profile_name) VALUES (?, ?)
      ON DUPLICATE KEY UPDATE profile_name = COALESCE(VALUES(profile_name), profile_name)`, [waId, profileName]);
  }
  const [row] = await functions.executeSql('SELECT * FROM whatsapp_contacts WHERE wa_id = ?', [waId]);
  return row || null;
}

async function conversationFor(account, contact) {
  await functions.executeSql('INSERT IGNORE INTO whatsapp_conversations (account_id, contact_id) VALUES (?, ?)', [account.id, contact.id]);
  const [row] = await functions.executeSql('SELECT * FROM whatsapp_conversations WHERE account_id = ? AND contact_id = ?', [account.id, contact.id]);
  return row;
}

async function windowOpen(conversationId) {
  const [row] = await functions.executeSql(`SELECT last_inbound_at >= NOW() - INTERVAL ${WINDOW_HOURS} HOUR AS open FROM whatsapp_conversations WHERE id = ?`, [conversationId]);
  return Number(row?.open) === 1;
}

async function approvedTemplate({ name, purpose }) {
  const [row] = await functions.executeSql(
    `SELECT name, language, param_count FROM whatsapp_templates WHERE status = 'approved' AND ${name ? 'name = ?' : 'purpose = ?'} ORDER BY id LIMIT 1`,
    [name || purpose],
  );
  return row || null;
}

// Grava a linha, envia e marca enviada (com uso mensal na mesma transação).
async function deliver({ account, conversation, contact, companyId, author, userId = null, message, body, templateName = null, billable = false }) {
  const inserted = await functions.executeSql(
    `INSERT INTO whatsapp_messages (conversation_id, company_id, direction, author, user_id, type, body, template_name, status, billable)
     VALUES (?, ?, 'out', ?, ?, ?, ?, ?, 'queued', ?)`,
    [conversation.id, companyId || null, author, userId, message.type, String(body ?? '').slice(0, 4096), templateName, billable ? 1 : 0],
  );
  const id = inserted.insertId;
  let wamid;
  try {
    wamid = await provider.send(account, contact.wa_id, message);
  } catch (error) {
    await functions.executeSql("UPDATE whatsapp_messages SET status = 'failed', error_code = ?, attempts = attempts + 1, status_at = NOW() WHERE id = ?",
      [String(error.providerCode || 'error').slice(0, 40), id]).catch(() => {});
    throw error;
  }
  await functions.executeTransaction(async query => {
    await query("UPDATE whatsapp_messages SET status = 'sent', wamid = ?, attempts = attempts + 1, status_at = NOW() WHERE id = ?", [wamid, id]);
    await query('UPDATE whatsapp_conversations SET last_message_at = NOW() WHERE id = ?', [conversation.id]);
    if (billable && companyId) await plans.incrementUsage(companyId, QUOTA, { query });
  });
  return { id, wamid };
}

// Respostas do bot na conversa (cliente acabou de escrever: janela aberta). Não contam quota.
async function replyAll({ account, conversation, contact, companyId }, messages) {
  const sent = [];
  for (const item of messages) {
    sent.push(await deliver({ account, conversation, contact, companyId, author: 'bot', message: item.message, body: item.body }));
  }
  return sent;
}

// Aviso iniciado pela empresa (lembrete, confirmação, remarcação). Nunca lança por regra de
// negócio: devolve { sent } ou { skipped, reason } para o chamador cair no e-mail ou pular.
// Erros de envio retentáveis são relançados (o job tenta de novo com backoff).
async function notify({ companyId, phone, waId, purpose, params = [], text = null }) {
  if (!provider.cloudEnabled()) return { skipped: true, reason: 'not_configured' };
  const to = waId || waIdFromPhone(phone);
  if (!to) return { skipped: true, reason: 'invalid_phone' };
  const account = await provider.platformAccount();
  const contact = await contactByWaId(to, { create: true });
  if (contact.opted_out_at) return { skipped: true, reason: 'opted_out' };
  const conversation = await conversationFor(account, contact);
  // A resposta do cliente a este aviso deve cair na clínica que avisou (se o bot está livre).
  if (companyId && conversation.mode === 'bot' && conversation.company_id !== companyId) {
    await functions.executeSql("UPDATE whatsapp_conversations SET company_id = ?, state = 'menu', context = NULL WHERE id = ? AND mode = 'bot'", [companyId, conversation.id]);
    conversation.company_id = companyId;
  }

  const open = await windowOpen(conversation.id);
  let message;
  let body;
  let templateName = null;
  if (open && text) {
    message = provider.text(text);
    body = text;
  } else {
    const tpl = await approvedTemplate({ purpose });
    if (!tpl) return { skipped: true, reason: 'template_unavailable' };
    const values = params.slice(0, tpl.param_count).map(String);
    while (values.length < tpl.param_count) values.push('-');
    message = provider.template(tpl.name, values, tpl.language);
    body = `[modelo ${tpl.name}] ${values.join(' | ')}`;
    templateName = tpl.name;
  }

  if (companyId) {
    try {
      await plans.assertQuota(companyId, QUOTA);
    } catch (error) {
      if (error?.code !== 'plan_upgrade_required') throw error;
      return { skipped: true, reason: 'quota' };
    }
  }
  try {
    const result = await deliver({ account, conversation, contact, companyId, author: 'system', message, body, templateName, billable: !!companyId });
    return { sent: true, ...result };
  } catch (error) {
    if (error instanceof provider.ProviderError && !error.retryable) return { skipped: true, reason: `provider_${error.providerCode}` };
    throw error;
  }
}

// Envio manual do atendente pelo painel. Regras viram erro HTTP (402/409).
async function agentSend({ companyId, conversationId, userId, text, template }) {
  if (!provider.cloudEnabled()) throw new OutboundError('whatsapp_not_configured', 'WhatsApp não configurado na plataforma.', 409);
  const [conversation] = await functions.executeSql('SELECT * FROM whatsapp_conversations WHERE id = ? AND company_id = ?', [conversationId, companyId]);
  if (!conversation) throw new OutboundError('conversation_not_found', 'Conversa não encontrada.', 404);
  const [contact] = await functions.executeSql('SELECT * FROM whatsapp_contacts WHERE id = ?', [conversation.contact_id]);
  if (contact.opted_out_at) throw new OutboundError('opted_out', 'O cliente pediu para não receber mensagens (PARAR).', 409);
  const account = await provider.accountById(conversation.account_id);

  let message;
  let body;
  let templateName = null;
  if (template) {
    const tpl = await approvedTemplate({ name: template.name });
    if (!tpl) throw new OutboundError('template_unavailable', 'Modelo inexistente ou não aprovado pela Meta.', 409);
    const values = (template.params || []).slice(0, tpl.param_count).map(String);
    if (values.length !== tpl.param_count) throw new OutboundError('template_params', `O modelo exige ${tpl.param_count} parâmetro(s).`, 400);
    message = provider.template(tpl.name, values, tpl.language);
    body = `[modelo ${tpl.name}] ${values.join(' | ')}`;
    templateName = tpl.name;
  } else {
    if (!(await windowOpen(conversation.id))) {
      throw new OutboundError('window_closed', 'Fora da janela de 24h: envie um modelo aprovado para retomar a conversa.', 409);
    }
    message = provider.text(text);
    body = text;
  }
  await plans.assertQuota(companyId, QUOTA);
  try {
    return await deliver({ account, conversation, contact, companyId, author: 'agent', userId, message, body, templateName, billable: true });
  } catch (error) {
    if (error instanceof provider.ProviderError) {
      throw new OutboundError('send_failed', 'A Meta recusou ou não respondeu ao envio. Tente novamente.', 502, { retryable: error.retryable });
    }
    throw error;
  }
}

// Status de entrega (webhook). Monotônico: queued < sent < delivered < read; failed só não
// sobrescreve read. wamid desconhecido é ignorado.
const RANK = { queued: 0, sent: 1, delivered: 2, read: 3 };
async function applyStatus({ wamid, status, errorCode }) {
  const allowedFrom = status === 'failed'
    ? ['queued', 'sent', 'delivered']
    : Object.keys(RANK).filter(s => RANK[s] < RANK[status]);
  if (!allowedFrom.length) return { ignored: true };
  const result = await functions.executeSql(
    'UPDATE whatsapp_messages SET status = ?, error_code = COALESCE(?, error_code), status_at = NOW() WHERE wamid = ? AND direction = \'out\' AND status IN (?)',
    [status, errorCode || null, wamid, allowedFrom],
  );
  return { updated: result.affectedRows > 0 };
}

module.exports = {
  QUOTA, WINDOW_HOURS, OutboundError, waIdFromPhone, nationalFromWaId, contactByWaId, conversationFor, windowOpen,
  approvedTemplate, deliver, replyAll, notify, agentSend, applyStatus,
};
