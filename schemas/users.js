const Joi = require('joi');
const errors = require('../utils/errors'); // Importe o arquivo de erros

let schema = {
    find: Joi.object({
        search_string: Joi.string().min(3).max(255).required().messages({
            'string.base': errors.string.base(),
            'string.min': errors.string.min(),
            'string.max': errors.string.max(),
            'any.required': errors.string.empty()
        })
    })
}

module.exports = schema;
