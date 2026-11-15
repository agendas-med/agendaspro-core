const express = require('express');
const Joi = require('joi');
const router = express.Router();
const { member, admin, handle, validateBody, validateQuery } = require('../middleware/tenant');
const professionals = require('../services/professionalsService');

const id = Joi.number().integer().positive();
const fields = {
  name: Joi.string().trim().min(2).max(120),
  email: Joi.string().email({ tlds: { allow: false } }).max(255).allow(null, ''),
  phone: Joi.string().pattern(/^[\d\s()+-]{8,20}$/).allow(null, ''),
  photo_url: Joi.string().uri({ scheme: ['https', 'http'] }).max(500).allow(null, ''),
  color: Joi.string().pattern(/^#[0-9a-fA-F]{6}$/).allow(null, ''),
  user_id: id.allow(null),
  service_ids: Joi.array().items(id).max(200).unique(),
};
const createSchema = Joi.object({ ...fields, name: fields.name.required() });
const updateSchema = Joi.object({ ...fields, active: Joi.boolean() }).min(1);
const listQuery = Joi.object({ include_inactive: Joi.boolean().default(false) });
const paramId = (req, res, next) => {
  const { error, value } = id.required().validate(req.params.id);
  if (error) return res.status(400).send({ message: 'Identificador inválido.' });
  req.params.id = value;
  next();
};

router.get('/', ...member, validateQuery(listQuery), handle(req => professionals.list(req.companyId, { includeInactive: req.validQuery.include_inactive })));
router.get('/:id', ...member, paramId, handle(req => professionals.get(req.companyId, req.params.id)));
// Criação respeita a quota max_professionals do plano (402 plan_upgrade_required).
router.post('/', ...admin, validateBody(createSchema), handle(async req => ({ __status: 201, data: await professionals.create(req.companyId, req.body) })));
router.patch('/:id', ...admin, paramId, validateBody(updateSchema), handle(req => professionals.update(req.companyId, req.params.id, req.body)));
router.delete('/:id', ...admin, paramId, handle(async req => { await professionals.deactivate(req.companyId, req.params.id); return { deactivated: true }; }));

router.paramId = paramId;
module.exports = router;
