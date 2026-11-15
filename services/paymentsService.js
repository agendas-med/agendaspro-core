const functions = require('../utils/functions');
const sales = require('./salesService');
const asaas = require('./asaasService');
const { decryptKey } = require('./asaasKeys');
const billing = require('./billingService');
const { toCents, centsToDecimal } = require('../utils/money');
const cents = value => (value === null || value === undefined || value === '' ? 0 : toCents(value));

async function record(query, sale, amount, paymentType, externalId = null) {
  await query('INSERT INTO payments (company_id, sale_id, customer_id, amount, payment_type, external_id) VALUES (?, ?, ?, ?, ?, ?)',
    [sale.company_id, sale.id, sale.customer_id, amount, paymentType, externalId]);
  if (externalId) await query("DELETE FROM accounts_receivable WHERE sale_id = ? AND payment_type = 'pix_asaas' AND status = 'EM ABERTO'", [sale.id]);
  await query("INSERT INTO accounts_receivable (sale_id, customer_id, amount, payment_type, status, receive_date) VALUES (?, ?, ?, ?, 'recebido', NOW())", [sale.id, sale.customer_id, amount, paymentType]);
  const totals = await sales.totals(query, sale);
  if (cents(totals.total_paid) >= cents(totals.total)) {
    if (sale.status !== 'cancelada') await query("UPDATE sales SET status = 'realizada' WHERE id = ?", [sale.id]);
    if (sale.appointment_id) await query("UPDATE appointments SET payment_status = 'pago' WHERE id = ? AND company_id = ?", [sale.appointment_id, sale.company_id]);
  }
}
const paymentsService = {
  async insert(companyId, data) {
    return functions.executeTransaction(async query => {
      const sale = await sales.lockSale(query, data.sale_id, companyId);
      if (sale.status !== 'em_aberto') throw new Error('A venda não está em aberto.');
      if (Number(data.customer_id) !== sale.customer_id) throw new Error('Cliente diferente do cliente da venda.');
      if (sale.pix_asaas_id) throw new Error('Aguarde ou cancele a cobrança Pix existente.');
      const totals = await sales.totals(query, sale);
      const amount = Number(data.amount);
      if (!Number.isFinite(amount) || cents(amount) < 1 || cents(amount) > cents(totals.total) - cents(totals.total_paid)) throw new Error('Valor inválido ou superior ao saldo em aberto.');
      if (data.payment_type !== 'pix_asaas') {
        await record(query, sale, amount, data.payment_type);
        return { message: 'Pagamento registrado com sucesso.' };
      }
      const [company] = await query('SELECT asaas_api_key, asaas_status FROM companies WHERE id = ?', [companyId]);
      if (!company?.asaas_api_key || company.asaas_status !== 'APPROVED') throw new Error('Configure e aprove a conta Asaas antes de gerar o Pix.');
      const [customer] = await query('SELECT name, cpf, tel, email FROM customers WHERE id = ? AND company_id = ?', [sale.customer_id, companyId]);
      const customerId = await asaas.getOrCreateCustomer(customer, decryptKey(company.asaas_api_key));
      // Comissão da plataforma conforme o plano efetivo (5% Free / 0,5% Premium), em centavos.
      const commission = await billing.commissionFor(companyId, toCents(data.amount), { query });
      const pix = await asaas.createPixCharge({ customerAsaasId: customerId, value: centsToDecimal(commission.gross_cents), split: commission.split,
        externalReference: `SALE_${sale.id}`, description: `Venda #${sale.id} no AgendasPRO` }, decryptKey(company.asaas_api_key));
      try {
        await query('UPDATE sales SET pix_asaas_id = ?, pix_payload = ?, pix_expiration_date = ?, pix_encoded_image = ? WHERE id = ? AND company_id = ?', [pix.paymentId, pix.payload, pix.expirationDate, pix.encodedImage, sale.id, companyId]);
        await query("INSERT INTO accounts_receivable (sale_id, customer_id, amount, payment_type, status) VALUES (?, ?, ?, 'pix_asaas', 'EM ABERTO')", [sale.id, sale.customer_id, amount]);
        await billing.recordCommission(query, { companyId, saleId: sale.id, providerPaymentId: pix.paymentId, commission });
      } catch (error) {
        await asaas.cancelCharge(pix.paymentId, decryptKey(company.asaas_api_key)).catch(() => {});
        throw error;
      }
      return { pix };
    });
  },
  async cancelPix(companyId, saleId) {
    return functions.executeTransaction(async query => {
      const sale = await sales.lockSale(query, saleId, companyId);
      if (!sale.pix_asaas_id) return;
      const [company] = await query('SELECT asaas_api_key FROM companies WHERE id = ?', [companyId]);
      await asaas.cancelCharge(sale.pix_asaas_id, decryptKey(company.asaas_api_key));
      await query("DELETE FROM accounts_receivable WHERE sale_id = ? AND payment_type = 'pix_asaas' AND status = 'EM ABERTO'", [sale.id]);
      await query('UPDATE sales SET pix_asaas_id = NULL, pix_payload = NULL, pix_expiration_date = NULL, pix_encoded_image = NULL WHERE id = ? AND company_id = ?', [sale.id, companyId]);
    });
  },
  async confirm(payment) {
    if (!payment?.id || !/^(APP|SALE)_\d+$/.test(payment.externalReference || '') || !Number.isFinite(Number(payment.value)) || cents(payment.value) < 1) throw new Error('Notificação de pagamento inválida.');
    return functions.executeTransaction(async query => {
      const [type, id] = payment.externalReference.split('_');
      const matches = type === 'APP'
        ? await query('SELECT * FROM sales WHERE appointment_id = ? AND pix_asaas_id = ? FOR UPDATE', [id, payment.id])
        : await query('SELECT * FROM sales WHERE id = ? AND pix_asaas_id = ? FOR UPDATE', [id, payment.id]);
      const sale = matches[0];
      // Após confirmar, o identificador fica em payments para reconhecer reentregas.
      const existing = await query('SELECT id FROM payments WHERE external_id = ?', [payment.id]);
      if (existing.length) return { duplicate: true };
      if (!sale) throw new Error('Cobrança não corresponde à venda ou ao agendamento.');
      const [pending] = await query("SELECT SUM(amount) AS amount FROM accounts_receivable WHERE sale_id = ? AND payment_type = 'pix_asaas' AND status = 'EM ABERTO'", [sale.id]);
      if (!pending.amount || cents(pending.amount) !== cents(payment.value)) throw new Error('Valor recebido difere da cobrança registrada.');
      await record(query, sale, Number(payment.value), 'pix_asaas', payment.id);
      await query('UPDATE sales SET pix_asaas_id = NULL, pix_payload = NULL, pix_expiration_date = NULL, pix_encoded_image = NULL WHERE id = ?', [sale.id]);
      await billing.setCommissionStatus(query, payment.id, 'settled');
      return { received: true };
    });
  },
  // Eventos que não são recebimento. Todos idempotentes (reentrega não muda o resultado).
  // OVERDUE/DELETED: a cobrança Pix em aberto deixa de valer; a venda volta a aceitar nova cobrança.
  async expire(payment) {
    if (!payment?.id) throw new Error('Notificação de pagamento inválida.');
    return functions.executeTransaction(async query => {
      const [sale] = await query("SELECT id FROM sales WHERE pix_asaas_id = ? AND status = 'em_aberto' FOR UPDATE", [payment.id]);
      if (!sale) return { ignored: true };
      await query("DELETE FROM accounts_receivable WHERE sale_id = ? AND payment_type = 'pix_asaas' AND status = 'EM ABERTO'", [sale.id]);
      await query('UPDATE sales SET pix_asaas_id = NULL, pix_payload = NULL, pix_expiration_date = NULL, pix_encoded_image = NULL WHERE id = ?', [sale.id]);
      await billing.setCommissionStatus(query, payment.id, 'canceled');
      return { expired: true };
    });
  },
  // REFUNDED/CHARGEBACK: marca o pagamento já registrado (sem apagar histórico) e o agendamento.
  async markReversal(payment, status) {
    if (!payment?.id) throw new Error('Notificação de pagamento inválida.');
    return functions.executeTransaction(async query => {
      const [row] = await query('SELECT p.id, p.sale_id, s.appointment_id, s.company_id FROM payments p JOIN sales s ON s.id = p.sale_id WHERE p.external_id = ? FOR UPDATE', [payment.id]);
      if (!row) return { ignored: true };
      const refunded = status === 'REFUNDED' || status === 'PARTIALLY_REFUNDED';
      await query('UPDATE payments SET external_status = ?, refunded_at = IF(?, COALESCE(refunded_at, NOW()), refunded_at) WHERE id = ?', [status, refunded ? 1 : 0, row.id]);
      if (status === 'REFUNDED') await billing.setCommissionStatus(query, payment.id, 'refunded');
      if (row.appointment_id && refunded) await query("UPDATE appointments SET payment_status = 'estornado' WHERE id = ? AND company_id = ?", [row.appointment_id, row.company_id]);
      return { updated: true };
    });
  },
};
module.exports = paymentsService;
