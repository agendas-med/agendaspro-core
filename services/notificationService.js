const functions = require("../utils/functions");
const axios = require("axios");
const plans = require("./plansService");
const { wallClock, wallMinutes, minutesToWall, dbWall, resolveTimezone, defaultTimezone } = require("../utils/time");

// O gatilho de jobs é HORÁRIO (POST /internal/jobs/tick ~1x/h). Por isso as janelas são largas e
// tolerantes a atraso (regra 1 do plano):
// - lembrete 24h: começa entre agora+1h e agora+24h30, sem lembrete 24h (flag notified_1h);
// - lembrete 2h (Premium): começa entre agora+1h e agora+2h30, sem lembrete 2h (notified_2h).
// Cada agendamento vira um job com dedupe por (id, data); o envio só marca a flag após sucesso.
// "Agora" é calculado por empresa (companies.timezone; fallback APP_TIMEZONE), pois as datas
// no banco são hora de parede no fuso da empresa.
const MIN_LEAD_MINUTES = 60;
const MAX_LEAD_MINUTES = 24 * 60 + 30;
const MAX_LEAD_2H_MINUTES = 2 * 60 + 30;
// Com lembrete 2h ativo, o de 24h não é enviado se faltar pouco (evita duas mensagens seguidas).
const CLOSE_LEAD_MINUTES = 3 * 60;
const HANDLER_SLACK_MINUTES = 30;

const KINDS = {
  "24h": { flag: "notified_1h", job: "appointment_reminder", dedupe: "reminder", maxLead: MAX_LEAD_MINUTES },
  "2h": { flag: "notified_2h", job: "appointment_reminder_2h", dedupe: "reminder2h", maxLead: MAX_LEAD_2H_MINUTES },
};

function whatsappNumber(tel) {
  let digits = String(tel || "").replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  return digits;
}

const CANDIDATES_SQL = (flag) => `
  SELECT a.id, a.company_id, a.date, DATE_FORMAT(a.date, '%Y-%m-%d %H:%i:%s') AS wall, DATE_FORMAT(a.date, '%Y%m%d%H%i') AS slot,
         c.name AS customer_name, c.tel, comp.name AS company_name, comp.timezone
  FROM appointments a
  INNER JOIN customers c ON c.id = a.customer_id AND c.company_id = a.company_id
  INNER JOIN companies comp ON comp.id = a.company_id
  INNER JOIN config_companies_preferences ccp ON ccp.company_id = a.company_id AND ccp.active = 1
  INNER JOIN preferences p ON p.id = ccp.preference_id AND p.code = 'notificate_scheduling'
  WHERE a.${flag} = 0
    AND (a.canceled = 0 OR a.canceled IS NULL)
    AND c.anonymized_at IS NULL`;

// Fusos em uso (poucos): para cada um, a janela exata em hora de parede vai para o SQL.
async function timezonesInUse() {
  const rows = await functions.executeSql("SELECT DISTINCT timezone FROM companies WHERE timezone IS NOT NULL AND timezone <> ''");
  return [...new Set([defaultTimezone(), ...rows.map(row => resolveTimezone(row.timezone))])];
}

function leadMinutes(row, now = new Date()) {
  const wall = row.wall || dbWall(row.date);
  return wallMinutes(wall) - wallMinutes(wallClock(now, resolveTimezone(row.timezone)));
}

// Plano efetivo por empresa, memoizado só durante uma execução (nada de estado entre ticks).
function entitlementMemo() {
  const memo = new Map();
  return companyId => {
    if (!memo.has(companyId)) memo.set(companyId, plans.entitlement(companyId));
    return memo.get(companyId);
  };
}

async function enqueue(kind, jobsService, limit) {
  const spec = KINDS[kind];
  const now = new Date();
  const fallback = defaultTimezone();
  const rows = [];
  for (const tz of await timezonesInUse()) {
    const nowWall = wallMinutes(wallClock(now, tz));
    const scope = tz === fallback ? "(comp.timezone IS NULL OR comp.timezone = '' OR comp.timezone = ?)" : "comp.timezone = ?";
    rows.push(...await functions.executeSql(
      `${CANDIDATES_SQL(spec.flag)} AND ${scope} AND a.date >= ? AND a.date <= ? ORDER BY a.date LIMIT ?`,
      [tz, minutesToWall(nowWall + MIN_LEAD_MINUTES), minutesToWall(nowWall + spec.maxLead), limit],
    ));
  }
  const ent = entitlementMemo();
  let enqueued = 0;
  for (const row of rows) {
    const lead = leadMinutes(row, now);
    if (lead < MIN_LEAD_MINUTES || lead > spec.maxLead) continue;
    if (kind === "2h" && (await ent(row.company_id)).features.whatsapp_reminder_2h !== true) continue;
    const created = await jobsService.enqueue(spec.job, { appointment_id: row.id }, { dedupeKey: `${spec.dedupe}:${row.id}:${row.slot}`, maxAttempts: 3 });
    if (created) enqueued++;
  }
  return enqueued;
}

