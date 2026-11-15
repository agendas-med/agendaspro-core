const functions = require('../../utils/functions');
const { randomToken } = require('../../utils/crypto');
const { wallClock, resolveTimezone } = require('../../utils/time');
const { hit } = require('../../middleware/rateLimit');
const provider = require('./provider');
const outbound = require('./outbound');
const router = require('./router');
const ai = require('./ai');

// Processamento de um item do webhook (job whatsapp_inbound). Ordem:
// conta -> contato -> trava da conversa -> grava a mensagem (wamid UNIQUE: reentrega = no-op)
// -> limite por telefone -> PARAR/VOLTAR -> opt-out -> modo atendente -> máquina de estados.
const OPT_OUT = /^(parar|sair|stop|descadastrar|cancelar mensagens|nao quero mais receber)$/;
const OPT_IN = /^(voltar|ativar|quero receber)$/;
const LEASE_SECONDS = 60;

const inboundMax = () => Number(process.env.WHATSAPP_INBOUND_MAX) || 20;
const humanTimeoutHours = () => Number(process.env.WHATSAPP_HUMAN_TIMEOUT_H) || 12;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function acquire(conversationId) {
  const token = randomToken(12);
  for (let i = 0; i < 6; i++) {
    const result = await functions.executeSql(
      `UPDATE whatsapp_conversations SET lease_token = ?, lease_until = NOW() + INTERVAL ${LEASE_SECONDS} SECOND
        WHERE id = ? AND (lease_until IS NULL OR lease_until < NOW())`, [token, conversationId]);
    if (result.affectedRows) return token;
    await sleep(100 * (i + 1));
  }
  throw new Error('Conversa ocupada; o job tenta de novo.');
}

const release = (conversationId, token) => functions.executeSql(
  'UPDATE whatsapp_conversations SET lease_token = NULL, lease_until = NULL WHERE id = ? AND lease_token = ?', [conversationId, token]);

