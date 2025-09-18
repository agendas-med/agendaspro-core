const Joi = require('joi');
const errors = require('../utils/errors'); // Importe o arquivo de erros

let schema = {
    create: Joi.object({
        customer_id: Joi.number().integer().required().messages({
            'number.base': errors.integer.base(),
            'number.integer': errors.integer.integer(),
            'any.required': errors.string.empty()
        }),
        sale_id: Joi.number().integer().allow(null).messages({
            'number.base': errors.integer.base(),
            'number.integer': errors.integer.integer()
        }),
        amount: Joi.number().required().min(0.01).messages({
            'number.base': errors.float.base(),
            'number.min': errors.float.min(0.01)
        }),
        payment_type: Joi.string().valid('pix', 'cartao_debito', 'cartao_credito', 'dinheiro').required().messages({
            'string.base': errors.string.base(),
            'any.only': 'O status deve ser "pix", "cartao_debito", "cartao_credito" ou "dinheiro".',
            'any.required': errors.string.empty()
        })
    })
}

module.exports = schema;
