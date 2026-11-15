const express = require('express');
const Joi = require('joi');
const router = express.Router();
const { member, admin, handle, validateBody, validateQuery } = require('../middleware/tenant');
const billing = require('../services/billingService');
const plans = require('../services/plansService');

const date = Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/).messages({ 'string.pattern.base': 'Use YYYY-MM-DD.' });
const subscribeSchema = Joi.object({
  plan_code: Joi.string().valid('free', 'premium').required(),
  billing_type: Joi.string().valid(...billing.BILLING_TYPES).default('UNDEFINED'),
});
const commissionsQuery = Joi.object({ from: date, to: date });

// Catálogo público aos membros (preço em centavos, comissão em bps, limites: null = ilimitado).
router.get('/plans', ...member, handle(async () => (await plans.listPlans()).map(({ id, ...plan }) => plan)));

// Plano efetivo (calculado na leitura) + assinatura + link da fatura em aberto.
router.get('/subscription', ...member, handle(req => billing.getOverview(req.companyId)));

// Assinar Premium / voltar ao Free. Retorna o mesmo formato de GET /billing/subscription.
router.post('/subscription', ...admin, validateBody(subscribeSchema), handle(req => billing.changePlan(req.companyId, req.body)));

router.get('/invoices', ...admin, handle(req => billing.listInvoices(req.companyId)));

// Comissões por venda online (recibos): itens + totais liquidados (gross/commission/net em centavos).
router.get('/commissions', ...admin, validateQuery(commissionsQuery), handle(req => billing.listCommissions(req.companyId, req.validQuery)));

module.exports = router;
