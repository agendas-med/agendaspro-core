const Joi = require("joi");
const errors = require("../utils/errors"); // Importe o arquivo de erros

let schema = {
  create: Joi.object({
    customer_id: Joi.number().integer().required().messages({
      "number.base": errors.integer.base(),
      "number.integer": errors.integer.integer(),
      "any.required": errors.string.empty(),
    }),
    customer_name: Joi.string()
      .min(3)
      .max(255)
      .required()
      .messages({
        "string.base": errors.string.base(),
        "string.min": errors.string.min(3),
        "string.max": errors.string.max(255),
        "any.required": errors.string.empty(),
      }),
    date: Joi.string()
      .min(10)
      .max(19)
      .required()
      .messages({
        "string.base": errors.string.base(),
        "string.min": errors.string.min(10),
        "string.max": errors.string.max(19),
        "any.required": errors.string.empty(),
      }),
    duration: Joi.number().integer().min(1).required().messages({
      "number.base": errors.integer.base(),
      "number.integer": errors.integer.integer(),
      "number.min": "A duração do serviço deve ser no mínimo 1 minuto.",
      "any.required": errors.string.empty(),
    }),
    observations: Joi.string().allow("").messages({
      "string.base": errors.string.base(),
    }),
    services: Joi.array()
      .items(
        Joi.object({
          id: Joi.number().integer().required().messages({
            "number.base": errors.integer.base(),
            "number.integer": errors.integer.integer(),
            "any.required": errors.string.empty(),
          }),
          company_id: Joi.number().integer().allow(null).messages({
            "number.base": errors.integer.base(),
            "number.integer": errors.integer.integer(),
          }),
          name: Joi.string()
            .min(3)
            .max(255)
            .required()
            .messages({
              "string.base": errors.string.empty(),
              "string.empty": errors.string.empty(),
              "string.min": errors.string.min(3),
              "string.max": errors.string.max(255),
              "any.required": errors.string.empty(),
            }),
          value: Joi.number().precision(2).min(0).required().messages({
            "number.base": errors.integer.base(),
            "number.min": "O valor do serviço deve ser maior ou igual a 0.",
            "any.required": errors.string.empty(),
          }),
          cost: Joi.number().precision(2).min(0).required().messages({
            "number.base": errors.integer.base(),
            "number.min": "O valor do serviço deve ser maior ou igual a 0.",
            "any.required": errors.string.empty(),
          }),
          observations: Joi.string().allow(null, "").messages({
            "string.base": errors.string.empty(),
          }),
          duration: Joi.number().integer().min(1).required().messages({
            "number.base": errors.integer.base(),
            "number.integer": errors.integer.integer(),
            "number.min": "A duração do serviço deve ser no mínimo 1 minuto.",
            "any.required": errors.string.empty(),
          }),
          requires_location: Joi.any().optional(),
          accepts_quantity: Joi.any().optional(),
          measurement_unit: Joi.string().allow(null, "").optional(),
          quantity: Joi.number().integer().min(1).allow(null, "").optional(),
        }).messages({
          "object.base": errors.object.base(),
        }),
      )
      .min(1)
      .required()
      .messages({
        "array.base": errors.array.base(),
        "array.min": "É necessário selecionar pelo menos um serviço.",
        "any.required": errors.string.empty(),
      }),
    status: Joi.string()
      .valid("agendado", "iniciado", "realizado", "cancelado")
      .required()
      .messages({
        "any.only":
          'O status deve ser "agendado", "iniciado", "realizado" ou "cancelado".',
        "any.required": errors.string.empty(),
      }),
    zip_code: Joi.string()
      .pattern(/^\d{5}-?\d{3}$/)
      .allow(null, "")
      .messages({
        "string.pattern.base": errors.string.pattern(),
      }),
    address: Joi.string()
      .max(255)
      .allow(null, "")
      .messages({
        "string.max": errors.string.max(255),
      }),
    number: Joi.string()
      .max(20)
      .allow(null, "")
      .messages({
        "string.max": errors.string.max(20),
      }),
    complement: Joi.string()
      .max(100)
      .allow(null, "")
      .messages({
        "string.max": errors.string.max(100),
      }),
    city: Joi.string()
      .max(100)
      .allow(null, "")
      .messages({
        "string.max": errors.string.max(100),
      }),
    state: Joi.string()
      .length(2)
      .uppercase()
      .allow(null, "")
      .messages({
        "string.length": errors.string.length(2),
        "string.uppercase": errors.string.uppercase(),
      }),
  }),
};

module.exports = schema;
