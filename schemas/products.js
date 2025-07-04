const Joi = require('joi');
const errors = require('../utils/errors'); // Importe o arquivo de erros

let schema = {
    create: Joi.object({
        id: Joi.number().integer().allow(null).messages({
            'number.base': errors.integer.base(),
            'number.integer': errors.integer.integer()
        }),
        name: Joi.string().min(3).max(100).required().messages({
            'string.base': errors.string.base(),
            'string.min': errors.string.min(3),
            'string.max': errors.string.max(100),
            'any.required': errors.string.empty()
        }),
        value: Joi.number().precision(2).min(0).required().messages({
            'number.base': errors.integer.base(),
            'number.min': "O valor do serviço deve ser maior ou igual a 0.",
            'any.required': errors.string.empty()
        }),
        description: Joi.string().allow(null, "").messages({
            'string.base': errors.string.empty()
        }),
        cost: Joi.number().precision(2).min(0).required().messages({
            'number.base': errors.integer.base(),
            'number.min': "O valor do serviço deve ser maior ou igual a 0.",
            'any.required': errors.string.empty()
        })
    })
}

module.exports = schema;
