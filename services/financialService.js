const functions = require("../utils/functions");
const sendEmails = require("../config/sendEmail");
const emailTemplates = require("../templates/emailTemplates");
const { func } = require("joi");

let financialService = {
    returnFinancial: function (company_id, clearCache = false) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        a.id,
                        a.customer_id,
                        a.customer_name,
                        c.image AS customer_image,
                        c.tel AS customer_tel,
                        a.date AS due_date,
                        s.value,
                        CASE 
                            WHEN a.date > CURDATE() OR a.date = CURDATE() THEN 'Em Aberto'
                            WHEN a.date < CURDATE() AND a.status = "realizado" THEN "Pago"
                            ELSE 'Atrasado'
                        END AS status
                    FROM
                        appointments a
                    JOIN
                        services s ON s.id = a.service_id
                    JOIN
                        customers c ON c.id = a.customer_id
                    WHERE
                        a.company_id = ?
                    AND
                        a.status <> "cancelado"
                    ORDER BY 
                        status

                `, [company_id], !clearCache
            ).then((results) => {
                resolve(results);
            }).catch((error) => {
                reject(error);
            })
        })
    }
}

module.exports = financialService;