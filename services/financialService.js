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
                        SUM(s.value) AS value,
                        CASE 
                            WHEN a.canceled = 0 AND a.status = "realizado" AND a.date <= NOW() THEN "Pago"
                            WHEN a.date >= NOW() THEN "Em Aberto"
                            ELSE "Atrasado"
                        END AS status
                    FROM
                        appointment_status_view a
                    JOIN
                        appointment_services aps ON aps.appointment_id = a.id
                    JOIN
                        services s ON s.id = aps.service_id
                    JOIN
                        customers c ON c.id = a.customer_id
                    WHERE
                        a.company_id = ?
                        AND a.canceled = 0
                    GROUP BY
                        a.id, a.customer_id, a.customer_name, c.image, c.tel, a.date
                    ORDER BY 
                        status;
                `,
                [company_id], !clearCache
            ).then((results) => {
                resolve(results);
            }).catch((error) => {
                reject(error);
            });
        });
    }
}

module.exports = financialService;