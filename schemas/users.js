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

module.exports = schema;
