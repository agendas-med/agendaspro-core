const functions = require("../utils/functions");
const sendEmails = require("../config/sendEmail");
const emailTemplates = require("../templates/emailTemplates");
const _usersService = require("./usersService");

let companiesService = {
    returnCompany: function (company_id, user_id) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        c.id,
                        c.name,
                        c.address,
                        c.zip_code
                    FROM
                        companies c
                    INNER JOIN
                        company_members cm ON cm.company_id = c.id
                    WHERE
                        c.id = ? AND cm.user_id = ?                         
                `, [company_id, user_id]
            ).then((results) => {
                let company = {
                    id: results[0]?.id || null,
                    name: results[0]?.name || "",
                    address: results[0]?.address || "",
                    zip_code: results[0]?.zip_code || ""
                }

                resolve(company);
            })
        })
    },
    returnBusinessTypes: function () {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        *
                    FROM
                        business_types                       
                `, []
            ).then((results) => {
                resolve(results);
            })
        })
    },
    createCompany: function (user_id, name, address, zip_code, city, state, business_type) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    INSERT INTO
                        companies
                        (name, address, zip_code, city, state, business_type)
                    VALUES
                        (?, ?, ?, ?, ?, ?)
                `, [name, address, zip_code, city, state, business_type]
            ).then((results) => {
                _usersService.enterCompany(user_id, results.insertId).then(() => {
                    resolve();
                })
            }).catch((error) => {
                reject(error);
            })
        })
    }
}

module.exports = companiesService;