const Joi = require('joi');
const errors = require('../utils/errors'); // Importe o arquivo de erros

let schema = {
    createCompany: Joi.object({
        name: Joi.string().min(3).max(100).required()
            .messages({
                'string.base': errors.string.empty(),
                'string.empty': errors.string.empty(),
                'string.min': errors.string.min(3),
                'string.max': errors.string.max(100),
                'any.required': errors.string.empty()
            }),
    
        address: Joi.string().min(5).max(255).required()
            .messages({
                'string.base': errors.string.empty(),
                'string.empty': errors.string.empty(),
                'string.min': errors.string.min(5),
                'string.max': errors.string.max(255),
                'any.required': errors.string.empty()
            }),
    
        zip_code: Joi.string().pattern(/^\d{5}-\d{3}$/).required()
            .messages({
                'string.empty': errors.string.empty(),
                'string.pattern.base': errors.string.pattern(),
                'any.required': errors.string.empty()
            }),
    
        city: Joi.string().min(2).max(100).required()
            .messages({
                'string.empty': errors.string.empty(),
                'string.min': errors.string.min(2),
                'string.max': errors.string.max(100),
                'any.required': errors.string.empty()
            }),
    
        state: Joi.string().length(2).uppercase().required()
            .messages({
                'string.empty': errors.string.empty(),
                'string.length': errors.string.length(2),
                'string.uppercase': errors.string.uppercase(),
                'any.required': errors.string.empty()
            }),
        business_type: Joi.number().integer().required()
            .messages({
                'number.base': errors.integer.base(),
                'number.integer': errors.integer.integer(),
                'any.required': errors.string.empty()
            })
    }),
    returnCompany: Joi.object({
        company_id: Joi.number().integer().required()
            .messages({
                'number.base': errors.integer.base(),
                'number.integer': errors.integer.integer(),
                'any.required': errors.string.empty()
            })
    })
}

module.exports = schema;