// Produtores: enfileiram um job por agendamento elegível (idempotente via dedupe_key).
const enqueueDueReminders = (jobsService, limit = 500) => enqueue("24h", jobsService, limit);
const enqueueDueReminders2h = (jobsService, limit = 500) => enqueue("2h", jobsService, limit);

async function markSent(appointmentId, flags) {
  await functions.executeSql(`UPDATE appointments SET ${flags.map(flag => `${flag} = 1`).join(", ")} WHERE id = ?`, [appointmentId]);
}

function reminderText(app, lead) {
  const [date, time] = app.wall.split(" ");
  const today = wallClock(new Date(), resolveTimezone(app.timezone)).slice(0, 10) === date;
  const day = today ? "hoje" : `em ${date.slice(8, 10)}/${date.slice(5, 7)}`;
  const prefix = lead <= MAX_LEAD_2H_MINUTES ? "Falta pouco! " : "";
  return `${prefix}Olá, ${app.customer_name}! Passando para lembrar do seu agendamento na *${app.company_name}* ${day} às *${time.slice(0, 5)}*. Nos vemos em breve! 🗓️`;
}

// Handler comum: revalida a elegibilidade, aplica plano/quota, envia e só então marca.
async function sendReminder(kind, { appointment_id: appointmentId }) {
  const spec = KINDS[kind];
  const [app] = await functions.executeSql(`${CANDIDATES_SQL(spec.flag)} AND a.id = ?`, [appointmentId]);
  if (!app) return { skipped: true };
  const lead = leadMinutes(app);
  if (lead < MIN_LEAD_MINUTES - HANDLER_SLACK_MINUTES || lead > spec.maxLead) return { skipped: true, reason: "fora da janela" };

  const ent = await plans.entitlement(app.company_id);
  if (kind === "2h" && ent.features.whatsapp_reminder_2h !== true) return { skipped: true, reason: "plano" };
  // O lembrete de 2h cobre os dois quando o agendamento está próximo.
  const flags = kind === "2h" ? ["notified_2h", "notified_1h"] : ["notified_1h"];
  if (kind === "24h" && ent.features.whatsapp_reminder_2h === true && lead <= CLOSE_LEAD_MINUTES) {
    await markSent(app.id, flags);
    return { skipped: true, reason: "coberto pelo lembrete 2h" };
  }

  const number = whatsappNumber(app.tel);
  if (number.length < 12) {
    await markSent(app.id, flags);
    return { skipped: true, reason: "telefone inválido" };
  }
  try {
    await plans.assertQuota(app.company_id, "whatsapp_monthly_messages", { ent });
  } catch (error) {
    if (error?.code !== "plan_upgrade_required") throw error;
    await markSent(app.id, flags);
    return { skipped: true, reason: "quota" };
  }
  if (!process.env.WHATSAPP_API_URL || !process.env.WHATSAPP_OUTBOUND_TOKEN) {
    throw new Error("WhatsApp de saída não configurado (WHATSAPP_API_URL/WHATSAPP_OUTBOUND_TOKEN).");
  }

  await axios.post(
    `${process.env.WHATSAPP_API_URL}/message/sendText`,
    { number, text: reminderText(app, lead) },
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_OUTBOUND_TOKEN}`, "Content-Type": "application/json" }, timeout: 10000 },
  );
  await markSent(app.id, flags);
  await plans.incrementUsage(app.company_id, "whatsapp_monthly_messages").catch(() => {});
  return { sent: true };
}

const sendAppointmentReminder = payload => sendReminder("24h", payload);
const sendAppointmentReminder2h = payload => sendReminder("2h", payload);

module.exports = {
  enqueueDueReminders, enqueueDueReminders2h, sendAppointmentReminder, sendAppointmentReminder2h, whatsappNumber, leadMinutes,
  MIN_LEAD_MINUTES, MAX_LEAD_MINUTES, MAX_LEAD_2H_MINUTES, CLOSE_LEAD_MINUTES,
};
