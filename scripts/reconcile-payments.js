require('dotenv').config();
const functions = require('../utils/functions');
const payments = require('../services/mercadoPagoPaymentsService');
const config = require('../config/mercadopago');

async function run() {
  config.requireCredentials();
  const environment = config.settings().environment;
  const charges = await functions.executeSql(`SELECT * FROM mp_charges WHERE environment = ?
    AND status IN ('creating', 'pending', 'in_process', 'approved', 'in_mediation')
    ORDER BY updated_at LIMIT 100`, [environment]);
  for (const charge of charges) {
    try {
      if (!charge.provider_payment_id) await payments.createCharge(charge.company_id,
        { sale_id: charge.sale_id, customer_id: charge.customer_id, amount: Number(charge.amount_cents) / 100 }, charge.idempotency_key);
      else await payments.reconcileCharge(charge.company_id, charge.id);
    }
    catch { console.error(`Falha ao reconciliar cobrança local ${charge.id}.`); }
  }
  const payouts = await functions.executeSql(`SELECT id, company_id, status, provider_transaction_id FROM mp_payouts
    WHERE environment = ? AND status IN ('ready', 'unknown', 'pending') ORDER BY updated_at LIMIT 100`, [environment]);
  for (const payout of payouts) {
    try {
      if (payout.provider_transaction_id) await payments.reconcilePayout(payout.company_id, payout.id);
      else if (process.env.MP_AUTO_PAYOUTS === 'true') await payments.submitPayout(payout.company_id, payout.id);
    } catch { console.error(`Falha ao reconciliar/enviar repasse local ${payout.id}. Consulte seu last_error.`); }
  }
}
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => require('../mysql').pool.end());
module.exports = run;
