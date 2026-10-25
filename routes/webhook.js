const express = require('express');
const router = express.Router();
const _openaiService = require('../services/openaiService');
const functions = require('../utils/functions');
const webhookAuth = require('../middleware/webhookAuth');

router.post('/mercadopago', async (req, res) => {
    if (!require('../utils/mercadoPago').verifySignature(req, process.env.MP_WEBHOOK_SECRET)) return res.status(401).json({ message: 'Assinatura inválida.' });
    if (!['payment', 'order', 'subscription_preapproval', 'subscription_authorized_payment'].includes(req.body.type)) return res.json({ ignored: true });
    try { res.json(req.body.type.startsWith('subscription_')
      ? await require('../services/mercadoPagoPlansService').notification(req.query['data.id'], req.body.type)
      : await require('../services/mercadoPagoSplitService').paymentNotification(req.query['data.id'], req.body.type, req.query.charge_id, req.body.user_id)); }
    catch { res.status(503).json({ message: 'Não foi possível reconciliar o pagamento.' }); }
});
router.post('/mercadopago/payouts', async (req, res) => {
    res.status(410).json({ message: 'Payouts substituído por split 1:1.' });
});

router.post("/whatsapp", webhookAuth, async (req, res) => {
    try {
        const { phone, message } = req.body;

        if (!phone || !message) {
            return res.status(400).send(functions.createResponse("Dados inválidos", null, "POST", 400));
        }

        const aiResponse = await _openaiService.processWhatsAppMessage(phone, message);

        let response = functions.createResponse("Mensagem processada", aiResponse, "POST", 200);
        return res.status(200).send(response);
    } catch (error) {
        console.log(error)
        return res.status(500).send(functions.createResponse("Erro interno", error.message, "POST", 500));
    }
});

router.post("/asaas", require('../middleware/asaasAuth'), async (req, res) => {
    try {
        const event = req.body.event; 
        const payment = req.body.payment;

        if (event === "PAYMENT_RECEIVED" || event === "PAYMENT_CONFIRMED") {
            if (!payment?.externalReference?.match(/^(APP|SALE)_/)) return res.status(200).json({ ignored: true });
            await require('../services/paymentsService').confirm(payment);
        }

        res.status(200).send({ received: true });
    } catch (error) {
        console.error("[Asaas Webhook Error]", error);
        res.status(500).send("Erro no webhook");
    }
});

module.exports = router;
