const companies = require("../schemas/companies");
const users = require("../schemas/users");
const customers = require("../schemas/customers");
const appointments = require("../schemas/appointments");
const _companiesService = require('../services/companiesService');

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
        customers: customers,
        appointments: appointments
    },
    validateCompanyAccess: (req, res, next) => {
        const userId = req.usuario.id;
        const companyId = req.headers['selected-company'];
        
        _companiesService.returnCompany(companyId, userId, true)
          .then(company => {
            next();
          })
          .catch(error => {
            return res.status(403).send({ error: "Acesso não autorizado à empresa." });
          });
    }
}

module.exports = validate;
