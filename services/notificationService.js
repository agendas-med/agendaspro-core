const functions = require("../utils/functions");
const moment = require("moment");
const axios = require("axios");

async function sendHourlyReminders() {
  try {
    const now = moment().utcOffset("-0300").format("YYYY-MM-DD HH:mm:ss");

    const targetTime = moment()
      .utcOffset("-0300")
      .add(1, "hour")
      .format("YYYY-MM-DD HH:mm:ss");

    const pending = await functions.executeSql(
      `SELECT a.id, a.date, c.name as customer_name, c.tel, comp.name as company_name 
         FROM appointments a
         INNER JOIN customers c ON a.customer_id = c.id
         INNER JOIN companies comp ON a.company_id = comp.id
         WHERE a.date > ? 
         AND a.date <= ? 
         AND a.notified_1h = 0 
         AND (a.canceled = 0 OR a.canceled IS NULL)`,
      [now, targetTime],
    );

    if (pending.length > 0) {
      console.log(
        `[Cron Lembrete] ${pending.length} agendamentos encontrados no intervalo entre ${now} e ${targetTime}.`,
      );
    }

    const sendPromises = pending.map(async (app) => {
      const horaFormatada = moment(app.date).format("HH:mm");
      const message = `Olá, ${app.customer_name}! Passando para lembrar do seu agendamento na *${app.company_name}* hoje às *${horaFormatada}*. Nos vemos em breve! 🗓️`;

      let wppNumber = app.tel ? app.tel.replace(/\D/g, "") : "";
      if (wppNumber.length === 10 || wppNumber.length === 11) {
        wppNumber = `55${wppNumber}`;
      }

      try {
        await axios.post(
          `${process.env.WHATSAPP_API_URL}/message/sendText`,
          {
            number: wppNumber,
            text: message,
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.WEBHOOK_SECRET_TOKEN}`,
              "Content-Type": "application/json",
            },
          },
        );

        console.log(
          `[Lembrete] Enviado com sucesso para ${app.customer_name} (${wppNumber})`,
        );
      } catch (error) {
        console.error(
          `[Erro Lembrete] Falha ao enviar para ${app.customer_name} (${wppNumber}):`,
          error.message,
        );
      }
    });

    await Promise.all(sendPromises);
  } catch (error) {
    console.error(
      "[Erro Cron Geral] Falha ao verificar agendamentos:",
      error.message,
    );
  }
}

module.exports = { sendHourlyReminders };
