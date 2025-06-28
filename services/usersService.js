const functions = require("../utils/functions");
const bcrypt = require('bcrypt');
const sendEmails = require("../config/sendEmail");
const emailTemplates = require("../templates/emailTemplates");
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

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

                            resolve({jwtToken: token, id: results[0].id});
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
                    
                    resolve(newToken);
                }
            })
        })
    },
    returnUser: function (user_id, company_id, clearCache = false) {
        return new Promise((resolve, reject) => {
            let companySQL = `
                SELECT
                    c.id
                FROM
                    companies c
                INNER JOIN
                    company_members cm ON cm.company_id = c.id
                WHERE
                    cm.user_id = ${user_id}
            `;

            functions.executeSql(companySQL, []).then((companies) => {
                if (!company_id && companies.length) {
                    company_id = companies[0].id;
                }

                functions.executeSql(
                    `
                        SELECT
                            u.id,
                            u.name,
                            u.email,
                            u.url_photo,
                            u.tel,
                            u.zip_code,
                            u.address,
                            u.city,
                            u.state,
                            (SELECT ccr.permission FROM config_company_roles ccr INNER JOIN config_users_roles cur ON cur.role_id = ccr.id WHERE ccr.company_id = ? AND cur.user_id = ?) AS permission
                        FROM
                            users u
                        WHERE
                            u.id = ?
                    `, [company_id, user_id, user_id], !clearCache, 60
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
                            companies: results2,
                            permission: results[0].permission
                        }
    
                        resolve(user);
                    }).catch((error) => {
                        reject(error);
                    })
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
                this.returnUser(user_id, company_id, true);
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

                let retorno = {
                    exist: exist,
                    user: results[0]
                }

                resolve(retorno);
            }).catch((error) => {
                reject(error);
            })
        })
    },
    returnCompanies: function (user_id) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        c.*
                    FROM
                        companies c
                    INNER JOIN
                        company_members cm ON cm.company_id = c.id
                    WHERE
                        cm.user_id = ?                   
                `, [user_id]
            ).then((results) => {
                resolve(results);
            }).catch((error) => {
                reject(error);
            })
        })
    },
    changeProfile: function (user_id, company_id, address, city, state, tel, zip_code) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    UPDATE
                        users
                    SET
                        address = ?, city = ?, state = ?, tel = ?, zip_code = ?
                    WHERE
                        id = ?                
                `, [address, city, state, tel, zip_code, user_id]
            ).then((results) => {
                this.returnUser(user_id, company_id, true);
                resolve(results);
            }).catch((error) => {
                reject(error);
            })
        })
    },
    requestResetPassword: function (email) {
        return new Promise(async (resolve, reject) => {
            try {
                let idUsuario = await functions.returnColumn("users", email, "id", "email") || null;
                let nomeUsuario = await functions.returnColumn("users", email, "name", "email");

                if (!idUsuario) {
                    reject("Ocorreu um erro ao enviar o email de redefinição");
                } else {
                    const token = crypto.randomBytes(32).toString('hex');

                    await functions.executeSql(
                        `
                            INSERT INTO
                                password_requests
                                (user_id, token)
                            VALUES
                                (?, ?)
                        `, [idUsuario, token]
                    )

                    let link_convite = process.env.URL_SITE + "/redefinir-senha?token=" + token;
                    let now = new Date();
                    let day = now.getDate();
                    let month = now.getMonth() + 1;
                    let year = now.getFullYear();
                    let hour = now.getHours();
                    let minute = now.getMinutes();

                    if (hour < 10) hour = "0" + hour;
                    if (minute < 10) minute = "0" + minute;

                    let requestDate = `${day}/${month}/${year} às ${hour}:${minute}`;
                    let emailHtml = emailTemplates.resetPassword(nomeUsuario, email, requestDate, link_convite);
                    
                    await sendEmails.sendEmail(emailHtml, "Redefinição de senha solicitada", process.env.USER_EMAIL, email);

                    resolve();
                }
            } catch (error) {
                reject(error);
            }
        })
    },
    checkTokenValidity: function (token) {
        return new Promise(async (resolve, reject) => {
            let results = await functions.executeSql(
                `
                    SELECT
                        id
                    FROM
                        password_requests
                    WHERE
                        token = ? AND request_date > NOW() - INTERVAL 15 MINUTE AND confirm_date IS NULL
                `, [token]
            )
            
            if (results[0] == undefined) {
                reject("Token inválido");
            } else {
                resolve();
            }
        })
    },
    resetPassword: function (token, password) {
        return new Promise(async (resolve, reject) => {
            try {
                await this.checkTokenValidity(token);
                let userId = await functions.returnColumn("password_requests", token, "user_id", "token");
                
                bcrypt.hash(password, 10, (errBcrypt, hash) => {
                    if (errBcrypt) {
                        reject(errBcrypt);
                    }

                    functions.executeSql(
                        `
                            UPDATE
                                users
                            SET
                                password = ?
                            WHERE
                                id = ?
                        `, [hash, userId]
                    ).then(async () => {
                        await functions.executeSql(
                            `
                                UPDATE
                                    password_requests
                                SET
                                    confirm_date = NOW()
                                WHERE
                                    token = ?
                            `, [token]
                        )

                        resolve();
                    }).catch((error2) => {
                        reject(error2);
                    })
                });     
            } catch (error) {
                reject(error);
            }
        })
    }
}

module.exports = usersService;