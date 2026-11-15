const { safeEqual } = require('../utils/crypto');

// Protege rotas administrativas/internas com um token de ambiente (comparação em tempo constante).
// Aceita somente header (Authorization: Bearer <token> ou X-Admin-Token); nunca query string.
module.exports = function requireToken(envName) {
  return (req, res, next) => {
    const expected = process.env[envName];
    if (!expected) return res.status(503).send({ message: 'Rota desabilitada neste ambiente.' });
    const auth = req.get('authorization') || '';
    const received = auth.startsWith('Bearer ') ? auth.slice(7).trim() : (req.get('x-admin-token') || '');
    if (!safeEqual(received, expected)) return res.status(401).send({ message: 'Não autorizado.' });
    next();
  };
};
