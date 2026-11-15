const functions = require('../utils/functions');
const plansService = require('./plansService');
const { HttpError } = require('../middleware/errorHandler');
const { toCents, centsToDecimal, commissionCents } = require('../utils/money');
const { wallClock } = require('../utils/time');

// Provedor de assinatura (Asaas, API key principal da plataforma). Atrás de interface + flag
// ASAAS_SUBSCRIPTIONS_ENABLED; os testes trocam o provedor por um stub (setProvider).
let provider = null;
function getProvider() {
  if (!provider) {
    const asaas = require('./asaasService');
    provider = {
      createCustomer: args => asaas.createPlatformCustomer(args),
      createSubscription: args => asaas.createSubscription(args),
      listPayments: id => asaas.listSubscriptionPayments(id),
      cancelSubscription: id => asaas.cancelSubscription(id),
    };
  }
  return provider;
}
function setProvider(next) { provider = next; }

function subscriptionsEnabled() {
  return process.env.ASAAS_SUBSCRIPTIONS_ENABLED === 'true';
}

function disabledError() {
  const error = new HttpError(503, 'Assinatura online indisponível no momento.');
  error.code = 'billing_disabled';
  return error;
}

const BILLING_TYPES = ['UNDEFINED', 'PIX', 'BOLETO', 'CREDIT_CARD'];

