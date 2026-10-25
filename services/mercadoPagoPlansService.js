const crypto = require("node:crypto");
const db = require("../utils/functions");
const gateway = require("./mercadoPagoService");
const config = require("../config/mercadopago");
const { cents } = require("../utils/mercadoPago");
const catalog = [
  { code: "free", name: "Gratuito", monthly_price: 0, commission_bps: 500 },
  {
    code: "premium",
    name: "Premium",
    monthly_price: 49.9,
    commission_bps: 100,
  },
];
const safeUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      /(^|\.)mercadopago\.com\.br$/.test(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
};
const service = {
  catalog,
  safeUrl,
  async entitlement(companyId, query = db.executeSql.bind(db)) {
    const [row] = await query(
      `SELECT MAX(i.period_end) AS paid_until FROM mp_subscription_invoices i JOIN mp_subscriptions s ON s.id = i.subscription_id
      WHERE s.company_id = ? AND s.environment = ? AND i.status = 'approved' AND i.period_start <= NOW() AND i.period_end > NOW()`,
      [companyId, config.settings().environment],
    );
    return {
      ...catalog[row?.paid_until ? 1 : 0],
      paid_until: row?.paid_until || null,
    };
  },
  async status(companyId) {
    const [subscription] = await db.executeSql(
      `SELECT id, provider_id, status, checkout_url, cancel_requested FROM mp_subscriptions
      WHERE company_id = ? AND environment = ? ORDER BY id DESC LIMIT 1`,
      [companyId, config.settings().environment],
    );
    return {
      current: await this.entitlement(companyId),
      catalog,
      subscription: subscription
        ? {
            id: subscription.id,
            status: subscription.status,
            checkout_url: safeUrl(subscription.checkout_url),
            cancel_requested: !!subscription.cancel_requested,
          }
        : null,
    };
  },
  async subscribe(companyId) {
    await gateway.account();
    const subscription = await db.executeTransaction(async (query) => {
      const [company] = await query(
        "SELECT id, email FROM companies WHERE id = ? FOR UPDATE",
        [companyId],
      );
      const [existing] = await query(
        `SELECT * FROM mp_subscriptions WHERE company_id = ? AND environment = ?
        AND status IN ('creating','dispatching','pending','authorized','paused') ORDER BY id DESC LIMIT 1`,
        [companyId, config.settings().environment],
      );
      if (existing) return existing;
      if (!company?.email || !company.email.includes("@"))
        throw new Error("Cadastre o e-mail da empresa antes de assinar.");
      const reference = `AGP_SUB_${crypto.randomUUID()}`;
      const body = JSON.stringify({
        reason: "AgendasPro Premium mensal",
        external_reference: reference,
        payer_email: company.email,
        auto_recurring: {
          frequency: 1,
          frequency_type: "months",
          transaction_amount: 49.9,
          currency_id: "BRL",
        },
        back_url: `${process.env.URL_SITE}/configuracoes/recebimentos?subscription=return`,
        status: "pending",
      });
      const key = crypto.randomUUID();
      const result = await query(
        `INSERT INTO mp_subscriptions (company_id, environment, external_reference, idempotency_key, request_body)
        VALUES (?, ?, ?, ?, ?)`,
        [companyId, config.settings().environment, reference, key, body],
      );
      return { id: result.insertId, request_body: body, idempotency_key: key };
    });
    if (subscription.cancel_requested)
      throw new Error(
        "O cancelamento está sendo processado. Atualize o status antes de assinar novamente.",
      );
    if (!subscription.provider_id) {
      // Recupera a intenção persistida por referência antes de repetir um POST cujo resultado possa ter se perdido.
      const found = await gateway.request(
        "GET",
        `/preapproval/search?external_reference=${encodeURIComponent(JSON.parse(subscription.request_body).external_reference)}`,
      );
      const matches = (found.results || []).filter(
        (row) =>
          row.external_reference ===
          JSON.parse(subscription.request_body).external_reference,
      );
      if (matches.length > 1)
        throw new Error(
          "Assinatura duplicada no provedor; revisão necessária.",
        );
      let remote = matches[0];
      if (!remote) {
        const claim = await db.executeSql(
          "UPDATE mp_subscriptions SET status = 'dispatching' WHERE id = ? AND status = 'creating'",
          [subscription.id],
        );
        if (!claim.affectedRows)
          throw new Error(
            "A criação da assinatura aguarda confirmação. Atualize antes de tentar novamente.",
          );
        try {
          remote = await gateway.request(
            "POST",
            "/preapproval",
            subscription.request_body,
            { "X-Idempotency-Key": subscription.idempotency_key },
          );
        } catch (error) {
          if ([400, 401, 403, 404, 422].includes(error.response?.status))
            await db.executeSql(
              "UPDATE mp_subscriptions SET status = 'creation_failed' WHERE id = ?",
              [subscription.id],
            );
          throw new Error(
            "Não foi possível criar a assinatura no Mercado Pago. Confira as credenciais e os dados da empresa.",
          );
        }
      }
      if (
        !remote.id ||
        !safeUrl(remote.init_point) ||
        remote.external_reference !==
          JSON.parse(subscription.request_body).external_reference
      )
        throw new Error("Resposta da assinatura inválida.");
      await db.executeSql(
        "UPDATE mp_subscriptions SET provider_id = ?, checkout_url = ?, status = ? WHERE id = ?",
        [remote.id, remote.init_point, remote.status, subscription.id],
      );
    }
    return this.status(companyId);
  },
  async reconcile(companyId, localId) {
    const [row] = await db.executeSql(
      "SELECT * FROM mp_subscriptions WHERE id = ? AND company_id = ? AND environment = ?",
      [localId, companyId, config.settings().environment],
    );
    if (!row?.provider_id)
      throw new Error("Assinatura ainda não criada no provedor.");
    const remote = await gateway.request(
      "GET",
      `/preapproval/${encodeURIComponent(row.provider_id)}`,
    );
    const settings = config.requireCredentials();
    if (
      String(remote.id) !== row.provider_id ||
      remote.external_reference !== row.external_reference ||
      String(remote.collector_id) !== settings.collectorId ||
      cents(remote.auto_recurring?.transaction_amount) !== 4990 ||
      remote.auto_recurring.currency_id !== "BRL" ||
      remote.auto_recurring.frequency !== 1 ||
      remote.auto_recurring.frequency_type !== "months"
    )
      throw new Error("Assinatura diverge do plano Premium contratado.");
    await db.executeSql("UPDATE mp_subscriptions SET status = ? WHERE id = ?", [
      remote.status,
      row.id,
    ]);
    const invoices = await gateway.request(
      "GET",
      `/authorized_payments/search?preapproval_id=${encodeURIComponent(row.provider_id)}&limit=100`,
    );
    for (const invoice of invoices.results || [])
      await this.invoice(invoice.id, row);
    return this.status(companyId);
  },
  async invoice(invoiceId, expected) {
    if (!/^\d+$/.test(String(invoiceId))) throw new Error("Fatura inválida.");
    const invoice = await gateway.request(
      "GET",
      `/authorized_payments/${invoiceId}`,
    );
    const [subscription] = await db.executeSql(
      "SELECT * FROM mp_subscriptions WHERE provider_id = ? AND environment = ?",
      [invoice.preapproval_id, config.settings().environment],
    );
    if (!subscription || (expected && expected.id !== subscription.id))
      return { ignored: true };
    if (String(invoice.id) !== String(invoiceId) || !invoice.payment?.id)
      return { pending: true };
    const payment = await gateway.request(
      "GET",
      `/v1/payments/${encodeURIComponent(invoice.payment.id)}`,
    );
    const settings = config.requireCredentials();
    if (
      String(payment.id) !== String(invoice.payment.id) ||
      String(payment.collector_id) !== settings.collectorId ||
      payment.live_mode !== (settings.environment === "production") ||
      payment.currency_id !== "BRL" ||
      cents(payment.transaction_amount) !== 4990 ||
      cents(invoice.transaction_amount) !== 4990
    )
      throw new Error("Pagamento da mensalidade inválido.");
    const start = new Date(invoice.debit_date || payment.date_approved);
    if (!Number.isFinite(start.getTime()))
      throw new Error("Período da fatura inválido.");
    const end = new Date(start);
    const day = start.getUTCDate();
    end.setUTCDate(1);
    end.setUTCMonth(end.getUTCMonth() + 1);
    const last = new Date(
      Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0),
    ).getUTCDate();
    end.setUTCDate(Math.min(day, last));
    const status =
      cents(payment.transaction_amount_refunded || 0) > 0
        ? "refunded"
        : payment.status;
    await db.executeSql(
      `INSERT INTO mp_subscription_invoices (provider_id, subscription_id, payment_id, status, period_start, period_end, amount_cents)
      VALUES (?, ?, ?, ?, ?, ?, 4990) ON DUPLICATE KEY UPDATE status = VALUES(status)`,
      [
        String(invoice.id),
        subscription.id,
        String(payment.id),
        status,
        start,
        end,
      ],
    );
    return { received: true };
  },
  async cancel(companyId, localId) {
    const [row] = await db.executeSql(
      "SELECT * FROM mp_subscriptions WHERE id = ? AND company_id = ? AND environment = ?",
      [localId, companyId, config.settings().environment],
    );
    if (!row?.provider_id) throw new Error("Assinatura não encontrada.");
    await db.executeSql(
      "UPDATE mp_subscriptions SET cancel_requested = 1 WHERE id = ?",
      [row.id],
    );
    await gateway.request(
      "PUT",
      `/preapproval/${encodeURIComponent(row.provider_id)}`,
      { status: "cancelled" },
    );
    return this.reconcile(companyId, row.id);
  },
  async notification(id, type) {
    if (type === "subscription_authorized_payment") return this.invoice(id);
    const [row] = await db.executeSql(
      "SELECT id, company_id FROM mp_subscriptions WHERE provider_id = ? AND environment = ?",
      [id, config.settings().environment],
    );
    return row ? this.reconcile(row.company_id, row.id) : { ignored: true };
  },
};
module.exports = service;
