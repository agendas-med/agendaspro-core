const functions = require("../utils/functions");
const moment = require("moment");
const axios = require("axios");

// O gatilho de jobs é HORÁRIO (POST /internal/jobs/tick ~1x/h). Por isso a janela é larga e
// tolerante a atraso: agendamentos que começam entre agora+1h e agora+24h30, ainda sem
// lembrete. Cada agendamento vira um job com dedupe por (id, data); o envio só marca
// notified_1h = 1 após sucesso.
const MIN_LEAD_MINUTES = 60;
const MAX_LEAD_MINUTES = 24 * 60 + 30;

function whatsappNumber(tel) {
  let digits = String(tel || "").replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  return digits;
}

const ELIGIBLE_SQL = `
  FROM appointments a
  INNER JOIN customers c ON c.id = a.customer_id AND c.company_id = a.company_id
  INNER JOIN companies comp ON comp.id = a.company_id
  INNER JOIN config_companies_preferences ccp ON ccp.company_id = a.company_id AND ccp.active = 1
  INNER JOIN preferences p ON p.id = ccp.preference_id AND p.code = 'notificate_scheduling'
  WHERE a.date >= NOW() + INTERVAL ? MINUTE
    AND a.date <= NOW() + INTERVAL ? MINUTE
    AND a.notified_1h = 0
    AND (a.canceled = 0 OR a.canceled IS NULL)
    AND c.anonymized_at IS NULL`;

// Produtor: enfileira um job por agendamento elegível (idempotente via dedupe_key).
async function enqueueDueReminders(jobsService, limit = 500) {
  const rows = await functions.executeSql(
    `SELECT a.id, DATE_FORMAT(a.date, '%Y%m%d%H%i') AS slot ${ELIGIBLE_SQL} ORDER BY a.date LIMIT ?`,
    [MIN_LEAD_MINUTES, MAX_LEAD_MINUTES, limit],
  );
  let enqueued = 0;
  for (const row of rows) {
    const created = await jobsService.enqueue("appointment_reminder", { appointment_id: row.id }, { dedupeKey: `reminder:${row.id}:${row.slot}`, maxAttempts: 3 });
    if (created) enqueued++;
  }
  return enqueued;
}

// Handler: revalida a elegibilidade, envia e só então marca como notificado.
async function sendAppointmentReminder({ appointment_id }) {
  const rows = await functions.executeSql(
    `SELECT a.id, a.date, c.name AS customer_name, c.tel, comp.name AS company_name ${ELIGIBLE_SQL} AND a.id = ?`,
    [MIN_LEAD_MINUTES - 30, MAX_LEAD_MINUTES, appointment_id],
  );
  if (!rows.length) return { skipped: true };
  const app = rows[0];

  const number = whatsappNumber(app.tel);
  if (number.length < 12) {
    await functions.executeSql(`UPDATE appointments SET notified_1h = 1 WHERE id = ?`, [app.id]);
    return { skipped: true, reason: "telefone inválido" };
  }
  if (!process.env.WHATSAPP_API_URL || !process.env.WHATSAPP_OUTBOUND_TOKEN) {
    throw new Error("WhatsApp de saída não configurado (WHATSAPP_API_URL/WHATSAPP_OUTBOUND_TOKEN).");
  }

  const when = moment(app.date);
  const day = when.isSame(moment(), "day") ? "hoje" : `em ${when.format("DD/MM")}`;
  const text = `Olá, ${app.customer_name}! Passando para lembrar do seu agendamento na *${app.company_name}* ${day} às *${when.format("HH:mm")}*. Nos vemos em breve! 🗓️`;

  await axios.post(
    `${process.env.WHATSAPP_API_URL}/message/sendText`,
    { number, text },
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_OUTBOUND_TOKEN}`, "Content-Type": "application/json" }, timeout: 10000 },
  );
  await functions.executeSql(`UPDATE appointments SET notified_1h = 1 WHERE id = ? AND notified_1h = 0`, [app.id]);
  return { sent: true };
}

module.exports = { enqueueDueReminders, sendAppointmentReminder, whatsappNumber, MIN_LEAD_MINUTES, MAX_LEAD_MINUTES };