// "YYYY-MM-DD" + 1 mês, limitado ao último dia do mês (31/01 -> 28/02 ou 29/02).
function addMonth(date) {
  const [y, m, d] = date.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

function isoDate(value) {
  if (value instanceof Date) return wallClock(value).slice(0, 10);
  const text = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function publicSubscription(row, plan) {
  if (!row) return null;
  return { status: row.status, plan_code: plan?.code || null, billing_type: row.billing_type, price_cents: Number(row.price_cents), next_due_date: isoDate(row.next_due_date), canceled_at: row.canceled_at || null };
}

function publicInvoice(row) {
  return { id: row.id, amount_cents: Number(row.amount_cents), status: row.status, due_date: isoDate(row.due_date), period_start: row.period_start, period_end: row.period_end, paid_at: row.paid_at, invoice_url: row.invoice_url, plan_code: row.plan_code };
}

async function getOverview(companyId) {
  const [ent, plans, [row]] = await Promise.all([
    plansService.entitlement(companyId),
    plansService.listPlans(),
    functions.executeSql('SELECT * FROM company_subscriptions WHERE company_id = ?', [companyId]),
  ]);
  const plan = row ? plans.find(p => p.id === row.plan_id) : null;
  const [pending] = row && row.status !== 'canceled'
    ? await functions.executeSql("SELECT invoice_url FROM subscription_invoices WHERE company_id = ? AND status IN ('pending','overdue') ORDER BY due_date LIMIT 1", [companyId])
    : [];
  return {
    entitlement: ent,
    subscription: publicSubscription(row, plan),
    pending_invoice_url: pending?.invoice_url || null,
    subscriptions_enabled: subscriptionsEnabled(),
  };
}

async function upsertInvoice(query, sub, payment, status) {
  const due = isoDate(payment.dueDate);
  const amount = toCents(payment.value);
  if (!payment.id || !due || !Number.isSafeInteger(amount)) throw new Error('Cobrança de assinatura inválida.');
  const [existing] = await query('SELECT id, status FROM subscription_invoices WHERE provider_payment_id = ? FOR UPDATE', [payment.id]);
  const periodStart = `${due} 00:00:00`;
  const periodEnd = `${addMonth(due)} 00:00:00`;
  if (!existing) {
    await query(
      `INSERT INTO subscription_invoices (company_id, subscription_id, plan_id, provider_payment_id, amount_cents, status, due_date, period_start, period_end, paid_at, invoice_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${status === 'paid' ? 'NOW()' : 'NULL'}, ?)`,
      [sub.company_id, sub.id, sub.plan_id, payment.id, amount, status, due, periodStart, periodEnd, payment.invoiceUrl ? String(payment.invoiceUrl).slice(0, 500) : null],
    );
    return;
  }
  // Pago só sai de "paid" por estorno; reentregas/eventos fora de ordem não rebaixam.
  if (existing.status === 'paid' && status !== 'refunded') return;
  if (existing.status === 'refunded') return;
  await query(
    `UPDATE subscription_invoices SET status = ?, amount_cents = ?, due_date = ?, period_start = ?, period_end = ?,
       paid_at = ${status === 'paid' ? 'COALESCE(paid_at, NOW())' : 'paid_at'}, invoice_url = COALESCE(?, invoice_url) WHERE id = ?`,
    [status, amount, due, periodStart, periodEnd, payment.invoiceUrl ? String(payment.invoiceUrl).slice(0, 500) : null, existing.id],
  );
}

const SUB_EVENT_STATUS = {
  PAYMENT_CREATED: 'pending', PAYMENT_UPDATED: 'pending',
  PAYMENT_RECEIVED: 'paid', PAYMENT_CONFIRMED: 'paid',
  PAYMENT_OVERDUE: 'overdue', PAYMENT_DELETED: 'canceled',
  PAYMENT_REFUNDED: 'refunded', PAYMENT_CHARGEBACK_REQUESTED: 'refunded', PAYMENT_CHARGEBACK_DISPUTE: 'refunded',
};

// Webhook: cobrança pertencente a uma assinatura da plataforma (payment.subscription).
async function handleSubscriptionPayment(event, payment) {
  const status = SUB_EVENT_STATUS[event];
  if (!status || !payment?.subscription) return { ignored: true };
  return functions.executeTransaction(async query => {
    const [sub] = await query('SELECT * FROM company_subscriptions WHERE provider_subscription_id = ? FOR UPDATE', [String(payment.subscription)]);
    if (!sub) return { ignored: true };
    await upsertInvoice(query, sub, payment, status);
    if (status === 'paid' && sub.status === 'pending') await query("UPDATE company_subscriptions SET status = 'active' WHERE id = ?", [sub.id]);
    return { processed: true };
  });
}

async function handleSubscriptionEvent(event, subscription) {
  if (!['SUBSCRIPTION_DELETED', 'SUBSCRIPTION_INACTIVATED'].includes(event) || !subscription?.id) return { ignored: true };
  const result = await functions.executeSql("UPDATE company_subscriptions SET status = 'canceled', canceled_at = COALESCE(canceled_at, NOW()) WHERE provider_subscription_id = ?", [String(subscription.id)]);
  return result.affectedRows ? { processed: true } : { ignored: true };
}

// Assinar/trocar de plano. Free = cancelar a assinatura (o Premium já pago vale até o fim do período).
async function changePlan(companyId, { plan_code: planCode, billing_type: billingType = 'UNDEFINED' }) {
  const plan = await plansService.getPlanByCode(planCode);
  if (!plan) throw new HttpError(400, 'Plano inválido.');
  if (!BILLING_TYPES.includes(billingType)) throw new HttpError(400, 'Forma de cobrança inválida.');

  if (plan.price_cents === 0) {
    const [row] = await functions.executeSql('SELECT * FROM company_subscriptions WHERE company_id = ?', [companyId]);
    if (row && row.status !== 'canceled') {
      if (row.provider_subscription_id) {
        if (!subscriptionsEnabled()) throw disabledError();
        await getProvider().cancelSubscription(row.provider_subscription_id);
      }
      await functions.executeSql("UPDATE company_subscriptions SET status = 'canceled', canceled_at = NOW() WHERE id = ? AND company_id = ?", [row.id, companyId]);
    }
    return getOverview(companyId);
  }

  if (!subscriptionsEnabled()) throw disabledError();
  const ent = await plansService.entitlement(companyId);

  await functions.executeTransaction(async query => {
    // Serializa por empresa (evita duas assinaturas no provedor em cliques simultâneos).
    const [company] = await query('SELECT id, name, document, email FROM companies WHERE id = ? FOR UPDATE', [companyId]);
    if (!company) throw new HttpError(404, 'Empresa não encontrada.');
    const [row] = await query('SELECT * FROM company_subscriptions WHERE company_id = ? FOR UPDATE', [companyId]);
    if (row && row.status !== 'canceled' && row.plan_id === plan.id && row.provider_subscription_id) return; // idempotente

    const api = getProvider();
    if (row?.provider_subscription_id && row.status !== 'canceled') await api.cancelSubscription(row.provider_subscription_id);
    const customer = row?.provider_customer_id || await api.createCustomer({
      name: company.name, cpfCnpj: (company.document || '').replace(/\D/g, '') || undefined, email: company.email || undefined, externalReference: `COMPANY_${companyId}`,
    });
    // Se já há período pago do mesmo plano em curso, a nova assinatura começa ao fim dele.
    const today = wallClock(new Date()).slice(0, 10);
    const paidThrough = ent.plan_id === plan.id && ent.source === 'paid' && ent.paid_through ? isoDate(new Date(ent.paid_through)) : null;
    const nextDueDate = paidThrough && paidThrough > today ? paidThrough : today;
    const created = await api.createSubscription({
      customer, billingType, value: centsToDecimal(plan.price_cents), nextDueDate,
      description: `AgendasPro ${plan.name}`, externalReference: `SUB_${companyId}`,
    });
    if (!created?.id) throw new Error('Provedor não retornou a assinatura.');
    await query(
      `INSERT INTO company_subscriptions (company_id, plan_id, status, billing_type, price_cents, provider, provider_customer_id, provider_subscription_id, next_due_date, canceled_at)
       VALUES (?, ?, 'pending', ?, ?, 'asaas', ?, ?, ?, NULL)
       ON DUPLICATE KEY UPDATE plan_id = VALUES(plan_id), status = 'pending', billing_type = VALUES(billing_type), price_cents = VALUES(price_cents),
         provider_customer_id = VALUES(provider_customer_id), provider_subscription_id = VALUES(provider_subscription_id), next_due_date = VALUES(next_due_date), canceled_at = NULL`,
      [companyId, plan.id, billingType, plan.price_cents, customer, created.id, isoDate(created.nextDueDate) || nextDueDate],
    );
    const [sub] = await query('SELECT * FROM company_subscriptions WHERE company_id = ?', [companyId]);
    const payments = await api.listPayments(created.id).catch(() => []);
    for (const payment of payments) await upsertInvoice(query, sub, payment, 'pending');
  });
  return getOverview(companyId);
}

async function listInvoices(companyId) {
  const rows = await functions.executeSql(
    `SELECT i.*, p.code AS plan_code FROM subscription_invoices i JOIN plans p ON p.id = i.plan_id
     WHERE i.company_id = ? ORDER BY i.due_date DESC, i.id DESC LIMIT 100`, [companyId]);
  return rows.map(publicInvoice);
}

async function listCommissions(companyId, { from, to } = {}) {
  const where = ['company_id = ?'];
  const params = [companyId];
  if (from) { where.push('created_at >= ?'); params.push(`${from} 00:00:00`); }
  if (to) { where.push('created_at < ? + INTERVAL 1 DAY'); params.push(`${to} 00:00:00`); }
  const rows = await functions.executeSql(
    `SELECT id, sale_id, plan_code, commission_bps, gross_cents, commission_cents, split_applied, status, created_at, settled_at
     FROM sale_commissions WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT 500`, params);
  const totals = { gross_cents: 0, commission_cents: 0, net_cents: 0 };
  for (const row of rows) {
    if (row.status !== 'settled') continue;
    totals.gross_cents += Number(row.gross_cents);
    totals.commission_cents += Number(row.commission_cents);
  }
  totals.net_cents = totals.gross_cents - totals.commission_cents;
  return { items: rows.map(row => ({ ...row, split_applied: !!row.split_applied })), totals_settled: totals };
}

// Comissão de uma venda online: bps do plano efetivo, centavos inteiros, split fixo (reais) só se
// houver carteira da plataforma configurada. `query` = transação do chamador.
async function commissionFor(companyId, grossCents, { query } = {}) {
  const ent = await plansService.entitlement(companyId, { query });
  const cents = commissionCents(grossCents, ent.commission_bps);
  const wallet = process.env.ASAAS_MAIN_WALLET_ID;
  const split = wallet && cents > 0 ? [{ walletId: wallet, fixedValue: centsToDecimal(cents) }] : [];
  return { plan_code: ent.plan_code, commission_bps: ent.commission_bps, gross_cents: grossCents, commission_cents: cents, split };
}

async function recordCommission(query, { companyId, saleId, providerPaymentId, commission }) {
  await query(
    `INSERT IGNORE INTO sale_commissions (company_id, sale_id, provider_payment_id, plan_code, commission_bps, gross_cents, commission_cents, split_applied)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, saleId, providerPaymentId, commission.plan_code, commission.commission_bps, commission.gross_cents, commission.commission_cents, commission.split.length ? 1 : 0],
  );
}

async function setCommissionStatus(query, providerPaymentId, status) {
  const settled = status === 'settled' ? ', settled_at = COALESCE(settled_at, NOW())' : '';
  const guard = status === 'canceled' ? " AND status = 'pending'" : '';
  await query(`UPDATE sale_commissions SET status = ?${settled} WHERE provider_payment_id = ?${guard}`, [status, providerPaymentId]);
}

module.exports = {
  getOverview, changePlan, listInvoices, listCommissions, handleSubscriptionPayment, handleSubscriptionEvent,
  commissionFor, recordCommission, setCommissionStatus, setProvider, getProvider, subscriptionsEnabled, addMonth, BILLING_TYPES,
};
