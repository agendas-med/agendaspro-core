const companies = require("../schemas/companies");

let validate = {
    validateRequest: (schema) => {
        return (req, res, next) => {
            const { error } = schema.validate(req.body, { abortEarly: false });
    
            if (error) {
                return res.status(400).json({
                    errors: error.details.map(err => ({
                        message: err.message,
                        field: err.path.join('.')
                    }))
                });
            }
    
            next();
        }
    },
    schemas: {
        companies: companies
    }
}

module.exports = validate;
