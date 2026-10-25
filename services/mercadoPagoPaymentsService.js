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
function checkEnvironment(row) {
  if (row.environment !== config.settings().environment) throw new Error('Registro pertence a outro ambiente Mercado Pago.');
}
function safeError(error) {
  if (error.response?.status) return `Mercado Pago retornou HTTP ${error.response.status}. Consulte as permissões, credenciais e a documentação.`;
  if (error.isAxiosError || error.code) return 'Não foi possível confirmar a operação. Reexecute com a mesma chave de idempotência.';
  return error.message;
}

const service = {
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
    const recovery = await functions.executeSql('SELECT id FROM mp_charges WHERE idempotency_key = ? AND company_id = ?', [idempotencyKey, companyId]);
    if (!recovery.length) throw new Error('Novas cobranças devem usar split 1:1.');
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
      if (pix.qr_code) {
        await query('UPDATE mp_charges SET pix_payload = ?, pix_encoded_image = ?, pix_expiration_date = ?, payment_url = ? WHERE id = ?',
          [pix.qr_code, pix.qr_code_base64 || null, payment.date_of_expiration || null, pix.ticket_url || null, chargeId]);
        if (sale.mp_charge_id === chargeId) await query('UPDATE sales SET pix_payload = ?, pix_encoded_image = ? WHERE id = ?', [pix.qr_code, pix.qr_code_base64 || null, sale.id]);
      }
      if (payment.status === 'approved' && rules.cents(payment.transaction_amount_refunded || 0) === 0) {
        const externalId = `mp:${payment.id}`;
        const [existing] = await query('SELECT id FROM payments WHERE external_id = ?', [externalId]);
        if (!existing) await require('./paymentsService').record(query, sale, Number(current.amount_cents) / 100, 'pix_mercadopago', externalId);
        await query('UPDATE mp_charges SET last_error = NULL WHERE id = ?', [chargeId]);
        if (sale.mp_charge_id === chargeId) await query('UPDATE sales SET mp_charge_id = NULL, pix_payload = NULL, pix_encoded_image = NULL, pix_expiration_date = NULL WHERE id = ?', [sale.id]);
        return { received: true, legacy: true };
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
  async paymentNotification(paymentId, type = 'order') {
    const [charge] = await functions.executeSql('SELECT company_id, id FROM mp_charges WHERE provider_payment_id = ? AND api_version = ?', [paymentId, type === 'payment' ? 'payments' : 'orders']);
    if (!charge) return { ignored: true };
    return this.reconcileCharge(charge.company_id, charge.id);
  },
  publicCharge,
};
module.exports = service;
