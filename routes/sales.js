const express = require('express');
const router = express.Router();
const login = require('../middleware/login');
const validate = require('../middleware/validate');
const sales = require('../services/salesService');
const payments = require('../services/paymentsService');
const functions = require('../utils/functions');
const handle = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (error) { res.status(400).send(error.response?.data?.errors?.[0]?.description || error.message || String(error)); }
};
router.use(login, validate.validateCompanyAccess);
router.get('/', handle(async (req, res) => {
  res.json(functions.createResponse('Retorno das vendas', await sales.returnSales(req.headers['selected-company']), 'GET', 200));
}));
router.get('/:id', handle(async (req, res) => {
  res.json(functions.createResponse('Retorno da venda', await sales.returnSale(req.params.id, req.headers['selected-company']), 'GET', 200));
}));
router.post('/', validate.validateRequest(validate.schemas.sales.create), handle(async (req, res) => {
  const d = req.body;
  const id = await sales.create(req.headers['selected-company'], d.customer_id, d.appointment_id, d.products, d.status);
  res.json(functions.createResponse('Venda criada com sucesso', { id }, 'POST', 200));
}));
router.patch('/:id', validate.validateRequest(validate.schemas.sales.create), handle(async (req, res) => {
  const d = req.body;
  await sales.update(req.params.id, req.headers['selected-company'], d.customer_id, d.appointment_id, d.products, req.query.finish === 'true' ? 'realizada' : d.status);
  res.json(functions.createResponse('Venda atualizada com sucesso', null, 'PATCH', 200));
}));
router.delete('/:id', handle(async (req, res) => {
  await sales.delete(req.params.id, req.headers['selected-company']);
  res.json(functions.createResponse('Venda excluída com sucesso', null, 'DELETE', 200));
}));
router.post('/insert_payment', validate.validateRequest(validate.schemas.payments.create), handle(async (req, res) => {
  res.json(await payments.insert(req.headers['selected-company'], req.body));
}));
router.post('/cancel_pix', handle(async (req, res) => {
  if (!Number.isInteger(Number(req.body.sale_id)) || Number(req.body.sale_id) < 1) return res.status(400).send('Venda inválida.');
  await payments.cancelPix(req.headers['selected-company'], req.body.sale_id);
  res.json({ message: 'Pix cancelado com sucesso.' });
}));
module.exports = router;
