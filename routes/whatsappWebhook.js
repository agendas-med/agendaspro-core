const express = require('express');
const functions = require('../utils/functions');
const jobsService = require('../services/jobsService');
const { verifySignature, verifyChallenge } = require('../services/whatsapp/signature');
const { parseWebhook } = require('../services/whatsapp/parser');

// Webhook da WhatsApp Cloud API (Meta). Montado ANTES do express.json global: a assinatura
// X-Hub-Signature-256 é sobre o corpo bruto. Responde 200 rápido; o trabalho vai para jobs
// (whatsapp_inbound), executados em seguida no mesmo processo (runNow) e, se falharem, no tick.
const router = express.Router();

const inlineEnabled = () => (process.env.WHATSAPP_INLINE_PROCESS
  ? process.env.WHATSAPP_INLINE_PROCESS === 'true'
  : process.env.NODE_ENV !== 'test');

router.get('/', (req, res) => {
  const challenge = verifyChallenge(req.query || {});
  if (!challenge) return res.status(403).send('Forbidden');
  return res.status(200).type('text/plain').send(challenge);
});

router.post('/', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!verifySignature(raw, req.get('x-hub-signature-256'))) return res.status(401).send({ message: 'Assinatura inválida.' });

  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).send({ message: 'JSON inválido.' }); }

  const { messages, statuses } = parseWebhook(payload);
  const keys = [];
  // Registra o evento (dedupe) e enfileira. Se enfileirar falhar, desfaz o registro para que a
  // reentrega da Meta (após o 500) não seja descartada como duplicada.
  const register = async (externalId, eventType, payloadJob, maxAttempts) => {
    const stored = await functions.executeSql(
      "INSERT IGNORE INTO inbound_events (provider, external_id, event_type, payload, status) VALUES ('meta', ?, ?, NULL, 'processed')", [externalId, eventType]);
    if (!stored.affectedRows) return; // reentrega da Meta: já enfileirado
    const key = `wa_in:${externalId}`.slice(0, 191);
    try {
      await jobsService.enqueue('whatsapp_inbound', payloadJob, { dedupeKey: key, maxAttempts });
    } catch (error) {
      await functions.executeSql("DELETE FROM inbound_events WHERE provider = 'meta' AND external_id = ?", [externalId]).catch(() => {});
      throw error;
    }
    keys.push(key);
  };
  try {
    for (const item of messages) await register(`msg:${item.wamid}`.slice(0, 191), 'message', { kind: 'message', item }, 5);
    for (const item of statuses) await register(`st:${item.wamid}:${item.status}`.slice(0, 191), 'status', { kind: 'status', item }, 3);
  } catch (error) {
    console.error('[meta-webhook] Falha ao registrar evento:', error?.code || 'erro');
    return res.status(500).send({ message: 'Erro ao registrar evento.' });
  }

  res.status(200).send({ received: true });
  if (keys.length && inlineEnabled()) {
    setImmediate(async () => {
      for (const key of keys) {
        try { await jobsService.runNow(key); } catch (error) { console.error('[meta-webhook] Job falhou:', error?.code || 'erro'); }
      }
    });
  }
  jobsService.drainSoon();
  return undefined;
});

module.exports = router;
