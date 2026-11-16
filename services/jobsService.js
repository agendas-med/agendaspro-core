const functions = require("../utils/functions");
const { randomToken } = require("../utils/crypto");

// Fila de jobs em banco, drenada por POST /internal/jobs/tick (gatilho externo HORÁRIO) e,
// de forma oportunista, após webhooks recebidos. Cada tick tem orçamento de tempo (~20 s):
// o que não couber fica pendente para o próximo tick, sem perda.
const handlers = new Map();
const producers = [];
const LOCK_MINUTES = 5;
const MAX_BACKOFF_SEC = 6 * 60 * 60;

function register(type, handler) {
  handlers.set(type, handler);
}

// Produtores rodam no início de cada tick e enfileiram trabalho baseado em janela.
function registerProducer(name, fn) {
  producers.push({ name, fn });
}

function backoffSeconds(attempts) {
  return Math.min(60 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_SEC);
}

// Retorna true se criou o job; false se já existia um com o mesmo dedupe_key.
async function enqueue(type, payload = {}, { dueAt = null, dedupeKey = null, maxAttempts = 5 } = {}) {
  const result = await functions.executeSql(
    `INSERT IGNORE INTO jobs (type, payload, due_at, dedupe_key, max_attempts) VALUES (?, ?, COALESCE(?, NOW()), ?, ?)`,
    [type, JSON.stringify(payload), dueAt, dedupeKey, maxAttempts],
  );
  return result.affectedRows > 0;
}

// Claim atômico: um único UPDATE marca o lote com um lock_token próprio; locks vencidos
// (processo morreu no meio) voltam a ser elegíveis.
async function claim(limit) {
  const lockToken = randomToken(16);
  const result = await functions.executeSql(
    `UPDATE jobs
        SET status = 'running', lock_token = ?, locked_until = NOW() + INTERVAL ? MINUTE, attempts = attempts + 1
      WHERE ((status = 'pending' AND due_at <= NOW()) OR (status = 'running' AND locked_until < NOW()))
      ORDER BY due_at, id
      LIMIT ?`,
    [lockToken, LOCK_MINUTES, limit],
  );
  if (!result.affectedRows) return [];
  return functions.executeSql(`SELECT id, type, payload, attempts, max_attempts FROM jobs WHERE lock_token = ? ORDER BY due_at, id`, [lockToken]);
}

// Follow-up 1 (LGPD): tipos cujo payload carrega texto/dados da mensagem têm o payload apagado ao
// terminar (done ou failed definitivo). A linha fica (dedupe_key, auditoria), sem o conteúdo.
const SCRUB_TYPES = new Set(["whatsapp_inbound"]);
const SCRUBBED = '{"scrubbed":true}';
const scrubbed = job => (SCRUB_TYPES.has(job.type) ? SCRUBBED : null);

async function complete(job) {
  await functions.executeSql(`UPDATE jobs SET status = 'done', lock_token = NULL, locked_until = NULL, last_error = NULL, payload = COALESCE(?, payload) WHERE id = ?`, [scrubbed(job), job.id]);
}

async function failOrRetry(job, error) {
  const message = String(error?.message || error).slice(0, 500);
  if (job.attempts >= job.max_attempts) {
    await functions.executeSql(`UPDATE jobs SET status = 'failed', lock_token = NULL, locked_until = NULL, last_error = ?, payload = COALESCE(?, payload) WHERE id = ?`, [message, scrubbed(job), job.id]);
    return "failed";
  }
  await functions.executeSql(
    `UPDATE jobs SET status = 'pending', lock_token = NULL, locked_until = NULL, last_error = ?, due_at = NOW() + INTERVAL ? SECOND WHERE id = ?`,
    [message, backoffSeconds(job.attempts), job.id],
  );
  return "retry";
}

// Itens reivindicados mas não processados por falta de tempo voltam sem gastar tentativa.
async function release(jobs) {
  if (!jobs.length) return;
  await functions.executeSql(
    `UPDATE jobs SET status = 'pending', lock_token = NULL, locked_until = NULL, attempts = GREATEST(attempts - 1, 0) WHERE id IN (?) AND status = 'running'`,
    [jobs.map((j) => j.id)],
  );
}

