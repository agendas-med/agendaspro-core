const express = require('express');
const router = express.Router();
const _openaiService = require('../services/openaiService');
const functions = require('../utils/functions');
const webhookAuth = require('../middleware/webhookAuth');

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

module.exports = router;