function parseContext(raw) {
  if (!raw) return {};
  try { const value = JSON.parse(raw); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}

// Dependências reais da máquina de estados (todas restritas à empresa da conversa).
function depsFor(conversation, contact) {
  const booking = require('../publicBookingService');
  const tokens = require('../publicTokens');
  const phone = outbound.nationalFromWaId(contact.wa_id);
  const companyId = () => conversation.company_id;

  async function listBookings() {
    if (!companyId() || !phone) return [];
    const [company] = await functions.executeSql('SELECT timezone FROM companies WHERE id = ?', [companyId()]);
    const nowWall = wallClock(new Date(), resolveTimezone(company?.timezone));
    const rows = await functions.executeSql(`SELECT pb.public_id, pb.token_expires_at, DATE_FORMAT(a.date, '%Y-%m-%d %H:%i') AS wall, a.canceled, a.payment_status,
        a.checkin, a.checkout, a.professional_id, pb.cancel_reason, (a.hold_expires_at IS NOT NULL AND a.hold_expires_at <= NOW()) AS hold_expired,
        GROUP_CONCAT(s.name ORDER BY s.id SEPARATOR ', ') AS services, GROUP_CONCAT(s.id ORDER BY s.id) AS service_ids
      FROM public_bookings pb
      JOIN appointments a ON a.id = pb.appointment_id AND a.company_id = pb.company_id
      JOIN customers cu ON cu.id = a.customer_id AND cu.company_id = a.company_id
      LEFT JOIN appointment_services aps ON aps.appointment_id = a.id
      LEFT JOIN services s ON s.id = aps.service_id AND s.company_id = a.company_id
      WHERE pb.company_id = ? AND a.canceled = 0 AND a.date >= ? AND cu.anonymized_at IS NULL
        AND REGEXP_REPLACE(COALESCE(cu.tel, ''), '[^0-9]', '') IN (?, ?)
      GROUP BY pb.public_id, pb.token_expires_at, a.date, a.canceled, a.payment_status, a.checkin, a.checkout, a.professional_id, pb.cancel_reason, a.hold_expires_at
      ORDER BY a.date LIMIT 10`, [companyId(), nowWall, phone, `55${phone}`]);
    return rows
      .map(row => ({ ...row, status: booking.deriveStatus(row).status, service_ids: String(row.service_ids || '').split(',').filter(Boolean).map(Number) }))
      .filter(row => ['confirmed', 'pending_payment'].includes(row.status));
  }

  // Só age sobre reservas que aparecem na lista deste telefone nesta empresa.
  async function tokenFor(publicId) {
    const own = (await listBookings()).find(b => b.public_id === publicId);
    if (!own) throw Object.assign(new Error('Agendamento não encontrado.'), { status: 404, code: 'not_found' });
    return tokens.issue(own.public_id, own.token_expires_at);
  }

  return {
    phone,
    conversationId: conversation.id,
    today: () => wallClock(new Date()).slice(0, 10),
    findCompany: async slug => {
      const found = await booking.companyBySlug(slug);
      return found ? { id: found.company.id, slug: found.company.slug, name: found.company.name } : null;
    },
    business: slug => booking.getBusiness(slug),
    availability: (slug, args) => booking.availability(slug, args),
    knownCustomerName: async () => {
      if (!phone) return null;
      const [row] = await functions.executeSql(`SELECT name FROM customers WHERE company_id = ? AND anonymized_at IS NULL
        AND REGEXP_REPLACE(COALESCE(tel, ''), '[^0-9]', '') IN (?, ?) ORDER BY id LIMIT 1`, [companyId(), phone, `55${phone}`]);
      return row?.name || null;
    },
    createBooking: (slug, body) => {
      if (!phone) throw Object.assign(new Error('Agendamento pelo WhatsApp disponível só para números do Brasil.'), { status: 400, code: 'validation_error' });
      return booking.createBooking(slug, body);
    },
    listBookings,
    cancel: async publicId => booking.cancelByToken(await tokenFor(publicId)),
    reschedule: async (publicId, start) => booking.rescheduleByToken(await tokenFor(publicId), start),
    classify: args => ai.classify(args),
  };
}

async function settingsOf(companyId) {
  if (!companyId) return { bot_enabled: 1, ai_enabled: 0 };
  const [row] = await functions.executeSql('SELECT bot_enabled, ai_enabled, welcome_text FROM whatsapp_settings WHERE company_id = ?', [companyId]);
  return row || { bot_enabled: 1, ai_enabled: 1 };
}

const sayText = body => ({ message: provider.text(body), body });

async function handleMessage(item, { deps: injectedDeps } = {}) {
  const account = await provider.accountByPhoneNumberId(item.phoneNumberId);
  if (!account) return { ignored: 'unknown_number' };
  const contact = await outbound.contactByWaId(item.waId, { create: true, profileName: item.profileName });
  const conversation = await outbound.conversationFor(account, contact);
  const lease = await acquire(conversation.id);
  try {
    // Estado fresco depois da trava.
    const [conv] = await functions.executeSql('SELECT * FROM whatsapp_conversations WHERE id = ?', [conversation.id]);
    const stored = await functions.executeSql(`INSERT IGNORE INTO whatsapp_messages (conversation_id, company_id, direction, author, wamid, type, body, status)
      VALUES (?, ?, 'in', 'customer', ?, ?, ?, 'received')`, [conv.id, conv.company_id, item.wamid, String(item.type || 'text').slice(0, 20), item.text || null]);
    if (!stored.affectedRows) return { duplicate: true };
    const messageId = stored.insertId;

    await functions.executeSql('UPDATE whatsapp_conversations SET last_inbound_at = NOW(), last_message_at = NOW() WHERE id = ?', [conv.id]);
    await functions.executeSql(`UPDATE whatsapp_contacts SET last_inbound_at = NOW(),
        opt_in_at = IF(opt_in_at IS NULL AND opted_out_at IS NULL, NOW(), opt_in_at),
        opt_in_source = IF(opt_in_source IS NULL AND opted_out_at IS NULL, 'inbound_message', opt_in_source) WHERE id = ?`, [contact.id]);

    const ctx = { account, conversation: conv, contact, companyId: conv.company_id };
    const { hits } = await hit(`wa-in:${item.waId}`, 60);
    if (hits > inboundMax()) return { rateLimited: true };

    const text = router.norm(item.text);
    if (OPT_OUT.test(text)) {
      await functions.executeSql('UPDATE whatsapp_contacts SET opted_out_at = NOW() WHERE id = ?', [contact.id]);
      await outbound.replyAll(ctx, [sayText('Pronto, você não vai mais receber mensagens nossas por aqui. Para voltar, envie VOLTAR.')]);
      return { optedOut: true };
    }
    const [fresh] = await functions.executeSql('SELECT opted_out_at FROM whatsapp_contacts WHERE id = ?', [contact.id]);
    if (fresh.opted_out_at) {
      if (!OPT_IN.test(text)) {
        const notice = await hit(`wa-optout-notice:${item.waId}`, 86400);
        if (notice.hits === 1) await outbound.replyAll(ctx, [sayText('Você pediu para não receber mensagens. Para voltar a usar o atendimento, envie VOLTAR.')]);
        return { optedOutSilent: true };
      }
      await functions.executeSql("UPDATE whatsapp_contacts SET opted_out_at = NULL, opt_in_at = NOW(), opt_in_source = 'keyword_voltar' WHERE id = ?", [contact.id]);
    }

    // Atendente humano: o bot fica em silêncio; volta sozinho após o tempo limite.
    if (conv.mode === 'human') {
      const [expired] = await functions.executeSql(`SELECT handoff_at < NOW() - INTERVAL ? HOUR AS expired FROM whatsapp_conversations WHERE id = ?`, [humanTimeoutHours(), conv.id]);
      if (!Number(expired?.expired)) return { human: true };
      await functions.executeSql("UPDATE whatsapp_conversations SET mode = 'bot', assigned_user_id = NULL, handoff_at = NULL, state = 'menu' WHERE id = ?", [conv.id]);
      conv.mode = 'bot';
      conv.state = 'menu';
    }
    const settings = await settingsOf(conv.company_id);
    if (conv.company_id && Number(settings.bot_enabled) === 0) return { botDisabled: true };

    const state = { ...conv, context: parseContext(conv.context) };
    const deps = injectedDeps || depsFor(conv, contact);
    if (conv.company_id && Number(settings.ai_enabled) === 0) deps.classify = null;
    const result = await router.step(state, { text: item.text, replyId: item.replyId || null }, deps);

    const companyId = Object.prototype.hasOwnProperty.call(result, 'companyId') ? result.companyId : conv.company_id;
    if (companyId !== conv.company_id) {
      await functions.executeSql('UPDATE whatsapp_messages SET company_id = ? WHERE id = ?', [companyId, messageId]);
    }
    ctx.companyId = companyId;

    if (result.handoff) {
      if (!companyId) {
        await outbound.replyAll(ctx, [sayText('Primeiro me diga o código do estabelecimento (final do link de agendamento).')]);
        return { handoff: false };
      }
      await functions.executeSql("UPDATE whatsapp_conversations SET mode = 'human', handoff_at = NOW(), assigned_user_id = NULL, state = 'menu' WHERE id = ?", [conv.id]);
      await outbound.replyAll(ctx, [sayText('Certo! Vou chamar alguém da equipe. Assim que possível um atendente responde por aqui.')]);
      return { handoff: true };
    }

    await functions.executeSql('UPDATE whatsapp_conversations SET company_id = ?, state = ?, context = ? WHERE id = ?',
      [companyId, String(result.state || 'menu').slice(0, 40), JSON.stringify(result.context || {}), conv.id]);
    if (result.replies?.length) await outbound.replyAll(ctx, result.replies);
    return { state: result.state, aiUsed: !!result.aiUsed };
  } finally {
    await release(conversation.id, lease).catch(() => {});
  }
}

// Handler do job: { kind: 'message' | 'status', item }.
async function handle(payload, job, options) {
  if (payload?.kind === 'status') return outbound.applyStatus(payload.item || {});
  if (payload?.kind === 'message') return handleMessage(payload.item || {}, options);
  return { ignored: true };
}

module.exports = { handle, handleMessage, OPT_OUT, OPT_IN };