async function tick({ budgetMs = 20000, batchSize = 25, now = () => Date.now() } = {}) {
  const started = now();
  const deadline = started + budgetMs;
  const stats = { enqueued: 0, claimed: 0, done: 0, retried: 0, failed: 0, released: 0, producerErrors: 0 };

  for (const producer of producers) {
    if (now() >= deadline) break;
    try {
      stats.enqueued += (await producer.fn(module.exports)) || 0;
    } catch (error) {
      stats.producerErrors++;
      console.error(`[jobs] Produtor ${producer.name} falhou:`, String(error?.message || error).slice(0, 200));
    }
  }

  while (now() < deadline) {
    const batch = await claim(batchSize);
    if (!batch.length) break;
    stats.claimed += batch.length;
    for (let i = 0; i < batch.length; i++) {
      const job = batch[i];
      if (now() >= deadline) {
        const rest = batch.slice(i);
        await release(rest);
        stats.released += rest.length;
        break;
      }
      const handler = handlers.get(job.type);
      try {
        if (!handler) throw new Error(`Sem handler para o tipo ${job.type}`);
        let payload = {};
        try { payload = job.payload ? JSON.parse(job.payload) : {}; } catch { payload = {}; }
        await handler(payload, job);
        await complete(job);
        stats.done++;
      } catch (error) {
        const outcome = await failOrRetry(job, error);
        if (outcome === "failed") stats.failed++;
        else stats.retried++;
      }
    }
  }

  const [{ pending }] = await functions.executeSql(`SELECT COUNT(*) AS pending FROM jobs WHERE status IN ('pending','running') AND due_at <= NOW()`);
  stats.remaining = Number(pending);
  stats.durationMs = now() - started;
  return stats;
}

// Drenagem oportunista após webhooks: não bloqueia a resposta e roda no máximo uma vez por
// janela (throttle em banco via rate_limits, válido entre dynos/reinícios).
let draining = false;
function drainSoon({ windowSec = Number(process.env.JOBS_DRAIN_THROTTLE_SEC) || 300, budgetMs = 10000 } = {}) {
  const enabled = process.env.JOBS_DRAIN_ON_WEBHOOK
    ? process.env.JOBS_DRAIN_ON_WEBHOOK === "true"
    : process.env.NODE_ENV !== "test";
  if (!enabled || draining) return;
  setImmediate(async () => {
    if (draining) return;
    draining = true;
    try {
      const { hit } = require("../middleware/rateLimit");
      const { hits } = await hit("jobs-drain", windowSec);
      if (hits > 1) return;
      await tick({ budgetMs });
    } catch (error) {
      console.error("[jobs] Drenagem oportunista falhou:", String(error?.message || error).slice(0, 200));
    } finally {
      draining = false;
    }
  });
}

// F4: executa já um job específico (resposta do bot sem esperar o tick). Claim atômico pelo
// dedupe_key: se outro processo pegou antes, não faz nada. A linha do job continua sendo a
// rede de segurança (queda no meio -> lock vence -> tick reprocessa).
async function runNow(dedupeKey) {
  if (!dedupeKey) return null;
  const lockToken = randomToken(16);
  const result = await functions.executeSql(
    `UPDATE jobs SET status = 'running', lock_token = ?, locked_until = NOW() + INTERVAL ? MINUTE, attempts = attempts + 1
      WHERE dedupe_key = ? AND status = 'pending' AND due_at <= NOW()`,
    [lockToken, LOCK_MINUTES, dedupeKey],
  );
  if (!result.affectedRows) return null;
  const [job] = await functions.executeSql(`SELECT id, type, payload, attempts, max_attempts FROM jobs WHERE lock_token = ?`, [lockToken]);
  if (!job) return null;
  const handler = handlers.get(job.type);
  try {
    if (!handler) throw new Error(`Sem handler para o tipo ${job.type}`);
    let payload = {};
    try { payload = job.payload ? JSON.parse(job.payload) : {}; } catch { payload = {}; }
    await handler(payload, job);
    await complete(job);
    return "done";
  } catch (error) {
    return failOrRetry(job, error);
  }
}

module.exports = { register, registerProducer, enqueue, claim, tick, drainSoon, runNow, backoffSeconds, SCRUB_TYPES, _handlers: handlers, _producers: producers };

// Registro padrão.
const notificationService = require("./notificationService");
register("appointment_reminder", notificationService.sendAppointmentReminder);
registerProducer("appointment_reminders", (jobs) => notificationService.enqueueDueReminders(jobs));
// F2: lembrete 2h (Premium), mesma regra de janela tolerante a atraso.
register("appointment_reminder_2h", notificationService.sendAppointmentReminder2h);
registerProducer("appointment_reminders_2h", (jobs) => notificationService.enqueueDueReminders2h(jobs));
// F3: avisos da API pública (lead -> comercial; confirmação de agendamento -> cliente).
const publicNotifications = require("./publicNotifications");
register("lead_notify", publicNotifications.leadNotify);
register("booking_confirmation", publicNotifications.bookingConfirmation);
// F4: WhatsApp Cloud API (mensagens recebidas e status de entrega do webhook /webhook/meta).
register("whatsapp_inbound", (payload, job) => require("./whatsapp/inbound").handle(payload, job));

// F5-core-B: indexação incremental do RAG do assistente (por hash de conteúdo).
register("assistant_rag_reconcile", (payload) => require("./assistant/rag").handleJob(payload));
registerProducer("assistant_rag_reconcile", (jobs) => require("./assistant/rag").enqueueReconciles(jobs));
