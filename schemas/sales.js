const Joi = require('joi');
const errors = require('../utils/errors'); // Importe o arquivo de erros
const products = require("./products");

let schema = {
    create: Joi.object({
        company_id: Joi.number().integer().required().messages({
            'number.base': errors.integer.base(),
            'number.integer': errors.integer.integer(),
            'any.required': errors.string.empty()
        }),
        customer_id: Joi.number().integer().required().messages({
            'number.base': errors.integer.base(),
            'number.integer': errors.integer.integer(),
            'any.required': errors.string.empty()
        }),
        appointment_id: Joi.number().integer().allow(null).messages({
            'number.base': errors.integer.base(),
            'number.integer': errors.integer.integer()
        }),
        products: Joi.array().items(
            products.create.append({
                quantity: Joi.number().integer().required().messages({
                    'number.base': errors.integer.base(),
                    'number.integer': errors.integer.integer(),
                    'any.required': errors.string.empty()
                })
            })
        ).optional().messages({
            'array.base': errors.array.base(), // Mensagem se não for um array
            'array.includes': errors.array.includes() // Mensagem se um item do array for inválido
        }),
        status: Joi.string().valid('em_aberto', 'realizada', 'cancelada').required().messages({
            'string.base': errors.string.base(),
            'any.only': 'O status deve ser "em_aberto", "realizada" ou "cancelada".',
            'any.required': errors.string.empty()
        })
    })
}

module.exports = schema;
