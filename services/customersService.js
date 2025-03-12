const functions = require("../utils/functions");
const sendEmails = require("../config/sendEmail");
const emailTemplates = require("../templates/emailTemplates");

let customersService = {
    create: function (company_id, name, birthday, tel, image) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                INSERT INTO customers (name, birthday, tel, image, company_id)
                VALUES (?, ?, ?, ?, ?)
                `, [name, birthday, tel, image, company_id]
            ).then((results) => {
                if (results.affectedRows > 0) {
                    this.getAllByCompany(company_id, true);
                    resolve();
                } else {
                    reject("Ocorreu um erro ao cadastrar o cliente");
                }
            }).catch((error) => {
                reject(error);
            });
        });
    },
    delete: function (company_id, customer_id) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `DELETE FROM customers WHERE id = ?`, 
                [customer_id]
            ).then((results) => {
                if (results.affectedRows > 0) {
                    this.getAllByCompany(company_id, true);
                    resolve("Cliente deletado com sucesso");
                } else {
                    reject("Cliente não encontrado");
                }
            }).catch((error) => {
                reject(error);
            });
        });
    },
    update: function (company_id, customer_id, name, birthday, tel, image) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                UPDATE customers 
                SET name = ?, birthday = ?, tel = ?, image = ?
                WHERE id = ?
                `, [name, birthday, tel, image, customer_id]
            ).then(() => {
                this.getAllByCompany(company_id, true);
                resolve();
            }).catch((error) => {
                reject(error);
            });
        });
    },
    get: function (customer_id) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `SELECT * FROM customers WHERE id = ?`, 
                [customer_id]
            ).then((results) => {
                if (results.length > 0) {
                    resolve(results[0]);
                } else {
                    reject("Cliente não encontrado");
                }
            }).catch((error) => {
                reject(error);
            });
        });
    },
    getAllByCompany: function (company_id, clearCache = false) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `SELECT * FROM customers WHERE company_id = ?`, 
                [company_id], !clearCache
            ).then((results) => {
                let customers = results.map((customer) => {
                    return {
                        id: customer.id,
                        name: customer.name,
                        birthday: customer.birthday,
                        tel: customer.tel,
                        image: customer.image || "",
                        last_appointment: "",
                        next_appointment: ""
                    }
                })

                resolve(customers);
            }).catch((error) => {
                reject(error);
            });
        });
    },
    find: function (company_id, search_string) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `SELECT * FROM customers WHERE company_id = ? ${search_string != "***" ? `AND name LIKE "%${search_string}%" or id LIKE "%${search_string}%"` : ""}`, 
                [company_id]
            ).then((results) => {
                let customers = results.map((customer) => {
                    return {
                        id: customer.id,
                        name: customer.name,
                        birthday: customer.birthday,
                        tel: customer.tel,
                        image: customer.image || ""
                    }
                })

                resolve(customers);
            }).catch((error) => {
                reject(error);
            });
        })
    }
}

module.exports = customersService;