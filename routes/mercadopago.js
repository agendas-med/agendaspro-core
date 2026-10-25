const express = require('express');
const router = express.Router();
const login = require('../middleware/login');
const validate = require('../middleware/validate');
const functions = require('../utils/functions');
const payments = require('../services/mercadoPagoPaymentsService');
const handle = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (error) { res.status(400).json({ message: error.message }); }
};
router.use(login, validate.validateCompanyAccess);
// Alterar o destino ou liberar saída de dinheiro exige o cargo administrativo da própria empresa.
const admin = async (req, res, next) => {
  try {
    const rows = await functions.executeSql(`SELECT 1 FROM config_users_roles ur JOIN config_company_roles r ON r.id = ur.role_id
      WHERE ur.user_id = ? AND r.company_id = ? AND r.permission = 1 LIMIT 1`, [req.usuario.id, req.headers['selected-company']]);
    if (!rows.length) return res.status(403).json({ message: 'Permissão de administrador necessária.' });
    next();
  } catch { res.status(503).json({ message: 'Não foi possível verificar a permissão.' }); }
};
router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) < 1) return res.status(400).json({ message: 'Identificador inválido.' });
  next();
});
router.get('/status', handle(async (req, res) => res.json(await payments.status(req.headers['selected-company']))));
router.put('/destination', admin, handle(async (req, res) => res.json(await payments.saveDestination(req.headers['selected-company'], req.usuario.id, req.body))));
router.post('/charges', validate.validateRequest(validate.schemas.payments.create), handle(async (req, res) => {
  if (req.body.payment_type !== 'pix_mercadopago') return res.status(400).json({ message: 'Use payment_type pix_mercadopago.' });
  res.json(await payments.createCharge(req.headers['selected-company'], req.body, req.headers['idempotency-key']));
}));
router.get('/charges/:id', handle(async (req, res) => res.json(payments.publicCharge(await payments.getCharge(req.headers['selected-company'], req.params.id)))));
router.post('/charges/:id/reconcile', handle(async (req, res) => res.json(await payments.reconcileCharge(req.headers['selected-company'], Number(req.params.id)))));
router.get('/payouts', handle(async (req, res) => res.json(await payments.listPayouts(req.headers['selected-company']))));
router.post('/payouts/:id/submit', admin, handle(async (req, res) => res.json(await payments.submitPayout(req.headers['selected-company'], Number(req.params.id)))));
router.post('/payouts/:id/reconcile', handle(async (req, res) => res.json(await payments.reconcilePayout(req.headers['selected-company'], Number(req.params.id)))));
module.exports = router;
