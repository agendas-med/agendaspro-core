const express = require('express');
const Joi = require('joi');
const router = express.Router();
const { member, admin, handle, validateBody, validateQuery } = require('../middleware/tenant');
const professionals = require('../services/professionalsService');
const { paramId } = require('./professionals');

const id = Joi.number().integer().positive();
const time = Joi.string().pattern(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/).messages({ 'string.pattern.base': 'Use o formato HH:mm.' });
const rule = { weekday: Joi.number().integer().min(0).max(6).required(), start_time: time.required(), end_time: time.required() };
const createSchema = Joi.object({ professional_id: id.required(), ...rule });
const replaceSchema = Joi.object({ rules: Joi.array().items(Joi.object(rule)).max(50).required() });
const listQuery = Joi.object({ professional_id: id });

// Expediente semanal por profissional (weekday 0 = domingo; horas no fuso da empresa).
router.get('/', ...member, validateQuery(listQuery), handle(req => professionals.listRules(req.companyId, req.validQuery)));
router.post('/', ...admin, validateBody(createSchema), handle(async req => ({ __status: 201, data: await professionals.createRule(req.companyId, req.body) })));
// Substitui todas as regras do profissional de uma vez.
router.put('/professional/:id', ...admin, paramId, validateBody(replaceSchema), handle(req => professionals.replaceRules(req.companyId, req.params.id, req.body.rules)));
router.delete('/:id', ...admin, paramId, handle(async req => { await professionals.deleteRule(req.companyId, req.params.id); return { deleted: true }; }));

module.exports = router;
