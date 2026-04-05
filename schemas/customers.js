const Joi = require('joi');
const errors = require('../utils/errors'); // Importe o arquivo de erros

let schema = {
    createCustomer: Joi.object({
        id: Joi.number().integer().messages({
            'number.base': errors.integer.base(),
            'number.integer': errors.integer.integer()
        }),
        name: Joi.string().min(3).max(255).required().messages({
            'string.base': errors.string.base(),
            'string.min': errors.string.min(3),
            'string.max': errors.string.max(255),
            'any.required': errors.string.empty()
        }),
        cpf: Joi.string()
        .pattern(/^\d{11}$/)
        .messages({
          'string.base': errors.string.base(),
          'string.empty': errors.string.empty(),
          'string.pattern.base': 'O CPF deve conter exatamente 11 dígitos numéricos.',
        }),
        email: Joi.string().email().allow('', null).optional(),
        birthday: Joi.string().min(10).max(19).required().messages({
            'string.empty': errors.string.empty(),
            'string.min': errors.string.min(10),
            'string.max': errors.string.max(19),
            'any.required': errors.string.empty()
        }),
        last_appointment: Joi.string().min(10).max(19).allow("").messages({
            'string.empty': errors.string.empty(),
            'string.min': errors.string.min(10),
            'string.max': errors.string.max(19)
        }),
        next_appointment: Joi.string().min(10).max(24).allow("").messages({
            'string.empty': errors.string.empty(),
            'string.min': errors.string.min(10),
            'string.max': errors.string.max(19)
        }),
        tel: Joi.string().min(10).max(11).messages({
            'string.base': errors.string.base(),
            'string.min': errors.string.min(10),
            'string.max': errors.string.max(11)
        }),
        image: Joi.string().allow("").messages({
            'string.base': errors.string.base(),
            'string.max': errors.string.max(255)
        })
    })
}

module.exports = schema;
