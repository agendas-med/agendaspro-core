const { safeEqual } = require('../utils/crypto');

// Webhook de entrada do WhatsApp (gateway -> API). Token só por header, comparado em tempo
// constante. WHATSAPP_INBOUND_TOKEN é o nome novo; WEBHOOK_SECRET_TOKEN segue como fallback.
function validateWebhookToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const apiKeyHeader = req.headers['apikey'] || req.headers['x-api-key'];
    let receivedToken = '';
    if (authHeader && authHeader.startsWith('Bearer ')) receivedToken = authHeader.slice(7).trim();
    else if (typeof apiKeyHeader === 'string') receivedToken = apiKeyHeader;

    const expectedToken = process.env.WHATSAPP_INBOUND_TOKEN || process.env.WEBHOOK_SECRET_TOKEN;
    if (!expectedToken) {
        console.warn('[webhook] WHATSAPP_INBOUND_TOKEN não configurado; requisição bloqueada.');
        return res.status(503).json({ error: 'Webhook não configurado.' });
    }
    if (safeEqual(receivedToken, expectedToken)) return next();
    console.warn('[webhook] token inválido recebido');
    return res.status(401).json({ error: 'Unauthorized: Access Denied' });
}

module.exports = validateWebhookToken;
