const express = require('express');
const cors = require('cors');
const Joi = require('joi');
const { hit, peek } = require('../middleware/rateLimit');
const { isInternal, logInternal, correlationId } = require('../middleware/errorHandler');
const turnstile = require('../services/turnstileService');
const booking = require('../services/publicBookingService');
const leads = require('../services/leadsService');

// API pública (sem login) consumida pelo site: /public/*.
// - CORS próprio (PUBLIC_CORS_ORIGINS), sem credenciais; corpo JSON de no máximo 32 KB;
// - Joi rejeita campos desconhecidos; erros sempre em { error: { code, message } };
// - a empresa sai do slug (ou do manage_token), nunca de um campo enviado pelo cliente;
// - limites em banco por IP, por telefone e por slug inexistente (anti-enumeração).
const router = express.Router();

const publicOrigins = () => (process.env.PUBLIC_CORS_ORIGINS || process.env.URL_SITE || '')
  .split(',').map(o => o.trim().replace(/\/$/, '')).filter(Boolean);

router.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const allowed = publicOrigins();
    if (allowed.includes(origin)) return callback(null, true);
    if (!allowed.length && process.env.NODE_ENV !== 'production') return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Accept'],
  credentials: false,
  maxAge: 600,
}));

router.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  next();
});

router.use(express.json({ limit: '32kb' }));

// ---------- helpers ----------

const fail = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const RETRY = resetAt => Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));

async function limit(key, windowSec, max) {
  const { hits, resetAt } = await hit(key, windowSec);
  if (hits > max) throw fail(429, 'rate_limited', 'Muitas tentativas. Aguarde um pouco e tente novamente.', { retryAfter: RETRY(resetAt) });
}

const ipLimit = (name, windowSec, max) => async (req, res, next) => {
  try {
    await limit(`public:${name}|${req.ip}`, windowSec, max);
    next();
  } catch (error) {
    next(error);
  }
};

// Anti-enumeração: cada slug inexistente conta por IP; acima do limite, 429 antes de consultar.
const SLUG_MISS_WINDOW = 3600;
const slugMissMax = () => Number(process.env.PUBLIC_SLUG_MISS_MAX) || 20;
async function slugGate(req, res, next) {
  try {
    const { hits, resetAt } = await peek(`public:slugmiss|${req.ip}`, SLUG_MISS_WINDOW);
    if (hits >= slugMissMax()) throw fail(429, 'rate_limited', 'Muitas tentativas. Aguarde um pouco e tente novamente.', { retryAfter: RETRY(resetAt) });
    next();
  } catch (error) {
    next(error);
  }
}

const validate = (schema, source) => (req, res, next) => {
  const { error, value } = schema.validate(req[source] || {}, { abortEarly: true, allowUnknown: false, stripUnknown: false, convert: true });
  if (error) return next(fail(400, 'validation_error', `Dado inválido: ${error.details[0]?.path?.join('.') || 'requisição'}.`));
  req[`valid_${source}`] = value;
  return next();
};

// Handler: devolve JSON; erro de slug inexistente conta para o limite anti-enumeração.
const handle = fn => async (req, res, next) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.status(out?.__status || 200).json(out?.__body ?? out);
  } catch (error) {
    if (error?.code === 'not_found' && req.params?.slug) await hit(`public:slugmiss|${req.ip}`, SLUG_MISS_WINDOW).catch(() => {});
    next(error);
  }
};

async function verifyTurnstile(token, ip) {
  await turnstile.verify(token, ip);
}

// ---------- schemas ----------

