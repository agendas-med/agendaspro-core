const express = require('express');
const Joi = require('joi');
const router = express.Router();
const { member, admin, handle, validateBody, validateQuery } = require('../middleware/tenant');
const professionals = require('../services/professionalsService');
const { paramId } = require('./professionals');

const id = Joi.number().integer().positive();
const wall = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/).messages({ 'string.pattern.base': 'Use YYYY-MM-DD HH:mm (hora local da empresa).' });
const createSchema = Joi.object({
  professional_id: id.allow(null), // null/ausente = empresa inteira (feriado)
  starts_at: wall.required(),
  ends_at: wall.required(),
  reason: Joi.string().trim().max(160).allow(null, ''),
});
const listQuery = Joi.object({ from: wall, to: wall, professional_id: id, include_company_blocks: Joi.boolean().truthy('1').falsy('0').default(true) });

router.get('/', ...member, validateQuery(listQuery), handle(req => professionals.listBlocks(req.companyId, req.validQuery)));
router.post('/', ...admin, validateBody(createSchema), handle(async req => ({ __status: 201, data: await professionals.createBlock(req.companyId, req.body) })));
router.delete('/:id', ...admin, paramId, handle(async req => { await professionals.deleteBlock(req.companyId, req.params.id); return { deleted: true }; }));

module.exports = router;
