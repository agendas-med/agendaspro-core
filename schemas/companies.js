const Joi = require('joi');
const errors = require('../utils/errors'); // Importe o arquivo de erros

let schema = {
    createCompany: Joi.object({
        name: Joi.string().min(3).max(100).required().messages({
            'string.base': errors.string.empty(),
            'string.empty': errors.string.empty(),
            'string.min': errors.string.min(3),
            'string.max': errors.string.max(100),
            'any.required': errors.string.empty()
        }),
        address: Joi.string().min(5).max(255).required().messages({
            'string.base': errors.string.empty(),
            'string.empty': errors.string.empty(),
            'string.min': errors.string.min(5),
            'string.max': errors.string.max(255),
            'any.required': errors.string.empty()
        }),
        zip_code: Joi.string().pattern(/^\d{5}-\d{3}$/).required().messages({
            'string.empty': errors.string.empty(),
            'string.pattern.base': errors.string.pattern(),
            'any.required': errors.string.empty()
        }),
        city: Joi.string().min(2).max(100).required().messages({
            'string.empty': errors.string.empty(),
            'string.min': errors.string.min(2),
            'string.max': errors.string.max(100),
            'any.required': errors.string.empty()
        }),
        state: Joi.string().length(2).uppercase().required().messages({
            'string.empty': errors.string.empty(),
            'string.length': errors.string.length(2),
            'string.uppercase': errors.string.uppercase(),
            'any.required': errors.string.empty()
        }),
        business_type: Joi.number().integer().required().messages({
            'number.base': errors.integer.base(),
            'number.integer': errors.integer.integer(),
            'any.required': errors.string.empty()
        }),
        roles: Joi.array().messages({
            'array.base': errors.array.base()
        })
    }),
    editCompany: Joi.object({
        id: Joi.number().integer().messages({
            'number.base': errors.integer.base(),
            'number.integer': errors.integer.integer()
        }),
        configurations: Joi.object({
            notifications: Joi.array().items(
                Joi.object({
                    id: Joi.number().integer().required().messages({
                        'number.base': errors.integer.base(),
                        'number.integer': errors.integer.integer(),
                        'any.required': errors.string.empty()
                    }),
                    code: Joi.string().required().messages({
                        'string.base': errors.string.base(),
                        'any.required': errors.string.empty()
                    }),
                    name: Joi.string().required().messages({
                        'string.base': errors.string.base(),
                        'any.required': errors.string.empty()
                    }),
                    active: Joi.boolean().required().messages({
                        'boolean.base': errors.boolean.base(),
                        'any.required': errors.string.empty()
                    })
                })
            ).required().messages({
                'array.base': errors.array.base(),
                'any.required': errors.string.empty()
            }),
            opening_hours: Joi.array().items(
                Joi.object({
                    day: Joi.number().integer().min(1).max(7).required().messages({
                        'number.base': errors.integer.base(),
                        'number.integer': errors.integer.integer(),
                        'number.min': errors.string.min(1),
                        'number.max': errors.string.max(7),
                        'any.required': errors.string.empty()
                    }),
                    hours: Joi.array().items(
                        Joi.object({
                            initial_date: Joi.string().required().messages({
                                'string.base': errors.string.base(),
                                'any.required': errors.string.empty()
                            }).required(),
                            final_date: Joi.string().required().messages({
                                'string.base': errors.string.base(),
                                'any.required': errors.string.empty()
                            }).required()
                        }).messages({
                            'object.base': errors.object.base(),
                            'any.required': errors.string.empty()
                        })
                    ).required().messages({
                        'array.base': errors.array.base(),
                        'any.required': errors.string.empty()
                    })
                }).required().messages({
                    'object.base': errors.object.base(),
                    'any.required': errors.string.empty()
                })
            ).required().messages({
                'array.base': errors.array.base(),
                'any.required': errors.string.empty()
            })
        }).required().messages({
            'object.base': errors.object.base(),
            'any.required': errors.string.empty()
        }),
        name: Joi.string().min(3).max(100).required().messages({
            'string.base': errors.string.empty(),
            'string.empty': errors.string.empty(),
            'string.min': errors.string.min(3),
            'string.max': errors.string.max(100),
            'any.required': errors.string.empty()
        }),
        address: Joi.string().min(5).max(255).required().messages({
            'string.base': errors.string.empty(),
            'string.empty': errors.string.empty(),
            'string.min': errors.string.min(5),
            'string.max': errors.string.max(255),
            'any.required': errors.string.empty()
        }),
        zip_code: Joi.string().pattern(/^\d{5}-\d{3}$/).required().messages({
            'string.empty': errors.string.empty(),
            'string.pattern.base': errors.string.pattern(),
            'any.required': errors.string.empty()
        }),
        city: Joi.string().min(2).max(100).required().messages({
            'string.empty': errors.string.empty(),
            'string.min': errors.string.min(2),
            'string.max': errors.string.max(100),
            'any.required': errors.string.empty()
        }),
        state: Joi.string().length(2).uppercase().required().messages({
            'string.empty': errors.string.empty(),
            'string.length': errors.string.length(2),
            'string.uppercase': errors.string.uppercase(),
            'any.required': errors.string.empty()
        }),
        business_type: Joi.number().integer().required().messages({
            'number.base': errors.integer.base(),
            'number.integer': errors.integer.integer(),
            'any.required': errors.string.empty()
        }),
        roles: Joi.array().messages({
            'array.base': errors.array.base()
        })
    }),
    editRole: Joi.object({
        id: Joi.number().integer().messages({
            'number.base': errors.integer.base(),
            'number.integer': errors.integer.integer()
        }),
        name: Joi.string().min(3).max(100).required().messages({
            'string.base': errors.string.empty(),
            'string.empty': errors.string.empty(),
            'string.min': errors.string.min(3),
            'string.max': errors.string.max(100),
            'any.required': errors.string.empty()
        }),
        permission: Joi.number().integer().required().messages({
            'number.base': errors.integer.base(),
            'number.integer': errors.integer.integer(),
            'any.required': errors.string.empty()
        })
    }),
    createRole: Joi.object({
        id: Joi.number().integer().messages({
            'number.base': errors.integer.base(),
            'number.integer': errors.integer.integer()
        }),
        name: Joi.string().min(3).max(100).required().messages({
            'string.base': errors.string.empty(),
            'string.empty': errors.string.empty(),
            'string.min': errors.string.min(3),
            'string.max': errors.string.max(100),
            'any.required': errors.string.empty()
        }),
        permission: Joi.number().integer().required().messages({
            'number.base': errors.integer.base(),
            'number.integer': errors.integer.integer(),
            'any.required': errors.string.empty()
        }),
        create_date: Joi.string().length(19).messages({
            'string.empty': errors.string.empty(),
            'string.length': errors.string.length(19)
        })
    }),
    inviteUser: Joi.object({
        id: Joi.number().integer().messages({
            'number.base': errors.integer.base(),
            'number.integer': errors.integer.integer()
        }),
        email: Joi.string().email({ tlds: { allow: false } }).required().messages({
            "string.email": errors.email.base(),
            "string.empty": errors.string.empty(),
            "any.required": errors.string.empty()
        }),
        name: Joi.string().min(3).max(100).required().messages({
            'string.base': errors.string.empty(),
            'string.empty': errors.string.empty(),
            'string.min': errors.string.min(3),
            'string.max': errors.string.max(100),
            'any.required': errors.string.empty()
        }),
        role: Joi.number().integer().required().messages({
            'number.base': errors.integer.base(),
            'number.integer': errors.integer.integer(),
            'any.required': errors.string.empty()
        })
    }),
    editUser: Joi.object({
        id: Joi.number().integer().required().messages({
            'number.base': errors.integer.base(),
            'number.integer': errors.integer.integer(),
            'any.required': errors.string.empty()
        }),
        email: Joi.string().email({ tlds: { allow: false } }).required().messages({
            "string.email": errors.email.base(),
            "string.empty": errors.string.empty(),
            "any.required": errors.string.empty()
        }),
        name: Joi.string().min(3).max(100).required().messages({
            'string.base': errors.string.empty(),
            'string.empty': errors.string.empty(),
            'string.min': errors.string.min(3),
            'string.max': errors.string.max(100),
            'any.required': errors.string.empty()
        }),
        role: Joi.number().integer().required().messages({
            'number.base': errors.integer.base(),
            'number.integer': errors.integer.integer(),
            'any.required': errors.string.empty()
        })
    })
}

module.exports = schema;
