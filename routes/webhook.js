const express = require('express');
const router = express.Router();
const _openaiService = require('../services/openaiService');
const functions = require('../utils/functions');
const webhookAuth = require('../middleware/webhookAuth');
const jobsService = require('../services/jobsService');
const { sendError } = require('../middleware/errorHandler');

const MEDIA_REPLY = "Por enquanto consigo ler apenas mensagens de texto. 🙂 Pode escrever o que você precisa?";

router.post("/whatsapp", webhookAuth, async (req, res) => {
    jobsService.drainSoon();
    try {
        const { phone, message } = req.body || {};

        if (typeof phone !== 'string' && typeof phone !== 'number') {
            return res.status(400).send(functions.createResponse("Dados inválidos", null, "POST", 400));
        }
        const digits = String(phone).replace(/\D/g, "");
        if (digits.length < 10 || digits.length > 15) {
            return res.status(400).send(functions.createResponse("Dados inválidos", null, "POST", 400));
        }
        // Áudio, imagem, figurinha etc. chegam sem texto: resposta educada em vez de 400.
        if (typeof message !== 'string' || !message.trim()) {
            return res.status(200).send(functions.createResponse("Mensagem processada", { reply: MEDIA_REPLY }, "POST", 200));
        }

        const aiResponse = await _openaiService.processWhatsAppMessage(digits, message.slice(0, 2000));
        return res.status(200).send(functions.createResponse("Mensagem processada", aiResponse, "POST", 200));
    } catch (error) {
        return sendError(req, res, error);
    }
});

// Eventos Asaas: dedupe por id externo em inbound_events (reentregas não reprocessam o que
// já foi processado; falhas podem ser reentregues pelo Asaas e reprocessadas).
const RECEIVED = new Set(["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"]);
const EXPIRED = new Set(["PAYMENT_OVERDUE", "PAYMENT_DELETED"]);
const REVERSAL = {
    PAYMENT_REFUNDED: "REFUNDED",
    PAYMENT_PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
    PAYMENT_REFUND_IN_PROGRESS: "REFUND_IN_PROGRESS",
    PAYMENT_CHARGEBACK_REQUESTED: "CHARGEBACK_REQUESTED",
    PAYMENT_CHARGEBACK_DISPUTE: "CHARGEBACK_DISPUTE",
    PAYMENT_AWAITING_CHARGEBACK_REVERSAL: "AWAITING_CHARGEBACK_REVERSAL",
};

async function handleAsaasEvent(event, payment) {
    const payments = require('../services/paymentsService');
    if (!payment?.externalReference?.match(/^(APP|SALE)_/)) return { ignored: true };
    if (RECEIVED.has(event)) return payments.confirm(payment);
    if (EXPIRED.has(event)) return payments.expire(payment);
    if (REVERSAL[event]) return payments.markReversal(payment, REVERSAL[event]);
    return { ignored: true };
}

router.post("/asaas", require('../middleware/asaasAuth'), async (req, res) => {
    jobsService.drainSoon();
    const event = typeof req.body?.event === 'string' ? req.body.event.slice(0, 100) : '';
    const payment = req.body?.payment;
    const externalId = String(req.body?.id || (payment?.id ? `${event}:${payment.id}` : '')).slice(0, 191);
    if (!event || !externalId) return res.status(400).send({ message: "Evento inválido." });

    try {
        await functions.executeSql(
            `INSERT IGNORE INTO inbound_events (provider, external_id, event_type, payload) VALUES ('asaas', ?, ?, ?)`,
            [externalId, event, JSON.stringify({ event, payment: payment ? { id: payment.id, externalReference: payment.externalReference, value: payment.value, status: payment.status } : null })]
        );
        const [stored] = await functions.executeSql(`SELECT id, status FROM inbound_events WHERE provider = 'asaas' AND external_id = ?`, [externalId]);
        if (stored.status === 'processed' || stored.status === 'ignored') return res.status(200).send({ received: true, duplicate: true });

        try {
            const outcome = await handleAsaasEvent(event, payment);
            await functions.executeSql(
                `UPDATE inbound_events SET status = ?, attempts = attempts + 1, processed_at = NOW(), last_error = NULL WHERE id = ?`,
                [outcome?.ignored ? 'ignored' : 'processed', stored.id]
            );
            return res.status(200).send(outcome?.ignored ? { ignored: true } : { received: true });
        } catch (error) {
            await functions.executeSql(
                `UPDATE inbound_events SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?`,
                [String(error?.message || error).slice(0, 500), stored.id]
            ).catch(() => {});
            console.error("[Asaas Webhook] Falha ao processar evento", event, String(error?.message || error).slice(0, 200));
            return res.status(500).send("Erro no webhook");
        }
    } catch (error) {
        return sendError(req, res, error);
    }
});

module.exports = router;
