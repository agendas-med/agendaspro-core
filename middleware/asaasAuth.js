const { timingSafeEqual } = require('node:crypto');
module.exports = (req, res, next) => {
  const expected = process.env.ASAAS_WEBHOOK_TOKEN;
  if (!expected) return res.status(503).json({ message: 'Webhook Asaas não configurado.' });
  const received = req.get('asaas-access-token') || '';
  const a = Buffer.from(expected), b = Buffer.from(received);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).json({ message: 'Token de webhook inválido.' });
  next();
};
