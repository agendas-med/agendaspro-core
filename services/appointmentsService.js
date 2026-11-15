const functions = require('../utils/functions');
const { transition } = require('../utils/appointmentState');
const addressFields = ['zip_code', 'address', 'number', 'complement', 'city', 'state'];

async function validateItems(query, companyId, customerId, services, address) {
  const customers = await query('SELECT id FROM customers WHERE id = ? AND company_id = ?', [customerId, companyId]);
  if (!customers.length) throw new Error('Cliente não encontrado nesta empresa.');
  if (!services?.length) throw new Error('Selecione pelo menos um serviço.');
  const ids = services.map(service => Number(service.id));
  const rows = await query('SELECT * FROM services WHERE company_id = ? AND id IN (?)', [companyId, ids]);
  if (rows.length !== ids.length) throw new Error('Serviço inválido ou de outra empresa.');
  return services.map(service => {
    const row = rows.find(item => item.id === Number(service.id));
    const quantity = row.accepts_quantity ? Number(service.quantity || 1) : 1;
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error('Quantidade inválida.');
    if (row.requires_location && (!address.address || !address.number || !address.city || !address.state)) {
      throw new Error('Preencha o endereço completo do atendimento em domicílio.');
    }
    return { id: row.id, quantity };
  });
}
async function saveServices(query, id, services) {
  await query('DELETE FROM appointment_services WHERE appointment_id = ?', [id]);
  if (services.length) await query('INSERT INTO appointment_services (service_id, appointment_id, quantity) VALUES ?', [services.map(service => [service.id, id, service.quantity || 1])]);
}
function parseRangeDate(value) {
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(text) || Number.isNaN(Date.parse(text.slice(0, 10)))) {
    const error = new Error('Intervalo de datas inválido (use YYYY-MM-DD).');
    error.status = 400;
    throw error;
  }
  return text.replace('T', ' ');
}
async function ensureSlot(query, companyId, date, duration, excludedId = 0) {
  // Serializa reservas concorrentes da mesma empresa.
  const companies = await query('SELECT id FROM companies WHERE id = ? FOR UPDATE', [companyId]);
  if (!companies.length) throw new Error('Empresa não encontrada.');
  const conflicts = await query(`SELECT id FROM appointments WHERE company_id = ? AND canceled = 0 AND id <> ?
    AND date < DATE_ADD(?, INTERVAL ? MINUTE) AND DATE_ADD(date, INTERVAL duration MINUTE) > ?`,
  [companyId, excludedId, date, duration, date]);
  if (conflicts.length) throw new Error('Já existe um agendamento neste intervalo.');
}
const appointmentsService = {
  async create(companyId, customerId, customerName, date, duration, observations, services, status, address = {}) {
    return functions.executeTransaction(async query => {
      await query('SELECT id FROM companies WHERE id = ? FOR UPDATE', [companyId]);
      const items = await validateItems(query, companyId, customerId, services, address || {});
      const state = transition({}, status);
      if (!state.canceled) await ensureSlot(query, companyId, date, duration);
      const values = [companyId, customerId, customerName, date, duration, observations || '', state.checkin, state.checkout, state.canceled, state.payment_status, ...addressFields.map(field => address?.[field] || null)];
      const result = await query(`INSERT INTO appointments
        (company_id, customer_id, customer_name, date, duration, observations, checkin, checkout, canceled, payment_status, zip_code, address, number, complement, city, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, values);
      await saveServices(query, result.insertId, items);
      await query('INSERT INTO sales (company_id, customer_id, appointment_id, status) VALUES (?, ?, ?, ?)',
        [companyId, customerId, result.insertId, state.canceled ? 'cancelada' : 'em_aberto']);
      return result.insertId;
    });
  },
  async update(id, companyId, customerId, customerName, date, duration, observations, services, status, address) {
    return functions.executeTransaction(async query => {
      await query('SELECT id FROM companies WHERE id = ? FOR UPDATE', [companyId]);
      const [current] = await query('SELECT * FROM appointments WHERE id = ? AND company_id = ? FOR UPDATE', [id, companyId]);
      if (!current) throw new Error('Agendamento não encontrado.');
      const finalAddress = Object.fromEntries(addressFields.map(field => [field, address?.[field] === undefined ? current[field] : address[field]]));
      const items = await validateItems(query, companyId, customerId, services, finalAddress);
      const state = transition(current, status);
      if (!state.canceled) await ensureSlot(query, companyId, date, duration, id);
      const [paid] = await query('SELECT COUNT(p.id) AS total FROM payments p JOIN sales s ON s.id = p.sale_id WHERE s.appointment_id = ?', [id]);
      const [charged] = await query('SELECT COUNT(*) AS total FROM sales WHERE appointment_id = ? AND pix_asaas_id IS NOT NULL', [id]);
      if (paid.total || charged.total) {
        const previous = await query('SELECT service_id AS id, quantity FROM appointment_services WHERE appointment_id = ? ORDER BY service_id', [id]);
        const sorted = [...items].sort((a, b) => a.id - b.id);
        if (Number(customerId) !== current.customer_id || JSON.stringify(previous) !== JSON.stringify(sorted)) {
          throw new Error('Não altere cliente ou serviços de um agendamento com pagamento ou cobrança vinculada.');
        }
      }
      await query(`UPDATE appointments SET customer_id = ?, customer_name = ?, date = ?, duration = ?, observations = ?,
        checkin = ?, checkout = ?, canceled = ?, payment_status = ?, zip_code = ?, address = ?, number = ?, complement = ?, city = ?, state = ?
        WHERE id = ? AND company_id = ?`,
      [customerId, customerName, date, duration, observations || '', state.checkin, state.checkout, state.canceled, state.payment_status, ...addressFields.map(field => finalAddress[field] || null), id, companyId]);
      await saveServices(query, id, items);
      await query('UPDATE sales SET customer_id = ? WHERE appointment_id = ? AND company_id = ?', [customerId, id, companyId]);
      await require('./salesService').setAppointmentCancellation(query, companyId, id, state.canceled);
    });
  },
  async delete(id, companyId) {
    return functions.executeTransaction(async query => {
      const [current] = await query('SELECT id FROM appointments WHERE id = ? AND company_id = ? FOR UPDATE', [id, companyId]);
      if (!current) throw new Error('Agendamento não encontrado.');
      const [paid] = await query('SELECT COUNT(p.id) AS total FROM payments p JOIN sales s ON s.id = p.sale_id WHERE s.appointment_id = ?', [id]);
      if (paid.total) throw new Error('Agendamento com pagamentos não pode ser excluído. Cancele o atendimento.');
      const [charged] = await query('SELECT COUNT(*) AS total FROM sales WHERE appointment_id = ? AND pix_asaas_id IS NOT NULL', [id]);
      if (charged.total) throw new Error('Cancele a cobrança antes de excluir o agendamento.');
      await require('./salesService').setAppointmentCancellation(query, companyId, id, true);
      await query('DELETE FROM appointment_services WHERE appointment_id = ?', [id]);
      await query('DELETE FROM appointments WHERE id = ? AND company_id = ?', [id, companyId]);
    });
  },
  async insertAppointmentServices(id, services) { return functions.executeTransaction(query => saveServices(query, id, services)); },
  async deleteAppointmentServices(id) { return functions.executeSql('DELETE FROM appointment_services WHERE appointment_id = ?', [id]); },
  async getAppointmentServices(id) {
    return functions.executeSql('SELECT s.*, aps.quantity FROM appointment_services aps JOIN services s ON s.id = aps.service_id WHERE aps.appointment_id = ?', [id]);
  },
  async decorate(appointment) {
    const services = await this.getAppointmentServices(appointment.id);
    const start = appointment.date;
    const end = new Date(new Date(start).getTime() + appointment.duration * 60000).toISOString();
    return { ...appointment, services, start, end, title: `${services[0]?.name || ''} - ${appointment.first_name}` };
  },
  async getById(id, companyId) {
    const [appointment] = await functions.executeSql(`SELECT c.image, a.*, SUBSTRING_INDEX(a.customer_name, ' ', 1) AS first_name
      FROM appointment_status_view a JOIN customers c ON c.id = a.customer_id WHERE a.id = ? AND a.company_id = ?`, [id, companyId]);
    if (!appointment) throw new Error('Agendamento não encontrado.');
    return this.decorate(appointment);
  },
  async getAllByCompany(companyId, clearCache = false, targetDate = null, range = {}) {
    let sql = `SELECT c.image, a.*, SUBSTRING_INDEX(a.customer_name, ' ', 1) AS first_name
      FROM appointment_status_view a JOIN customers c ON c.id = a.customer_id WHERE a.company_id = ?`;
    const params = [companyId];
    if (targetDate === true || targetDate === 'true') sql += ' AND DATE(a.date) = CURDATE()';
    else if (targetDate && targetDate !== 'false') { sql += ' AND DATE(a.date) = ?'; params.push(targetDate); }
    // Intervalo ?start=&end= (datas YYYY-MM-DD inclusivas ou datetime); sempre dentro da empresa.
    if (range.start) { sql += ' AND a.date >= ?'; params.push(parseRangeDate(range.start)); }
    if (range.end) { const end = parseRangeDate(range.end); sql += end.length === 10 ? ' AND a.date < DATE_ADD(?, INTERVAL 1 DAY)' : ' AND a.date <= ?'; params.push(end); }
    sql += " ORDER BY FIELD(a.status, 'iniciado', 'pendente_pagamento', 'agendado', 'realizado', 'cancelado'), a.date";
    const appointments = await functions.executeSql(sql, params);
    return Promise.all(appointments.map(appointment => this.decorate(appointment)));
  },
  async changeState(companyId, id, status) {
    return functions.executeTransaction(async query => {
      const [appointment] = await query('SELECT * FROM appointments WHERE company_id = ? AND id = ? FOR UPDATE', [companyId, id]);
      if (!appointment) throw new Error('Agendamento não encontrado.');
      if (appointment.canceled && status !== 'cancelado') throw new Error('Este agendamento está cancelado.');
      if (status === 'realizado' && !appointment.checkin) throw new Error('Inicie o atendimento antes de concluí-lo.');
      if (status === 'iniciado' && appointment.checkout) throw new Error('Este atendimento já foi concluído.');
      const state = transition(appointment, status);
      if (status === 'cancelado') { state.checkin = appointment.checkin; state.checkout = appointment.checkout; }
      await query('UPDATE appointments SET checkin = ?, checkout = ?, canceled = ?, payment_status = ? WHERE id = ? AND company_id = ?', [state.checkin, state.checkout, state.canceled, state.payment_status, id, companyId]);
      if (status === 'cancelado') await require('./salesService').setAppointmentCancellation(query, companyId, id, true);
    });
  },
  init(companyId, id) { return this.changeState(companyId, id, 'iniciado'); },
  stop(companyId, id) { return this.changeState(companyId, id, 'realizado'); },
  cancel(companyId, id) { return this.changeState(companyId, id, 'cancelado'); },
};
// Exportado para o bot reutilizar a mesma checagem de conflito dentro da transação.
appointmentsService.ensureSlot = ensureSlot;
module.exports = appointmentsService;
