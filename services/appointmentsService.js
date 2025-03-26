const functions = require("../utils/functions");
const sendEmails = require("../config/sendEmail");
const emailTemplates = require("../templates/emailTemplates");

let appointmentsService = {
    create: function (company_id, customer_id, customer_name, date, duration, observations, service, status) {
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
                    // Nenhum agendamento no horário, pode inserir
                    return functions.executeSql(
                        `
                        INSERT INTO appointments (company_id, customer_id, customer_name, date, duration, observations, service_id, status)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        `, [company_id, customer_id, customer_name, date, duration, observations, service, status]
                    );
                }
            }).then((results) => {
                if (results && results.affectedRows > 0) {
                    this.getAllByCompany(company_id, true);
                    resolve();
                } else {
                    reject("Ocorreu um erro ao cadastrar o agendamento.");
                }
            }).catch((error) => {
                reject(error);
            });
        });
    },
    update: function (appointment_id, company_id, customer_id, customer_name, date, duration, observations, service, status) {
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
                        SET customer_id = ?, customer_name = ?, date = ?, duration = ?, observations = ?, service_id = ?, status = ?
                        WHERE id = ? AND company_id = ?
                        `, [customer_id, customer_name, date, duration, observations, service, status, appointment_id, company_id]
                    );
                }
            }).then((results) => {
                if (results && results.affectedRows > 0) {
                    this.getAllByCompany(company_id, true);
                    this.getById(appointment_id, company_id, true);
                    resolve();
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
                    this.getAllByCompany(company_id, true);
                    resolve();
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
                SELECT a.*, 
                       s.name AS service_name, 
                       SUBSTRING_INDEX(a.customer_name, ' ', 1) AS first_name
                FROM appointments a
                JOIN services s ON a.service_id = s.id
                WHERE a.id = ? AND a.company_id = ?
                `, [appointment_id, company_id], !clearCache
            ).then((results) => {
                if (results.length > 0) {
                    let appointment = results[0];
    
                    // Calcula o fim do evento somando a duração ao início
                    let start = appointment.date;
                    let end = new Date(new Date(start).getTime() + appointment.duration * 60000).toISOString();
    
                    resolve({
                        ...appointment,
                        start,
                        end,
                        title: `${appointment.service_name} - ${appointment.first_name}`
                    });
                } else {
                    reject("Agendamento não encontrado");
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
                SELECT a.*, 
                       s.name AS service_name, 
                       SUBSTRING_INDEX(a.customer_name, ' ', 1) AS first_name
                FROM appointments a
                INNER JOIN services s ON a.service_id = s.id
                WHERE a.company_id = ?
                `, [company_id], !clearCache
            ).then((results) => {
                let appointments = results.map(appointment => {
                    let start = appointment.date;
                    let end = new Date(new Date(start).getTime() + appointment.duration * 60000).toISOString();
    
                    return {
                        ...appointment,
                        start,
                        end,
                        title: `${appointment.service_name} - ${appointment.first_name}`
                    };
                });
    
                resolve(appointments);
            }).catch((error) => {
                reject(error);
            });
        });
    }    
}

module.exports = appointmentsService;