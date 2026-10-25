const express = require('express');
const router = express.Router();
const login = require('../middleware/login');
const validate = require('../middleware/validate');
const functions = require('../utils/functions');
const payments = require('../services/mercadoPagoSplitService');
const connections = require('../services/mercadoPagoConnectionsService');
const plans = require('../services/mercadoPagoPlansService');
const handle = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (error) { res.status(400).json({ message: error.message }); }
};
router.get('/oauth/callback', async (req, res) => {
  const target = new URL('/configuracoes/recebimentos', process.env.URL_SITE);
  try {
    const companyId = await connections.callback(req.query.state, req.query.code);
    target.searchParams.set('connection', 'success');
    target.searchParams.set('company', companyId);
  } catch { target.searchParams.set('connection', 'failed'); }
  res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer').redirect(target.href);
});
router.use(login, validate.validateCompanyAccess);
// Conectar contas e contratar/cancelar planos exige administração da própria empresa.
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
router.get('/charges', handle(async (req, res) => res.json(await payments.listCharges(req.headers['selected-company']))));
router.post('/connect', admin, handle(async (req, res) => res.json(await connections.start(req.headers['selected-company'], req.usuario.id))));
router.post('/disconnect', admin, handle(async (req, res) => res.json(await connections.disconnect(req.headers['selected-company']))));
router.get('/plans', handle(async (req, res) => res.json(await plans.status(req.headers['selected-company']))));
router.post('/plans/premium', admin, handle(async (req, res) => res.json(await plans.subscribe(req.headers['selected-company']))));
router.post('/plans/:id/reconcile', admin, handle(async (req, res) => res.json(await plans.reconcile(req.headers['selected-company'], Number(req.params.id)))));
router.post('/plans/:id/cancel', admin, handle(async (req, res) => res.json(await plans.cancel(req.headers['selected-company'], Number(req.params.id)))));
router.post('/charges', validate.validateRequest(validate.schemas.payments.create), handle(async (req, res) => {
  if (req.body.payment_type !== 'mercadopago') return res.status(400).json({ message: 'Use payment_type mercadopago.' });
  res.json(await payments.createCharge(req.headers['selected-company'], req.body, req.headers['idempotency-key']));
}));
router.get('/charges/:id', handle(async (req, res) => res.json(payments.publicCharge(await payments.getCharge(req.headers['selected-company'], req.params.id)))));
router.post('/charges/:id/reconcile', handle(async (req, res) => res.json(await payments.reconcileCharge(req.headers['selected-company'], Number(req.params.id)))));
router.all('/payouts*', (req, res) => res.status(410).json({ message: 'Payouts substituído por split 1:1. Conecte sua conta Mercado Pago.' }));
router.all('/destination', (req, res) => res.status(410).json({ message: 'Conecte sua conta Mercado Pago para receber por split.' }));
module.exports = router;
