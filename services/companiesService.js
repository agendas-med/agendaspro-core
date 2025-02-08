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
                    let company = {
                        id: results[0]?.id || null,
                        name: results[0]?.name || "",
                        address: results[0]?.address || "",
                        zip_code: results[0]?.zip_code || "",
                        business_type: results[0]?.business_type || "",
                        city: results[0]?.city || "",
                        state: results[0]?.state || "",
                        configurations: results2
                    }
    
                    resolve(company);
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
                    this.insertCompanyDefaultPreferences(results.insertId);
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
            for (let i = 0; i < configurations.notifications.length; i++) {
                let currentPreference = configurations.notifications[i];
                functions.insertCompanyPreference(company_id, currentPreference.code, currentPreference.active ? 1 : 0);
            }

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
    checkCompanyAdmin: function (user_id, company_id) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        *
                    FROM
                        company_members
                    WHERE
                        user_id = ? AND company_id = ? AND role = "Admin"
                `, [user_id, company_id], true, 60
            ).then((results) => {
                if (results.length < 0) {
                    reject("Você não tem permissão para fazer isso");
                } 

                resolve();
            })
        })
    },
    editCompany: function (company_id, name, address, city, state, business_type, zip_code, configurations) {
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
                    resolve();
                })
            }).catch((error) => {
                reject(error);
            })
        })
    }
}

module.exports = companiesService;