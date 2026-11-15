// Normaliza o payload do webhook da Meta (object = whatsapp_business_account) em itens
// independentes: mensagens recebidas e status de entrega. Um POST pode trazer vários.
// Nada aqui confia no conteúdo: textos são cortados e ids validados.
const MAX_TEXT = 2000;
const WAMID_RE = /^[A-Za-z0-9._:=+/-]{8,191}$/;
const WA_ID_RE = /^\d{8,15}$/;
const STATUS = new Set(['sent', 'delivered', 'read', 'failed']);

const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);

function messageContent(msg) {
  switch (msg.type) {
    case 'text':
      return { type: 'text', text: clip(msg.text?.body, MAX_TEXT) || '' };
    case 'interactive': {
      const reply = msg.interactive?.button_reply || msg.interactive?.list_reply;
      return { type: 'interactive', text: clip(reply?.title, 200) || '', replyId: clip(reply?.id, 200) };
    }
    case 'button': // resposta a botão de template
      return { type: 'button', text: clip(msg.button?.text, 200) || '', replyId: clip(msg.button?.payload, 200) };
    default:
      return { type: clip(String(msg.type || 'unknown'), 20), text: '' };
  }
}

function parseWebhook(payload) {
  const out = { messages: [], statuses: [] };
  if (!payload || payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) return out;
  for (const entry of payload.entry.slice(0, 50)) {
    for (const change of (Array.isArray(entry?.changes) ? entry.changes : []).slice(0, 50)) {
      if (change?.field !== 'messages') continue;
      const value = change.value || {};
      const phoneNumberId = clip(String(value.metadata?.phone_number_id || ''), 64);
      if (!phoneNumberId) continue;
      const names = new Map((Array.isArray(value.contacts) ? value.contacts : []).map(c => [String(c?.wa_id || ''), clip(c?.profile?.name, 120)]));
      for (const msg of (Array.isArray(value.messages) ? value.messages : []).slice(0, 100)) {
        const waId = String(msg?.from || '');
        const wamid = String(msg?.id || '');
        if (!WA_ID_RE.test(waId) || !WAMID_RE.test(wamid)) continue;
        out.messages.push({
          phoneNumberId, waId, wamid, profileName: names.get(waId) || null,
          timestamp: Number(msg.timestamp) || null, ...messageContent(msg),
        });
      }
      for (const st of (Array.isArray(value.statuses) ? value.statuses : []).slice(0, 100)) {
        const wamid = String(st?.id || '');
        if (!WAMID_RE.test(wamid) || !STATUS.has(st?.status)) continue;
        out.statuses.push({
          phoneNumberId, wamid, status: st.status, recipient: clip(String(st.recipient_id || ''), 20),
          errorCode: st.errors?.[0]?.code ? clip(String(st.errors[0].code), 40) : null,
          timestamp: Number(st.timestamp) || null,
        });
      }
    }
  }
  return out;
}

module.exports = { parseWebhook, MAX_TEXT };
