const functions = require('../utils/functions');
const { normalizePhone } = require('./publicBookingService');

// POST /public/leads (site institucional). Turnstile e limites ficam no guard da rota.
async function createLead(body, { guard = async () => {} } = {}) {
  const whatsapp = normalizePhone(body.whatsapp);
  if (!whatsapp) throw Object.assign(new Error('Informe um WhatsApp válido com DDD.'), { status: 400, code: 'validation_error' });
  await guard({ phone: whatsapp });
  const result = await functions.executeSql(
    'INSERT INTO leads (name, whatsapp, email, segment, source, message, consent_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
    [String(body.name).trim(), whatsapp, body.email ? String(body.email).trim().toLowerCase() : null, body.segment, body.source, body.message ? String(body.message).trim() : null],
  );
  const jobs = require('./jobsService');
  await jobs.enqueue('lead_notify', { lead_id: result.insertId }, { dedupeKey: `lead_notify:${result.insertId}`, maxAttempts: 5 })
    .catch(error => console.error('[public] Falha ao enfileirar lead:', error?.code || 'erro'));
  jobs.drainSoon();
  return { ok: true };
}

module.exports = { createLead };
