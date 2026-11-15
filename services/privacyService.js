const functions = require('../utils/functions');
const { HttpError } = require('../middleware/errorHandler');

const NOT_FOUND = () => new HttpError(404, 'Cliente não encontrado.');

async function assertCustomer(company_id, customer_id, query) {
    const run = query || ((sql, params) => functions.executeSql(sql, params));
    const rows = await run(`SELECT id FROM customers WHERE id = ? AND company_id = ?${query ? ' FOR UPDATE' : ''}`, [customer_id, company_id]);
    if (!rows.length) throw NOT_FOUND();
}

// Exportação (portabilidade/acesso): dados do titular nesta empresa, nada de outras.
async function exportCustomer(company_id, customer_id) {
    const [customer] = await functions.executeSql(
        `SELECT id, name, birthday, tel, image, cpf, email, anonymized_at FROM customers WHERE id = ? AND company_id = ?`,
        [customer_id, company_id]
    );
    if (!customer) throw NOT_FOUND();
    const [appointments, sales, payments, consents] = await Promise.all([
        functions.executeSql(`SELECT id, date, duration, observations, canceled, zip_code, address, number, complement, city, state, payment_status FROM appointments WHERE customer_id = ? AND company_id = ? ORDER BY date`, [customer_id, company_id]),
        functions.executeSql(`SELECT id, appointment_id, create_date, status FROM sales WHERE customer_id = ? AND company_id = ? ORDER BY create_date`, [customer_id, company_id]),
        functions.executeSql(`SELECT id, sale_id, amount, payment_type, create_date FROM payments WHERE customer_id = ? AND company_id = ? ORDER BY create_date`, [customer_id, company_id]),
        functions.executeSql(`SELECT purpose, granted, source, granted_at, revoked_at FROM consents WHERE customer_id = ? AND company_id = ? ORDER BY granted_at`, [customer_id, company_id]),
    ]);
    return { exported_at: new Date().toISOString(), customer, appointments, sales, payments, consents };
}

// Anonimização: remove identificadores e mantém o histórico financeiro/agenda sem PII.
async function anonymizeCustomer(company_id, customer_id) {
    await functions.executeTransaction(async (query) => {
        await assertCustomer(company_id, customer_id, query);
        await query(
            `UPDATE customers SET name = 'Cliente anonimizado', tel = NULL, cpf = NULL, email = NULL, image = NULL, birthday = NULL, anonymized_at = NOW() WHERE id = ? AND company_id = ?`,
            [customer_id, company_id]
        );
        await query(
            `UPDATE appointments SET customer_name = 'Cliente anonimizado', observations = NULL, zip_code = NULL, address = NULL, number = NULL, complement = NULL WHERE customer_id = ? AND company_id = ?`,
            [customer_id, company_id]
        );
        await query(`UPDATE consents SET granted = 0, revoked_at = COALESCE(revoked_at, NOW()) WHERE customer_id = ? AND company_id = ?`, [customer_id, company_id]);
    });
}

// Exclusão definitiva só sem histórico financeiro (as FKs apagariam vendas/pagamentos em cascata).
async function deleteCustomer(company_id, customer_id) {
    await functions.executeTransaction(async (query) => {
        await assertCustomer(company_id, customer_id, query);
        const [{ total }] = await query(
            `SELECT (SELECT COUNT(*) FROM sales WHERE customer_id = ? AND company_id = ?) + (SELECT COUNT(*) FROM payments WHERE customer_id = ? AND company_id = ?) AS total`,
            [customer_id, company_id, customer_id, company_id]
        );
        if (Number(total) > 0) throw new HttpError(409, 'Cliente possui histórico financeiro: use a anonimização.');
        await query(`DELETE FROM customers WHERE id = ? AND company_id = ?`, [customer_id, company_id]);
    });
}

async function recordConsent(company_id, customer_id, purpose, granted, source) {
    await assertCustomer(company_id, customer_id);
    if (!granted) {
        await functions.executeSql(`UPDATE consents SET granted = 0, revoked_at = NOW() WHERE company_id = ? AND customer_id = ? AND purpose = ? AND revoked_at IS NULL`, [company_id, customer_id, purpose]);
    }
    await functions.executeSql(
        `INSERT INTO consents (company_id, customer_id, purpose, granted, source, revoked_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [company_id, customer_id, purpose, granted ? 1 : 0, source || null, granted ? null : new Date()]
    );
}

module.exports = { exportCustomer, anonymizeCustomer, deleteCustomer, recordConsent };