const SLUG = Joi.string().max(60).required();
const DATE = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
const START = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:00)?$/);
const TOKEN = Joi.string().max(2048).allow('');
const SOURCES = ['instagram', 'qr', 'link', 'whatsapp', 'site'];
const validDate = text => {
  const d = new Date(`${text.slice(0, 10)}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text.slice(0, 10);
};
const realDate = (value, helpers) => (validDate(value) ? value : helpers.error('any.invalid'));
const realTime = (value, helpers) => {
  if (!validDate(value)) return helpers.error('any.invalid');
  const [h, m] = value.slice(11, 16).split(':').map(Number);
  return h < 24 && m < 60 ? value.slice(0, 16) : helpers.error('any.invalid');
};

const slugParams = Joi.object({ slug: SLUG }).unknown(false);
const tokenParams = Joi.object({ token: Joi.string().max(120).required() }).unknown(false);

const availabilityQuery = Joi.object({
  service_id: Joi.string().pattern(/^\d{1,10}(,\d{1,10}){0,4}$/).required(),
  professional_id: Joi.number().integer().positive().allow('', null),
  from: DATE.custom(realDate).required(),
  to: DATE.custom(realDate).required(),
}).unknown(false);

const bookingBody = Joi.object({
  service_ids: Joi.array().items(Joi.number().integer().positive()).min(1).max(5).unique().required(),
  professional_id: Joi.number().integer().positive().allow(null),
  start: START.custom(realTime).required(),
  customer: Joi.object({
    name: Joi.string().trim().min(2).max(120).required(),
    phone: Joi.string().trim().max(25).required(),
    email: Joi.string().trim().email({ tlds: { allow: false } }).max(255).allow('', null),
    cpf: Joi.string().trim().pattern(/^[\d.\-\s]{11,14}$/).allow('', null),
  }).unknown(false).required(),
  consent: Joi.boolean(),
  source: Joi.string().valid(...SOURCES).required(),
  idempotency_key: Joi.string().pattern(/^[A-Za-z0-9_-]{8,64}$/).required(),
  turnstile_token: TOKEN,
}).unknown(false);

const leadBody = Joi.object({
  name: Joi.string().trim().min(2).max(120).required(),
  whatsapp: Joi.string().trim().max(25).required(),
  email: Joi.string().trim().email({ tlds: { allow: false } }).max(255).allow('', null),
  segment: Joi.string().trim().min(2).max(60).required(),
  source: Joi.string().trim().min(1).max(80).default('site'),
  message: Joi.string().trim().max(1000).allow('', null),
  consent: Joi.boolean(),
  turnstile_token: TOKEN,
}).unknown(false);

const cancelBody = Joi.object({}).unknown(false);
const rescheduleBody = Joi.object({ start: START.custom(realTime).required() }).unknown(false);

// ---------- rotas ----------

router.post('/leads', ipLimit('leads', 3600, Number(process.env.PUBLIC_LEADS_IP_MAX) || 5), validate(leadBody, 'body'), handle(async req => {
  const body = req.valid_body;
  const out = await leads.createLead(body, {
    guard: async ({ phone }) => {
      await verifyTurnstile(body.turnstile_token, req.ip);
      await limit(`public:lead-phone|${phone}`, 86400, Number(process.env.PUBLIC_LEADS_PHONE_MAX) || 3);
    },
  });
  return { __status: 201, __body: out };
}));

router.get('/b/:slug', ipLimit('read', 600, 300), slugGate, validate(slugParams, 'params'), handle(req => booking.getBusiness(req.valid_params.slug)));

router.get('/b/:slug/availability', ipLimit('read', 600, 300), slugGate, validate(slugParams, 'params'), validate(availabilityQuery, 'query'), handle(req => {
  const q = req.valid_query;
  return booking.availability(req.valid_params.slug, {
    serviceIds: [...new Set(q.service_id.split(',').map(Number))],
    professionalId: q.professional_id ? Number(q.professional_id) : null,
    from: q.from,
    to: q.to,
  });
}));

router.post('/b/:slug/bookings', ipLimit('read', 600, 300), slugGate, validate(slugParams, 'params'), validate(bookingBody, 'body'), handle(async req => {
  const body = req.valid_body;
  const out = await booking.createBooking(req.valid_params.slug, body, {
    guard: async ({ companyId, phone }) => {
      await verifyTurnstile(body.turnstile_token, req.ip);
      await limit(`public:booking-ip|${req.ip}`, 3600, Number(process.env.PUBLIC_BOOKING_IP_MAX) || 10);
      await limit(`public:booking-phone|${companyId}|${phone}`, 86400, Number(process.env.PUBLIC_BOOKING_PHONE_MAX) || 5);
    },
  });
  return { __status: out.status, __body: out.body };
}));

router.get('/bookings/:token', ipLimit('manage', 600, 60), validate(tokenParams, 'params'), handle(req => booking.getByToken(req.valid_params.token)));

router.post('/bookings/:token/cancel', ipLimit('manage', 600, 60), validate(tokenParams, 'params'), validate(cancelBody, 'body'),
  handle(req => booking.cancelByToken(req.valid_params.token)));

router.post('/bookings/:token/reschedule', ipLimit('manage', 600, 60), validate(tokenParams, 'params'), validate(rescheduleBody, 'body'),
  handle(req => booking.rescheduleByToken(req.valid_params.token, req.valid_body.start)));

router.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Não encontrado.' } }));

// Erros: { error: { code, message } }. Internos viram 500 genérico com correlation_id (sem detalhes).
// eslint-disable-next-line no-unused-vars
router.use((error, req, res, next) => {
  if (res.headersSent) return undefined;
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'payload_too_large', message: 'Corpo da requisição muito grande.' } });
  if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'validation_error', message: 'JSON inválido.' } });
  const status = Number(error?.status);
  if (!isInternal(error) && typeof error?.code === 'string' && status >= 400 && status < 600) {
    if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    if (status >= 500 && error.internalReason) console.error('[public] indisponível:', error.internalReason);
    return res.status(status).json({ error: { code: error.code, message: error.message } });
  }
  logInternal(req, error);
  return res.status(500).json({ error: { code: 'internal_error', message: 'Erro interno. Tente novamente em instantes.', correlation_id: correlationId(req) } });
});

module.exports = router;
