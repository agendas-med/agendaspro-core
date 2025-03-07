const companies = require("../schemas/companies");
const users = require("../schemas/users");
const customers = require("../schemas/customers");

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
        companies: companies,
        users: users,
        customers: customers
    }
}

module.exports = validate;
