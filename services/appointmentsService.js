const functions = require("../utils/functions");
const sendEmails = require("../config/sendEmail");
const emailTemplates = require("../templates/emailTemplates");

let appointmentsService = {
    create: function (company_id, customer_id, customer_name, date, duration, observations, service) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                INSERT INTO appointments (company_id, customer_id, customer_name, date, duration, observations, service)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [company_id, customer_id, customer_name, date, duration, observations, service]
            ).then((results) => {
                if (results.affectedRows > 0) {
                    this.getAllByCompany(company_id, true);
                    resolve();
                } else {
                    reject("Ocorreu um erro ao cadastrar o agendamento");
                }
            }).catch((error) => {
                reject(error);
            });
        });
    },
    update: function (appointment_id, company_id, customer_id, customer_name, date, duration, observations, service) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                UPDATE appointments
                SET customer_id = ?, customer_name = ?, date = ?, duration = ?, observations = ?, service = ?
                WHERE id = ? AND company_id = ?
                `, [customer_id, customer_name, date, duration, observations, service, appointment_id, company_id]
            ).then((results) => {
                if (results.affectedRows > 0) {
                    this.getAllByCompany(company_id, true);
                    resolve();
                } else {
                    reject("Nenhum agendamento foi atualizado");
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
    getById: function (appointment_id, company_id) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                SELECT a.*, 
                       s.name AS service_name, 
                       SUBSTRING_INDEX(a.customer_name, ' ', 1) AS first_name
                FROM appointments a
                JOIN services s ON a.service = s.id
                WHERE a.id = ? AND a.company_id = ?
                `, [appointment_id, company_id]
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
    getAllByCompany: function (company_id, refreshCache = false) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                SELECT a.*, 
                       s.name AS service_name, 
                       SUBSTRING_INDEX(a.customer_name, ' ', 1) AS first_name
                FROM appointments a
                JOIN services s ON a.service = s.id
                WHERE a.company_id = ?
                `, [company_id]
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