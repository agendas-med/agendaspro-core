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
        products: Joi.array().items(products.create).optional().messages({
            'array.base': errors.array.base(), // Mensagem se não for um array
            'array.includes': errors.array.includes() // Mensagem se um item do array for inválido
        })
    })
}

module.exports = schema;
