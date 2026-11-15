const functions = require('../utils/functions');
const { HttpError } = require('../middleware/errorHandler');

// Entitlement = plano efetivo da empresa, calculado NA LEITURA (sem cron):
// Premium (ou outro plano pago) só se existe fatura paga cujo período cobre `now`, com carência
// de BILLING_GRACE_DAYS (padrão 3) após o fim do período. Caso contrário, Free.
// Fatura estornada (refunded) deixa de cobrir. Nada é guardado em memória.
const DAY_MS = 24 * 60 * 60 * 1000;

function graceDays() {
  const value = Number(process.env.BILLING_GRACE_DAYS);
  return Number.isInteger(value) && value >= 0 && value <= 30 ? value : 3;
}

function parseFeatures(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

function normalizePlan(row) {
  const plan = { id: row.id, code: row.code, name: row.name, price_cents: Number(row.price_cents), commission_bps: Number(row.commission_bps), billing_cycle: row.billing_cycle || 'MONTHLY', features: parseFeatures(row.features), sort_order: Number(row.sort_order) || 0 };
  // Preço do Premium configurável por env (o dono confirmará o valor).
  const override = Number(process.env.PLAN_PREMIUM_PRICE_CENTS);
  if (plan.code === 'premium' && Number.isSafeInteger(override) && override > 0) plan.price_cents = override;
  return plan;
}

// Função PURA: { plans, invoices, now, graceDays } -> entitlement.
// invoices: [{ plan_id, status, period_start, period_end }] (Date ou texto ISO).
function computeEntitlement({ plans, invoices = [], now = new Date(), graceDays: grace = 3 }) {
  const byId = new Map(plans.map(plan => [plan.id, plan]));
  const free = plans.find(plan => plan.code === 'free');
  if (!free) throw new Error('Plano free não cadastrado.');
  const t = new Date(now).getTime();
  const graceMs = grace * DAY_MS;
  let best = null;
  for (const invoice of invoices) {
    if (invoice.status !== 'paid' || !invoice.period_start || !invoice.period_end) continue;
    const plan = byId.get(invoice.plan_id);
    if (!plan) continue;
    const start = new Date(invoice.period_start).getTime();
    const end = new Date(invoice.period_end).getTime();
    if (!(start <= t && t < end + graceMs)) continue;
    const rank = plan.sort_order;
    if (!best || rank > best.plan.sort_order || (rank === best.plan.sort_order && end > best.end)) best = { plan, end };
  }
  if (!best) {
    return { plan_code: free.code, plan_name: free.name, plan_id: free.id, commission_bps: free.commission_bps, features: free.features, source: 'free', paid_through: null, grace_until: null };
  }
  // paid_through = maior fim de período pago contíguo do mesmo plano (renovações já pagas).
  let paidThrough = best.end;
  const sameplan = invoices.filter(i => i.status === 'paid' && i.plan_id === best.plan.id && i.period_start && i.period_end)
    .map(i => ({ start: new Date(i.period_start).getTime(), end: new Date(i.period_end).getTime() }))
    .sort((a, b) => a.start - b.start);
  for (const period of sameplan) if (period.start <= paidThrough && period.end > paidThrough) paidThrough = period.end;
  return {
    plan_code: best.plan.code, plan_name: best.plan.name, plan_id: best.plan.id,
    commission_bps: best.plan.commission_bps, features: best.plan.features,
    source: t < paidThrough ? 'paid' : 'grace',
    paid_through: new Date(paidThrough).toISOString(),
    grace_until: new Date(paidThrough + graceMs).toISOString(),
  };
}

async function listPlans(query = functions.executeSql.bind(functions)) {
  const rows = await query('SELECT * FROM plans WHERE active = 1 ORDER BY sort_order, id');
  return rows.map(normalizePlan);
}

async function getPlanByCode(code, query) {
  return (await listPlans(query)).find(plan => plan.code === code) || null;
}

// Carrega do banco e delega para a função pura. `query` opcional (dentro de transação).
async function entitlement(companyId, { now = new Date(), query } = {}) {
  const run = query || functions.executeSql.bind(functions);
  const plans = await listPlans(run);
  const invoices = await run(
    "SELECT plan_id, status, period_start, period_end FROM subscription_invoices WHERE company_id = ? AND status = 'paid'",
    [companyId],
  );
  return computeEntitlement({ plans, invoices, now, graceDays: graceDays() });
}

function upgradeError(message, details) {
  const error = new HttpError(402, message);
  error.code = 'plan_upgrade_required';
  error.details = details;
  return error;
}

function sendPlanError(res, error) {
  return res.status(error.status).send({ error: { code: error.code, message: error.message, ...error.details } });
}

// Middleware: exige feature booleana do plano efetivo (depois de validateCompanyAccess).
function requireFeature(key) {
  return async (req, res, next) => {
    try {
      const ent = await entitlement(req.companyId);
      if (ent.features[key] !== true) return sendPlanError(res, upgradeError('Recurso disponível no plano Premium.', { feature: key, plan: ent.plan_code }));
      req.entitlement = ent;
      next();
    } catch (error) {
      next(error);
    }
  };
}

// Quotas: feature numérica (null = ilimitado) x uso atual.
const QUOTA_USAGE = {
  max_professionals: (query, companyId) => query('SELECT COUNT(*) AS used FROM professionals WHERE company_id = ? AND active = 1', [companyId]),
  max_team_users: (query, companyId) => query(
    "SELECT (SELECT COUNT(*) FROM company_members WHERE company_id = ?) + (SELECT COUNT(*) FROM company_invitations WHERE company_id = ? AND status = 'pending' AND used_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())) AS used",
    [companyId, companyId]),
};

function monthPeriod(now = new Date()) {
  return require('../utils/time').wallClock(now).slice(0, 7);
}

async function usageOf(query, companyId, key, now) {
  if (QUOTA_USAGE[key]) return Number((await QUOTA_USAGE[key](query, companyId))[0].used) || 0;
  const [row] = await query('SELECT used FROM usage_counters WHERE company_id = ? AND metric = ? AND period = ?', [companyId, key, monthPeriod(now)]);
  return Number(row?.used) || 0;
}

// Lança 402 se `used + amount` excede o limite. Devolve { limit, used }.
async function assertQuota(companyId, key, { amount = 1, query, now = new Date(), ent } = {}) {
  const run = query || functions.executeSql.bind(functions);
  const current = ent || await entitlement(companyId, { now, query: run });
  const limit = current.features[key];
  if (limit === null || limit === undefined) return { limit: null, used: null };
  const used = await usageOf(run, companyId, key, now);
  if (used + amount > Number(limit)) {
    throw upgradeError('Limite do plano atingido. Faça upgrade para o Premium.', { quota: key, limit: Number(limit), used, plan: current.plan_code });
  }
  return { limit: Number(limit), used };
}

// Contador mensal atômico (mensagens WhatsApp, interações de IA...).
async function incrementUsage(companyId, metric, { amount = 1, now = new Date(), query } = {}) {
  const run = query || functions.executeSql.bind(functions);
  await run('INSERT INTO usage_counters (company_id, metric, period, used) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE used = used + VALUES(used)', [companyId, metric, monthPeriod(now), amount]);
}

module.exports = { computeEntitlement, entitlement, listPlans, getPlanByCode, normalizePlan, requireFeature, assertQuota, incrementUsage, usageOf, upgradeError, sendPlanError, graceDays, monthPeriod };
