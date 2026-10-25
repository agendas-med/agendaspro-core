const functions = require('../utils/functions');
const sales = require('./salesService');
const asaas = require('./asaasService');
const cents = value => Math.round(Number(value) * 100);

async function record(query, sale, amount, paymentType, externalId = null) {
  await query('INSERT INTO payments (company_id, sale_id, customer_id, amount, payment_type, external_id) VALUES (?, ?, ?, ?, ?, ?)',
    [sale.company_id, sale.id, sale.customer_id, amount, paymentType, externalId]);
  if (externalId) await query("DELETE FROM accounts_receivable WHERE sale_id = ? AND payment_type = ? AND status = 'EM ABERTO'", [sale.id, paymentType]);
  await query("INSERT INTO accounts_receivable (sale_id, customer_id, amount, payment_type, status, receive_date) VALUES (?, ?, ?, ?, 'recebido', NOW())", [sale.id, sale.customer_id, amount, paymentType]);
  const totals = await sales.totals(query, sale);
  if (cents(totals.total_paid) >= cents(totals.total)) {
    if (sale.status !== 'cancelada') await query("UPDATE sales SET status = 'realizada' WHERE id = ?", [sale.id]);
    if (sale.appointment_id) await query("UPDATE appointments SET payment_status = 'pago' WHERE id = ? AND company_id = ?", [sale.appointment_id, sale.company_id]);
  }
}
const paymentsService = {
  record,
  async insert(companyId, data, options = {}) {
    if (data.payment_type === 'pix_mercadopago') return require('./mercadoPagoPaymentsService').createCharge(companyId, data, options.idempotencyKey);
    if (data.payment_type === 'pix_asaas' && require('../config/mercadopago').provider() !== 'asaas') throw new Error('Use pix_mercadopago nesta integração.');
    return functions.executeTransaction(async query => {
      const sale = await sales.lockSale(query, data.sale_id, companyId);
      if (sale.status !== 'em_aberto') throw new Error('A venda não está em aberto.');
      if (Number(data.customer_id) !== sale.customer_id) throw new Error('Cliente diferente do cliente da venda.');
      if (sale.pix_asaas_id || sale.mp_charge_id) throw new Error('Aguarde ou cancele a cobrança Pix existente.');
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
      const customerId = await asaas.getOrCreateCustomer(customer, company.asaas_api_key);
      const pix = await asaas.createPixCharge({ customerAsaasId: customerId, value: amount,
        externalReference: `SALE_${sale.id}`, description: `Venda #${sale.id} no AgendasPRO` }, company.asaas_api_key);
      try {
        await query('UPDATE sales SET pix_asaas_id = ?, pix_payload = ?, pix_expiration_date = ?, pix_encoded_image = ? WHERE id = ? AND company_id = ?', [pix.paymentId, pix.payload, pix.expirationDate, pix.encodedImage, sale.id, companyId]);
        await query("INSERT INTO accounts_receivable (sale_id, customer_id, amount, payment_type, status) VALUES (?, ?, ?, 'pix_asaas', 'EM ABERTO')", [sale.id, sale.customer_id, amount]);
      } catch (error) {
        await asaas.cancelCharge(pix.paymentId, company.asaas_api_key).catch(() => {});
        throw error;
      }
      return { pix };
    });
  },
  async cancelPix(companyId, saleId) {
    const [current] = await functions.executeSql('SELECT mp_charge_id FROM sales WHERE id = ? AND company_id = ?', [saleId, companyId]);
    if (current?.mp_charge_id) return require('./mercadoPagoPaymentsService').cancelCharge(companyId, saleId);
    return functions.executeTransaction(async query => {
      const sale = await sales.lockSale(query, saleId, companyId);
      if (!sale.pix_asaas_id) return;
      const [company] = await query('SELECT asaas_api_key FROM companies WHERE id = ?', [companyId]);
      await asaas.cancelCharge(sale.pix_asaas_id, company.asaas_api_key);
      await query("DELETE FROM accounts_receivable WHERE sale_id = ? AND payment_type = 'pix_asaas' AND status = 'EM ABERTO'", [sale.id]);
      await query('UPDATE sales SET pix_asaas_id = NULL, pix_payload = NULL, pix_expiration_date = NULL, pix_encoded_image = NULL WHERE id = ? AND company_id = ?', [sale.id, companyId]);
    });
  },
  async confirm(payment) {
    if (!payment?.id || !/^(APP|SALE)_\d+$/.test(payment.externalReference || '') || !Number.isFinite(Number(payment.value)) || cents(payment.value) < 1) throw new Error('Notificação de pagamento inválida.');
    return functions.executeTransaction(async query => {
      const [type, id] = payment.externalReference.split('_');
      const matches = await query(`SELECT * FROM sales WHERE ${type === 'APP' ? 'appointment_id' : 'id'} = ? AND pix_asaas_id = ? FOR UPDATE`, [id, payment.id]);
      const sale = matches[0];
      // Após confirmar, o identificador fica em payments para reconhecer reentregas.
      const existing = await query('SELECT id FROM payments WHERE external_id = ?', [payment.id]);
      if (existing.length) return { duplicate: true };
      if (!sale) throw new Error('Cobrança não corresponde à venda ou ao agendamento.');
      const [pending] = await query("SELECT SUM(amount) AS amount FROM accounts_receivable WHERE sale_id = ? AND payment_type = 'pix_asaas' AND status = 'EM ABERTO'", [sale.id]);
      if (!pending.amount || cents(pending.amount) !== cents(payment.value)) throw new Error('Valor recebido difere da cobrança registrada.');
      await record(query, sale, Number(payment.value), 'pix_asaas', payment.id);
      await query('UPDATE sales SET pix_asaas_id = NULL, pix_payload = NULL, pix_expiration_date = NULL, pix_encoded_image = NULL WHERE id = ?', [sale.id]);
      return { received: true };
    });
  },
};
module.exports = paymentsService;
