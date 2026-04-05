const functions = require("../utils/functions");
const sendEmails = require("../config/sendEmail");
const emailTemplates = require("../templates/emailTemplates");
const { uploadImageToS3 } = require("../config/s3");

let customersService = {
    create: function (company_id, name, cpf, birthday, tel, image, email) {
        return new Promise(async (resolve, reject) => {
            try {
                const folderName = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, '-');
                const path = `companies/${company_id}/clientes/${folderName}`;
                
                const imageUrl = await uploadImageToS3(image, path);

                functions.executeSql(
                    `
                    INSERT INTO customers (name, cpf, birthday, tel, image, company_id, email)
                    VALUES (?, ?, ?, ?, ?, ?, )
                    `, [name, cpf, birthday, tel, imageUrl, company_id, email]
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
            } catch (error) {
                reject("Erro ao fazer upload da imagem: " + error.message);
            }
        });
    },
    
    update: function (company_id, customer_id, name, cpf, birthday, tel, image, email) {
        return new Promise(async (resolve, reject) => {
            try {
                const folderName = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, '-');
                const path = `companies/${company_id}/clientes/${folderName}`;

                const imageUrl = await uploadImageToS3(image, path);

                functions.executeSql(
                    `
                    UPDATE customers 
                    SET name = ?, cpf = ?, birthday = ?, tel = ?, image = ?, email = ?
                    WHERE id = ?
                    `, [name, cpf, birthday, tel, imageUrl, email, customer_id]
                ).then(() => {
                    this.getAllByCompany(company_id, true);
                    resolve();
                }).catch((error) => {
                    reject(error);
                });
            } catch (error) {
                reject("Erro ao fazer upload da imagem: " + error.message);
            }
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
                `
                    SELECT 
                        c.*,
                        (SELECT a.date FROM appointment_status_view a WHERE a.customer_id = c.id AND a.status <> "agendado" ORDER BY id DESC LIMIT 1) AS last_appointment,
                        (SELECT a.date FROM appointment_status_view a WHERE a.customer_id = c.id AND a.status = "agendado" ORDER BY id DESC LIMIT 1) AS next_appointment
                    FROM customers c 
                    WHERE c.company_id = ?
                `, 
                [company_id], !clearCache
            ).then((results) => {
                let customers = results.map((customer) => {
                    return {
                        id: customer.id,
                        name: customer.name,
                        cpf: customer.cpf,
                        email: customer.email,
                        birthday: customer.birthday,
                        tel: customer.tel,
                        image: customer.image || "",
                        last_appointment: customer.last_appointment || "",
                        next_appointment: customer.next_appointment || ""
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
                        cpf: customer.cpf,
                        email: customer.email,
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