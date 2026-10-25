const crypto = require('node:crypto');
const functions = require('../utils/functions');
const sales = require('./salesService');
const gateway = require('./mercadoPagoService');
const config = require('../config/mercadopago');
const rules = require('../utils/mercadoPago');

const publicCharge = charge => ({
  id: charge.id, sale_id: charge.sale_id, status: charge.status, amount: Number(charge.amount_cents) / 100,
  provider: 'mercadopago', environment: charge.environment, api: charge.api_version,
  pix: { paymentId: charge.provider_payment_id, payload: charge.pix_payload, encodedImage: charge.pix_encoded_image,
    expirationDate: charge.pix_expiration_date, url: charge.payment_url },
});
const publicPayout = payout => ({
  id: payout.id, charge_id: payout.charge_id, environment: payout.environment, status: payout.status,
  status_detail: payout.status_detail, last_error: payout.last_error,
  gross: Number(payout.gross_cents) / 100, provider_fee: Number(payout.provider_fee_cents) / 100,
  commission: Number(payout.commission_cents) / 100, amount: Number(payout.amount_cents) / 100,
  destination_name: payout.destination_name, pix_key_type: payout.pix_key_type,
  pix_key_masked: `***${payout.pix_key.slice(-4)}`, paid_at: payout.paid_at,
});
function checkEnvironment(row) {
  if (row.environment !== config.settings().environment) throw new Error('Registro pertence a outro ambiente Mercado Pago.');
}
function safeError(error) {
  if (error.response?.status) return `Mercado Pago retornou HTTP ${error.response.status}. Consulte as permissões, credenciais e a documentação.`;
  if (error.isAxiosError || error.code) return 'Não foi possível confirmar a operação. Reexecute com a mesma chave de idempotência.';
  return error.message;
}

