const express = require('express');
const Joi = require('joi');
const router = express.Router();
const { member, admin, handle, validateBody } = require('../middleware/tenant');
const assistant = require('../services/assistant/assistantService');
const actions = require('../services/assistant/actions');
const knowledge = require('../services/assistant/knowledge');
const { config } = require('../services/assistant/config');

// Assistente interno do painel (F5-core-B). Empresa e usuário SEMPRE do JWT + Selected-company
// (req.companyId / req.usuario.id); a IA age com as permissões do usuário.
const enabled = (req, res, next) => {
  if (config().enabled) return next();
  return res.status(503).send({ error: { code: 'assistant_disabled', message: 'Assistente indisponível.' } });
};
const ctx = req => ({ companyId: req.companyId, userId: req.usuario.id });
const publicId = Joi.string().pattern(/^[a-f0-9]{32}$/).required();
const paramPublicId = (req, res, next) => {
  const { error } = publicId.validate(req.params.id);
  if (error) return res.status(404).send({ error: { code: 'not_found', message: 'Não encontrado.' } });
  return next();
};
// 429 com Retry-After.
const retryAfter = fn => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (error) {
    if (error?.status === 429 && error.details?.retry_after) res.set('Retry-After', String(error.details.retry_after));
    throw error;
  }
};

const messageSchema = Joi.object({ message: Joi.string().trim().min(1).max(4000).required() });
const confirmSchema = Joi.object({ confirm_token: Joi.string().trim().min(10).max(200).required() });
const knowledgeSchema = Joi.object({
  kind: Joi.string().valid('faq', 'policy', 'rule', 'template').required(),
  title: Joi.string().trim().min(1).max(160).required(),
  content: Joi.string().trim().min(1).max(4000).required(),
  active: Joi.boolean(),
});
// Follow-up 1: PATCH parcial (ao menos um campo).
const knowledgePatchSchema = Joi.object({
  kind: Joi.string().valid('faq', 'policy', 'rule', 'template'),
  title: Joi.string().trim().min(1).max(160),
  content: Joi.string().trim().min(1).max(4000),
  active: Joi.boolean(),
}).min(1);
const knowledgeId = (req, res, next) => {
  const { error, value } = Joi.number().integer().positive().required().validate(req.params.id);
  if (error) return res.status(400).send({ message: 'Id inválido.' });
  req.params.id = value;
  return next();
};

// Follow-up 1: status antes do gate (200 com enabled:false em vez de 503).
router.get('/status', ...member, handle(req => assistant.status(ctx(req))));

router.use(enabled);

router.post('/conversations', ...member, handle(async req => ({ __status: 201, data: await assistant.createConversation(ctx(req)) })));
router.get('/conversations', ...member, handle(req => assistant.listConversations(ctx(req))));
router.get('/conversations/:id', ...member, paramPublicId, handle(req => assistant.getConversation(ctx(req), req.params.id)));
router.post('/conversations/:id/messages', ...member, paramPublicId, validateBody(messageSchema),
  handle(retryAfter(req => assistant.sendMessage(ctx(req), req.params.id, req.body.message))));

router.post('/actions/:id/confirm', ...member, paramPublicId, validateBody(confirmSchema), handle(req => actions.confirm(ctx(req), req.params.id, req.body.confirm_token)));
// Follow-up 1: novo confirm_token para ação pendente do próprio usuário (o anterior é invalidado).
router.post('/actions/:id/token', ...member, paramPublicId, handle(req => actions.reissueToken(ctx(req), req.params.id)));
router.post('/actions/:id/reject', ...member, paramPublicId, handle(req => actions.reject(ctx(req), req.params.id)));

// Base de conhecimento (texto não estruturado para o RAG): somente admin.
router.get('/knowledge', ...admin, handle(req => knowledge.list(req.companyId)));
router.post('/knowledge', ...admin, validateBody(knowledgeSchema), handle(async req => ({ __status: 201, data: await knowledge.create(req.companyId, req.usuario.id, req.body) })));
router.put('/knowledge/:id', ...admin, knowledgeId, validateBody(knowledgeSchema), handle(req => knowledge.update(req.companyId, req.params.id, req.body)));
router.patch('/knowledge/:id', ...admin, knowledgeId, validateBody(knowledgePatchSchema), handle(req => knowledge.update(req.companyId, req.params.id, req.body)));
router.delete('/knowledge/:id', ...admin, knowledgeId, handle(req => knowledge.remove(req.companyId, req.params.id)));


module.exports = router;
