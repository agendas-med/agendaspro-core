const express = require('express');
const router = express.Router();
const Joi = require('joi');
const login = require('../middleware/login');
const validate = require('../middleware/validate');
const { sendError } = require('../middleware/errorHandler');
const functions = require('../utils/functions');
const _companiesService = require('../services/companiesService');
const privacyService = require('../services/privacyService');

// LGPD por empresa: só administradores da empresa do header, e só clientes dela.
const requireAdmin = (req, res, next) => {
    _companiesService.checkCompanyPermission(req.usuario.id, req.companyId).then(() => next())
        .catch((error) => sendError(req, res, error, 401, { text: typeof error === 'string' }));
};
const admin = [login, validate.validateCompanyAccess, requireAdmin];
const customerId = (req) => (/^\d{1,10}$/.test(req.params.id) ? Number(req.params.id) : 0);
const fail = (req, res) => (error) => sendError(req, res, error, 400);

router.get('/customers/:id/export', ...admin, (req, res) => {
    privacyService.exportCustomer(req.companyId, customerId(req))
        .then((data) => res.status(200).send(functions.createResponse('Dados do titular', data, 'GET', 200)))
        .catch(fail(req, res));
});

router.post('/customers/:id/anonymize', ...admin, (req, res) => {
    privacyService.anonymizeCustomer(req.companyId, customerId(req))
        .then(() => res.status(200).send(functions.createResponse('Cliente anonimizado', null, 'POST', 200)))
        .catch(fail(req, res));
});

router.delete('/customers/:id', ...admin, (req, res) => {
    privacyService.deleteCustomer(req.companyId, customerId(req))
        .then(() => res.status(200).send(functions.createResponse('Cliente excluído', null, 'DELETE', 200)))
        .catch(fail(req, res));
});

const consentSchema = Joi.object({
    purpose: Joi.string().valid('whatsapp_reminders', 'whatsapp_bot', 'marketing', 'data_processing').required(),
    granted: Joi.boolean().required(),
    source: Joi.string().max(30).default('painel'),
});

router.post('/customers/:id/consents', ...admin, validate.validateRequest(consentSchema), (req, res) => {
    privacyService.recordConsent(req.companyId, customerId(req), req.body.purpose, req.body.granted, req.body.source)
        .then(() => res.status(200).send(functions.createResponse('Consentimento registrado', null, 'POST', 200)))
        .catch(fail(req, res));
});

module.exports = router;
