function validateWebhookToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const apiKeyHeader = req.headers['apikey'] || req.headers['x-api-key']; 
    const queryToken = req.query.token;

    let receivedToken = '';

    if (authHeader && authHeader.startsWith('Bearer ')) {
        receivedToken = authHeader.split(' ')[1];
    } else if (apiKeyHeader) {
        receivedToken = apiKeyHeader;
    } else if (queryToken) {
        receivedToken = queryToken;
    }

    const expectedToken = process.env.WEBHOOK_SECRET_TOKEN;

    if (!expectedToken) {
        console.warn("⚠️ ALERTA: WEBHOOK_SECRET_TOKEN não configurado no .env! Bloqueando requisição por segurança.");
        return res.status(500).json({ error: 'Server configuration error.' });
    }

    if (receivedToken === expectedToken) {
        return next();
    } else {
        console.error(`🚨 Invasão bloqueada no Webhook! Token recebido: ${receivedToken}`);
        return res.status(401).json({ error: 'Unauthorized: Access Denied' });
    }
}

module.exports = validateWebhookToken;