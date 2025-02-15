const Joi = require('joi');
const errors = require('../utils/errors'); // Importe o arquivo de erros

let schema = {
    enterCompany: Joi.object({
        company_id: Joi.number().integer().required()
            .messages({
                'number.base': errors.integer.base(),
                'number.integer': errors.integer.integer(),
                'any.required': errors.string.empty()
            })
    }),
    find: Joi.object({
        search_string: Joi.string().min(3).max(255).required().messages({
            'string.base': errors.string.base(),
            'string.min': errors.string.min(),
            'string.max': errors.string.max(),
            'any.required': errors.string.empty()
        })
    }),
    createUser: Joi.object({
        id: Joi.number().integer().required().messages({
            'number.base': errors.integer.base(),
            'number.integer': errors.integer.integer(),
            'any.required': errors.string.empty()
        }),
        name: Joi.string().min(3).max(100).required().messages({
            'string.base': errors.string.empty(),
            'string.empty': errors.string.empty(),
            'string.min': errors.string.min(3),
            'string.max': errors.string.max(100),
            'any.required': errors.string.empty()
        }),
        email: Joi.string().email({ tlds: { allow: false } }).required().messages({
            "string.email": errors.email.base(),
            "string.empty": errors.string.empty(),
            "any.required": errors.string.empty()
        })
    }) 
}

module.exports = schema;
