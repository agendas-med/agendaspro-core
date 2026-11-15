const functions = require('../utils/functions');
const { transition } = require('../utils/appointmentState');
const { dbWall, minutesToWall, wallMinutes } = require('../utils/time');
const addressFields = ['zip_code', 'address', 'number', 'complement', 'city', 'state'];
const WALL_FIELDS = ["date", 'checkin', 'checkout'].map(col => `DATE_FORMAT(a.${col}, '%Y-%m-%d %H:%i:%s') AS _wall_${col}`).join(', ');

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
// Datas do banco são "hora de parede" do fuso da empresa (APP_TIMEZONE, padrão America/Sao_Paulo).
// Aceita YYYY-MM-DD, YYYY-MM-DD[ T]HH:mm[:ss[.sss]] e ISO com offset (FullCalendar envia
// "2027-03-01T00:00:00-03:00": a hora de parede já é a da empresa e o offset é descartado).
// Sufixo Z (UTC) é convertido para o fuso da empresa.
const RANGE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
function wallClock(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.APP_TIMEZONE || 'America/Sao_Paulo', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
function parseRangeDate(value) {
  const match = RANGE_RE.exec(String(value));
  const invalid = () => Object.assign(new Error('Intervalo de datas inválido (use YYYY-MM-DD ou ISO 8601).'), { status: 400 });
  if (!match) throw invalid();
  const [, y, m, d, hh, mi, ss, zone] = match;
  const day = new Date(Date.UTC(+y, +m - 1, +d));
  if (day.getUTCFullYear() !== +y || day.getUTCMonth() !== +m - 1 || day.getUTCDate() !== +d) throw invalid();
  if (hh === undefined) return { value: `${y}-${m}-${d}`, dateOnly: true };
  if (+hh > 23 || +mi > 59 || +(ss || 0) > 59) throw invalid();
  if (zone === 'Z') return { value: wallClock(new Date(String(value))), dateOnly: false };
  return { value: `${y}-${m}-${d} ${hh}:${mi}:${ss || '00'}`, dateOnly: false };
}
// Profissional precisa ser da empresa e estar ativo (checado dentro da transação).
async function assertProfessional(query, companyId, professionalId) {
  if (professionalId === null || professionalId === undefined) return null;
  const id = Number(professionalId);
  const [row] = Number.isSafeInteger(id) && id > 0
    ? await query('SELECT id FROM professionals WHERE id = ? AND company_id = ? AND active = 1', [id, companyId])
    : [];
  if (!row) throw Object.assign(new Error('Profissional inválido ou inativo nesta empresa.'), { status: 400 });
  return id;
}

// Conflito de horário. Sem profissional = regra legada (empresa inteira). Com profissional:
// conflita com agendamentos do mesmo profissional e com os sem profissional; respeita bloqueios
// (da empresa e do profissional) e o expediente do profissional, se ele tiver regras cadastradas.
// Agendamento que ocupa horário: não cancelado e, se for reserva com sinal, ainda dentro do prazo
// (reserva vencida sem pagamento libera o horário na leitura, sem cron).
const OCCUPYING_SQL = 'canceled = 0 AND (hold_expires_at IS NULL OR hold_expires_at > NOW())';
const slotTaken = message => Object.assign(new Error(message), { code: 'slot_taken' });

// requireRules: a página pública só oferece horário dentro do expediente cadastrado (fail closed).
async function ensureSlot(query, companyId, date, duration, excludedId = 0, { professionalId = null, verified = false, requireRules = false } = {}) {
  // Serializa reservas concorrentes da mesma empresa.
  const companies = await query('SELECT id FROM companies WHERE id = ? FOR UPDATE', [companyId]);
  if (!companies.length) throw new Error('Empresa não encontrada.');
  const professional = verified ? (professionalId || null) : await assertProfessional(query, companyId, professionalId);
  const scope = professional ? ' AND (professional_id = ? OR professional_id IS NULL)' : '';
  const conflicts = await query(`SELECT id FROM appointments WHERE company_id = ? AND ${OCCUPYING_SQL} AND id <> ?${scope}
    AND date < DATE_ADD(?, INTERVAL ? MINUTE) AND DATE_ADD(date, INTERVAL duration MINUTE) > ?`,
  professional ? [companyId, excludedId, professional, date, duration, date] : [companyId, excludedId, date, duration, date]);
  if (conflicts.length) throw slotTaken('Já existe um agendamento neste intervalo.');

  const blocks = await query(`SELECT id FROM time_blocks WHERE company_id = ? AND (professional_id IS NULL${professional ? ' OR professional_id = ?' : ''})
    AND starts_at < DATE_ADD(?, INTERVAL ? MINUTE) AND ends_at > ?`,
  professional ? [companyId, professional, date, duration, date] : [companyId, date, duration, date]);
  if (blocks.length) throw slotTaken('Horário bloqueado (folga ou feriado).');

  if (requireRules && !professional) throw slotTaken('Fora do horário de atendimento do profissional.');
  if (professional) {
    const rules = await query('SELECT weekday, TIME_FORMAT(start_time, "%H:%i") AS start_time, TIME_FORMAT(end_time, "%H:%i") AS end_time FROM availability_rules WHERE company_id = ? AND professional_id = ?', [companyId, professional]);
    if (!rules.length && requireRules) throw slotTaken('Fora do horário de atendimento do profissional.');
    if (rules.length) {
      const { wallWeekday, timeToMinutes } = require('../utils/time');
      const wall = parseRangeDate(date);
      if (wall.dateOnly) throw Object.assign(new Error('Informe data e hora do agendamento.'), { status: 400 });
      const weekday = wallWeekday(wall.value);
      const startOfDay = timeToMinutes(wall.value.slice(11, 16));
      const end = startOfDay + Number(duration);
      const fits = rules.some(rule => rule.weekday === weekday && timeToMinutes(rule.start_time) <= startOfDay && end <= timeToMinutes(rule.end_time));
      if (!fits) throw slotTaken('Fora do horário de atendimento do profissional.');
    }
  }
}
const appointmentsService = {
  async create(companyId, customerId, customerName, date, duration, observations, services, status, address = {}, { professionalId = null } = {}) {
    return functions.executeTransaction(async query => {
      await query('SELECT id FROM companies WHERE id = ? FOR UPDATE', [companyId]);
      const items = await validateItems(query, companyId, customerId, services, address || {});
      const state = transition({}, status);
      const professional = await assertProfessional(query, companyId, professionalId);
      if (!state.canceled) await ensureSlot(query, companyId, date, duration, 0, { professionalId: professional, verified: true });
      const values = [companyId, customerId, customerName, date, duration, observations || '', state.checkin, state.checkout, state.canceled, state.payment_status, ...addressFields.map(field => address?.[field] || null), professional];
      const result = await query(`INSERT INTO appointments
        (company_id, customer_id, customer_name, date, duration, observations, checkin, checkout, canceled, payment_status, zip_code, address, number, complement, city, state, professional_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, values);
      await saveServices(query, result.insertId, items);
      await query('INSERT INTO sales (company_id, customer_id, appointment_id, status) VALUES (?, ?, ?, ?)',
        [companyId, customerId, result.insertId, state.canceled ? 'cancelada' : 'em_aberto']);
      return result.insertId;
    });
  },
  async update(id, companyId, customerId, customerName, date, duration, observations, services, status, address, { professionalId } = {}) {
    return functions.executeTransaction(async query => {
      await query('SELECT id FROM companies WHERE id = ? FOR UPDATE', [companyId]);
      const [current] = await query('SELECT * FROM appointments WHERE id = ? AND company_id = ? FOR UPDATE', [id, companyId]);
      if (!current) throw new Error('Agendamento não encontrado.');
      const finalAddress = Object.fromEntries(addressFields.map(field => [field, address?.[field] === undefined ? current[field] : address[field]]));
      const items = await validateItems(query, companyId, customerId, services, finalAddress);
      const state = transition(current, status);
      // Ausente = mantém o profissional atual (null explícito remove).
      const professional = professionalId === undefined
        ? current.professional_id
        : await assertProfessional(query, companyId, professionalId);
      if (!state.canceled) await ensureSlot(query, companyId, date, duration, id, { professionalId: professional, verified: true });
      const [paid] = await query('SELECT COUNT(p.id) AS total FROM payments p JOIN sales s ON s.id = p.sale_id WHERE s.appointment_id = ?', [id]);
      const [charged] = await query('SELECT COUNT(*) AS total FROM sales WHERE appointment_id = ? AND pix_asaas_id IS NOT NULL', [id]);
      if (paid.total || charged.total) {
        const previous = await query('SELECT service_id AS id, quantity FROM appointment_services WHERE appointment_id = ? ORDER BY service_id', [id]);
        const sorted = [...items].sort((a, b) => a.id - b.id);
        if (Number(customerId) !== current.customer_id || JSON.stringify(previous) !== JSON.stringify(sorted)) {
          throw new Error('Não altere cliente ou serviços de um agendamento com pagamento ou cobrança vinculada.');
        }
      }
      // Lembretes voltam a valer se a data mudou (resets antes de `date =`: MariaDB avalia em ordem).
      await query(`UPDATE appointments SET notified_1h = IF(date <> ?, 0, notified_1h), notified_2h = IF(date <> ?, 0, notified_2h),
        customer_id = ?, customer_name = ?, date = ?, duration = ?, observations = ?,
        checkin = ?, checkout = ?, canceled = ?, payment_status = ?, zip_code = ?, address = ?, number = ?, complement = ?, city = ?, state = ?, professional_id = ?
        WHERE id = ? AND company_id = ?`,
      [date, date, customerId, customerName, date, duration, observations || '', state.checkin, state.checkout, state.canceled, state.payment_status, ...addressFields.map(field => finalAddress[field] || null), professional, id, companyId]);
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
  // F4: date/start/end/checkin/checkout saem como hora de parede "YYYY-MM-DD HH:mm:ss" (sem offset),
  // formatadas no SQL (DATE_FORMAT não depende do timezone do pool). Antes: Date + ISO com Z.
  async decorate(appointment) {
    const services = await this.getAppointmentServices(appointment.id);
    const { _wall_date, _wall_checkin, _wall_checkout, ...row } = appointment;
    const start = _wall_date || (row.date ? dbWall(row.date) : null);
    const end = start ? minutesToWall(wallMinutes(start) + Number(row.duration || 0)) : null;
    return {
      ...row, date: start, checkin: _wall_checkin ?? null, checkout: _wall_checkout ?? null,
      services, start, end, title: `${services[0]?.name || ''} - ${row.first_name}`,
    };
  },
  async getById(id, companyId) {
    const [appointment] = await functions.executeSql(`SELECT c.image, a.*, ${WALL_FIELDS}, SUBSTRING_INDEX(a.customer_name, ' ', 1) AS first_name
      FROM appointment_status_view a JOIN customers c ON c.id = a.customer_id WHERE a.id = ? AND a.company_id = ?`, [id, companyId]);
    if (!appointment) throw new Error('Agendamento não encontrado.');
    return this.decorate(appointment);
  },
  async getAllByCompany(companyId, clearCache = false, targetDate = null, range = {}) {
    let sql = `SELECT c.image, a.*, ${WALL_FIELDS}, SUBSTRING_INDEX(a.customer_name, ' ', 1) AS first_name
      FROM appointment_status_view a JOIN customers c ON c.id = a.customer_id WHERE a.company_id = ?`;
    const params = [companyId];
    // ?professional_id=N: só os agendamentos do profissional; include_unassigned=true soma os sem profissional.
    if (range.professionalId) {
      sql += range.includeUnassigned ? ' AND (a.professional_id = ? OR a.professional_id IS NULL)' : ' AND a.professional_id = ?';
      params.push(range.professionalId);
    }
    if (targetDate === true || targetDate === 'true') sql += ' AND DATE(a.date) = CURDATE()';
    else if (targetDate && targetDate !== 'false') { sql += ' AND DATE(a.date) = ?'; params.push(targetDate); }
    // Intervalo ?start=&end=, sempre dentro da empresa. Data pura: end inclusivo (dia inteiro).
    // Data e hora: end exclusivo, como o endStr do FullCalendar.
    if (range.start) { sql += ' AND a.date >= ?'; params.push(parseRangeDate(range.start).value); }
    if (range.end) { const end = parseRangeDate(range.end); sql += end.dateOnly ? ' AND a.date < DATE_ADD(?, INTERVAL 1 DAY)' : ' AND a.date < ?'; params.push(end.value); }
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
appointmentsService.saveServices = saveServices;
appointmentsService.OCCUPYING_SQL = OCCUPYING_SQL;
module.exports = appointmentsService;
