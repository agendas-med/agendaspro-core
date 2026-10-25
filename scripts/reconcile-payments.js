require('dotenv').config();
const functions = require('../utils/functions');
const payments = require('../services/mercadoPagoSplitService');
const config = require('../config/mercadopago');

async function run() {
  config.requireCredentials();
  const environment = config.settings().environment;
  const charges = await functions.executeSql(`SELECT * FROM mp_charges WHERE environment = ?
    AND status IN ('creating', 'dispatching', 'pending', 'in_process', 'approved', 'in_mediation', 'expired')
    ORDER BY COALESCE(last_checked_at, created_at), id LIMIT 100`, [environment]);
  for (const charge of charges) {
    try {
      if (charge.api_version === 'checkout' && !charge.provider_preference_id) await payments.createCharge(charge.company_id,
        { sale_id: charge.sale_id, customer_id: charge.customer_id, amount: Number(charge.amount_cents) / 100 }, charge.idempotency_key);
      else if (charge.api_version !== 'checkout' && !charge.provider_payment_id) await require('../services/mercadoPagoPaymentsService').createCharge(charge.company_id,
        { sale_id: charge.sale_id, customer_id: charge.customer_id, amount: Number(charge.amount_cents) / 100 }, charge.idempotency_key);
      else await payments.reconcileCharge(charge.company_id, charge.id);
    }
    catch { console.error(`Falha ao reconciliar cobrança local ${charge.id}.`); }
    finally { await functions.executeSql('UPDATE mp_charges SET last_checked_at = NOW() WHERE id = ?', [charge.id]); }
  }
  const subscriptions = await functions.executeSql(`SELECT id, company_id FROM mp_subscriptions
    WHERE environment = ? AND provider_id IS NOT NULL AND status IN ('pending','authorized','paused','cancelled')
    ORDER BY COALESCE(last_checked_at, created_at), id LIMIT 100`, [environment]);
  for (const subscription of subscriptions) {
    try {
      await require('../services/mercadoPagoPlansService').reconcile(subscription.company_id, subscription.id);
    } catch { console.error(`Falha ao reconciliar assinatura local ${subscription.id}.`); }
    finally { await functions.executeSql('UPDATE mp_subscriptions SET last_checked_at = NOW() WHERE id = ?', [subscription.id]); }
  }
}
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => require('../mysql').pool.end());
module.exports = run;
