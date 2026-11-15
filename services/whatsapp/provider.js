const axios = require('axios');
const functions = require('../../utils/functions');
const { decrypt } = require('../../utils/crypto');

// Cliente da WhatsApp Cloud API (Graph). Base e versão configuráveis por env (testes apontam
// META_GRAPH_URL para um stub local; nada real é chamado). Token nunca vai para log.
const DEFAULT_GRAPH = 'https://graph.facebook.com';

const graphBase = () => `${(process.env.META_GRAPH_URL || DEFAULT_GRAPH).replace(/\/+$/, '')}/${process.env.META_GRAPH_VERSION || 'v21.0'}`;
const language = () => process.env.WHATSAPP_TEMPLATE_LANG || 'pt_BR';

function cloudEnabled() {
  return process.env.WHATSAPP_CLOUD_ENABLED === 'true' && !!process.env.META_PHONE_NUMBER_ID;
}

class ProviderError extends Error {
  constructor(message, { retryable, code, status } = {}) {
    super(message);
    this.retryable = !!retryable;
    this.providerCode = code || null;
    this.httpStatus = status || null;
  }
}

// Conta da plataforma (número único) criada/atualizada a partir do ambiente.
let platformCache = null;
async function platformAccount() {
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  if (!phoneNumberId) return null;
  if (platformCache?.phone_number_id === phoneNumberId) return platformCache;
  await functions.executeSql(`INSERT INTO whatsapp_accounts (company_id, phone_number_id, waba_id, display_phone) VALUES (NULL, ?, ?, ?)
    ON DUPLICATE KEY UPDATE waba_id = COALESCE(VALUES(waba_id), waba_id), display_phone = COALESCE(VALUES(display_phone), display_phone)`,
  [phoneNumberId, process.env.META_WABA_ID || null, process.env.WHATSAPP_DISPLAY_PHONE || null]);
  const [row] = await functions.executeSql('SELECT * FROM whatsapp_accounts WHERE phone_number_id = ?', [phoneNumberId]);
  platformCache = row;
  return row;
}

async function accountByPhoneNumberId(phoneNumberId) {
  await platformAccount();
  const [row] = await functions.executeSql("SELECT * FROM whatsapp_accounts WHERE phone_number_id = ? AND status = 'active'", [phoneNumberId]);
  return row || null;
}

async function accountById(id) {
  const [row] = await functions.executeSql('SELECT * FROM whatsapp_accounts WHERE id = ?', [id]);
  return row || null;
}

function tokenOf(account) {
  const token = account?.access_token_enc ? decrypt(account.access_token_enc) : process.env.META_ACCESS_TOKEN;
  if (!token) throw new ProviderError('WhatsApp Cloud API sem token configurado.', { retryable: false, code: 'not_configured' });
  return token;
}

// Erros da Meta: 429/5xx/rede e códigos de limite (130429, 131048, 131056, 131000) = tentar de novo.
const RETRYABLE_CODES = new Set(['130429', '131048', '131056', '131000', '1', '2']);
function classify(error) {
  const status = error?.response?.status;
  const code = error?.response?.data?.error?.code !== undefined ? String(error.response.data.error.code) : null;
  const retryable = !status || status >= 500 || status === 429 || (code && RETRYABLE_CODES.has(code));
  return new ProviderError(`Falha no envio WhatsApp (${status || 'rede'}${code ? `/${code}` : ''}).`, { retryable, code: code || (status ? `http_${status}` : 'network'), status });
}

// Envia uma mensagem (corpo Graph sem messaging_product/to). Devolve o wamid.
async function send(account, to, message) {
  if (!cloudEnabled()) throw new ProviderError('WhatsApp Cloud API desligada (WHATSAPP_CLOUD_ENABLED).', { retryable: false, code: 'not_configured' });
  const token = tokenOf(account);
  try {
    const { data } = await axios.post(`${graphBase()}/${encodeURIComponent(account.phone_number_id)}/messages`,
      { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...message },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10000 });
    const wamid = data?.messages?.[0]?.id;
    if (!wamid) throw new ProviderError('Resposta da Cloud API sem id de mensagem.', { retryable: true, code: 'no_id' });
    return String(wamid).slice(0, 191);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw classify(error);
  }
}

// Lista modelos da WABA (sincronização de status de aprovação).
async function listTemplates(account) {
  const waba = account?.waba_id || process.env.META_WABA_ID;
  if (!waba) throw new ProviderError('META_WABA_ID ausente.', { retryable: false, code: 'not_configured' });
  try {
    const { data } = await axios.get(`${graphBase()}/${encodeURIComponent(waba)}/message_templates`, {
      params: { fields: 'name,language,status,category', limit: 200 },
      headers: { Authorization: `Bearer ${tokenOf(account)}` }, timeout: 10000,
    });
    return Array.isArray(data?.data) ? data.data : [];
  } catch (error) {
    throw classify(error);
  }
}

// ---- construtores de mensagem (limites da Cloud API) ----
const cut = (text, max) => String(text ?? '').slice(0, max);

const text = body => ({ type: 'text', text: { preview_url: false, body: cut(body, 4096) } });

function buttons(body, items) {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: cut(body, 1024) },
      action: { buttons: items.slice(0, 3).map(b => ({ type: 'reply', reply: { id: cut(b.id, 256), title: cut(b.title, 20) } })) },
    },
  };
}

function list(body, buttonLabel, rows) {
  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: cut(body, 1024) },
      action: {
        button: cut(buttonLabel, 20),
        sections: [{ title: cut('Opções', 24), rows: rows.slice(0, 10).map(r => ({ id: cut(r.id, 200), title: cut(r.title, 24), ...(r.description ? { description: cut(r.description, 72) } : {}) })) }],
      },
    },
  };
}

function template(name, params = [], lang = language()) {
  return {
    type: 'template',
    template: {
      name, language: { code: lang },
      ...(params.length ? { components: [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: cut(p, 1000) || '-' })) }] } : {}),
    },
  };
}

module.exports = {
  cloudEnabled, platformAccount, accountByPhoneNumberId, accountById, send, listTemplates, ProviderError,
  text, buttons, list, template, language, _resetCache: () => { platformCache = null; },
};
