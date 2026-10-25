const companies = require("../schemas/companies");
const users = require("../schemas/users");
const customers = require("../schemas/customers");
const appointments = require("../schemas/appointments");
const sales = require("../schemas/sales");
const products = require("../schemas/products");
const services = require("../schemas/services");
const payments = require("../schemas/payments");

let validate = {
    validateRequest: (schema) => {
        return (req, res, next) => {
            const { error, value } = schema.validate(req.body, { abortEarly: false });
            
            if (error) {
                return res.status(400).json({
                    errors: error.details.map(err => ({
                        message: err.message,
                        field: err.path.join('.')
                    }))
                });
            }
    
            req.body = value;
            next();
        }
    },
    schemas: {
        companies: companies,
        users: users,
        customers: customers,
        appointments: appointments,
        sales: sales,
        products: products,
        services: services,
        payments: payments
    },
    validateCompanyAccess: (req, res, next) => {
        const userId = req.usuario.id;
        const companyId = req.headers['selected-company'];
        
        require('../utils/functions').executeSql('SELECT 1 FROM company_members WHERE company_id = ? AND user_id = ?', [companyId, userId])
          .then(rows => {
            if (!rows.length) return res.status(403).send({ error: "Acesso não autorizado à empresa." });
            next();
          })
          .catch(error => {
            return res.status(403).send({ error: "Acesso não autorizado à empresa." });
          });
    }
}

module.exports = validate;
