const { safeEqual } = require('../utils/crypto');
module.exports = (req, res, next) => {
  const expected = process.env.ASAAS_WEBHOOK_TOKEN;
  if (!expected) return res.status(503).json({ message: 'Webhook Asaas não configurado.' });
  if (!safeEqual(req.get('asaas-access-token') || '', expected)) return res.status(401).json({ message: 'Token de webhook inválido.' });
  next();
};
