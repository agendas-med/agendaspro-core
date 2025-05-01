const functions = require("../utils/functions");
const sendEmails = require("../config/sendEmail");
const emailTemplates = require("../templates/emailTemplates");
const _usersService = require("./usersService");

let companiesService = {
    returnCompany: function (company_id, user_id, clearCache = false) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        c.id,
                        c.name,
                        c.address,
                        c.zip_code,
                        business_type,
                        city,
                        state
                    FROM
                        companies c
                    INNER JOIN
                        company_members cm ON cm.company_id = c.id
                    WHERE
                        c.id = ? AND cm.user_id = ?                         
                `, [company_id, user_id], !clearCache, 60
            ).then((results) => {
                this.returnCompanyConfigurations(company_id, clearCache).then((results2) => {
                    this.returnCompanyRoles(company_id, clearCache).then((results3) => {
                        this.returnCompanyServices(company_id, clearCache).then((results4) => {
                            let company = {
                                id: results[0]?.id || null,
                                name: results[0]?.name || "",
                                address: results[0]?.address || "",
                                zip_code: results[0]?.zip_code || "",
                                business_type: results[0]?.business_type || "",
                                city: results[0]?.city || "",
                                state: results[0]?.state || "",
                                configurations: results2,
                                roles: results3,
                                services: results4
                            }
    
                            if (company.id != null) {
                                resolve(company);
                            } else {
                                reject();
                            }
                        })
                    })
                })
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
                `, [], true, 120
            ).then((results) => {
                resolve(results);
            })
        })
    },
    createRole: function (company_id, name, permission, default_role = false) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    INSERT INTO
                        config_company_roles
                        (company_id, name, permission, default_role)   
                    VALUES
                        (?, ?, ?, ?)                 
                `, [company_id, name, permission, default_role ? 1 : 0]
            ).then((results) => {
                if (results.affectedRows == 0) {
                    reject("Ocorreu um erro ao criar o cargo");
                }

                this.returnCompanyRoles(company_id, true);
                resolve(results.insertId);
            })
        })
    },
    excludeRole: function (company_id, role_id) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        *
                    FROM
                        config_users_roles
                    WHERE
                        role_id = ?
                `, [role_id]
            ).then((results) => {
                if (results.length > 0) {
                    reject("Você não pode excluir um cargo que ja está atribuído a alguém");
                } else {
                    functions.executeSql(
                        `
                            DELETE FROM
                                config_company_roles
                            WHERE
                                id = ? AND company_id = ? AND default_role = 0
                        `, [role_id, company_id]
                    ).then((results) => {
                        if (results.affectedRows == 0) {
                            reject("Você não pode excluir o cargo padrão da empresa");
                        }
        
                        this.returnCompanyRoles(company_id, true);
                        resolve();
                    }).catch((error) => {
                        reject(error);
                    })
                }
            }).catch((error) => {
                reject(error);
            })
        })
    },
    editRole: function (company_id, role_id, name, permission) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    UPDATE 
                        config_company_roles
                    SET
                        name = ?, permission = ?
                    WHERE
                        id = ? AND company_id = ?
                `, [name, permission, role_id, company_id]
            ).then((results) => {
                if (results.affectedRows == 0) {
                    reject("Ocorreu um erro ao editar o cargo");
                }

                this.returnCompanyRoles(company_id, true);
                resolve();
            }).catch((error) => {
                reject(error);
            })
        })
    },
    returnCompanyRoles: function (company_id, clearCache = false) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        *
                    FROM
                        config_company_roles
                    WHERE
                        company_id = ?
                `, [company_id], !clearCache, 60
            ).then((results) => {
                resolve(results);
            }).catch((error) => {
                reject(error);
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
                let promises = [];

                promises.push(
                    _usersService.enterCompany(user_id, results.insertId)
                )

                promises.push(
                    this.createRole(results.insertId, "Gerente", 1, true).then((roleId) => {
                        _usersService.insertRole(user_id, roleId);
                    })
                )

                promises.push(
                    this.insertCompanyDefaultPreferences(results.insertId)
                )
                
                Promise.all(promises).then(() => {
                    _usersService.returnUserCompanies(user_id, true);
                    resolve();
                })
            }).catch((error) => {
                reject(error);
            })
        })
    },
    insertCompanyDefaultPreferences: function (company_id) {
        functions.insertCompanyPreference(company_id, "notificate_scheduling", 1);
        functions.insertCompanyPreference(company_id, "notificate_in_app_payment", 1);
        functions.insertCompanyPreference(company_id, "notificate_scheduling_cancelation", 1);
    },
    returnCompanyConfigurations: function (company_id, clearCache = false) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        p.id,
                        p.code,
                        p.name,
                        ccp.active
                    FROM
                        preferences p
                    LEFT JOIN
                        config_companies_preferences ccp ON ccp.preference_id = p.id
                    WHERE
                        ccp.company_id = ?
                `, [company_id], !clearCache, 60
            ).then((results) => {
                let preferences = results.map((preference) => {
                    return {
                        id: preference.id,
                        code: preference.code,
                        name: preference.name,
                        active: preference.active == 1 ? true : false,
                    }
                })

                functions.executeSql(
                    `
                        SELECT
                            *
                        FROM
                            config_companies_schedule
                        WHERE
                            company_id = ?
                        ORDER BY day
                    `, [company_id], !clearCache, 60
                ).then((results2) => {
                    let schedule = [];

                    for (let i = 1; i <= 7; i++) { //For para os dias da semana
                        let scheduleDay = results2.filter((item) => { return item.day == i });

                        schedule.push(
                            {
                                day: i,
                                hours: scheduleDay.map((item) => {
                                    return {
                                        initial_date: item.initial_date,
                                        final_date: item.final_date
                                    }
                                })
                            }
                        )
                    }

                    let configurations = {
                        notifications: preferences,
                        opening_hours: schedule
                    }

                    resolve(configurations);
                })
            })
        })
    },
    editCompanyConfigurations: function (company_id, configurations) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    DELETE FROM
                        config_companies_schedule
                    WHERE
                        company_id = ?
                `, [company_id]
            ).then(() => {
                let schedulesInsert = [];
                
                for (let i = 0; i < configurations.opening_hours.length; i++) {
                    let currentDay = configurations.opening_hours[i];
                    
                    for (let j = 0; j < currentDay.hours.length; j++) {
                        let currentHour = currentDay.hours[j];
        
                        schedulesInsert.push(`(${company_id}, ${currentDay.day}, "${currentHour.initial_date}", "${currentHour.final_date}")`)
                    }
                }

                if (schedulesInsert.length > 0) {
                    functions.executeSql(
                        `
                            INSERT INTO 
                                config_companies_schedule
                                (company_id, day, initial_date, final_date)
                            VALUES
                                ${schedulesInsert.join(",")}
                        `, []
                    ).then(() => {
                        resolve();
                    }).catch((error2) => {
                        reject(error2);
                    })
                }

                this.returnCompanyConfigurations(company_id, true);
                resolve();
                
            }).catch((error) => {
                reject(error);
            })
        })
    },
    checkCompanyPermission: function (user_id, company_id) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        *
                    FROM
                        company_members
                    WHERE
                        user_id = ${user_id} AND company_id = ${company_id} AND (SELECT permission FROM config_company_roles ccr INNER JOIN config_users_roles cur ON cur.role_id = ccr.id WHERE ccr.company_id = ${company_id} AND cur.user_id = ${user_id}) 
                `, [], true, 60
            ).then((results) => {
                if (results.length == 0) {
                    reject("Você não tem permissão de administrador");
                } 

                resolve();
            })
        })
    },
    editCompany: function (user_id, company_id, name, address, city, state, business_type, zip_code, configurations) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    UPDATE 
                        companies
                    SET 
                        name = ?, address = ?, city = ?, state = ?, business_type = ?, zip_code = ?
                    WHERE
                        id = ?
                `, [name, address, city, state, business_type, zip_code, company_id]
            ).then((results) => {
                if (results.affectedRows = 0) {
                    reject("Ocorreu um erro ao alterar as informações da empresa");
                }

                this.editCompanyConfigurations(company_id, configurations).then(() => {
                    this.returnCompany(company_id, true);
                    _usersService.returnUserCompanies(user_id, true);
                    resolve();
                })
            }).catch((error) => {
                reject(error);
            })
        })
    },
    checkCompaniesFromUser: function (user_id, company_id) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        *
                    FROM
                        company_members
                    WHERE
                        user_id = ? AND company_id = ?
                `, [user_id, company_id]
            ).then((results) => {
                resolve(results);
            }).catch((error) => {
                reject(error);
            })
        })
    },
    inviteUser: function (company_id, requested_user_name, requested_user_id, requested_user_email, request_user, role_id) {
        return new Promise((resolve, reject) => {
            this.checkCompaniesFromUser(requested_user_id, company_id).then((results2) => {
                if (results2.length > 0) {
                    reject("Este usuário já faz parte desta empresa");
                }

                this.checkIfExistInvite(company_id, requested_user_email).then((results3) => {
                    if (results3.length > 0) {
                        reject("Este usuário já foi convidado para esta empresa");
                    } else {
                        _usersService.checkIfUserExists(requested_user_email).then((results) => {
                            let invited_user = results.user?.email;
            
                            if (!results.exist) {
                                invited_user = requested_user_email;
                            }
        
                            let token = functions.generateToken();
                            
                            functions.executeSql(
                                `
                                    INSERT INTO
                                        company_invitations
                                        (invited_user, company_id, invited_by, token, role_id)
                                    VALUES
                                        (?, ?, ?, ?, ?)
                                `, [invited_user, company_id, request_user, token, role_id]
                            ).then(() => {
                                functions.executeSql(
                                    `
                                        SELECT
                                            name
                                        FROM
                                            companies
                                        WHERE 
                                            id = ?
                                    `, [company_id]
                                ).then((results2) => {
                                    let company_name = results2[0].name;
                                    let link_convite = `${process.env.URL_SITE}/empresa_entrar?token=${token}&email=${requested_user_email}`;
                                    let emailHtml = emailTemplates.inviteUser(requested_user_name, company_name, link_convite);
            
                                    sendEmails.sendEmail(emailHtml, "Convite para entrar em uma empresa", process.env.USER_EMAIL, requested_user_email).then(() => {
                                        this.returnCompanyUsers(company_id, true);
                                        resolve();
                                    })
                                })
                            }).catch((error) => {
                                reject(error);
                            })
                        }).catch((error) => {
                            reject(error);
                        })
                    }
                })
            })
        })
    },
    checkIfExistInvite: function (company_id, email) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        *
                    FROM
                        company_invitations
                    WHERE
                        company_id = ? AND invited_user = ?
                `, [company_id, email]
            ).then((results) => {
                resolve(results);
            }).catch((error) => {
                reject(error);
            })
        })
    },
    returnCompanyUsers: function (company_id, clearCache = false) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        u.id,
                        u.name,
                        u.email,
                        ccr.id AS role,
                        ccr.name AS roleName,
                        ccr.permission AS rolePermission,
                        "Membro" AS status
                    FROM
                        company_members cm
                    INNER JOIN
                        users u ON u.id = cm.user_id
                    INNER JOIN
                        config_users_roles cur ON cur.user_id = u.id
                    INNER JOIN
                        config_company_roles ccr ON ccr.id = cur.role_id AND ccr.company_id = ${company_id}
                    WHERE
                        cm.company_id = ${company_id}

                    UNION

                    SELECT
                        NULL AS id,
                        invited_user AS name,
                        "" AS email,
                        "" AS role,
                        "" AS roleName,
                        0 AS rolePermission,
                        "Convite pendente" AS status
                    FROM
                        company_invitations ci
                    WHERE
                        ci.company_id = ${company_id} AND ci.status = "pending"

                    ORDER BY id IS NULL, name;
                `, [], !clearCache, 60
            ).then((results) => {
                resolve(results);
            }).catch((error) => {
                reject(error);
            })
        })
    },
    changeUserRole: function (role_id, user_id, company_id) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    UPDATE 
                        config_users_roles
                    SET
                        role_id = ?
                    WHERE
                        user_id = ?
                `, [role_id, user_id]
            ).then(() => {
                this.returnCompanyUsers(company_id, true);
                resolve();
            }).catch((error) => {
                reject(error);
            })
        })
    },
    checkTokenValidity: function (token, user_email) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        invited_user AS email,
                        invited_user = ? AS email_match
                    FROM
                        company_invitations
                    WHERE
                        token = ? AND status = "pending"
                `, [user_email, token]
            ).then((results) => {
                if (results.length == 0) {
                    reject("Token inválido ou expirado.");
                } else if (results[0].email_match == 0) {
                    reject("E-mail inválido para o convite");
                } else {
                    resolve(results[0].email);
                }
            }).catch((error) => {
                reject(error);
            })
        })
    },
    updateInvite: function (token) {
        return new Promise((resolve) => {
            functions.executeSql(
                `
                    UPDATE
                        company_invitations
                    SET
                        status = "accepted"
                    WHERE
                        token = ?;
                `, [token]
            ).then(() => {
                resolve();
            }).catch((error) => {
                reject(error);
            })
        })
    },
    enterCompanyWithToken: function (token) {
        return new Promise((resolve) => {
            functions.executeSql(
                `
                    INSERT INTO 
                            company_members
                            (user_id, company_id)
                        VALUES
                            (
                                (SELECT id from users WHERE email = (SELECT invited_user FROM company_invitations WHERE token = '${token}')),
                                (SELECT company_id FROM company_invitations WHERE token = '${token}')
                            )
                `, []
            ).then(() => {
                resolve();
            }).catch((error) => {
                reject(error);
            })
        })
    },
    insertRoleFromInvite: function (token) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    INSERT INTO 
                        config_users_roles
                        (role_id, user_id)
                    VALUES
                        (
                            (SELECT role_id FROM company_invitations WHERE token = '${token}'), 
                            (SELECT id from users WHERE email = (SELECT invited_user FROM company_invitations WHERE token = '${token}'))
                        )
                `, []
            ).then(() => {
                resolve();
            }).catch((error) => {
                reject(error);
            })
        })
    },
    enterCompany: function (token, user_email) {
        return new Promise((resolve, reject) => {
            let self = this;

            this.checkTokenValidity(token, user_email).then(() => {
                let promises = [];

                promises.push(
                    this.updateInvite(token)
                )

                promises.push(
                    this.enterCompanyWithToken(token)
                )
                
                promises.push(
                    this.insertRoleFromInvite(token)
                )

                promises.push(
                    functions.executeSql(
                        `
                            SELECT
                                company_id
                            FROM
                                company_invitations
                            WHERE
                                token = ?
                        `, [token]
                    ).then((results) => {
                        self.returnCompanyUsers(results[0].company_id, true);
                    })
                )

                promises.push(
                    functions.executeSql(
                        `
                            SELECT
                                id
                            FROM
                                users
                            WHERE 
                                email = (SELECT invited_user FROM company_invitations WHERE token = ?)
                        `, [token]
                    ).then((results) => {
                        _usersService.returnUserCompanies(results[0].id, true);
                    }).catch(() => {
                        reject("Email inválido para o convite");
                    })
                )

                Promise.all(promises).then(() => {
                    resolve();
                })
            }).catch((error) => {
                reject(error);
            })
        })
    },
    removeUserFromCompany: function (company_id, exclude_user_id, connected_user_id) {
        return new Promise((resolve, reject) => {
            if (exclude_user_id == connected_user_id) {
                reject("Você não pode se auto remover da empresa");
            }

            functions.executeSql(
                `
                    SELECT
                        *
                    FROM
                        company_members
                    WHERE
                        company_id = ?
                `, [company_id]
            ).then((results) => {
                if (results.length == 0) {
                    reject("Ocorreu um erro ao verificar os membros da empresa");
                }

                if (results.length == 1) {
                    reject("Você não pode sair de uma empresa cujo o único membro é você");
                }

                functions.executeSql(
                    `
                        DELETE FROM
                            company_members
                        WHERE
                            company_id = ${company_id} AND user_id = ${exclude_user_id};

                        DELETE FROM
                            company_invitations
                        WHERE
                            company_id = ${company_id} AND invited_user = (SELECT email FROM users WHERE id = '${exclude_user_id}');

                        DELETE FROM
                            config_users_roles
                        WHERE
                            user_id = ${exclude_user_id} AND role_id IN (SELECT id FROM config_company_roles WHERE company_id = ${company_id})
                    `, []
                ).then((results) => {
                    if (results.affectedRows == 0) {
                        reject("Ocorreu um erro ao remover o usuário");
                    }
    
                    this.returnCompanyUsers(company_id, true);
                    resolve();
                }).catch((error) => {
                    reject(error);
                })
            })
        })
    },
    findUserByToken: function (token, user_email) {
        return new Promise((resolve, reject) => {
            this.checkTokenValidity(token, user_email).then((results) => {
                _usersService.checkIfUserExists(results).then((results) => {
                    if (results.exist) {
                        resolve(true);
                    }

                    resolve(false);
                })
            }).catch((error) => {
                reject(error);
            })
        })
    },
    createService: function (company_id, name, value, cost, observations, duration) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    INSERT INTO services (company_id, name, value, cost, observations, duration)
                    VALUES (?, ?, ?, ?, ?, ?)
                `,
                [company_id, name, value, cost, observations, duration]
            ).then((results) => {
                if (results.affectedRows === 0) {
                    reject("Erro ao criar o serviço");
                }
                this.returnCompanyServices(company_id, true);
                resolve();
            }).catch((error) => {
                reject(error);
            });
        });
    },
    returnCompanyServices: function (company_id, clearCache = false) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT id, name, value, cost, observations, duration
                    FROM services
                    WHERE company_id = ?
                `,
                [company_id], !clearCache
            ).then((results) => {
                resolve(results);
            }).catch((error) => {
                reject(error);
            });
        });
    },
    editService: function (company_id, service_id, name, value, cost, observations, duration) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    UPDATE services
                    SET name = ?, value = ?, cost = ?, observations = ?, duration = ?
                    WHERE id = ? AND company_id = ?
                `,
                [name, value, cost, observations, duration, service_id, company_id]
            ).then((results) => {
                if (results.affectedRows === 0) {
                    reject("Erro ao atualizar o serviço");
                }
                this.returnCompanyServices(company_id, true);
                resolve();
            }).catch((error) => {
                reject(error);
            });
        });
    },
    excludeService: function (company_id, service_id) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    DELETE FROM services
                    WHERE id = ? AND company_id = ?
                `,
                [service_id, company_id]
            ).then((results) => {
                if (results.affectedRows === 0) {
                    reject("Erro ao excluir o serviço");
                }
                this.returnCompanyServices(company_id, true);
                resolve();
            }).catch((error) => {
                reject(error);
            });
        });
    },
    getPreferences: function (company_id, clearCache = false) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        *,
                        (SELECT active FROM config_companies_preferences ccp WHERE ccp.preference_id = p.id AND ccp.company_id = ?) AS active
                    FROM
                        preferences p
                `, [company_id], !clearCache
            ).then((results) => {
                resolve(results);
            }).catch((error) => {
                reject(error);
            });
        })
    },
    setPreferences: function (company_id, preferences) {
        for (let i = 0; i < preferences.length; i++) {
            let currentPreference = preferences[i];
            functions.insertCompanyPreference(company_id, currentPreference.code, !currentPreference.active ? 0 : 1);
        }

        this.getPreferences(company_id, true);
    }
}

module.exports = companiesService;