async function preparePayout(query, charge, payment) {
  const [existing] = await query('SELECT id FROM mp_payouts WHERE charge_id = ?', [charge.id]);
  if (existing) return existing.id;
  const amounts = rules.payoutAmounts(payment, charge);
  const [destination] = await query('SELECT * FROM mp_destinations WHERE company_id = ?', [charge.company_id]);
  if (!destination) throw new Error('Cadastre a conta Pix do assinante antes de preparar o repasse.');
  const reference = `AGP_OUT_${crypto.randomUUID()}`;
  const body = JSON.stringify({ external_reference: reference,
    ...(config.settings().payoutWebhookUrl ? { config: { notification_url: config.settings().payoutWebhookUrl } } : {}),
    description: `Repasse AgendasPro venda ${charge.sale_id}`,
    transactions: [{ description: `Venda ${charge.sale_id}`, type: 'pix',
      pix: { type: destination.pix_key_type, chave: destination.pix_key },
      amount: { currency: 'BRL', value: amounts.payout / 100 }, external_reference: reference }],
  });
  const result = await query(`INSERT INTO mp_payouts (charge_id, company_id, environment, external_reference, idempotency_key,
    gross_cents, provider_fee_cents, commission_cents, amount_cents, destination_name, destination_document, pix_key_type, pix_key, request_body)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [charge.id, charge.company_id, charge.environment, reference, crypto.randomUUID(), amounts.gross, amounts.providerFee,
    amounts.commission, amounts.payout, destination.holder_name, destination.holder_document, destination.pix_key_type, destination.pix_key, body]);
  return result.insertId;
}

const service = {
  async saveDestination(companyId, userId, input) {
    const data = rules.destination(input);
    return functions.executeTransaction(async query => {
      const [company] = await query('SELECT document FROM companies WHERE id = ? FOR UPDATE', [companyId]);
      if (!company || String(company.document || '').replace(/\D/g, '') !== data.holder_document) throw new Error('O titular deve ser o CPF/CNPJ cadastrado na empresa.');
      await query(`INSERT INTO mp_destinations (company_id, holder_name, holder_document, pix_key_type, pix_key, updated_by)
        VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE holder_name = VALUES(holder_name), holder_document = VALUES(holder_document),
        pix_key_type = VALUES(pix_key_type), pix_key = VALUES(pix_key), updated_by = VALUES(updated_by)`,
      [companyId, data.holder_name, data.holder_document, data.pix_key_type, data.pix_key, userId]);
      return { configured: true, pix_key_type: data.pix_key_type, pix_key_masked: `***${data.pix_key.slice(-4)}` };
    });
  },
  async status(companyId) {
    const settings = config.settings();
    const [destination] = await functions.executeSql('SELECT holder_name, pix_key_type, RIGHT(pix_key, 4) AS suffix FROM mp_destinations WHERE company_id = ?', [companyId]);
    return { provider: config.provider(), environment: settings.environment,
      configured: Boolean(settings.accessToken && settings.collectorId && settings.webhookSecret && settings.webhookUrl),
      payouts_enabled: settings.payoutsEnabled, commission_bps: settings.commissionBps,
      destination: destination ? { holder_name: destination.holder_name, pix_key_type: destination.pix_key_type, pix_key_masked: `***${destination.suffix}` } : null };
  },
  async getCharge(companyId, chargeId) {
    const [charge] = await functions.executeSql('SELECT * FROM mp_charges WHERE id = ? AND company_id = ?', [chargeId, companyId]);
    if (!charge) throw new Error('Cobrança não encontrada nesta empresa.');
    return charge;
  },
  async createCharge(companyId, input, idempotencyKey) {
    const settings = config.requireCredentials();
    if (config.provider() !== 'mercadopago') throw new Error('Selecione PAYMENT_PROVIDER=mercadopago para gerar esta cobrança.');
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(idempotencyKey || '')) throw new Error('Envie um Idempotency-Key único (UUID) e reutilize-o nas tentativas da mesma cobrança.');
    if (!settings.webhookSecret || !/^https:\/\//.test(settings.webhookUrl || '')) throw new Error('Configure MP_WEBHOOK_SECRET e MP_WEBHOOK_URL pública HTTPS.');
    const amountCents = rules.cents(input.amount);
    if (amountCents < 1) throw new Error('Valor inválido.');
    const chargeId = await functions.executeTransaction(async query => {
      const sale = await sales.lockSale(query, input.sale_id, companyId);
      const [existing] = await query('SELECT * FROM mp_charges WHERE idempotency_key = ?', [idempotencyKey]);
      if (existing) {
        if (existing.company_id !== Number(companyId) || existing.sale_id !== sale.id || existing.customer_id !== Number(input.customer_id) || Number(existing.amount_cents) !== amountCents) throw new Error('Chave de idempotência já usada para outra cobrança.');
        checkEnvironment(existing);
        return existing.id;
      }
      if (sale.status !== 'em_aberto' || sale.pix_asaas_id || sale.mp_charge_id) throw new Error('Venda concluída ou com cobrança em andamento.');
      if (sale.customer_id !== Number(input.customer_id)) throw new Error('Cliente diferente do cliente da venda.');
      const totals = await sales.totals(query, sale);
      if (amountCents > rules.cents(totals.total) - rules.cents(totals.total_paid)) throw new Error('Valor superior ao saldo em aberto.');
      const [destination] = await query('SELECT company_id FROM mp_destinations WHERE company_id = ?', [companyId]);
      if (!destination) throw new Error('Cadastre a conta Pix do assinante antes de gerar uma cobrança.');
      const [customer] = await query('SELECT name, cpf, email FROM customers WHERE id = ? AND company_id = ?', [sale.customer_id, companyId]);
      if (!customer?.email || !customer.email.includes('@')) throw new Error('Cadastre o e-mail do cliente para gerar o Pix.');
      const reference = `AGP_IN_${crypto.randomUUID()}`;
      const document = String(customer.cpf || '').replace(/\D/g, '');
      const body = JSON.stringify({ type: 'online', processing_mode: 'automatic', total_amount: (amountCents / 100).toFixed(2),
        external_reference: reference, description: `Venda ${sale.id} - AgendasPro`,
        transactions: { payments: [{ amount: (amountCents / 100).toFixed(2), payment_method: { id: 'pix', type: 'bank_transfer' }, expiration_time: 'PT1H' }] },
        payer: { email: customer.email, first_name: customer.name,
          ...(rules.validDocument(document) ? { identification: { type: document.length === 11 ? 'CPF' : 'CNPJ', number: document } } : {}) },
      });
      const result = await query(`INSERT INTO mp_charges (company_id, sale_id, customer_id, environment, api_version, external_reference,
        idempotency_key, request_body, amount_cents, commission_bps) VALUES (?, ?, ?, ?, 'orders', ?, ?, ?, ?, ?)`,
      [companyId, sale.id, sale.customer_id, settings.environment, reference, idempotencyKey, body, amountCents, settings.commissionBps]);
      await query('UPDATE sales SET mp_charge_id = ? WHERE id = ?', [result.insertId, sale.id]);
      await query("INSERT INTO accounts_receivable (sale_id, customer_id, amount, payment_type, status) VALUES (?, ?, ?, 'pix_mercadopago', 'EM ABERTO')", [sale.id, sale.customer_id, amountCents / 100]);
      return result.insertId;
    });
    // A intenção e a chave já estão commitadas antes de chamar o provedor.
    const charge = await this.getCharge(companyId, chargeId);
    if (!charge.provider_payment_id) {
      try {
        await functions.executeTransaction(async query => {
          await sales.lockSale(query, charge.sale_id, companyId);
          const [current] = await query('SELECT * FROM mp_charges WHERE id = ? FOR UPDATE', [chargeId]);
          if (current.provider_payment_id) return;
          const payment = await gateway.createPix(current.request_body, current.idempotency_key, current.api_version);
          current.provider_payment_id = String(payment.id);
          if (current.api_version === 'payments') rules.validatePayment(payment, current, settings);
          else if (!/^ORD[A-Z0-9]+$/i.test(String(payment.id))) throw new Error('Identificador da order inválido.');
          const pix = payment.point_of_interaction?.transaction_data || {};
          // Orders pode responder em processamento, antes de disponibilizar a transação e o QR.
          await query(`UPDATE mp_charges SET provider_payment_id = ?, status = ?, pix_payload = ?, pix_encoded_image = ?,
            pix_expiration_date = ?, payment_url = ?, last_error = NULL WHERE id = ?`,
          [String(payment.id), payment.status === 'approved' ? 'pending' : payment.status, pix.qr_code || null, pix.qr_code_base64 || null, payment.date_of_expiration || null, pix.ticket_url || null, chargeId]);
          await query('UPDATE sales SET pix_payload = ?, pix_encoded_image = ? WHERE id = ?', [pix.qr_code || null, pix.qr_code_base64 || null, charge.sale_id]);
        });
      } catch (error) {
        await functions.executeSql('UPDATE mp_charges SET last_error = ? WHERE id = ?', [safeError(error), chargeId]);
        throw new Error(safeError(error));
      }
    }
    return publicCharge(await this.getCharge(companyId, chargeId));
  },
  async reconcileCharge(companyId, chargeId) {
    const charge = await this.getCharge(companyId, chargeId);
    checkEnvironment(charge);
    if (!charge.provider_payment_id) throw new Error('Reenvie a criação com o mesmo Idempotency-Key para recuperar a cobrança.');
    const payment = await gateway.getPayment(charge.provider_payment_id, charge.api_version);
    rules.validatePayment(payment, charge, config.requireCredentials());
    return functions.executeTransaction(async query => {
      const sale = await sales.lockSale(query, charge.sale_id, companyId);
      const [current] = await query('SELECT * FROM mp_charges WHERE id = ? FOR UPDATE', [chargeId]);
      await query('UPDATE mp_charges SET status = ? WHERE id = ?', [payment.status, chargeId]);
      const pix = payment.point_of_interaction?.transaction_data || {};
      if (pix.qr_code && pix.qr_code_base64) {
        await query('UPDATE mp_charges SET pix_payload = ?, pix_encoded_image = ?, pix_expiration_date = ?, payment_url = ? WHERE id = ?',
          [pix.qr_code, pix.qr_code_base64, payment.date_of_expiration || null, pix.ticket_url || null, chargeId]);
        if (sale.mp_charge_id === chargeId) await query('UPDATE sales SET pix_payload = ?, pix_encoded_image = ? WHERE id = ?', [pix.qr_code, pix.qr_code_base64, sale.id]);
      }
      if (payment.status === 'approved' && rules.cents(payment.transaction_amount_refunded || 0) === 0) {
        const externalId = `mp:${payment.id}`;
        const [existing] = await query('SELECT id FROM payments WHERE external_id = ?', [externalId]);
        if (!existing) await require('./paymentsService').record(query, sale, Number(current.amount_cents) / 100, 'pix_mercadopago', externalId);
        let payoutId;
        try {
          payoutId = await preparePayout(query, current, payment);
          await query('UPDATE mp_charges SET last_error = NULL WHERE id = ?', [chargeId]);
        } catch (error) {
          // Pagamento recebido continua registrado mesmo quando as taxas/destino ainda não estão disponíveis.
          await query('UPDATE mp_charges SET last_error = ? WHERE id = ?', [error.message, chargeId]);
        }
        if (sale.mp_charge_id === chargeId) await query('UPDATE sales SET mp_charge_id = NULL, pix_payload = NULL, pix_encoded_image = NULL, pix_expiration_date = NULL WHERE id = ?', [sale.id]);
        return { received: true, payout_id: payoutId || null };
      }
      const [recorded] = await query('SELECT id FROM payments WHERE external_id = ?', [`mp:${payment.id}`]);
      if (recorded || rules.cents(payment.transaction_amount_refunded || 0) > 0) {
        await query("UPDATE mp_payouts SET status = 'needs_review', last_error = 'Pagamento devolvido, contestado ou deixou de estar aprovado. Revisão financeira necessária.' WHERE charge_id = ?", [chargeId]);
        return { needs_review: true };
      }
      if (['cancelled', 'rejected', 'expired'].includes(payment.status) && sale.mp_charge_id === chargeId) {
        await query("DELETE FROM accounts_receivable WHERE sale_id = ? AND payment_type = 'pix_mercadopago' AND status = 'EM ABERTO'", [sale.id]);
        await query('UPDATE sales SET mp_charge_id = NULL, pix_payload = NULL, pix_encoded_image = NULL, pix_expiration_date = NULL WHERE id = ?', [sale.id]);
      }
      return { received: false, status: payment.status };
    });
  },
  async cancelCharge(companyId, saleId) {
    const [sale] = await functions.executeSql('SELECT mp_charge_id FROM sales WHERE id = ? AND company_id = ?', [saleId, companyId]);
    if (!sale?.mp_charge_id) throw new Error('Não há cobrança Mercado Pago pendente nesta venda.');
    const charge = await this.getCharge(companyId, sale.mp_charge_id);
    checkEnvironment(charge);
    if (!charge.provider_payment_id) throw new Error('Recupere a cobrança com o mesmo Idempotency-Key antes de cancelar.');
    const payment = await gateway.getPayment(charge.provider_payment_id, charge.api_version);
    rules.validatePayment(payment, charge, config.requireCredentials());
    if (payment.status === 'approved') throw new Error('Pagamento já aprovado. Reconcilie a cobrança antes de continuar.');
    if (!['cancelled', 'rejected', 'expired'].includes(payment.status)) await gateway.cancelPayment(charge.provider_payment_id, charge.api_version, `cancel-${charge.idempotency_key}`);
    return this.reconcileCharge(companyId, charge.id);
  },
  async listPayouts(companyId) {
    const rows = await functions.executeSql('SELECT * FROM mp_payouts WHERE company_id = ? ORDER BY id DESC LIMIT 200', [companyId]);
    return rows.map(publicPayout);
  },
  async getPayout(companyId, payoutId) {
    const [payout] = await functions.executeSql('SELECT * FROM mp_payouts WHERE id = ? AND company_id = ?', [payoutId, companyId]);
    if (!payout) throw new Error('Repasse não encontrado nesta empresa.');
    checkEnvironment(payout);
    return payout;
  },
  async submitPayout(companyId, payoutId) {
    const payout = await this.getPayout(companyId, payoutId);
    if (payout.provider_transaction_id) return this.reconcilePayout(companyId, payoutId);
    try {
      await functions.executeTransaction(async query => {
        const charge = await this.getCharge(companyId, payout.charge_id);
        const sale = await sales.lockSale(query, charge.sale_id, companyId);
        await query('SELECT id FROM mp_charges WHERE id = ? FOR UPDATE', [charge.id]);
        const [current] = await query('SELECT * FROM mp_payouts WHERE id = ? FOR UPDATE', [payoutId]);
        if (current.provider_payout_id || current.provider_transaction_id) return;
        if (!['ready', 'unknown'].includes(current.status)) throw new Error('Repasse bloqueado para revisão.');
        const payment = await gateway.getPayment(charge.provider_payment_id, charge.api_version);
        rules.validatePayment(payment, charge, config.requireCredentials());
        if (sale.status === 'cancelada' || payment.status !== 'approved' || rules.cents(payment.transaction_amount_refunded || 0) > 0) throw new Error('Pagamento não está aprovado ou foi devolvido.');
        if (payment.money_release_status !== 'released') throw new Error('Saldo ainda não foi liberado pelo Mercado Pago.');
        const amounts = rules.payoutAmounts(payment, charge);
        if (amounts.payout !== Number(current.amount_cents)) throw new Error('Valor líquido mudou. Revise o repasse antes de enviar.');
        const response = await gateway.createPayout(current.request_body, current.idempotency_key);
        const transaction = response.transactions?.find(item => item.external_reference === current.external_reference);
        if (!response.id || !transaction?.id || response.external_reference !== current.external_reference) throw new Error('Resposta de repasse não reconhecida.');
        await query("UPDATE mp_payouts SET provider_payout_id = ?, provider_transaction_id = ?, status = 'pending', last_error = NULL WHERE id = ?", [response.id, transaction.id, payoutId]);
      });
    } catch (error) {
      // Nunca gere outra chave após timeout: a operação pode ter sido aceita no provedor.
      await functions.executeSql('UPDATE mp_payouts SET last_error = ? WHERE id = ?', [safeError(error), payoutId]);
      throw new Error(error.response || error.code ? safeError(error) : error.message);
    }
    return publicPayout(await this.getPayout(companyId, payoutId));
  },
  async reconcilePayout(companyId, payoutId) {
    const payout = await this.getPayout(companyId, payoutId);
    if (!payout.provider_payout_id || !payout.provider_transaction_id) throw new Error('Repasse ainda não enviado.');
    const transaction = await gateway.getPayoutTransaction(payout.provider_payout_id, payout.provider_transaction_id);
    if (transaction.id !== payout.provider_transaction_id || transaction.external_reference !== payout.external_reference ||
        transaction.amount?.currency !== 'BRL' || rules.cents(transaction.amount?.value) !== Number(payout.amount_cents)) throw new Error('Transação não corresponde ao repasse registrado.');
    const state = rules.payoutState(transaction);
    await functions.executeTransaction(async query => {
      const [current] = await query('SELECT * FROM mp_payouts WHERE id = ? FOR UPDATE', [payoutId]);
      // Revisão por devolução do pagamento não é removida por uma notificação atrasada do repasse.
      const next = current.status === 'needs_review' || (current.status === 'paid' && state === 'pending') ? current.status : state;
      await query('UPDATE mp_payouts SET status = ?, status_detail = ?, paid_at = IF(? = \'paid\', COALESCE(paid_at, NOW()), paid_at) WHERE id = ?', [next, transaction.status_detail || transaction.status, next, payoutId]);
    });
    return publicPayout(await this.getPayout(companyId, payoutId));
  },
  async paymentNotification(paymentId, type = 'order') {
    const [charge] = await functions.executeSql('SELECT company_id, id FROM mp_charges WHERE provider_payment_id = ? AND api_version = ?', [paymentId, type === 'payment' ? 'payments' : 'orders']);
    if (!charge) return { ignored: true };
    return this.reconcileCharge(charge.company_id, charge.id);
  },
  async payoutNotification(payoutId, transactionId) {
    // Payouts não documenta HMAC como Payments. O callback é só um aviso; consultamos o recurso conhecido pela API autenticada.
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(payoutId || '') || !/^[A-Za-z0-9_-]{1,100}$/.test(transactionId || '')) throw new Error('Notificação inválida.');
    const [payout] = await functions.executeSql('SELECT id, company_id FROM mp_payouts WHERE provider_payout_id = ? AND provider_transaction_id = ?', [payoutId, transactionId]);
    if (!payout) return { ignored: true };
    return this.reconcilePayout(payout.company_id, payout.id);
  },
  publicCharge,
};
module.exports = service;
