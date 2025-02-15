const functions = require("../utils/functions");
const bcrypt = require('bcrypt');
const sendEmails = require("../config/sendEmail");
const emailTemplates = require("../templates/emailTemplates");
const jwt = require('jsonwebtoken');
const NodeCache = require('node-cache');
const tokenCache = new NodeCache({ stdTTL: 28.800 });

let usersService = {
    register: function (name, email, password) {
        return new Promise((resolve, reject) => {
            bcrypt.hash(password, 10, (errBcrypt, hash) => {
                if (errBcrypt) {
                    reject(errBcrypt);
                }

                functions.executeSql(
                    `
                        INSERT INTO
                            users
                            (name, email, password)
                        VALUES
                            (?, ?, ?)
                    `, [
                        name, 
                        email, 
                        hash
                    ]
                ).then((results2) => {

                    let createdUser = {
                        id: results2.insertId,
                        email: email
                    }

                    resolve(createdUser);
                }).catch((error2) => {
                    reject(error2);
                })
            });     
        })
    },
    login: function (email, password) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        *
                    FROM
                        users
                    WHERE
                        email = ?
                `, [email]
            ).then((results) => {
                if (results.length < 1) {
                    reject("Falha na autenticação");
                } else {
                    bcrypt.compare(password, results[0].password, (error2, result) => {
                        if (error2) {
                            reject("Falha na autenticação");
                        }

                        if (result) {
                            let token = jwt.sign({
                                id: results[0].id,
                                email: results[0].email,
                                name: results[0].name
                            }, 
                            process.env.JWT_KEY,
                            {
                                expiresIn: "8h"
                            })

                            resolve(token);
                        }

                        reject("Falha na autenticação");
                    });
                }
            }).catch((error) => {
                reject(error);
            })
        })
    },
    checkJwt: function (tokenParam) {
        return new Promise((resolve, reject) => {
            let token = tokenParam.split(" ")[1];
            jwt.verify(token, process.env.JWT_KEY, (err, decoded) => {
                if (err) {
                    reject("Token inválido");
                } else {
                    let newToken = jwt.sign({
                        id: decoded.id,
                        email: decoded.email,
                        name: decoded.name
                    }, process.env.JWT_KEY, {expiresIn: "8h"});

                    tokenCache.set(decoded.id, newToken);
                    tokenCache.del(token);
                    
                    resolve(newToken);
                }
            })
        })
    },
    returnUser: function (user_id, clearCache = false) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        id,
                        name,
                        email,
                        url_photo,
                        tel,
                        zip_code,
                        address,
                        city,
                        state
                    FROM
                        users 
                    WHERE
                        id = ?
                `, [user_id], !clearCache, 60
            ).then((results) => {
                this.returnUserCompanies(user_id).then((results2) => {

                    let user = {
                        id: results[0].id,
                        name: results[0].name,
                        email: results[0].email,
                        url_photo: results[0].url_photo,
                        tel: results[0].tel,
                        zip_code: results[0].zip_code,
                        address: results[0].address,
                        city: results[0].city,
                        state: results[0].state,
                        country: results[0].country,
                        companies: results2
                    }

                    resolve(user);
                }).catch((error) => {
                    reject(error);
                })
            }).catch((error) => {
                reject(error);
            })
        })
    },
    returnUserCompanies: function (user_id, clearCache = false) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        company_id
                    FROM
                        company_members
                    WHERE
                        user_id = ?
                `, [user_id], !clearCache, 60
            ).then((results) => {
                let companies = [];

                for (let i = 0; i < results.length; i++) {
                    companies.push(results[i].company_id);
                }

                resolve(companies);
            }).catch((error) => {
                reject(error);
            })
        })
    },
    enterCompany: function (user_id, company_id) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    INSERT INTO
                        company_members
                        (user_id, company_id)
                    VALUES
                        (?, ?)
                `, [user_id, company_id]
            ).then(() => {
                this.returnUser(user_id, true);
                resolve();
            }).catch((error) => {
                reject(error);
            })
        })
    },
    insertRole: function (user_id, role_id) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    INSERT INTO
                        config_users_roles
                        (user_id, role_id)
                    VALUES
                        (?, ?)
                `, [user_id, role_id]
            ).then(() => {
                resolve();
            }).catch((error) => {
                reject(error);
            })
        })
    },
    findUser: function (searchString) {
        return new Promise((resolve, reject) => {
            searchString = searchString == "***" ? "" : searchString;

            functions.executeSql(
                `
                    SELECT
                        id,
                        name,
                        email,
                        url_photo,
                        tel,
                        zip_code,
                        address,
                        city,
                        state
                    FROM
                        users 
                    WHERE
                        name LIKE ?
                        OR email LIKE ?
                `, [`%${searchString}%`, `%${searchString}%`]
            ).then((results) => {
                resolve(results);
            }).catch((error) => {
                reject(error);
            })
        })
    },
    checkIfUserExists: function (email) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        id,
                        name,
                        email
                    FROM
                        users
                    WHERE
                        email = ?
                `, [email]
            ).then((results) => {
                let exist = false;

                if (results.length > 0) {
                    exist = true;
                }

                exist = false;

                let retorno = {
                    exist: exist,
                    user: results[0]
                }

                resolve(retorno);
            }).catch((error) => {
                reject(error);
            })
        })
    }
}

module.exports = usersService;