const express = require('express');
const Joi = require('joi');
const { member, handle, validateBody, validateQuery } = require('../middleware/tenant');
const { requireFeature, entitlement } = require('../services/plansService');
const { hit } = require('../middleware/rateLimit');
const companiesService = require('../services/companiesService');
const instagram = require('../services/instagram/service');
const attribution = require('../services/attributionService');

// F6: Instagram (API with Instagram Login). Leitura: qualquer membro; conectar/desconectar: admin (403).
// Free: status, conexão, perfil e últimos 6 posts. Premium (feature "instagram"): insights, histórico,
// comparativo e conversão.
const router = express.Router();

const adminOnly = [...member, (req, res, next) => companiesService.checkCompanyPermission(req.usuario.id, req.companyId)
  .then(() => next())
  .catch(() => res.status(403).send({ error: { code: 'admin_required', message: 'Apenas administradores gerenciam integrações.' } }))];

// refresh=true é limitado por empresa (padrão 6/h); acima disso serve o cache.
async function allowRefresh(req, wanted) {
  if (!wanted) return false;
  const max = Number(process.env.INSTAGRAM_REFRESH_MAX_PER_HOUR) || 6;
  return (await hit(`ig_refresh:${req.companyId}`, 3600)).hits <= max;
}

const boolQuery = Joi.boolean().truthy('1', 'true').falsy('0', 'false').default(false);

router.get('/status', member, handle(req => instagram.status(req.companyId)));

router.post('/connect/start', adminOnly, validateBody(Joi.object({ redirect_uri: Joi.string().uri().max(500) })),
  handle(req => instagram.startConnect({ companyId: req.companyId, userId: req.usuario.id, redirectUri: req.body.redirect_uri })));

router.post('/callback', adminOnly, validateBody(Joi.object({ code: Joi.string().max(2000).required(), state: Joi.string().max(600).required() })),
  handle(req => instagram.completeConnect({ companyId: req.companyId, userId: req.usuario.id, code: req.body.code, state: req.body.state })));

router.post('/disconnect', adminOnly, handle(req => instagram.disconnect(req.companyId)));

router.get('/overview', member, validateQuery(Joi.object({ refresh: boolQuery })), handle(async req => {
  const ent = await entitlement(req.companyId);
  return instagram.overview(req.companyId, { ent, refresh: await allowRefresh(req, req.validQuery.refresh) });
}));

router.get('/posts', member, validateQuery(Joi.object({ refresh: boolQuery, limit: Joi.number().integer().min(1).max(50).default(12), before: Joi.string().max(64) })), handle(async req => {
  const ent = await entitlement(req.companyId);
  return instagram.posts(req.companyId, { ent, refresh: await allowRefresh(req, req.validQuery.refresh), limit: req.validQuery.limit, before: req.validQuery.before });
}));

router.post('/refresh', member, handle(async req => {
  const ent = await entitlement(req.companyId);
  if (!(await allowRefresh(req, true))) return instagram.overview(req.companyId, { ent, refresh: false });
  const out = await instagram.overview(req.companyId, { ent, refresh: true });
  if (ent.features.instagram === true) await instagram.insights(req.companyId, { ent, refresh: false });
  return out;
}));

router.get('/insights', member, requireFeature('instagram'), validateQuery(Joi.object({ refresh: boolQuery, days: Joi.number().integer().min(1).max(365).default(30) })), handle(async req => {
  const ent = await entitlement(req.companyId);
  return instagram.insights(req.companyId, { ent, refresh: await allowRefresh(req, req.validQuery.refresh), days: req.validQuery.days });
}));

router.get('/conversion', member, requireFeature('instagram'), validateQuery(Joi.object({
  from: Joi.date().iso(), to: Joi.date().iso(), utm_campaign: Joi.string().max(80),
})), handle(req => attribution.instagramConversion(req.companyId, req.validQuery)));

// Link UTM para a página pública. Bio (utm_content vazio) liberado a todos; por post/campanha é Premium.
router.post('/utm-link', member, validateBody(Joi.object({
  placement: Joi.string().valid('bio', 'post', 'story', 'campaign').default('bio'),
  campaign: Joi.string().trim().lowercase().pattern(/^[a-z0-9_-]{1,80}$/),
  content: Joi.string().trim().lowercase().pattern(/^[a-z0-9_-]{1,80}$/),
  label: Joi.string().trim().max(120),
})), handle(async req => {
  const ent = await entitlement(req.companyId);
  return { __status: 201, data: await attribution.createInstagramLink(req.companyId, req.usuario.id, req.body, ent) };
}));

router.get('/utm-links', member, handle(req => attribution.listLinks(req.companyId, 'instagram')));

module.exports = router;
