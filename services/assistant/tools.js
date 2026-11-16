const Joi = require('joi');
const functions = require('../../utils/functions');
const { wallClock, wallMinutes, minutesToWall, resolveTimezone } = require('../../utils/time');
const { daySlots, dateRange } = require('../../utils/slots');
const appointmentsService = require('../appointmentsService');
const companiesService = require('../companiesService');
const customersService = require('../customersService');
const stockService = require('../stockService');
const financialService = require('../financialService');
const professionalsService = require('../professionalsService');
const schemas = {
  appointments: require('../../schemas/appointments'),
  services: require('../../schemas/services'),
  products: require('../../schemas/products'),
  customers: require('../../schemas/customers'),
};
const { config } = require('./config');

// Allowlist FECHADA de ferramentas do assistente. Cada uma tem schema Joi próprio; a IA só escolhe
// o nome e argumentos, nunca company_id/user_id (vêm do contexto autenticado).
// - read: executa direto, com saída projetada (sem colunas sensíveis) e limite de linhas;
// - write: prepare() monta um payload imutável (dados resolvidos do banco, nunca do modelo) que vira
//   proposta; execute() só roda após confirmação humana, chamando a MESMA camada de serviço das rotas.
// Exclusões, estornos, anonimização e ações em massa ficam fora da allowlist.

class ToolError extends Error {
  constructor(message, status = 400, code = 'assistant_tool_error') { super(message); this.status = status; this.code = code; }
}

const id = Joi.number().integer().positive();
const day = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
const wall = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/);
const shortText = max => Joi.string().trim().max(max).allow('');
const OPTS = { abortEarly: true, stripUnknown: true, convert: true };

const today = () => wallClock(new Date()).slice(0, 10);
const addDays = (date, n) => minutesToWall(wallMinutes(`${date} 00:00`) + n * 1440).slice(0, 10);
const normWall = value => minutesToWall(wallMinutes(String(value).replace('T', ' ').slice(0, 16)));
const money = v => Math.round((Number(v) || 0) * 100) / 100;
const clip = (text, max = 160) => (text === null || text === undefined ? null : String(text).replace(/\s+/g, ' ').trim().slice(0, max));
const maskPhone = tel => (tel ? `***${String(tel).replace(/\D/g, '').slice(-4)}` : null);

