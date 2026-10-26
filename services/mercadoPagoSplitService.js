const crypto = require("node:crypto");
const db = require("../utils/functions");
const config = require("../config/mercadopago");
const gateway = require("./mercadoPagoService");
const connections = require("./mercadoPagoConnectionsService");
const plans = require("./mercadoPagoPlansService");
const sales = require("./salesService");
const { cents } = require("../utils/mercadoPago");
const legacy = () => require("./mercadoPagoPaymentsService");
const safeError = (error) =>
  error.response || error.isAxiosError
    ? "Não foi possível confirmar a operação no Mercado Pago. Atualize para recuperar a mesma cobrança."
    : error.message;

function validatePayment(payment, charge, context = {}) {
  const metadata = JSON.parse(charge.request_body || "{}").metadata || {};
  const applicationId = String(
    metadata.agendaspro_application_id || config.settings().clientId,
  );
  const marketplaceOwner = String(
    metadata.agendaspro_marketplace_owner_id || config.settings().collectorId,
  );
  const testOwner =
    String(context.owner?.id) === charge.seller_id &&
    context.owner?.site_id === "MLB" &&
    context.owner?.tags?.includes("test_user");
  const environmentMatches =
    payment.live_mode === (charge.environment === "production") ||
    (charge.environment === "test" && payment.live_mode === true && testOwner);
  const preference = context.preference;
  const merchantOrder = context.merchantOrder;
  const checkoutMatches =
    String(preference?.id) === String(charge.provider_preference_id) &&
    String(preference?.client_id) === applicationId &&
    preference?.external_reference === charge.external_reference &&
    String(preference?.collector_id) === charge.seller_id &&
    cents(preference?.marketplace_fee || 0) === Number(charge.commission_cents) &&
    String(merchantOrder?.id) === String(payment.order?.id) &&
    String(merchantOrder?.preference_id) === String(charge.provider_preference_id) &&
    String(merchantOrder?.collector?.id) === charge.seller_id &&
    (merchantOrder?.payments || []).some(
      (item) => String(item.id) === String(payment.id),
    );
  const fee = (payment.fee_details || [])
    .filter((item) => item.type === "application_fee")
    .reduce((sum, item) => sum + cents(item.amount), 0);
  if (
    !/^\d+$/.test(String(payment.id)) ||
    payment.external_reference !== charge.external_reference ||
    String(payment.collector_id) !== charge.seller_id ||
    !environmentMatches ||
    payment.currency_id !== "BRL" ||
    cents(payment.transaction_amount) !== Number(charge.amount_cents) ||
    (payment.status === "approved" &&
      cents(payment.transaction_amount_refunded || 0) === 0 &&
      (!checkoutMatches ||
        (payment.application_id != null &&
          String(payment.application_id) !== applicationId) ||
        String(payment.marketplace_owner) !== marketplaceOwner ||
        fee !== Number(charge.commission_cents)))
  ) {
    throw new Error(
      "Pagamento ou comissão não corresponde à cobrança da empresa.",
    );
  }
}
function publicCharge(row) {
  if (row.api_version !== "checkout") return legacy().publicCharge(row);
  return {
    id: row.id,
    sale_id: row.sale_id,
    status: row.status,
    provider: "mercadopago",
    api: "checkout",
    environment: row.environment,
    amount: Number(row.amount_cents) / 100,
    commission: Number(row.commission_cents) / 100,
    commission_bps: row.commission_bps,
    plan: row.plan_code,
    checkout_url: plans.safeUrl(row.payment_url),
    payment_id: row.provider_payment_id,
    review_reason: row.review_reason,
  };
}
const service = {
  publicCharge,
  validatePayment,
  async getCharge(companyId, id) {
    const [row] = await db.executeSql(
      "SELECT * FROM mp_charges WHERE id = ? AND company_id = ? AND environment = ?",
      [id, companyId, config.settings().environment],
    );
    if (!row) throw new Error("Cobrança não encontrada nesta empresa.");
    return row;
  },
  async status(companyId) {
    const settings = config.settings();
    const connection = await connections.current(companyId);
    const [company] = await db.executeSql(
      "SELECT name, document FROM companies WHERE id = ?",
      [companyId],
    );
    const plan = await plans.status(companyId);
    return {
      provider: config.provider(),
      environment: settings.environment,
      mode: "split",
      company,
      configured: !!(
        settings.accessToken &&
        settings.collectorId &&
        settings.webhookSecret &&
        settings.webhookUrl &&
        settings.clientId &&
        settings.clientSecret &&
        settings.redirectUri &&
        process.env.MP_TOKEN_ENCRYPTION_KEY
      ),
      connection,
      commission_bps: plan.current.commission_bps,
      plan,
      payouts_enabled: false,
    };
  },
  async listCharges(companyId) {
    const rows = await db.executeSql(
      `SELECT c.*, customer.name AS customer_name FROM mp_charges c JOIN customers customer ON customer.id = c.customer_id
      WHERE c.company_id = ? AND c.environment = ? ORDER BY c.id DESC LIMIT 100`,
      [companyId, config.settings().environment],
    );
    return rows.map((row) => ({
      ...publicCharge(row),
      customer_name: row.customer_name,
      created_at: row.created_at,
      commission:
        Number(
          row.commission_cents ??
            Math.round((Number(row.amount_cents) * row.commission_bps) / 10000),
        ) / 100,
    }));
  },
  async createCharge(companyId, input, key) {
    const settings = config.requireCredentials();
    if (config.provider() !== "mercadopago")
      throw new Error("Integração Mercado Pago desativada.");
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(key || ""))
      throw new Error(
        "Envie uma chave de idempotência e reutilize-a nas tentativas da mesma cobrança.",
      );
    if (
      !settings.webhookSecret ||
      !/^https:\/\//.test(settings.webhookUrl || "")
    )
      throw new Error("Configure o webhook Mercado Pago no backend.");
    const amount = cents(input.amount);
    if (amount < 1) throw new Error("Valor inválido.");
    const chargeId = await db.executeTransaction(async (query) => {
      const sale = await sales.lockSale(query, input.sale_id, companyId);
      const [existing] = await query(
        "SELECT * FROM mp_charges WHERE idempotency_key = ?",
        [key],
      );
      if (existing) {
        if (
          existing.company_id !== Number(companyId) ||
          existing.sale_id !== sale.id ||
          existing.customer_id !== Number(input.customer_id) ||
          Number(existing.amount_cents) !== amount ||
          existing.environment !== settings.environment ||
          existing.api_version !== "checkout"
        )
          throw new Error("Chave de idempotência pertence a outra cobrança.");
        return existing.id;
      }
      if (sale.status !== "em_aberto" || sale.mp_charge_id || sale.pix_asaas_id)
        throw new Error("Venda concluída ou com cobrança em andamento.");
      if (sale.customer_id !== Number(input.customer_id))
        throw new Error("Cliente diferente do cliente da venda.");
      const totals = await sales.totals(query, sale);
      if (amount > cents(totals.total) - cents(totals.total_paid))
        throw new Error("Valor superior ao saldo da venda.");
      const [connection] = await query(
        "SELECT id, collector_id FROM mp_connections WHERE company_id = ? AND environment = ? AND active = 1 LIMIT 1",
        [companyId, settings.environment],
      );
      if (!connection)
        throw new Error(
          "Conecte a conta Mercado Pago da empresa antes de cobrar.",
        );
      const [customer] = await query(
        "SELECT name, email FROM customers WHERE id = ? AND company_id = ?",
        [sale.customer_id, companyId],
      );
      if (!customer?.email?.includes("@"))
        throw new Error("Cadastre o e-mail do cliente.");
      const plan = await plans.entitlement(companyId, query);
      const fee = Math.round((amount * plan.commission_bps) / 10000);
      if (fee < 1)
        throw new Error("Valor insuficiente para aplicar a comissão do plano.");
      const reference = `AGP_SPL_${crypto.randomUUID()}`;
      const result = await query(
        `INSERT INTO mp_charges (company_id, sale_id, customer_id, environment, api_version, external_reference,
        idempotency_key, request_body, amount_cents, commission_bps, commission_cents, plan_code, connection_id, seller_id)
        VALUES (?, ?, ?, ?, 'checkout', ?, ?, '', ?, ?, ?, ?, ?, ?)`,
        [
          companyId,
          sale.id,
          sale.customer_id,
          settings.environment,
          reference,
          key,
          amount,
          plan.commission_bps,
          fee,
          plan.code,
          connection.id,
          connection.collector_id,
        ],
      );
      const url = new URL(settings.webhookUrl);
      url.searchParams.set("charge_id", result.insertId);
      const returnUrl = `${process.env.URL_SITE}/vendas?payment=return`;
      const body = JSON.stringify({
        external_reference: reference,
        items: [
          {
            id: String(sale.id),
            title: `Venda #${sale.id} — AgendasPro`,
            quantity: 1,
            currency_id: "BRL",
            unit_price: amount / 100,
          },
        ],
        marketplace_fee: fee / 100,
        metadata: {
          agendaspro_application_id: settings.clientId,
          agendaspro_marketplace_owner_id: settings.collectorId,
        },
        payer: { email: customer.email },
        notification_url: url.href,
        back_urls: {
          success: returnUrl,
          pending: returnUrl,
          failure: returnUrl,
        },
        ...(returnUrl.startsWith("https://")
          ? { auto_return: "approved" }
          : {}),
        expires: true,
        expiration_date_to: new Date(Date.now() + 86400000).toISOString(),
      });
      await query("UPDATE mp_charges SET request_body = ? WHERE id = ?", [
        body,
        result.insertId,
      ]);
      await query("UPDATE sales SET mp_charge_id = ? WHERE id = ?", [
        result.insertId,
        sale.id,
      ]);
      await query(
        "INSERT INTO accounts_receivable (sale_id, customer_id, amount, payment_type, status) VALUES (?, ?, ?, 'mercadopago', 'EM ABERTO')",
        [sale.id, sale.customer_id, amount / 100],
      );
      return result.insertId;
    });
    const charge = await this.getCharge(companyId, chargeId);
    if (charge.status === "creation_failed") return publicCharge(charge);
    if (charge.provider_preference_id) return publicCharge(charge);
    const auth = await connections.credentials(
      charge.connection_id,
      companyId,
      true,
    );
    const owner = await gateway.request(
      "GET",
      "/users/me",
      undefined,
      {},
      auth.accessToken,
    );
    if (
      String(owner.id) !== charge.seller_id ||
      owner.site_id !== "MLB" ||
      !Array.isArray(owner.tags) ||
      owner.tags.includes("test_user") !== (settings.environment === "test")
    )
      throw new Error("Conta conectada não corresponde ao ambiente esperado.");
    let submitted = false;
    try {
      let remote;
      if (charge.status !== "creating") {
        const found = await gateway.request(
          "GET",
          `/checkout/preferences/search?external_reference=${encodeURIComponent(charge.external_reference)}`,
          undefined,
          {},
          auth.accessToken,
        );
        const matches = (found.elements || found.results || []).filter(
          (row) => row.external_reference === charge.external_reference,
        );
        if (matches.length !== 1)
          throw new Error(
            "A criação ainda não foi confirmada. Aguarde e atualize; nenhuma segunda cobrança será enviada.",
          );
        remote = await gateway.request(
          "GET",
          `/checkout/preferences/${encodeURIComponent(matches[0].id)}`,
          undefined,
          {},
          auth.accessToken,
        );
      } else {
        const claim = await db.executeSql(
          "UPDATE mp_charges SET status = 'dispatching' WHERE id = ? AND status = 'creating'",
          [charge.id],
        );
        if (!claim.affectedRows)
          throw new Error(
            "Cobrança já está sendo criada. Atualize em alguns instantes.",
          );
        submitted = true;
        remote = await gateway.request(
          "POST",
          "/checkout/preferences",
          charge.request_body,
          { "X-Idempotency-Key": key },
          auth.accessToken,
        );
      }
      if (
        !remote.id ||
        String(remote.client_id) !== String(settings.clientId) ||
        remote.external_reference !== charge.external_reference ||
        String(remote.collector_id) !== charge.seller_id ||
        cents(remote.marketplace_fee) !== Number(charge.commission_cents)
      )
        throw new Error(
          "Preferência não corresponde à comissão ou ao vendedor.",
        );
      const paymentUrl = remote.init_point;
      if (!plans.safeUrl(paymentUrl))
        throw new Error("URL de checkout inválida.");
      await db.executeSql(
        "UPDATE mp_charges SET provider_preference_id = ?, payment_url = ?, status = 'pending', last_error = NULL WHERE id = ?",
        [remote.id, paymentUrl, charge.id],
      );
      return publicCharge(await this.getCharge(companyId, charge.id));
    } catch (error) {
      if (
        submitted &&
        [400, 401, 403, 404, 422].includes(error.response?.status)
      ) {
        await db.executeTransaction(async (query) => {
          await sales.lockSale(query, charge.sale_id, companyId);
          await query(
            "UPDATE mp_charges SET status = 'creation_failed', last_error = 'Criação recusada pelo provedor. Confira os dados e a conexão antes de gerar uma nova cobrança.' WHERE id = ?",
            [charge.id],
          );
          await query(
            "UPDATE sales SET mp_charge_id = NULL WHERE id = ? AND mp_charge_id = ?",
            [charge.sale_id, charge.id],
          );
          await query(
            "DELETE FROM accounts_receivable WHERE sale_id = ? AND payment_type = 'mercadopago' AND status = 'EM ABERTO'",
            [charge.sale_id],
          );
        });
        return publicCharge(await this.getCharge(companyId, charge.id));
      }
      await db.executeSql("UPDATE mp_charges SET last_error = ? WHERE id = ?", [
        safeError(error).slice(0, 255),
        charge.id,
      ]);
      throw new Error(safeError(error));
    }
  },
  async reconcileCharge(companyId, id, paymentId) {
    const charge = await this.getCharge(companyId, id);
    if (charge.api_version !== "checkout")
      return legacy().reconcileCharge(companyId, id);
    const auth = await connections.credentials(charge.connection_id, companyId);
    if (!paymentId) {
      const found = await gateway.request(
        "GET",
        `/v1/payments/search?external_reference=${encodeURIComponent(charge.external_reference)}&sort=date_created&criteria=desc&limit=100`,
        undefined,
        {},
        auth.accessToken,
      );
      const matches = (found.results || []).filter(
        (row) => row.external_reference === charge.external_reference,
      );
      const approved = matches.filter((row) => row.status === "approved");
      if (approved.length > 1) {
        await db.executeSql(
          "UPDATE mp_charges SET status = 'needs_review', review_reason = 'Mais de um pagamento aprovado para a cobrança.' WHERE id = ?",
          [charge.id],
        );
        return { needs_review: true };
      }
      paymentId = (approved[0] || matches[0])?.id || charge.provider_payment_id;
      if (!paymentId) return { received: false, status: charge.status };
    }
    if (!/^\d+$/.test(String(paymentId)))
      throw new Error("Pagamento inválido.");
    const payment = await gateway.request(
      "GET",
      `/v1/payments/${paymentId}`,
      undefined,
      {},
      auth.accessToken,
    );
    if (String(payment.id) !== String(paymentId))
      throw new Error("Identificador do pagamento divergente.");
    const context = {};
    if (charge.environment === "test" && payment.live_mode === true) {
      context.owner = await gateway.request(
        "GET",
        "/users/me",
        undefined,
        {},
        auth.accessToken,
      );
      connections.validateOwner(context.owner, charge.seller_id);
    }
    if (
      payment.status === "approved" &&
      cents(payment.transaction_amount_refunded || 0) === 0
    ) {
      if (
        payment.order?.type !== "mercadopago" ||
        !/^\d+$/.test(String(payment.order?.id))
      )
        throw new Error("Pedido comercial do pagamento inválido.");
      context.preference = await gateway.request(
        "GET",
        `/checkout/preferences/${encodeURIComponent(charge.provider_preference_id)}`,
        undefined,
        {},
        auth.accessToken,
      );
      context.merchantOrder = await gateway.request(
        "GET",
        `/merchant_orders/${payment.order.id}`,
        undefined,
        {},
        auth.accessToken,
      );
    }
    validatePayment(payment, charge, context);
    return db.executeTransaction(async (query) => {
      const sale = await sales.lockSale(query, charge.sale_id, companyId);
      const [current] = await query(
        "SELECT * FROM mp_charges WHERE id = ? FOR UPDATE",
        [charge.id],
      );
      if (current.status === "needs_review" && current.review_reason)
        return { needs_review: true };
      const [recorded] = await query(
        "SELECT id FROM payments WHERE external_id = ?",
        [`mp:${payment.id}`],
      );
      if (
        current.provider_payment_id &&
        String(current.provider_payment_id) !== String(payment.id)
      ) {
        // Uma tentativa recusada pode ser seguida de uma aprovada; um segundo pagamento após aprovação exige revisão.
        const [previous] = await query(
          "SELECT id FROM payments WHERE external_id = ?",
          [`mp:${current.provider_payment_id}`],
        );
        if (previous || recorded) {
          if (payment.status === "approved")
            await query(
              "UPDATE mp_charges SET status = 'needs_review', review_reason = 'Pagamento adicional recebido; revisão necessária.' WHERE id = ?",
              [charge.id],
            );
          return { ignored: true };
        }
      }
      const refunded = cents(payment.transaction_amount_refunded || 0) > 0;
      const next = refunded ? "refunded" : payment.status;
      await query(
        "UPDATE mp_charges SET provider_payment_id = ?, status = ?, last_error = NULL WHERE id = ?",
        [String(payment.id), next, charge.id],
      );
      if (payment.status === "approved" && !refunded) {
        if (!recorded) {
          const totals = await sales.totals(query, sale);
          if (
            sale.status === "cancelada" ||
            cents(totals.total) - cents(totals.total_paid) <
              Number(current.amount_cents)
          ) {
            await query(
              "UPDATE mp_charges SET status = 'needs_review', review_reason = 'Pagamento recebido para venda cancelada ou sem saldo.' WHERE id = ?",
              [charge.id],
            );
            return { needs_review: true };
          }
          await require("./paymentsService").record(
            query,
            sale,
            Number(current.amount_cents) / 100,
            "mercadopago",
            `mp:${payment.id}`,
          );
        }
        if (sale.mp_charge_id === charge.id)
          await query("UPDATE sales SET mp_charge_id = NULL WHERE id = ?", [
            sale.id,
          ]);
        return { received: true, split: true };
      }
      if (recorded)
        await query(
          "UPDATE mp_charges SET review_reason = 'Pagamento devolvido ou contestado; revisão financeira necessária.' WHERE id = ?",
          [charge.id],
        );
      return { received: false, status: next };
    });
  },
  async cancelCharge(companyId, saleId) {
    const [sale] = await db.executeSql(
      "SELECT mp_charge_id FROM sales WHERE id = ? AND company_id = ?",
      [saleId, companyId],
    );
    if (!sale?.mp_charge_id) throw new Error("Não há cobrança pendente.");
    const charge = await this.getCharge(companyId, sale.mp_charge_id);
    if (charge.api_version !== "checkout")
      return legacy().cancelCharge(companyId, saleId);
    const result = await this.reconcileCharge(companyId, charge.id);
    if (result.received || result.needs_review)
      throw new Error("Pagamento recebido. Atualize a venda.");
    if (!charge.provider_preference_id)
      throw new Error(
        "Recupere a criação com a mesma chave antes de cancelar.",
      );
    const auth = await connections.credentials(charge.connection_id, companyId);
    await gateway.request(
      "PUT",
      `/checkout/preferences/${encodeURIComponent(charge.provider_preference_id)}`,
      {
        expires: true,
        expiration_date_from: new Date(Date.now() - 86400000).toISOString(),
        expiration_date_to: new Date(Date.now() - 1000).toISOString(),
      },
      {},
      auth.accessToken,
    );
    // Expirar o checkout impede novas tentativas; Pix/boletos já emitidos ainda podem ser pagos e continuam reconciliáveis.
    await db.executeTransaction(async (query) => {
      await sales.lockSale(query, saleId, companyId);
      const [current] = await query(
        "SELECT status FROM mp_charges WHERE id = ? FOR UPDATE",
        [charge.id],
      );
      if (current.status === "approved") return;
      await query("UPDATE mp_charges SET status = 'expired' WHERE id = ?", [
        charge.id,
      ]);
      await query(
        "DELETE FROM accounts_receivable WHERE sale_id = ? AND payment_type = 'mercadopago' AND status = 'EM ABERTO'",
        [saleId],
      );
      await query(
        "UPDATE sales SET mp_charge_id = NULL WHERE id = ? AND mp_charge_id = ?",
        [saleId, charge.id],
      );
    });
    return { expired: true };
  },
  async paymentNotification(paymentId, type, hint, sellerHint) {
    const [legacyCharge] = await db.executeSql(
      "SELECT id FROM mp_charges WHERE provider_payment_id = ? AND api_version <> 'checkout' AND environment = ?",
      [paymentId, config.settings().environment],
    );
    if (legacyCharge) return legacy().paymentNotification(paymentId, type);
    let charge;
    if (/^\d+$/.test(String(hint)))
      [charge] = await db.executeSql(
        "SELECT id, company_id FROM mp_charges WHERE id = ? AND api_version = 'checkout' AND environment = ?",
        [hint, config.settings().environment],
      );
    if (!charge)
      [charge] = await db.executeSql(
        "SELECT id, company_id FROM mp_charges WHERE provider_payment_id = ? AND api_version = 'checkout' AND environment = ?",
        [paymentId, config.settings().environment],
      );
    // A URL específica pode ser substituída pela notificação global do painel.
    // user_id só seleciona uma credencial; a API autenticada confirma referência e recebedor.
    if (!charge && type === "payment" && /^\d+$/.test(String(sellerHint))) {
      const [connection] = await db.executeSql(
        `SELECT id, company_id FROM mp_connections
        WHERE collector_id = ? AND environment = ? ORDER BY active DESC, id DESC LIMIT 1`,
        [String(sellerHint), config.settings().environment],
      );
      if (connection) {
        const auth = await connections.credentials(
          connection.id,
          connection.company_id,
        );
        const remote = await gateway.request(
          "GET",
          `/v1/payments/${encodeURIComponent(paymentId)}`,
          undefined,
          {},
          auth.accessToken,
        );
        [charge] = await db.executeSql(
          `SELECT id, company_id FROM mp_charges WHERE api_version = 'checkout'
          AND external_reference = ? AND seller_id = ? AND environment = ?`,
          [
            remote.external_reference,
            String(sellerHint),
            config.settings().environment,
          ],
        );
      }
    }
    if (charge && type === "payment")
      return this.reconcileCharge(charge.company_id, charge.id, paymentId);
    const [invoice] = await db.executeSql(
      "SELECT provider_id FROM mp_subscription_invoices WHERE payment_id = ?",
      [paymentId],
    );
    return invoice ? plans.invoice(invoice.provider_id) : { ignored: true };
  },
};
module.exports = service;
