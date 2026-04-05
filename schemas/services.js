const Joi = require('joi');
const errors = require('../utils/errors'); // Importe o arquivo de erros

let schema = {
    create: Joi.object({
        name: Joi.string().min(3).max(255).required().messages({
            'string.base': errors.string.empty(),
            'string.empty': errors.string.empty(),
            'string.min': errors.string.min(3),
            'string.max': errors.string.max(255),
            'any.required': errors.string.empty()
        }),
        value: Joi.number().precision(2).min(0).required().messages({
            'number.base': errors.integer.base(),
            'number.min': "O valor do serviço deve ser maior ou igual a 0.",
            'any.required': errors.string.empty()
        }),
        cost: Joi.number().precision(2).min(0).required().messages({
            'number.base': errors.integer.base(),
            'number.min': "O valor do serviço deve ser maior ou igual a 0.",
            'any.required': errors.string.empty()
        }),
        observations: Joi.string().allow(null, "").messages({
            'string.base': errors.string.empty()
        }),
        duration: Joi.number().integer().min(1).required().messages({
            'number.base': errors.integer.base(),
            'number.integer': errors.integer.integer(),
            'number.min': "A duração do serviço deve ser no mínimo 1 minuto.",
            'any.required': errors.string.empty()
        }),
        requires_location: Joi.boolean().allow('', null).optional().messages({
            'boolean.base': "O valor de requires_location deve ser verdadeiro ou falso."
        }),
        accepts_quantity: Joi.boolean().allow('', null).optional().messages({
            'boolean.base': "O valor de accepts_quantity deve ser verdadeiro ou falso."
        }),
        measurement_unit_id: Joi.number().integer().min(1).max(7).allow('', null).optional()
    })
}

module.exports = schema;
