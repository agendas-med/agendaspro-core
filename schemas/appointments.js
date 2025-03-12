const Joi = require('joi');
const errors = require('../utils/errors'); // Importe o arquivo de erros

let schema = {
    create: Joi.object({
        customer_id: Joi.number().integer().required().messages({
            'number.base': errors.integer.base(),
            'number.integer': errors.integer.integer(),
            'any.required': errors.string.empty()
        }),
        customer_name: Joi.string().min(3).max(255).required().messages({
            'string.base': errors.string.base(),
            'string.min': errors.string.min(3),
            'string.max': errors.string.max(255),
            'any.required': errors.string.empty()
        }),        
        date: Joi.string().min(10).max(19).required().messages({
            'string.base': errors.string.base(),
            'string.min': errors.string.min(10),
            'string.max': errors.string.max(19),
            'any.required': errors.string.empty()
        }),
        duration: Joi.string().valid(
            "15", "30", "45", "60", "75", "90", "105", "120", 
            "135", "150", "165", "180", "195", "210", "225", "240"
        ).required().messages({
            'any.only': errors.string.invalid(),
            'any.required': errors.string.empty()
        }),
        observations: Joi.string().allow("").messages({
            'string.base': errors.string.base()
        }),
        service: Joi.number().integer().required().messages({
            'number.base': errors.integer.base(),
            'number.integer': errors.integer.integer(),
            'any.required': errors.string.empty()
        })
    })
}

module.exports = schema;
