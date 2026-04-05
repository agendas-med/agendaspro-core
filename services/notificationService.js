const functions = require("../utils/functions");
const moment = require("moment");
const axios = require("axios");

async function sendHourlyReminders() {
  try {
    const pending = await functions.executeSql(
      `SELECT a.id, a.date, c.name as customer_name, c.tel, comp.name as company_name 
             FROM appointments a
             INNER JOIN customers c ON a.customer_id = c.id
             INNER JOIN companies comp ON a.company_id = comp.id
             WHERE a.date > NOW() 
             AND a.date <= DATE_ADD(NOW(), INTERVAL 1 HOUR) 
             AND a.notified_1h = 0 
             AND (a.canceled = 0 OR a.canceled IS NULL)`,
    );

    if (pending.length > 0) {
      console.log(
        `[Cron Lembrete] ${pending.length} agendamentos encontrados para os próximos 60 min.`,
      );

      const idsString = pending.map((app) => app.id).join(",");

      try {
        const updateDb = await functions.executeSql(
          `UPDATE appointments SET notified_1h = 1 WHERE id IN (${idsString})`,
        );
        console.log(
          `[Cron Lembrete] Status atualizado no banco. Linhas afetadas: ${updateDb.affectedRows}`,
        );
      } catch (dbError) {
        console.error(
          "[Erro Cron] Falha crítica ao atualizar a coluna notified_1h no banco:",
          dbError.message,
        );
        return;
      }
    } else {
      return;
    }

    if (!process.env.WHATSAPP_API_URL || !process.env.WEBHOOK_SECRET_TOKEN) {
      console.error(
        "[Erro Lembrete] URL ou Token da API do WhatsApp não configurados no .env",
      );
      return;
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
