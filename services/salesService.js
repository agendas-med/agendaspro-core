const functions = require('../utils/functions');
const cents = value => Math.round(Number(value) * 100);

async function validateLinks(query, companyId, customerId, appointmentId, saleId = 0) {
  const customers = await query('SELECT id FROM customers WHERE id = ? AND company_id = ?', [customerId, companyId]);
  if (!customers.length) throw new Error('Cliente não encontrado nesta empresa.');
  if (appointmentId) {
    const appointments = await query('SELECT id FROM appointments WHERE id = ? AND company_id = ? AND customer_id = ? FOR UPDATE', [appointmentId, companyId, customerId]);
    if (!appointments.length) throw new Error('Agendamento inválido para esta empresa e cliente.');
    const linked = await query('SELECT id FROM sales WHERE appointment_id = ? AND id <> ? FOR UPDATE', [appointmentId, saleId]);
    if (linked.length) throw new Error('Este agendamento já possui uma venda.');
  }
}
async function replaceProducts(query, sale, products, status) {
  const previous = await query('SELECT * FROM sales_products WHERE sale_id = ?', [sale.id]);
  const ids = [...new Set([...previous.map(p => p.product_id), ...products.map(p => Number(p.id))])].sort((a, b) => a - b);
  if (new Set(products.map(p => Number(p.id))).size !== products.length) throw new Error('Produto duplicado.');
  const stock = ids.length ? await query('SELECT * FROM products WHERE company_id = ? AND id IN (?) ORDER BY id FOR UPDATE', [sale.company_id, ids]) : [];
  for (const product of products) {
    if (!stock.some(p => p.id === Number(product.id)) || !Number.isInteger(Number(product.quantity)) || Number(product.quantity) <= 0) throw new Error('Produto ou quantidade inválida.');
  }
  for (const id of ids) {
    const product = stock.find(p => p.id === id);
    if (!product) throw new Error('Produto de outra empresa.');
    const oldQuantity = sale.status === 'cancelada' ? 0 : Number(previous.find(p => p.product_id === id)?.quantity || 0);
    const newQuantity = status === 'cancelada' ? 0 : Number(products.find(p => Number(p.id) === id)?.quantity || 0);
    const delta = newQuantity - oldQuantity;
    if (product.current_stock < delta) throw new Error(`Estoque insuficiente para ${product.name}.`);
    if (delta) {
      await query('UPDATE products SET current_stock = current_stock - ? WHERE id = ?', [delta, id]);
      await query('INSERT INTO stock_movements (product_id, quantity, type) VALUES (?, ?, ?)', [id, Math.abs(delta), delta > 0 ? 'remove' : 'add']);
    }
  }
  await query('DELETE FROM sales_products WHERE sale_id = ?', [sale.id]);
  for (const product of products) {
    const old = previous.find(p => p.product_id === Number(product.id));
    const unitPrice = old?.unit_price ?? stock.find(p => p.id === Number(product.id)).value;
    await query('INSERT INTO sales_products (sale_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)', [sale.id, product.id, product.quantity, unitPrice]);
  }
}

