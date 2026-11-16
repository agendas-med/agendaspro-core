const login = require('./login');
const validate = require('./validate');
const { sendError } = require('./errorHandler');
const companiesService = require('../services/companiesService');

// Helpers das rotas F2: empresa sempre do header validado (req.companyId), nunca do corpo.
const requireAdmin = (req, res, next) => {
  companiesService.checkCompanyPermission(req.usuario.id, req.companyId)
    .then(() => next())
    .catch(error => sendError(req, res, error, 401));
};

const member = [login, validate.validateCompanyAccess];
const admin = [login, validate.validateCompanyAccess, requireAdmin];

// Erros com código estável (plano/billing) saem como { error: { code, message, ... } }.
const CODED = new Set(['plan_upgrade_required', 'billing_disabled', 'slot_unavailable',
  // F4 WhatsApp (painel)
  'window_closed', 'opted_out', 'template_unavailable', 'template_params', 'whatsapp_not_configured', 'send_failed', 'conversation_not_found', 'conversation_busy',
  // follow-up 1
  'conversation_assigned', 'admin_required',
  // Follow-up 1 (profissionais)
  'professional_user_taken',
  // F5-core-B assistente
  'assistant_disabled', 'rate_limited', 'assistant_budget_exceeded', 'assistant_forbidden', 'assistant_tool_error', 'assistant_actions_disabled',
  'action_not_found', 'invalid_confirm_token', 'action_expired', 'action_already_processed', 'action_failed',
  // Follow-up 1 (assistente: base de conhecimento)
  'knowledge_not_found', 'knowledge_limit_reached',
  // F6 integrações (Instagram / Google Agenda)
  'oauth_state_invalid', 'redirect_uri_not_allowed', 'integration_not_configured', 'integration_not_connected',
  'instagram_reauth_required', 'instagram_rate_limited', 'instagram_unavailable', 'instagram_oauth_failed',
  'google_calendar_reauth_required', 'google_calendar_unavailable', 'google_calendar_oauth_failed', 'calendar_not_found',
  'google_calendar_rate_limited', 'calendar_link_conflict', 'calendar_link_not_found', 'professional_not_found']);
function respondError(req, res, error) {
  if (error && CODED.has(error.code) && Number(error.status) >= 400) {
    return res.status(Number(error.status)).send({ error: { code: error.code, message: error.message, ...(error.details || {}) } });
  }
  return sendError(req, res, error);
}

// Envolve handler async: resposta JSON simples ({ data }) e erros padronizados.
const handle = fn => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.status(result?.__status || 200).send({ data: result?.__status ? result.data : result });
  } catch (error) {
    respondError(req, res, error);
  }
};

// Joi para query string / params (rejeita campos desconhecidos).
const validateQuery = schema => (req, res, next) => {
  const { error, value } = schema.validate(req.query, { abortEarly: false });
  if (error) return res.status(400).json({ errors: error.details.map(err => ({ message: err.message, field: err.path.join('.') })) });
  req.validQuery = value;
  next();
};

module.exports = { member, admin, requireAdmin, handle, respondError, validateQuery, validateBody: validate.validateRequest };
