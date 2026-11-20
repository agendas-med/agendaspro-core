const Joi = require('joi');
const errors = require('../utils/errors'); // Importe o arquivo de erros

let schema = {
    find: Joi.object({
        search_string: Joi.string().min(3).max(255).required().messages({
            'string.base': errors.string.base(),
            'string.min': errors.string.min(3),
            'string.max': errors.string.max(255),
            'any.required': errors.string.empty()
        })
    }),
    change_profile: Joi.object({
        address: Joi.string().max(255).required().messages({
            'string.base': errors.string.base(),
            'string.max': errors.string.max(255),
            'any.required': errors.string.empty()
        }),
        city: Joi.string().max(100).required().messages({
            'string.base': errors.string.base(),
            'string.max': errors.string.max(100),
            'any.required': errors.string.empty()
        }),
        state: Joi.string().max(100).required().messages({
            'string.base': errors.string.base(),
            'string.max': errors.string.max(100),
            'any.required': errors.string.empty()
        }),
        tel: Joi.string().min(10).max(20).required().messages({
            'string.base': errors.string.base(),
            'string.min': errors.string.min(10),
            'string.max': errors.string.max(20),
            'any.required': errors.string.empty()
        }),
        zip_code: Joi.string().length(9).required().messages({
            'string.base': errors.string.base(),
            'string.length': errors.string.length(9),
            'any.required': errors.string.empty()
        })
    })
}

// Autenticação: apenas strings (objetos/arrays como {"$ne":...} são rejeitados com 400).
const email = () => Joi.string().trim().lowercase().email({ tlds: { allow: false } }).max(255).required();
const newPassword = () => Joi.string().min(8).max(128).required().messages({ 'string.min': 'A senha deve ter pelo menos 8 caracteres.' });
const opaqueToken = () => Joi.string().min(16).max(200).required();
// Aceite dos Termos no cadastro: obrigatório e somente `true` (checkbox do painel).
const TERMS_MESSAGE = 'É preciso aceitar os Termos de Uso e a Política de Privacidade.';
const termsAccepted = () => Joi.valid(true).required().messages({ 'any.only': TERMS_MESSAGE, 'any.required': TERMS_MESSAGE });
Object.assign(schema, {
    register: Joi.object({ name: Joi.string().trim().min(2).max(255).required(), email: email(), password: newPassword(), accept_terms: termsAccepted() }),
    login: Joi.object({ email: email(), password: Joi.string().min(1).max(128).required() }),
    googleLogin: Joi.object({ token: Joi.string().min(1).max(2048).required() }),
    checkJwt: Joi.object({ token: Joi.string().max(4096).allow(''), refresh_token: Joi.string().max(200) }).or('token', 'refresh_token'),
    refresh: Joi.object({ refresh_token: opaqueToken() }),
    logout: Joi.object({ refresh_token: Joi.string().max(200) }),
    requestResetPassword: Joi.object({ email: email() }),
    checkResetToken: Joi.object({ token: opaqueToken() }),
    resetPassword: Joi.object({ token: opaqueToken(), password: newPassword() }),
});

module.exports = schema;