const salesService = {
  async setAppointmentCancellation(query, companyId, appointmentId, canceled) {
    const linked = await query('SELECT * FROM sales WHERE company_id = ? AND appointment_id = ? FOR UPDATE', [companyId, appointmentId]);
    for (const sale of linked) {
      const [paid] = await query('SELECT COUNT(*) AS total FROM payments WHERE sale_id = ?', [sale.id]);
      if (paid.total || sale.pix_asaas_id || sale.mp_charge_id || sale.status === 'realizada') continue;
      const items = await query('SELECT product_id AS id, quantity FROM sales_products WHERE sale_id = ?', [sale.id]);
      const status = canceled ? 'cancelada' : 'em_aberto';
      await replaceProducts(query, sale, items, status);
      await query('UPDATE sales SET status = ? WHERE id = ?', [status, sale.id]);
    }
  },
  async lockSale(query, saleId, companyId) {
    const [sale] = await query('SELECT * FROM sales WHERE id = ? AND company_id = ? FOR UPDATE', [saleId, companyId]);
    if (!sale) throw new Error('Venda não encontrada nesta empresa.');
    return sale;
  },
  async totals(query, sale) {
    const [row] = await query(`SELECT
      COALESCE((SELECT SUM(quantity * unit_price) FROM sales_products WHERE sale_id = ?), 0) +
      COALESCE((SELECT SUM(aps.quantity * s.value) FROM appointment_services aps JOIN services s ON s.id = aps.service_id WHERE aps.appointment_id = ?), 0) AS total,
      COALESCE((SELECT SUM(amount) FROM payments WHERE sale_id = ?), 0) AS total_paid`, [sale.id, sale.appointment_id, sale.id]);
    return { total: Number(row.total), total_paid: Number(row.total_paid) };
  },
  async create(companyId, customerId, appointmentId, products = [], status = 'em_aberto') {
    if (status === 'realizada') throw new Error('Cadastre a venda e registre o pagamento antes de finalizar.');
    return functions.executeTransaction(async query => {
      await validateLinks(query, companyId, customerId, appointmentId);
      const result = await query('INSERT INTO sales (company_id, customer_id, appointment_id, status) VALUES (?, ?, ?, ?)', [companyId, customerId, appointmentId || null, status]);
      await replaceProducts(query, { id: result.insertId, company_id: companyId, status: 'cancelada' }, products, status);
      return result.insertId;
    });
  },
  async update(id, companyId, customerId, appointmentId, products = [], status) {
    return functions.executeTransaction(async query => {
      const sale = await this.lockSale(query, id, companyId);
      if (sale.status === 'realizada') throw new Error('A venda já foi concluída.');
      if (sale.pix_asaas_id || sale.mp_charge_id) throw new Error('Cancele ou aguarde o pagamento do Pix antes de alterar a venda.');
      await validateLinks(query, companyId, customerId, appointmentId, id);
      const [paid] = await query('SELECT COUNT(*) AS total FROM payments WHERE sale_id = ?', [id]);
      if (paid.total) {
        const old = await query('SELECT product_id AS id, quantity FROM sales_products WHERE sale_id = ? ORDER BY product_id', [id]);
        const incoming = products.map(p => ({ id: Number(p.id), quantity: Number(p.quantity) })).sort((a, b) => a.id - b.id);
        if (JSON.stringify(old) !== JSON.stringify(incoming) || Number(customerId) !== sale.customer_id || (Number(appointmentId) || null) !== sale.appointment_id || status === 'cancelada') {
          throw new Error('Não altere os itens ou cancele uma venda com pagamentos registrados.');
        }
      }
      await replaceProducts(query, sale, products, status);
      sale.appointment_id = appointmentId || null;
      const totals = await this.totals(query, sale);
      if (status === 'realizada' && cents(totals.total_paid) < cents(totals.total)) throw new Error('Existem valores em aberto nesta venda.');
      await query('UPDATE sales SET customer_id = ?, appointment_id = ?, status = ? WHERE id = ? AND company_id = ?', [customerId, appointmentId || null, status, id, companyId]);
    });
  },
  async delete(id, companyId) {
    return functions.executeTransaction(async query => {
      const sale = await this.lockSale(query, id, companyId);
      if (sale.appointment_id) throw new Error('Cancele o agendamento vinculado para manter o histórico da venda.');
      const [paid] = await query('SELECT COUNT(*) AS total FROM payments WHERE sale_id = ?', [id]);
      if (paid.total || sale.pix_asaas_id || sale.mp_charge_id) throw new Error('Venda com pagamento ou cobrança não pode ser excluída.');
      await replaceProducts(query, sale, [], 'cancelada');
      await query('DELETE FROM sales WHERE id = ? AND company_id = ?', [id, companyId]);
    });
  },
  async returnSaleProducts(id) {
    return functions.executeSql(`SELECT p.id, p.name, sp.unit_price AS value, p.description, p.cost, sp.quantity,
      p.current_stock + IF(s.status = 'cancelada', 0, sp.quantity) AS available_quantity
      FROM sales_products sp JOIN products p ON p.id = sp.product_id JOIN sales s ON s.id = sp.sale_id WHERE sp.sale_id = ?`, [id]);
  },
  async returnSaleServices(id) {
    return functions.executeSql(`SELECT s.*, aps.quantity FROM services s JOIN appointment_services aps ON aps.service_id = s.id
      JOIN sales sa ON sa.appointment_id = aps.appointment_id WHERE sa.id = ?`, [id]);
  },
  async returnPayments(id) { return functions.executeSql('SELECT * FROM payments WHERE sale_id = ? ORDER BY id', [id]); },
  async decorate(sale) {
    const [products, services, payments] = await Promise.all([this.returnSaleProducts(sale.id), this.returnSaleServices(sale.id), this.returnPayments(sale.id)]);
    const debts_list = [...products, ...services].map(item => ({ name: Number(item.quantity || 1) > 1 ? `${item.name} (x${item.quantity})` : item.name, value: Number(item.value) * Number(item.quantity || 1) }));
    const payments_summary = {};
    for (const payment of payments) payments_summary[payment.payment_type] = (payments_summary[payment.payment_type] || 0) + Number(payment.amount);
    return { ...sale, products, services, payments, debts_list, payments_summary,
      total: debts_list.reduce((sum, item) => sum + item.value, 0), total_paid: payments.reduce((sum, payment) => sum + Number(payment.amount), 0) };
  },
  async returnSale(id, companyId) {
    const [sale] = await functions.executeSql(`SELECT s.*, c.name AS customer_name, c.image AS customer_image
      FROM sales s JOIN customers c ON c.id = s.customer_id WHERE s.id = ? AND s.company_id = ?`, [id, companyId]);
    if (!sale) throw new Error('Venda não encontrada nesta empresa.');
    return this.decorate(sale);
  },
  async returnSales(companyId) {
    const sales = await functions.executeSql(`SELECT s.*, c.name AS customer_name, c.image AS customer_image
      FROM sales s JOIN customers c ON c.id = s.customer_id WHERE s.company_id = ? ORDER BY s.id DESC`, [companyId]);
    return Promise.all(sales.map(sale => this.decorate(sale)));
  },
};
module.exports = salesService;
