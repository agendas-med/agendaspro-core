const functions = require("../utils/functions");
const sendEmails = require("../config/sendEmail");
const emailTemplates = require("../templates/emailTemplates");
const _salesService = require("./salesService");
const axios = require("axios");

let appointmentsService = {
  create: function (
    company_id,
    customer_id,
    customer_name,
    date,
    duration,
    observations,
    services,
    status,
    addressData,
  ) {
    return new Promise(async (resolve, reject) => {
      const companyInfo = await functions.executeSql(
        `SELECT asaas_status FROM companies WHERE id = ?`,
        [company_id],
      );
      if (companyInfo[0].asaas_status !== "APPROVED") {
        return reject(
          "Ação bloqueada. A conta de recebimentos desta empresa ainda não foi aprovada ou validada.",
        );
      }

      if (
        addressData &&
        addressData.zip_code &&
        (!addressData.city || !addressData.state)
      ) {
        try {
          const cleanCep = addressData.zip_code.replace(/\D/g, "");
          if (cleanCep.length === 8) {
            const viaCepResponse = await axios.get(
              `https://viacep.com.br/ws/${cleanCep}/json/`,
            );
            if (!viaCepResponse.data.erro) {
              addressData.city =
                addressData.city || viaCepResponse.data.localidade;
              addressData.state = addressData.state || viaCepResponse.data.uf;
              addressData.address =
                addressData.address || viaCepResponse.data.logradouro;
            }
          }
        } catch (error) {
          console.log(
            "[Aviso] Não foi possível consultar o ViaCEP no agendamento:",
            error.message,
          );
        }
      }

      let checkin = null;
      let checkout = null;
      let canceled = 0;

      if (status === "cancelado") {
        canceled = 1;
      } else if (status === "iniciado") {
        checkin = new Date();
      } else if (status === "realizado") {
        checkin = new Date();
        checkout = new Date();
      }

      functions
        .executeSql(
          `
                SELECT COUNT(*) AS total FROM appointments 
                WHERE company_id = ? AND date = ? AND canceled = 0
                `,
          [company_id, date],
        )
        .then((results) => {
          if (results[0].total > 0) {
            reject("Já existe um agendamento para este horário.");
          } else {
            return functions.executeSql(
              `
                        INSERT INTO appointments 
                            (company_id, customer_id, customer_name, date, duration, observations, checkin, checkout, canceled, zip_code, address, number, complement, city, state)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `,
              [
                company_id,
                customer_id,
                customer_name,
                date,
                duration,
                observations,
                checkin,
                checkout,
                canceled,
                addressData?.zip_code || null,
                addressData?.address || null,
                addressData?.number || null,
                addressData?.complement || null,
                addressData?.city || null,
                addressData?.state || null,
              ],
            );
          }
        })
        .then((results) => {
          if (results && results.affectedRows > 0) {
            const newAppointmentId = results.insertId;

            this.insertAppointmentServices(newAppointmentId, services)
              .then(() => {
                let statusVenda = "";

                switch (status) {
                  case "cancelado":
                    statusVenda = "cancelada";
                    break;
                  case "iniciado":
                  case "agendado":
                    statusVenda = "em_aberto";
                    break;
                  case "realizado":
                    statusVenda = "realizada";
                    break;
                }

                _salesService
                  .create(
                    company_id,
                    customer_id,
                    newAppointmentId,
                    [],
                    statusVenda,
                  )
                  .catch((err) =>
                    console.log("Aviso: Falha ao criar venda automática", err),
                  );

                this.getAllByCompany(company_id, true);
                this.getAllByCompany(company_id, true, true);

                resolve(newAppointmentId);
              })
              .catch((error) => reject(error));
          } else {
            reject("Ocorreu um erro ao cadastrar o agendamento.");
          }
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  deleteAppointmentServices: function (appointment_id) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `DELETE FROM appointment_services WHERE appointment_id = ?`,
          [appointment_id],
        )
        .then(() => resolve())
        .catch((error) => reject(error));
    });
  },
  insertAppointmentServices: function (appointment_id, services) {
    return new Promise((resolve, reject) => {
      this.deleteAppointmentServices(appointment_id)
        .then(() => {
          let inserts = [];

          if (!services || services.length === 0) return resolve();

          for (let i = 0; i < services.length; i++) {
            let currentService = services[i];
            let qty = currentService.quantity
              ? parseInt(currentService.quantity)
              : 1;
            inserts.push(`(${currentService.id}, ${appointment_id}, ${qty})`);
          }

          functions
            .executeSql(
              `INSERT INTO appointment_services (service_id, appointment_id, quantity)
             VALUES ${inserts.join(",")}`,
              [],
            )
            .then(() => resolve())
            .catch((error) => reject(error));
        })
        .catch((error) => reject(error));
    });
  },
  getAppointmentServices: function (appointment_id) {
    return new Promise((resolve) => {
      functions
        .executeSql(
          `SELECT s.*, aas.quantity 
           FROM appointment_services aas
           INNER JOIN services s ON s.id = aas.service_id
           WHERE aas.appointment_id = ?`,
          [appointment_id],
        )
        .then((results) => resolve(results));
    });
  },
  update: function (
    appointment_id,
    company_id,
    customer_id,
    customer_name,
    date,
    duration,
    observations,
    services,
    status,
    addressData,
  ) {
    return new Promise(async (resolve, reject) => {
      let checkin = null;
      let checkout = null;
      let canceled = 0;

      if (status === "cancelado") {
        canceled = 1;
      } else if (status === "iniciado") {
        checkin = new Date();
      } else if (status === "realizado") {
        checkin = new Date();
        checkout = new Date();
      }

      const currentApp = await functions.executeSql(
        `SELECT zip_code, address, number, complement, city, state FROM appointments WHERE id = ?`,
        [appointment_id],
      );
      let finalAddress = addressData;

      if (canceled === 1 && !addressData && currentApp.length > 0) {
        finalAddress = {
          zip_code: currentApp[0].zip_code,
          address: currentApp[0].address,
          number: currentApp[0].number,
          complement: currentApp[0].complement,
          city: currentApp[0].city,
          state: currentApp[0].state,
        };
      }

      if (
        finalAddress &&
        finalAddress.zip_code &&
        (!finalAddress.city || !finalAddress.state)
      ) {
        try {
          const cleanCep = finalAddress.zip_code.replace(/\D/g, "");
          if (cleanCep.length === 8) {
            const viaCepResponse = await axios.get(
              `https://viacep.com.br/ws/${cleanCep}/json/`,
            );
            if (!viaCepResponse.data.erro) {
              finalAddress.city =
                finalAddress.city || viaCepResponse.data.localidade;
              finalAddress.state = finalAddress.state || viaCepResponse.data.uf;
              finalAddress.address =
                finalAddress.address || viaCepResponse.data.logradouro;
            }
          }
        } catch (error) {
          console.log(
            "[Aviso] Não foi possível consultar o ViaCEP na edição:",
            error.message,
          );
        }
      }

      functions
        .executeSql(
          `
                SELECT COUNT(*) AS total FROM appointments 
                WHERE company_id = ? AND date = ? AND canceled = 0 AND id != ?
          `,
          [company_id, date, appointment_id],
        )
        .then((results) => {
          if (results[0].total > 0) {
            reject("Já existe outro agendamento para este horário.");
          } else {
            return functions.executeSql(
              `
                        UPDATE appointments
                        SET customer_id = ?, customer_name = ?, date = ?, duration = ?, observations = ?, checkin = ?, checkout = ?, canceled = ?, zip_code = ?, address = ?, number = ?, complement = ?, city = ?, state = ?
                        WHERE id = ? AND company_id = ?
                        `,
              [
                customer_id,
                customer_name,
                date,
                duration,
                observations,
                checkin,
                checkout,
                canceled,
                finalAddress?.zip_code || null,
                finalAddress?.address || null,
                finalAddress?.number || null,
                finalAddress?.complement || null,
                finalAddress?.city || null,
                finalAddress?.state || null,
                appointment_id,
                company_id,
              ],
            );
          }
        })
        .then((results) => {
          if (results && results.affectedRows > 0) {
            this.insertAppointmentServices(appointment_id, services).then(
              () => {
                this.getAllByCompany(company_id, true);
                this.getAllByCompany(company_id, true, true);
                this.getById(appointment_id, company_id, true);
                resolve();
              },
            );
          } else {
            reject("Nenhum agendamento foi atualizado.");
          }
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  delete: function (appointment_id, company_id) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `
                    DELETE FROM appointments
                    WHERE id = ? AND company_id = ?
                `,
          [appointment_id, company_id],
        )
        .then((results) => {
          if (results.affectedRows > 0) {
            this.deleteAppointmentServices(appointment_id).then(() => {
              this.getAllByCompany(company_id, true);
              this.getAllByCompany(company_id, true, true);
              resolve();
            });
          } else {
            reject("Nenhum agendamento foi encontrado para excluir");
          }
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  getById: function (appointment_id, company_id, clearCache = false) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `
                SELECT 
                    c.image,
                    a.*, 
                    SUBSTRING_INDEX(a.customer_name, ' ', 1) AS first_name                    
                FROM appointment_status_view a
                INNER JOIN customers c ON c.id = a.customer_id
                WHERE a.id = ? AND a.company_id = ?
                `,
          [appointment_id, company_id],
          !clearCache,
        )
        .then((results) => {
          if (results.length > 0) {
            let appointment = results[0];

            this.getAppointmentServices(appointment_id).then((services) => {
              appointment["services"] = services;

              // Calcula o fim do evento somando a duração ao início
              let start = appointment.date;
              let end = new Date(
                new Date(start).getTime() + appointment.duration * 60000,
              ).toISOString();

              resolve({
                ...appointment,
                start,
                end,
                title: `${appointment.services[0]?.name || ""} - ${appointment.first_name}`,
              });
            });
          } else {
            reject("Agendamento não encontrado");
          }
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  getAllByCompany: function (
    company_id,
    clearCache = false,
    targetDate = null,
  ) {
    return new Promise((resolve, reject) => {
      let sql = `                 
          SELECT 
              c.image,
              a.*,
              SUBSTRING_INDEX(a.customer_name, ' ', 1) AS first_name
          FROM appointment_status_view a
          INNER JOIN customers c ON c.id = a.customer_id
          WHERE a.company_id = ?
      `;
      let params = [company_id];

      if (targetDate) {
        if (typeof targetDate === "string") {
          sql += ` AND DATE(a.date) = ?`;
          params.push(targetDate);
        } else {
          sql += ` AND DATE(a.date) = CURDATE() ORDER BY FIELD(status, 'iniciado', 'agendado', 'realizado'), a.date DESC`;
        }
      }

      functions
        .executeSql(sql, params, !clearCache)
        .then((results) => {
          let promises = results.map(async (appointment) => {
            let start = appointment.date;
            let end = new Date(
              new Date(start).getTime() + appointment.duration * 60000,
            ).toISOString();

            let services = await this.getAppointmentServices(appointment.id);
            appointment["services"] = services;

            return {
              ...appointment,
              start,
              end,
              title: `${appointment.services[0]?.name || ""} - ${appointment.first_name}`,
            };
          });

          Promise.all(promises).then((resolvedAppointments) => {
            resolve(resolvedAppointments);
          });
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  init: function (company_id, appointment_id) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `
                    UPDATE 
                        appointments
                    SET
                        checkin = now()
                    WHERE 
                        company_id = ? AND id = ?                        
                `,
          [company_id, appointment_id],
        )
        .then(() => {
          this.getAllByCompany(company_id, true);
          this.getAllByCompany(company_id, true, true);
          resolve();
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  stop: function (company_id, appointment_id) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `
                    UPDATE 
                        appointments
                    SET
                        checkout = now()
                    WHERE 
                        company_id = ? AND id = ?                        
                `,
          [company_id, appointment_id],
        )
        .then(() => {
          this.getAllByCompany(company_id, true);
          this.getAllByCompany(company_id, true, true);
          resolve();
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  cancel: function (company_id, appointment_id) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `
                    UPDATE 
                        appointments
                    SET
                        canceled = 1
                    WHERE 
                        company_id = ? AND id = ?                        
                `,
          [company_id, appointment_id],
        )
        .then(() => {
          this.getAllByCompany(company_id, true);
          this.getAllByCompany(company_id, true, true);
          resolve();
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
};

module.exports = appointmentsService;
