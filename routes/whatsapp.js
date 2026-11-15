const express = require('express');
const Joi = require('joi');
const router = express.Router();
const { member, admin, handle, validateBody, validateQuery } = require('../middleware/tenant');
const inbox = require('../services/whatsapp/inbox');

// Painel WhatsApp (F4). Empresa sempre da sessão (req.companyId). Atendimento: membro;
// configuração: admin.
const id = Joi.number().integer().positive();
const paramId = (req, res, next) => {
  const { error, value } = id.required().validate(req.params.id);
  if (error) return res.status(400).send({ message: 'Id inválido.' });
  req.params.id = value;
  return next();
};

const configSchema = Joi.object({
  bot_enabled: Joi.boolean(),
  ai_enabled: Joi.boolean(),
  welcome_text: Joi.string().trim().max(300).allow(null, ''),
  ai_daily_token_limit: Joi.number().integer().min(0).max(1000000).allow(null),
}).min(1);
const listQuery = Joi.object({
  mode: Joi.string().valid('bot', 'human'),
  assigned_to_me: Joi.boolean().truthy('1').falsy('0'),
  limit: Joi.number().integer().min(1).max(100).default(50),
  offset: Joi.number().integer().min(0).max(100000).default(0),
});
const messagesQuery = Joi.object({ before_id: id, limit: Joi.number().integer().min(1).max(200).default(50) });
const sendSchema = Joi.object({
  text: Joi.string().trim().min(1).max(4096),
  template: Joi.string().trim().pattern(/^[a-z0-9_]{1,80}$/),
  params: Joi.array().items(Joi.string().trim().max(1000)).max(10).default([]),
}).xor('text', 'template');
const usageQuery = Joi.object({ period: Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])$/) });

router.get('/status', ...member, handle(req => inbox.status(req.companyId)));
router.put('/config', ...admin, validateBody(configSchema), handle(req => inbox.updateConfig(req.companyId, req.body)));
router.get('/conversations', ...member, validateQuery(listQuery), handle(req => inbox.listConversations(req.companyId, { ...req.validQuery, userId: req.usuario.id })));
router.get('/conversations/:id', ...member, paramId, handle(req => inbox.getConversation(req.companyId, req.params.id)));
router.get('/conversations/:id/messages', ...member, paramId, validateQuery(messagesQuery), handle(req => inbox.listMessages(req.companyId, req.params.id, req.validQuery)));
router.post('/conversations/:id/assume', ...member, paramId, handle(req => inbox.assume(req.companyId, req.params.id, req.usuario.id)));
router.post('/conversations/:id/release', ...member, paramId, handle(req => inbox.release(req.companyId, req.params.id)));
router.post('/conversations/:id/messages', ...member, paramId, validateBody(sendSchema),
  handle(async req => ({ __status: 201, data: await inbox.send(req.companyId, req.params.id, req.usuario.id, req.body) })));
router.get('/templates', ...member, handle(() => inbox.templates()));
router.get('/usage', ...member, validateQuery(usageQuery), handle(req => inbox.usage(req.companyId, req.validQuery.period)));

module.exports = router;
