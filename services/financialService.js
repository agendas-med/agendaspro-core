const functions = require('../utils/functions');

module.exports = {
  async returnFinancial(companyId) {
    // A venda reúne o serviço e os produtos. Subconsultas evitam multiplicar
    // os valores ao combinar vários itens com vários pagamentos parciais.
    const rows = await functions.executeSql(`
      SELECT ledger.*,
        CASE WHEN ROUND(total_paid * 100) >= ROUND(value * 100) THEN 'Pago'
          WHEN DATE(due_date) >= CURDATE() THEN 'Em Aberto'
          ELSE 'Atrasado' END AS status
      FROM (
        SELECT sale.id, sale.id AS sale_id, sale.appointment_id,
          customer.id AS customer_id, customer.name AS customer_name,
          customer.image AS customer_image, customer.tel AS customer_tel,
          COALESCE(appointment.date, sale.create_date) AS due_date,
          COALESCE((SELECT SUM(item.quantity * item.unit_price) FROM sales_products item WHERE item.sale_id = sale.id), 0) +
          COALESCE((SELECT SUM(item.quantity * service.value) FROM appointment_services item
            JOIN services service ON service.id = item.service_id WHERE item.appointment_id = sale.appointment_id), 0) AS value,
          COALESCE((SELECT SUM(payment.amount) FROM payments payment WHERE payment.sale_id = sale.id), 0) AS total_paid
        FROM sales sale
        JOIN customers customer ON customer.id = sale.customer_id AND customer.company_id = sale.company_id
        LEFT JOIN appointments appointment ON appointment.id = sale.appointment_id AND appointment.company_id = sale.company_id
        WHERE sale.company_id = ? AND sale.status <> 'cancelada'

        UNION ALL

        SELECT -appointment.id, NULL AS sale_id, appointment.id AS appointment_id,
          customer.id, customer.name, customer.image, customer.tel, appointment.date,
          SUM(service.value * item.quantity) AS value,
          IF(appointment.payment_status = 'pago', SUM(service.value * item.quantity), 0) AS total_paid
        FROM appointments appointment
        JOIN appointment_services item ON item.appointment_id = appointment.id
        JOIN services service ON service.id = item.service_id
        JOIN customers customer ON customer.id = appointment.customer_id AND customer.company_id = appointment.company_id
        WHERE appointment.company_id = ? AND appointment.canceled = 0
          AND NOT EXISTS (SELECT 1 FROM sales sale WHERE sale.appointment_id = appointment.id AND sale.company_id = appointment.company_id)
        GROUP BY appointment.id, customer.id, customer.name, customer.image, customer.tel, appointment.date, appointment.payment_status
      ) ledger
      ORDER BY FIELD(status, 'Atrasado', 'Em Aberto', 'Pago'), due_date DESC, id DESC`, [companyId, companyId]);
    return rows.map(row => ({ ...row, value: Number(row.value), total_paid: Number(row.total_paid),
      remaining: Math.max(0, Math.round((Number(row.value) - Number(row.total_paid)) * 100) / 100) }));
  }
};
