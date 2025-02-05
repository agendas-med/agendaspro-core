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
    })
}

module.exports = schema;
