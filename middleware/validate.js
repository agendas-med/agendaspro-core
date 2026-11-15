const companies = require("../schemas/companies");
const users = require("../schemas/users");
const customers = require("../schemas/customers");
const appointments = require("../schemas/appointments");
const sales = require("../schemas/sales");
const products = require("../schemas/products");
const services = require("../schemas/services");
const payments = require("../schemas/payments");

// Header `selected-company`: apenas inteiro positivo (até 10 dígitos).
const COMPANY_ID_PATTERN = /^\d{1,10}$/;

function parseCompanyId(raw) {
    if (typeof raw !== 'string' || !COMPANY_ID_PATTERN.test(raw.trim())) return null;
    const id = Number(raw.trim());
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

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
    parseCompanyId,
    // Valida o header como inteiro e exige vínculo do usuário com a empresa.
    // Normaliza o header e expõe req.companyId para as rotas.
    validateCompanyAccess: (req, res, next) => {
        const userId = req.usuario?.id;
        const companyId = parseCompanyId(req.headers['selected-company']);
        if (!companyId || !userId) return res.status(403).send({ error: "Acesso não autorizado à empresa." });

        require('../utils/functions').executeSql('SELECT 1 FROM company_members WHERE company_id = ? AND user_id = ?', [companyId, userId])
          .then(rows => {
            if (!rows.length) return res.status(403).send({ error: "Acesso não autorizado à empresa." });
            req.companyId = companyId;
            req.headers['selected-company'] = String(companyId);
            next();
          })
          .catch(() => res.status(403).send({ error: "Acesso não autorizado à empresa." }));
    }
}

module.exports = validate;
