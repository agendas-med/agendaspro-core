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
  'window_closed', 'opted_out', 'template_unavailable', 'template_params', 'whatsapp_not_configured', 'send_failed', 'conversation_not_found', 'conversation_busy']);
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
