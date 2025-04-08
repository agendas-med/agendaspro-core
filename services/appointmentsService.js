const functions = require("../utils/functions");
const sendEmails = require("../config/sendEmail");
const emailTemplates = require("../templates/emailTemplates");

let appointmentsService = {
    create: function (company_id, customer_id, customer_name, date, duration, observations, services, status) {
        return new Promise((resolve, reject) => {
            // Primeiro, verifica se já existe um agendamento no mesmo horário para a empresa
            functions.executeSql(
                `
                SELECT COUNT(*) AS total FROM appointments 
                WHERE company_id = ? AND date = ?
                `, [company_id, date]
            ).then((results) => {
                if (results[0].total > 0) {
                    // Já existe um agendamento nesse horário
                    reject("Já existe um agendamento para este horário.");
                } else {
                    return functions.executeSql(
                        `
                        INSERT INTO appointments (company_id, customer_id, customer_name, date, duration, observations, status)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        `, [company_id, customer_id, customer_name, date, duration, observations, status]
                    );
                }
            }).then((results) => {
                if (results && results.affectedRows > 0) {
                    this.insertAppointmentServices(results.insertId, services).then(() => {
                        this.getAllByCompany(company_id, true);
                        this.getAllByCompany(company_id, true, true);
                        resolve();
                    });
                } else {
                    reject("Ocorreu um erro ao cadastrar o agendamento.");
                }
            }).catch((error) => {
                reject(error);
            });
        });
    },
    deleteAppointmentServices: function (appointment_id) {
        return new Promise((resolve) => {
            functions.executeSql(
                `
                    DELETE FROM
                        appointment_services
                    WHERE
                        appointment_id = ?
                `, [appointment_id]
            ).then(() => {
                resolve();
            })
        })
    },
    insertAppointmentServices: function (appointment_id, services) {
        return new Promise((resolve) => {
            this.deleteAppointmentServices(appointment_id).then(() => {
                let inserts = [];

                for (let i = 0; i < services.length; i++) {
                    let currentService = services[i];
                    
                    inserts.push(
                        `
                            (${currentService.id}, ${appointment_id})
                        `
                    )
                }

                functions.executeSql(
                    `
                        INSERT INTO
                            appointment_services
                            (service_id, appointment_id)
                        VALUES
                            ${inserts.join(",")}
                    `, []
                ).then(() => {
                    resolve();
                })
            })
        })
    },
    getAppointmentServices: function (appointment_id) {
        return new Promise((resolve) => {
            functions.executeSql(
                `
                    SELECT
                        s.*
                    FROM
                        appointment_services aas
                    INNER JOIN
                        services s ON s.id = aas.service_id
                    WHERE
                        aas.appointment_id = ?
                `, [appointment_id]
            ).then((results) => {
                resolve(results);
            })
        })
    },
    update: function (appointment_id, company_id, customer_id, customer_name, date, duration, observations, services, status) {
        return new Promise((resolve, reject) => {
            // Primeiro, verifica se já existe outro agendamento no mesmo horário para a empresa
            functions.executeSql(
                `
                SELECT COUNT(*) AS total FROM appointments 
                WHERE company_id = ? AND date = ? AND id <> ?
                `, [company_id, date, appointment_id]
            ).then((results) => {
                if (results[0].total > 0) {
                    // Já existe um outro agendamento nesse horário
                    reject("Já existe outro agendamento para este horário.");
                } else {
                    // Nenhum outro agendamento no horário, pode atualizar
                    return functions.executeSql(
                        `
                        UPDATE appointments
                        SET customer_id = ?, customer_name = ?, date = ?, duration = ?, observations = ?, status = ?
                        WHERE id = ? AND company_id = ?
                        `, [customer_id, customer_name, date, duration, observations, status, appointment_id, company_id]
                    );
                }
            }).then((results) => {
                if (results && results.affectedRows > 0) {
                    this.insertAppointmentServices(appointment_id, services).then(() => {
                        this.getAllByCompany(company_id, true);
                        this.getAllByCompany(company_id, true, true);
                        this.getById(appointment_id, company_id, true);
                        resolve();
                    });
                } else {
                    reject("Nenhum agendamento foi atualizado.");
                }
            }).catch((error) => {
                reject(error);
            });
        });
    },
    delete: function (appointment_id, company_id) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    DELETE FROM appointments
                    WHERE id = ? AND company_id = ?
                `, [appointment_id, company_id]
            ).then((results) => {
                if (results.affectedRows > 0) {
                    this.deleteAppointmentServices(appointment_id).then(() => {
                        this.getAllByCompany(company_id, true);
                        this.getAllByCompany(company_id, true, true);
                        resolve();
                    })
                } else {
                    reject("Nenhum agendamento foi encontrado para excluir");
                }
            }).catch((error) => {
                reject(error);
            });
        });
    },
    getById: function (appointment_id, company_id, clearCache = false) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                SELECT 
                    c.image,
                    a.*, 
                    SUBSTRING_INDEX(a.customer_name, ' ', 1) AS first_name                    
                FROM appointments a
                INNER JOIN customers c ON c.id = a.customer_id
                WHERE a.id = ? AND a.company_id = ?
                `, [appointment_id, company_id], !clearCache
            ).then((results) => {
                if (results.length > 0) {
                    let appointment = results[0];

                    this.getAppointmentServices(appointment_id).then((services) => {
                        appointment["services"] = services;

                        // Calcula o fim do evento somando a duração ao início
                        let start = appointment.date;
                        let end = new Date(new Date(start).getTime() + appointment.duration * 60000).toISOString();
        
                        resolve({
                            ...appointment,
                            start,
                            end,
                            title: `${appointment.services[0]?.name || ""} - ${appointment.first_name}`
                        });
                    })
                } else {
                    reject("Agendamento não encontrado");
                }
            }).catch((error) => {
                reject(error);
            });
        });
    },
    getAllByCompany: function (company_id, clearCache = false, today = null) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT 
                        c.image,
                        a.*, 
                        SUBSTRING_INDEX(a.customer_name, ' ', 1) AS first_name
                    FROM appointments a
                    INNER JOIN customers c ON c.id = a.customer_id
                    WHERE a.company_id = ?
                        ${today ? "AND DATE(a.date) = CURDATE() ORDER BY FIELD(status, 'iniciado', 'agendado', 'realizado'), a.date DESC" : ""}
                `, [company_id], !clearCache
            ).then((results) => {
                let promises = results.map(async (appointment) => {
                    let start = appointment.date;
                    let end = new Date(new Date(start).getTime() + appointment.duration * 60000).toISOString();
                
                    let services = await this.getAppointmentServices(appointment.id);
                    appointment["services"] = services;
                
                    return {
                        ...appointment,
                        start,
                        end,
                        title: `${appointment.services[0]?.name || ""} - ${appointment.first_name}`
                    };
                });
                
                Promise.all(promises).then((resolvedAppointments) => {
                    resolve(resolvedAppointments);
                });
            }).catch((error) => {
                reject(error);
            });
        });
    },
    init: function (company_id, appointment_id) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    UPDATE 
                        appointments
                    SET
                        status = 'iniciado', checkin = now()
                    WHERE 
                        company_id = ? AND id = ?                        
                `, [company_id, appointment_id]
            ).then(() => {
                this.getAllByCompany(company_id, true);
                this.getAllByCompany(company_id, true, true);
                resolve();
            }).catch((error) => {
                reject(error);
            });
        })
    },
    stop: function (company_id, appointment_id) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    UPDATE 
                        appointments
                    SET
                        status = 'realizado', checkout = now()
                    WHERE 
                        company_id = ? AND id = ?                        
                `, [company_id, appointment_id]
            ).then(() => {
                this.getAllByCompany(company_id, true);
                this.getAllByCompany(company_id, true, true);
                resolve();
            }).catch((error) => {
                reject(error);
            });
        })
    },
    cancel: function (company_id, appointment_id) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    UPDATE 
                        appointments
                    SET
                        status = 'cancelado'
                    WHERE 
                        company_id = ? AND id = ?                        
                `, [company_id, appointment_id]
            ).then(() => {
                this.getAllByCompany(company_id, true);
                this.getAllByCompany(company_id, true, true);
                resolve();
            }).catch((error) => {
                reject(error);
            });
        })
    }      
}

module.exports = appointmentsService;