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
                        SUM(s.value) AS value,  -- Soma dos valores dos serviços
                        CASE 
                            WHEN a.date > CURDATE() OR a.date = CURDATE() THEN 'Em Aberto'
                            WHEN a.date < CURDATE() AND a.status = "realizado" THEN "Pago"
                            ELSE 'Atrasado'
                        END AS status
                    FROM
                        appointments a
                    JOIN
                        appointment_services as aps ON aps.appointment_id = a.id  -- Relaciona os serviços do agendamento
                    JOIN
                        services s ON s.id = aps.service_id  -- Obtém os dados dos serviços
                    JOIN
                        customers c ON c.id = a.customer_id
                    WHERE
                        a.company_id = ?  -- Filtro pela empresa
                    AND
                        a.status <> "cancelado"  -- Filtro para não incluir cancelados
                    GROUP BY
                        a.id, a.customer_id, a.customer_name, c.image, c.tel, a.date  -- Agrupa pelos campos selecionados
                    ORDER BY 
                        status;

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