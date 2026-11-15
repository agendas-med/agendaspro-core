const express = require('express');
const Joi = require('joi');
const router = express.Router();
const { member, admin, handle, validateBody } = require('../middleware/tenant');
const functions = require('../utils/functions');
const { isValidSlug } = require('../utils/slug');

// Configuração da página pública (/b/:slug) pela própria empresa (header Selected-company).
const FIELDS = ['slug', 'public_page_enabled', 'public_description', 'logo_url', 'instagram_url', 'public_hours', 'theme_primary_color',
  'booking_min_notice_minutes', 'booking_cancel_notice_minutes', 'booking_hold_minutes', 'booking_slot_step_minutes', 'booking_horizon_days'];

const url = Joi.string().uri({ scheme: ['https'] }).max(500).allow(null, '');
const pageSchema = Joi.object({
  slug: Joi.string().trim().lowercase().max(60),
  public_page_enabled: Joi.boolean(),
  public_description: Joi.string().trim().max(600).allow(null, ''),
  logo_url: url,
  instagram_url: Joi.string().uri({ scheme: ['https'] }).max(255).allow(null, ''),
  public_hours: Joi.string().trim().max(255).allow(null, ''),
  theme_primary_color: Joi.string().pattern(/^#[0-9a-fA-F]{6}$/).allow(null, ''),
  booking_min_notice_minutes: Joi.number().integer().min(0).max(43200),
  booking_cancel_notice_minutes: Joi.number().integer().min(0).max(43200),
  booking_hold_minutes: Joi.number().integer().min(5).max(60),
  booking_slot_step_minutes: Joi.number().integer().valid(5, 10, 15, 20, 30, 45, 60, 90, 120),
  booking_horizon_days: Joi.number().integer().min(1).max(365),
}).min(1).unknown(false);

const serviceSchema = Joi.object({
  online_booking: Joi.boolean(),
  public_description: Joi.string().trim().max(600).allow(null, ''),
  deposit_cents: Joi.number().integer().min(0).max(10000000).custom((value, helpers) => (value === 0 || value >= 500 ? value : helpers.error('any.invalid'))),
}).min(1).unknown(false);

const bad = (message, status = 400, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

async function get(companyId) {
  const [row] = await functions.executeSql(`SELECT ${FIELDS.join(', ')} FROM companies WHERE id = ?`, [companyId]);
  if (!row) throw bad('Empresa não encontrada.', 404);
  return { ...row, public_page_enabled: Number(row.public_page_enabled) === 1 };
}

async function update(companyId, body) {
  if (body.slug !== undefined && !isValidSlug(body.slug)) throw bad('Endereço inválido: use 3 a 60 letras minúsculas, números ou hífen.');
  if (body.public_page_enabled === true && body.slug === undefined && !(await get(companyId)).slug) throw bad('Defina o endereço (slug) antes de publicar a página.');
  const keys = Object.keys(body);
  const values = keys.map(key => (typeof body[key] === 'boolean' ? (body[key] ? 1 : 0) : body[key] === '' ? null : body[key]));
  try {
    await functions.executeSql(`UPDATE companies SET ${keys.map(key => `${key} = ?`).join(', ')} WHERE id = ?`, [...values, companyId]);
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') throw bad('Este endereço já está em uso. Escolha outro.', 409);
    throw error;
  }
  return get(companyId);
}

async function updateService(companyId, serviceId, body) {
  const keys = Object.keys(body);
  const values = keys.map(key => (typeof body[key] === 'boolean' ? (body[key] ? 1 : 0) : body[key] === '' ? null : body[key]));
  const result = await functions.executeSql(`UPDATE services SET ${keys.map(key => `${key} = ?`).join(', ')} WHERE id = ? AND company_id = ?`, [...values, serviceId, companyId]);
  if (!result.affectedRows) throw bad('Serviço não encontrado nesta empresa.', 404);
  const [row] = await functions.executeSql('SELECT id, name, online_booking, public_description, deposit_cents FROM services WHERE id = ? AND company_id = ?', [serviceId, companyId]);
  return { ...row, online_booking: Number(row.online_booking) === 1 };
}

router.get('/', ...member, handle(req => get(req.companyId)));
router.put('/', ...admin, validateBody(pageSchema), handle(req => update(req.companyId, req.body)));
router.put('/services/:id', ...admin, (req, res, next) => {
  const { error, value } = Joi.number().integer().positive().required().validate(req.params.id);
  if (error) return res.status(400).send({ message: 'Identificador inválido.' });
  req.params.id = value;
  return next();
}, validateBody(serviceSchema), handle(req => updateService(req.companyId, req.params.id, req.body)));

module.exports = router;
