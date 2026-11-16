const express = require('express');
const Joi = require('joi');
const { member, handle, validateBody } = require('../middleware/tenant');
const { requireFeature } = require('../services/plansService');
const { hit } = require('../middleware/rateLimit');
const companiesService = require('../services/companiesService');
const gcal = require('../services/googleCalendar/service');
const sync = require('../services/googleCalendar/sync');

// F6: Google Agenda (Premium "google_calendar"). Leitura de status/vínculos: qualquer membro.
// Conectar, listar calendários da conta, vincular/desvincular, sincronizar e desconectar: admin (403).
// Desconectar fica liberado em qualquer plano (quem caiu para o Free consegue apagar os dados).
// O login com Google (routes/users.js) é independente desta integração.
const router = express.Router();

const adminOnly = [...member, (req, res, next) => companiesService.checkCompanyPermission(req.usuario.id, req.companyId)
  .then(() => next())
  .catch(() => res.status(403).send({ error: { code: 'admin_required', message: 'Apenas administradores gerenciam integrações.' } }))];
const premium = requireFeature(gcal.FEATURE);
const id = Joi.number().integer().positive();
const calendarId = Joi.string().trim().max(190);

router.get('/status', member, handle(req => gcal.status(req.companyId)));

router.post('/connect/start', adminOnly, premium, validateBody(Joi.object({ redirect_uri: Joi.string().uri().max(500) })),
  handle(req => gcal.startConnect({ companyId: req.companyId, userId: req.usuario.id, redirectUri: req.body.redirect_uri })));

router.post('/callback', adminOnly, premium, validateBody(Joi.object({ code: Joi.string().max(2000).required(), state: Joi.string().max(600).required() })),
  handle(req => gcal.completeConnect({ companyId: req.companyId, userId: req.usuario.id, code: req.body.code, state: req.body.state })));

router.post('/disconnect', adminOnly, validateBody(Joi.object({ remove_app_calendars: Joi.boolean().default(false) })),
  handle(req => gcal.disconnect(req.companyId, req.body)));

router.get('/calendars', adminOnly, premium, handle(req => gcal.calendars(req.companyId)));

router.get('/links', member, handle(req => gcal.listLinks(req.companyId)));

const linkSchema = Joi.object({
  role: Joi.string().valid('push', 'busy').required(),
  calendar_id: calendarId.when('create_app_calendar', { is: true, then: Joi.forbidden(), otherwise: Joi.required() }),
  create_app_calendar: Joi.boolean().default(false).when('role', { is: 'busy', then: Joi.valid(false) }),
  professional_id: id.allow(null).default(null),
  // busy sem profissional bloqueia a empresa inteira: exige opt-in explícito.
  all_company: Joi.boolean().default(false),
}).custom((value, helpers) => {
  if (value.role === 'busy' && !value.professional_id && !value.all_company) return helpers.message('Informe professional_id ou all_company=true para bloquear a empresa inteira.');
  return value;
});

router.post('/links', adminOnly, premium, validateBody(linkSchema),
  handle(async req => ({ __status: 201, data: await gcal.addLink(req.companyId, req.body) })));

const paramId = (req, res, next) => (id.validate(req.params.id).error ? res.status(400).json({ errors: [{ message: 'id inválido.', field: 'id' }] }) : next());

router.delete('/links/:id', adminOnly, paramId,
  handle(req => gcal.removeLink(req.companyId, Number(req.params.id))));

// Sincronização manual (a automática é horária). Limite por empresa: GOOGLE_CALENDAR_SYNC_MAX_PER_HOUR (6).
router.post('/sync', adminOnly, premium, handle(async req => {
  const status = await gcal.status(req.companyId);
  if (!status.connected) throw Object.assign(new Error('Google Agenda não conectado.'), { status: 404, code: 'integration_not_connected' });
  const max = Number(process.env.GOOGLE_CALENDAR_SYNC_MAX_PER_HOUR) || 6;
  if ((await hit(`gcal_sync:${req.companyId}`, 3600)).hits > max) {
    throw Object.assign(new Error('Muitas sincronizações manuais. Tente mais tarde.'), { status: 429, code: 'rate_limited' });
  }
  let queued = 0;
  if (status.links.some(l => l.role === 'push')) queued += (await sync.enqueuePush(req.companyId, { soon: true })) ? 1 : 0;
  for (const link of status.links.filter(l => l.role === 'busy')) queued += (await sync.enqueuePull(link.id, { soon: true })) ? 1 : 0;
  require('../services/jobsService').drainSoon();
  return { __status: 202, data: { queued } };
}));

module.exports = router;