// Mensagem de erro de serviço segura para o usuário (strings/Error de negócio); nada interno vaza.
function safeServiceError(error) {
  if (error instanceof ToolError) return error.message;
  const raw = typeof error === 'string' ? error : (error && !error.sql && !error.sqlMessage && !error.errno ? error.message : null);
  if (!raw || /ER_|SQL|sql|stack|at\s+\S+\s+\(/.test(raw) || raw.length > 200) return 'Não foi possível concluir a operação.';
  return raw;
}

function periodRange(args) {
  const base = today();
  if (args.date_from || args.date_to) {
    const from = args.date_from || args.date_to;
    const to = args.date_to || from;
    if (to < from) throw new ToolError('Período inválido.');
    return { from, to };
  }
  switch (args.period) {
    case 'tomorrow': { const d = addDays(base, 1); return { from: d, to: d }; }
    case 'week': return { from: base, to: addDays(base, 6) };
    case 'month': return { from: `${base.slice(0, 7)}-01`, to: lastDayOfMonth(base) };
    case 'last_month': {
      const [y, m] = base.split('-').map(Number);
      const prev = m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
      return { from: prev, to: lastDayOfMonth(prev) };
    }
    default: return { from: base, to: base };
  }
}
function lastDayOfMonth(date) {
  const [y, m] = date.split('-').map(Number);
  return `${y}-${String(m).padStart(2, '0')}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}
const periodSchema = { period: Joi.string().valid('today', 'tomorrow', 'week', 'month', 'last_month'), date_from: day, date_to: day };
const spanDays = ({ from, to }) => Math.round((wallMinutes(`${to} 00:00`) - wallMinutes(`${from} 00:00`)) / 1440) + 1;

async function ensureCustomer(companyId, customerId) {
  const [row] = await functions.executeSql('SELECT id, name FROM customers WHERE id = ? AND company_id = ? AND anonymized_at IS NULL', [customerId, companyId]);
  if (!row) throw new ToolError('Cliente não encontrado nesta empresa.', 404);
  return row;
}
async function servicesByIds(companyId, ids) {
  const unique = [...new Set(ids.map(Number))];
  const rows = unique.length ? await functions.executeSql('SELECT id, name, value, cost, duration, requires_location FROM services WHERE company_id = ? AND id IN (?)', [companyId, unique]) : [];
  if (rows.length !== unique.length) throw new ToolError('Serviço inválido ou de outra empresa.', 404);
  return unique.map(sid => rows.find(r => r.id === sid));
}
async function ensureProduct(companyId, productId) {
  const [row] = await functions.executeSql('SELECT id, name, value, cost, description, unit_of_measure, current_stock FROM products WHERE id = ? AND company_id = ?', [productId, companyId]);
  if (!row) throw new ToolError('Insumo não encontrado nesta empresa.', 404);
  return row;
}
async function ensureService(companyId, serviceId) {
  const [row] = await functions.executeSql('SELECT id, name, value, cost, observations, duration, requires_location, accepts_quantity, measurement_unit FROM services WHERE id = ? AND company_id = ?', [serviceId, companyId]);
  if (!row) throw new ToolError('Serviço não encontrado nesta empresa.', 404);
  return row;
}
async function ensureProfessional(companyId, professionalId) {
  if (!professionalId) return null;
  const [row] = await functions.executeSql('SELECT id, name FROM professionals WHERE id = ? AND company_id = ? AND active = 1', [professionalId, companyId]);
  if (!row) throw new ToolError('Profissional não encontrado nesta empresa.', 404);
  return row;
}
// Revalida o payload final com o MESMO schema Joi da rota correspondente.
function routeValidate(schema, payload) {
  const { error, value } = schema.validate(payload, { abortEarly: true, stripUnknown: true });
  if (error) throw new ToolError(error.details?.[0]?.message || 'Dados inválidos.');
  return value;
}
const UNITS = { unidade: 1, pessoa: 2, peca: 3, hora: 4, sessao: 5, m2: 6, km: 7 };

// ---------- leitura ----------

const projectAppointment = a => ({
  id: a.id, start: a.start, end: a.end, customer_id: a.customer_id, customer_name: clip(a.customer_name, 80),
  status: a.status, professional_id: a.professional_id || null,
  services: (a.services || []).map(s => clip(s.name, 80)), observations: clip(a.observations, 160),
});

const READ = {
  get_schedule: {
    description: 'Agenda (agendamentos) por período e/ou profissional.',
    schema: Joi.object({ ...periodSchema, professional_id: id }),
    limit: 50,
    async run(ctx, args) {
      const range = periodRange(args);
      if (spanDays(range) > 31) throw new ToolError('Consulte no máximo 31 dias por vez.');
      const rows = await appointmentsService.getAllByCompany(ctx.companyId, false, null, { start: range.from, end: range.to, professionalId: args.professional_id || null });
      rows.sort((a, b) => String(a.start).localeCompare(String(b.start)));
      return { range, total: rows.length, items: rows.slice(0, this.limit).map(projectAppointment) };
    },
  },
  next_appointment: {
    description: 'Próximo(s) atendimento(s) a partir de agora.',
    schema: Joi.object({ professional_id: id }),
    limit: 3,
    async run(ctx, args) {
      const now = wallClock(new Date()).slice(0, 19);
      const params = [ctx.companyId, now];
      let sql = `SELECT a.id FROM appointment_status_view a WHERE a.company_id = ? AND a.canceled = 0 AND a.date >= ? AND a.status IN ('agendado','pendente_pagamento')`;
      if (args.professional_id) { sql += ' AND a.professional_id = ?'; params.push(args.professional_id); }
      const ids = await functions.executeSql(`${sql} ORDER BY a.date LIMIT ${this.limit}`, params);
      const items = [];
      for (const row of ids) items.push(projectAppointment(await appointmentsService.getById(row.id, ctx.companyId)));
      return { total: items.length, items };
    },
  },
  find_customers: {
    description: 'Busca clientes por nome ou código.',
    schema: Joi.object({ search: Joi.string().trim().min(2).max(80).required() }),
    limit: 20,
    async run(ctx, args) {
      const rows = await customersService.find(ctx.companyId, args.search.replace(/[%_*]/g, ''));
      return {
        total: rows.length,
        items: rows.filter(r => !r.anonymized_at).slice(0, this.limit).map(r => ({ id: r.id, name: clip(r.name, 80), phone_end: maskPhone(r.tel), has_email: !!r.email })),
      };
    },
  },
  list_services: {
    description: 'Serviços da empresa com preço e duração.',
    schema: Joi.object({ search: Joi.string().trim().max(80) }),
    limit: 100,
    async run(ctx, args) {
      let rows = await companiesService.returnCompanyServices(ctx.companyId, true);
      if (args.search) rows = rows.filter(r => String(r.name).toLowerCase().includes(args.search.toLowerCase()));
      return { total: rows.length, items: rows.slice(0, this.limit).map(r => ({ id: r.id, name: clip(r.name, 80), value: money(r.value), duration_min: Number(r.duration), observations: clip(r.observations, 160) })) };
    },
  },
  list_stock: {
    description: 'Estoque de insumos/produtos; only_low=true para itens com estoque baixo.',
    schema: Joi.object({ only_low: Joi.boolean(), search: Joi.string().trim().max(80) }),
    limit: 100,
    async run(ctx, args) {
      const threshold = config().lowStockThreshold;
      let rows = await companiesService.returnCompanyProducts(ctx.companyId, true);
      rows = rows.map(r => ({ id: r.id, name: clip(r.name, 80), quantity: Number(r.available_quantity) || 0, unit: clip(r.unit_of_measure_abbreviation, 10), low: (Number(r.available_quantity) || 0) <= threshold }));
      if (args.only_low) rows = rows.filter(r => r.low);
      if (args.search) rows = rows.filter(r => r.name.toLowerCase().includes(args.search.toLowerCase()));
      rows.sort((a, b) => a.quantity - b.quantity);
      return { threshold, total: rows.length, items: rows.slice(0, this.limit) };
    },
  },
  financial_summary: {
    description: 'Resumo financeiro (faturamento previsto, recebido, em aberto e atrasado) do período.',
    schema: Joi.object({ ...periodSchema }),
    async run(ctx, args) {
      const range = periodRange({ period: 'month', ...args });
      const rows = await financialService.returnFinancial(ctx.companyId, true);
      const inRange = rows.filter(r => { const d = String(r.due_date).slice(0, 10); return d >= range.from && d <= range.to; });
      const sum = status => money(inRange.filter(r => !status || r.status === status).reduce((n, r) => n + (Number(r.value) || 0), 0));
      return {
        range, appointments: inRange.length,
        total: sum(), received: sum('Pago'), open: sum('Em Aberto'), overdue: sum('Atrasado'),
      };
    },
  },
  appointments_report: {
    description: 'Relatório básico: quantidade de agendamentos por status no período.',
    schema: Joi.object({ ...periodSchema }),
    async run(ctx, args) {
      const range = periodRange({ period: 'month', ...args });
      const rows = await functions.executeSql(
        'SELECT status, COUNT(*) AS total FROM appointment_status_view WHERE company_id = ? AND date >= ? AND date < DATE_ADD(?, INTERVAL 1 DAY) GROUP BY status',
        [ctx.companyId, range.from, range.to],
      );
      const by = Object.fromEntries(rows.map(r => [r.status, Number(r.total)]));
      return { range, total: rows.reduce((n, r) => n + Number(r.total), 0), by_status: by };
    },
  },
  check_availability: {
    description: 'Horários livres para serviço(s) em até 7 dias, opcionalmente por profissional.',
    schema: Joi.object({ service_ids: Joi.array().items(id).min(1).max(5).required(), professional_id: id, ...periodSchema }),
    limit: 40,
    async run(ctx, args) {
      const range = periodRange(args);
      if (spanDays(range) > 7) throw new ToolError('Consulte no máximo 7 dias por vez.');
      const services = await servicesByIds(ctx.companyId, args.service_ids);
      const duration = services.reduce((n, s) => n + Number(s.duration), 0);
      const professional = await ensureProfessional(ctx.companyId, args.professional_id);
      const pros = professional ? [professional] : await professionalsService.list(ctx.companyId);
      const ids = pros.map(p => p.id);
      if (!ids.length) return { range, duration_min: duration, total: 0, days: [] };
      const [company] = await functions.executeSql('SELECT timezone FROM companies WHERE id = ?', [ctx.companyId]);
      const nowMin = wallMinutes(wallClock(new Date(), resolveTimezone(company?.timezone)).slice(0, 16));
      const rangeStart = `${range.from} 00:00:00`;
      const rangeEnd = minutesToWall(wallMinutes(`${range.to} 00:00`) + 1440);
      const [rules, busyRows, blockRows] = await Promise.all([
        functions.executeSql('SELECT professional_id, weekday, TIME_FORMAT(start_time, "%H:%i") AS start_time, TIME_FORMAT(end_time, "%H:%i") AS end_time FROM availability_rules WHERE company_id = ? AND professional_id IN (?)', [ctx.companyId, ids]),
        functions.executeSql(`SELECT professional_id, DATE_FORMAT(date, '%Y-%m-%d %H:%i:%s') AS wall, duration FROM appointments WHERE company_id = ? AND ${appointmentsService.OCCUPYING_SQL} AND date < ? AND DATE_ADD(date, INTERVAL duration MINUTE) > ?`, [ctx.companyId, rangeEnd, rangeStart]),
        functions.executeSql("SELECT professional_id, DATE_FORMAT(starts_at, '%Y-%m-%d %H:%i:%s') AS s, DATE_FORMAT(ends_at, '%Y-%m-%d %H:%i:%s') AS e FROM time_blocks WHERE company_id = ? AND starts_at < ? AND ends_at > ?", [ctx.companyId, rangeEnd, rangeStart]),
      ]);
      const busy = busyRows.map(r => ({ professional_id: r.professional_id, start: wallMinutes(r.wall), end: wallMinutes(r.wall) + Number(r.duration) }));
      const blocks = blockRows.map(r => ({ professional_id: r.professional_id, start: wallMinutes(r.s), end: wallMinutes(r.e) }));
      let left = this.limit;
      const days = [];
      for (const date of dateRange(range.from, range.to)) {
        const slots = daySlots({ date, professionals: ids, duration, step: 30, minStart: nowMin, rules, busy, blocks }).slice(0, Math.max(0, left));
        left -= slots.length;
        days.push({ date, slots });
      }
      return { range, duration_min: duration, total: this.limit - left, days };
    },
  },
  search_knowledge: {
    description: 'Busca em textos livres da clínica (FAQ, políticas, regras, descrições e observações).',
    schema: Joi.object({ query: Joi.string().trim().min(3).max(300).required() }),
    async run(ctx, args) {
      const items = await require('./rag').search(ctx.companyId, args.query);
      return { total: items.length, items };
    },
  },
};

// ---------- escrita (proposta -> confirmação -> execução) ----------

function appointmentPayload(base) {
  return routeValidate(schemas.appointments.create, base);
}
async function executeAppointment(ctx, p, appointmentId = null) {
  const args = [ctx.companyId, p.customer_id, p.customer_name, p.date, p.duration, p.observations, p.services, p.status, p, { professionalId: p.professional_id ?? null }];
  if (appointmentId) return appointmentsService.update(appointmentId, ...args);
  return appointmentsService.create(...args);
}

const WRITE = {
  create_appointment: {
    description: 'Cria um agendamento (cliente, serviço(s), data/hora e profissional opcional).',
    risk: 'medium', admin: false,
    schema: Joi.object({ customer_id: id.required(), service_ids: Joi.array().items(id).min(1).max(5).required(), date: wall.required(), professional_id: id, observations: shortText(500) }),
    params: Joi.object({ appointment: Joi.object().unknown(true).required() }),
    async prepare(ctx, args) {
      const customer = await ensureCustomer(ctx.companyId, args.customer_id);
      const services = await servicesByIds(ctx.companyId, args.service_ids);
      if (services.some(s => s.requires_location)) throw new ToolError('Serviços em domicílio precisam de endereço: crie pelo painel.');
      const professional = await ensureProfessional(ctx.companyId, args.professional_id);
      const appointment = appointmentPayload({
        customer_id: customer.id, customer_name: customer.name, date: normWall(args.date),
        duration: services.reduce((n, s) => n + Number(s.duration), 0), observations: args.observations || '',
        services: services.map(s => ({ id: s.id, name: s.name, value: money(s.value), cost: money(s.cost), duration: Number(s.duration), quantity: 1 })),
        status: 'agendado', professional_id: professional ? professional.id : null,
      });
      return {
        params: { appointment },
        summary: `Agendar ${clip(customer.name, 60)} em ${appointment.date.slice(0, 16)} (${services.map(s => clip(s.name, 40)).join(', ')})${professional ? ` com ${clip(professional.name, 40)}` : ''}`,
        preview: { customer: clip(customer.name, 80), date: appointment.date.slice(0, 16), duration_min: appointment.duration, services: services.map(s => clip(s.name, 80)), professional: professional ? clip(professional.name, 80) : null },
      };
    },
    async execute(ctx, params) {
      const p = appointmentPayload(params.appointment);
      const appointmentId = await executeAppointment(ctx, p);
      return { appointment_id: appointmentId || null };
    },
  },
  update_appointment: {
    description: 'Edita data/hora, serviço(s), profissional ou observação de um agendamento existente.',
    risk: 'medium', admin: false,
    schema: Joi.object({ appointment_id: id.required(), date: wall, service_ids: Joi.array().items(id).min(1).max(5), professional_id: id, observations: shortText(500) })
      .or('date', 'service_ids', 'professional_id', 'observations'),
    params: Joi.object({ appointment_id: id.required(), appointment: Joi.object().unknown(true).required() }),
    async prepare(ctx, args) {
      let current;
      try { current = await appointmentsService.getById(args.appointment_id, ctx.companyId); } catch { throw new ToolError('Agendamento não encontrado.', 404); }
      if (current.canceled) throw new ToolError('Este agendamento está cancelado.');
      const services = args.service_ids ? await servicesByIds(ctx.companyId, args.service_ids) : current.services;
      const professional = args.professional_id ? await ensureProfessional(ctx.companyId, args.professional_id) : null;
      const status = current.status === 'concluido' ? 'realizado' : current.status === 'em_andamento' ? 'iniciado' : current.status;
      const appointment = appointmentPayload({
        customer_id: current.customer_id, customer_name: current.customer_name,
        date: args.date ? normWall(args.date) : current.date,
        duration: args.service_ids ? services.reduce((n, s) => n + Number(s.duration), 0) : Number(current.duration),
        observations: args.observations !== undefined ? args.observations : (current.observations || ''),
        services: services.map(s => ({ id: s.id, name: s.name, value: money(s.value), cost: money(s.cost), duration: Number(s.duration), quantity: Number(s.quantity) || 1 })),
        status, professional_id: professional ? professional.id : (current.professional_id || null),
        zip_code: current.zip_code || '', address: current.address || '', number: current.number || '', complement: current.complement || '', city: current.city || '', state: current.state || '',
      });
      const changes = [];
      if (args.date) changes.push(`data ${current.date.slice(0, 16)} → ${appointment.date.slice(0, 16)}`);
      if (args.service_ids) changes.push(`serviços: ${services.map(s => clip(s.name, 40)).join(', ')}`);
      if (professional) changes.push(`profissional: ${clip(professional.name, 40)}`);
      if (args.observations !== undefined) changes.push('observação');
      return {
        params: { appointment_id: current.id, appointment },
        summary: `Alterar agendamento #${current.id} de ${clip(current.customer_name, 60)}: ${changes.join('; ')}`,
        preview: { appointment_id: current.id, customer: clip(current.customer_name, 80), from: current.date.slice(0, 16), date: appointment.date.slice(0, 16), duration_min: appointment.duration, services: services.map(s => clip(s.name, 80)) },
      };
    },
    async execute(ctx, params) {
      const p = appointmentPayload(params.appointment);
      await executeAppointment(ctx, p, params.appointment_id);
      return { appointment_id: params.appointment_id };
    },
  },
  cancel_appointment: {
    description: 'Cancela um agendamento (não exclui; mantém histórico).',
    risk: 'medium', admin: false,
    schema: Joi.object({ appointment_id: id.required() }),
    params: Joi.object({ appointment_id: id.required() }),
    async prepare(ctx, args) {
      let current;
      try { current = await appointmentsService.getById(args.appointment_id, ctx.companyId); } catch { throw new ToolError('Agendamento não encontrado.', 404); }
      if (current.canceled) throw new ToolError('Este agendamento já está cancelado.');
      return {
        params: { appointment_id: current.id },
        summary: `Cancelar agendamento #${current.id} de ${clip(current.customer_name, 60)} em ${String(current.date).slice(0, 16)}`,
        preview: { appointment_id: current.id, customer: clip(current.customer_name, 80), date: String(current.date).slice(0, 16) },
      };
    },
    async execute(ctx, params) {
      await appointmentsService.cancel(ctx.companyId, params.appointment_id);
      return { appointment_id: params.appointment_id, status: 'cancelado' };
    },
  },
  create_service: {
    description: 'Cria um serviço (nome, preço, duração, custo opcional).',
    risk: 'low', admin: true,
    schema: Joi.object({ name: Joi.string().trim().min(3).max(120).required(), value: Joi.number().min(0).max(1e6).required(), duration: Joi.number().integer().min(1).max(1440).required(), cost: Joi.number().min(0).max(1e6), observations: shortText(500) }),
    params: Joi.object({ service: Joi.object().unknown(true).required() }),
    async prepare(ctx, args) {
      const service = routeValidate(schemas.services.create, { name: args.name, value: money(args.value), cost: money(args.cost || 0), duration: args.duration, observations: args.observations || '', requires_location: false, accepts_quantity: false, measurement_unit_id: 1 });
      return { params: { service }, summary: `Criar serviço "${clip(service.name, 60)}" (R$ ${service.value.toFixed(2)}, ${service.duration} min)`, preview: { name: clip(service.name, 80), value: service.value, cost: service.cost, duration_min: service.duration } };
    },
    async execute(ctx, params) {
      const s = routeValidate(schemas.services.create, params.service);
      await companiesService.createService(ctx.companyId, s.name, s.value, s.cost, s.observations, s.duration, s.requires_location, s.accepts_quantity, s.measurement_unit_id);
      return { created: true };
    },
  },
  update_service: {
    description: 'Edita nome, preço, custo, duração ou observação de um serviço existente.',
    risk: 'low', admin: true,
    schema: Joi.object({ service_id: id.required(), name: Joi.string().trim().min(3).max(120), value: Joi.number().min(0).max(1e6), duration: Joi.number().integer().min(1).max(1440), cost: Joi.number().min(0).max(1e6), observations: shortText(500) })
      .or('name', 'value', 'duration', 'cost', 'observations'),
    params: Joi.object({ service_id: id.required(), service: Joi.object().unknown(true).required() }),
    async prepare(ctx, args) {
      const cur = await ensureService(ctx.companyId, args.service_id);
      const service = routeValidate(schemas.services.create, {
        name: args.name ?? cur.name, value: money(args.value ?? cur.value), cost: money(args.cost ?? cur.cost), duration: args.duration ?? Number(cur.duration),
        observations: args.observations ?? (cur.observations || ''), requires_location: !!cur.requires_location, accepts_quantity: !!cur.accepts_quantity, measurement_unit_id: UNITS[cur.measurement_unit] || 1,
      });
      return { params: { service_id: cur.id, service }, summary: `Alterar serviço "${clip(cur.name, 60)}": R$ ${service.value.toFixed(2)}, ${service.duration} min${service.name !== cur.name ? `, novo nome "${clip(service.name, 60)}"` : ''}`, preview: { service_id: cur.id, before: { name: clip(cur.name, 80), value: money(cur.value), duration_min: Number(cur.duration) }, after: { name: clip(service.name, 80), value: service.value, duration_min: service.duration } } };
    },
    async execute(ctx, params) {
      const s = routeValidate(schemas.services.create, params.service);
      await companiesService.editService(ctx.companyId, params.service_id, s.name, s.value, s.cost, s.observations, s.duration, s.requires_location, s.accepts_quantity, s.measurement_unit_id);
      return { service_id: params.service_id };
    },
  },
  create_product: {
    description: 'Cadastra um insumo/produto de estoque.',
    risk: 'low', admin: true,
    schema: Joi.object({ name: Joi.string().trim().min(3).max(100).required(), value: Joi.number().min(0).max(1e6), cost: Joi.number().min(0).max(1e6), description: shortText(300), unit_of_measure: Joi.number().integer().min(1).max(50) }),
    params: Joi.object({ product: Joi.object().unknown(true).required() }),
    async prepare(ctx, args) {
      const unit = args.unit_of_measure || 1;
      const [exists] = await functions.executeSql('SELECT id FROM units_of_measurement WHERE id = ?', [unit]);
      if (!exists) throw new ToolError('Unidade de medida inválida.');
      const product = routeValidate(schemas.products.create, { name: args.name, value: money(args.value || 0), cost: money(args.cost || 0), description: args.description || '', unit_of_measure: unit });
      return { params: { product }, summary: `Cadastrar insumo "${clip(product.name, 60)}"`, preview: { name: clip(product.name, 80), value: product.value, cost: product.cost } };
    },
    async execute(ctx, params) {
      const p = routeValidate(schemas.products.create, params.product);
      await companiesService.createProduct(ctx.companyId, p.name, p.value, p.cost, p.description, p.unit_of_measure);
      return { created: true };
    },
  },
  update_product: {
    description: 'Edita nome, preço, custo ou descrição de um insumo/produto.',
    risk: 'low', admin: true,
    schema: Joi.object({ product_id: id.required(), name: Joi.string().trim().min(3).max(100), value: Joi.number().min(0).max(1e6), cost: Joi.number().min(0).max(1e6), description: shortText(300) })
      .or('name', 'value', 'cost', 'description'),
    params: Joi.object({ product_id: id.required(), product: Joi.object().unknown(true).required() }),
    async prepare(ctx, args) {
      const cur = await ensureProduct(ctx.companyId, args.product_id);
      const product = routeValidate(schemas.products.create, { name: args.name ?? cur.name, value: money(args.value ?? cur.value), cost: money(args.cost ?? cur.cost), description: args.description ?? (cur.description || ''), unit_of_measure: cur.unit_of_measure });
      return { params: { product_id: cur.id, product }, summary: `Alterar insumo "${clip(cur.name, 60)}"`, preview: { product_id: cur.id, before: { name: clip(cur.name, 80), value: money(cur.value), cost: money(cur.cost) }, after: { name: clip(product.name, 80), value: product.value, cost: product.cost } } };
    },
    async execute(ctx, params) {
      const p = routeValidate(schemas.products.create, params.product);
      await companiesService.editProduct(ctx.companyId, params.product_id, p.name, p.value, p.cost, p.description, p.unit_of_measure);
      return { product_id: params.product_id };
    },
  },
  adjust_stock: {
    description: 'Entrada (add) ou saída (remove) de estoque de um insumo.',
    risk: 'low', admin: false,
    schema: Joi.object({ product_id: id.required(), operation: Joi.string().valid('add', 'remove').required(), quantity: Joi.number().integer().min(1).max(100000).required() }),
    params: Joi.object({ product_id: id.required(), operation: Joi.string().valid('add', 'remove').required(), quantity: Joi.number().integer().min(1).max(100000).required() }),
    async prepare(ctx, args) {
      const cur = await ensureProduct(ctx.companyId, args.product_id);
      if (args.operation === 'remove' && Number(cur.current_stock) < args.quantity) throw new ToolError('Estoque insuficiente.');
      const after = Number(cur.current_stock) + (args.operation === 'add' ? args.quantity : -args.quantity);
      return { params: { product_id: cur.id, operation: args.operation, quantity: args.quantity }, summary: `${args.operation === 'add' ? 'Entrada' : 'Saída'} de ${args.quantity} em "${clip(cur.name, 60)}" (${cur.current_stock} → ${after})`, preview: { product: clip(cur.name, 80), operation: args.operation, quantity: args.quantity, before: Number(cur.current_stock), after } };
    },
    async execute(ctx, params) {
      if (params.operation === 'add') await stockService.add(ctx.companyId, params.product_id, params.quantity);
      else await stockService.remove(ctx.companyId, params.product_id, params.quantity);
      return { product_id: params.product_id };
    },
  },
  create_customer: {
    description: 'Cadastra um cliente (nome e telefone; e-mail opcional).',
    risk: 'low', admin: true,
    schema: Joi.object({ name: Joi.string().trim().min(3).max(120).required(), tel: Joi.string().pattern(/^\d{10,11}$/).required(), email: Joi.string().email().max(160) }),
    params: Joi.object({ customer: Joi.object().unknown(true).required() }),
    async prepare(ctx, args) {
      const customer = routeValidate(schemas.customers.createCustomer, { name: args.name, tel: args.tel, email: args.email || null });
      return { params: { customer }, summary: `Cadastrar cliente "${clip(customer.name, 60)}" (tel. ${maskPhone(customer.tel)})`, preview: { name: clip(customer.name, 80), phone_end: maskPhone(customer.tel), email: customer.email ? 'informado' : null } };
    },
    async execute(ctx, params) {
      const c = routeValidate(schemas.customers.createCustomer, params.customer);
      // Sem imagem: nunca aciona upload ao S3 a partir do assistente.
      await customersService.create(ctx.companyId, c.name, null, null, c.tel, null, c.email || null);
      return { created: true };
    },
  },
  block_time: {
    description: 'Bloqueia um intervalo de horário (geral ou de um profissional).',
    risk: 'low', admin: true,
    schema: Joi.object({ starts_at: wall.required(), ends_at: wall.required(), professional_id: id, reason: Joi.string().trim().max(160).allow('') }),
    params: Joi.object({ starts_at: wall.required(), ends_at: wall.required(), professional_id: id.allow(null), reason: Joi.string().max(160).allow('', null) }),
    async prepare(ctx, args) {
      const starts = normWall(args.starts_at);
      const ends = normWall(args.ends_at);
      if (wallMinutes(ends) <= wallMinutes(starts)) throw new ToolError('O fim do bloqueio deve ser depois do início.');
      if (wallMinutes(ends) - wallMinutes(starts) > 31 * 1440) throw new ToolError('Bloqueie no máximo 31 dias por vez.');
      const professional = await ensureProfessional(ctx.companyId, args.professional_id);
      return { params: { starts_at: starts, ends_at: ends, professional_id: professional ? professional.id : null, reason: args.reason || null }, summary: `Bloquear ${starts.slice(0, 16)} até ${ends.slice(0, 16)}${professional ? ` para ${clip(professional.name, 40)}` : ' (agenda geral)'}`, preview: { starts_at: starts.slice(0, 16), ends_at: ends.slice(0, 16), professional: professional ? clip(professional.name, 80) : null, reason: clip(args.reason, 160) } };
    },
    async execute(ctx, params) {
      const block = await professionalsService.createBlock(ctx.companyId, params);
      return { block_id: block.id };
    },
  },
};

const ALL = { ...Object.fromEntries(Object.entries(READ).map(([k, v]) => [k, { ...v, kind: 'read' }])), ...Object.fromEntries(Object.entries(WRITE).map(([k, v]) => [k, { ...v, kind: 'write' }])) };
const NAMES = Object.keys(ALL);

function get(name) {
  return Object.prototype.hasOwnProperty.call(ALL, name) ? ALL[name] : null;
}
function validateArgs(tool, args) {
  const { error, value } = tool.schema.validate(args || {}, OPTS);
  if (error) throw new ToolError('Parâmetros inválidos para a ferramenta.');
  return value;
}
// Resumo curto das ferramentas para o classificador (nome, tipo, descrição, campos aceitos).
function summary() {
  return NAMES.map(name => {
    const t = ALL[name];
    const keys = Object.keys(t.schema.describe().keys || {});
    return `- ${name} [${t.kind}${t.admin ? ', admin' : ''}]: ${t.description} Campos: ${keys.join(', ') || 'nenhum'}.`;
  }).join('\n');
}

module.exports = { get, validateArgs, summary, safeServiceError, ToolError, NAMES, READ_NAMES: Object.keys(READ), WRITE_NAMES: Object.keys(WRITE), periodRange, _today: today };
