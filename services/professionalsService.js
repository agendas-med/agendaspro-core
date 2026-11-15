const functions = require('../utils/functions');
const plans = require('./plansService');
const { HttpError } = require('../middleware/errorHandler');
const { wallMinutes, minutesToWall, timeToMinutes } = require('../utils/time');

// Profissionais, expediente e bloqueios. Toda consulta é filtrada por company_id (da sessão).
const notFound = () => new HttpError(404, 'Profissional não encontrado.');

async function lockCompany(query, companyId) {
  const [company] = await query('SELECT id FROM companies WHERE id = ? FOR UPDATE', [companyId]);
  if (!company) throw new HttpError(404, 'Empresa não encontrada.');
}

async function getProfessional(query, companyId, id, { lock = false } = {}) {
  const [row] = await query(`SELECT * FROM professionals WHERE id = ? AND company_id = ?${lock ? ' FOR UPDATE' : ''}`, [id, companyId]);
  if (!row) throw notFound();
  return row;
}

async function assertUser(query, companyId, userId) {
  if (userId === null || userId === undefined) return;
  const [member] = await query('SELECT 1 AS ok FROM company_members WHERE company_id = ? AND user_id = ?', [companyId, userId]);
  if (!member) throw new HttpError(400, 'Usuário não pertence a esta empresa.');
}

async function setServices(query, companyId, professionalId, serviceIds) {
  if (serviceIds === undefined) return;
  const ids = [...new Set(serviceIds.map(Number))];
  if (ids.length) {
    const rows = await query('SELECT id FROM services WHERE company_id = ? AND id IN (?)', [companyId, ids]);
    if (rows.length !== ids.length) throw new HttpError(400, 'Serviço inválido ou de outra empresa.');
  }
  await query('DELETE FROM professional_services WHERE professional_id = ? AND company_id = ?', [professionalId, companyId]);
  if (ids.length) await query('INSERT INTO professional_services (professional_id, service_id, company_id) VALUES ?', [ids.map(id => [professionalId, id, companyId])]);
}

function present(row, services = []) {
  return { id: row.id, name: row.name, email: row.email, phone: row.phone, photo_url: row.photo_url, color: row.color, user_id: row.user_id, active: !!row.active, service_ids: services };
}

const FIELDS = ['name', 'email', 'phone', 'photo_url', 'color', 'user_id'];

const professionalsService = {
  async list(companyId, { includeInactive = false } = {}) {
    const rows = await functions.executeSql(`SELECT * FROM professionals WHERE company_id = ?${includeInactive ? '' : ' AND active = 1'} ORDER BY name, id`, [companyId]);
    const links = rows.length
      ? await functions.executeSql('SELECT professional_id, service_id FROM professional_services WHERE company_id = ? AND professional_id IN (?)', [companyId, rows.map(r => r.id)])
      : [];
    return rows.map(row => present(row, links.filter(l => l.professional_id === row.id).map(l => l.service_id)));
  },

  async get(companyId, id) {
    const row = await getProfessional(functions.executeSql.bind(functions), companyId, id);
    const links = await functions.executeSql('SELECT service_id FROM professional_services WHERE company_id = ? AND professional_id = ?', [companyId, id]);
    return present(row, links.map(l => l.service_id));
  },

  async create(companyId, data) {
    const id = await functions.executeTransaction(async query => {
      await lockCompany(query, companyId); // serializa a checagem de quota
      await plans.assertQuota(companyId, 'max_professionals', { query });
      await assertUser(query, companyId, data.user_id);
      const result = await query(
        `INSERT INTO professionals (company_id, ${FIELDS.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [companyId, ...FIELDS.map(field => data[field] ?? null)],
      );
      await setServices(query, companyId, result.insertId, data.service_ids);
      return result.insertId;
    });
    return this.get(companyId, id);
  },

  async update(companyId, id, data) {
    await functions.executeTransaction(async query => {
      await lockCompany(query, companyId);
      const current = await getProfessional(query, companyId, id, { lock: true });
      if (data.active === true && !current.active) await plans.assertQuota(companyId, 'max_professionals', { query });
      if (data.user_id !== undefined) await assertUser(query, companyId, data.user_id);
      const sets = [];
      const params = [];
      for (const field of [...FIELDS, 'active']) {
        if (data[field] === undefined) continue;
        sets.push(`${field} = ?`);
        params.push(field === 'active' ? (data.active ? 1 : 0) : data[field]);
      }
      if (sets.length) await query(`UPDATE professionals SET ${sets.join(', ')} WHERE id = ? AND company_id = ?`, [...params, id, companyId]);
      await setServices(query, companyId, id, data.service_ids);
    });
    return this.get(companyId, id);
  },

  // Desativa (não apaga): agendamentos antigos mantêm o vínculo.
  async deactivate(companyId, id) {
    const result = await functions.executeSql('UPDATE professionals SET active = 0 WHERE id = ? AND company_id = ?', [id, companyId]);
    if (!result.affectedRows) throw notFound();
  },

  // ---- Expediente semanal ----
  async listRules(companyId, { professional_id: professionalId } = {}) {
    const params = [companyId];
    let sql = `SELECT id, professional_id, weekday, TIME_FORMAT(start_time, '%H:%i') AS start_time, TIME_FORMAT(end_time, '%H:%i') AS end_time
      FROM availability_rules WHERE company_id = ?`;
    if (professionalId) { sql += ' AND professional_id = ?'; params.push(professionalId); }
    return functions.executeSql(`${sql} ORDER BY professional_id, weekday, start_time`, params);
  },

  async createRule(companyId, data) {
    checkRange(data.start_time, data.end_time);
    return functions.executeTransaction(async query => {
      await getProfessional(query, companyId, data.professional_id);
      await assertNoOverlap(query, companyId, data.professional_id, [data]);
      const result = await query('INSERT INTO availability_rules (company_id, professional_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?, ?)',
        [companyId, data.professional_id, data.weekday, data.start_time, data.end_time]);
      return { id: result.insertId, ...data };
    });
  },

  // Substitui o expediente inteiro de um profissional (tela "horários da semana").
  async replaceRules(companyId, professionalId, rules) {
    rules.forEach(rule => checkRange(rule.start_time, rule.end_time));
    checkSelfOverlap(rules);
    await functions.executeTransaction(async query => {
      await getProfessional(query, companyId, professionalId, { lock: true });
      await query('DELETE FROM availability_rules WHERE company_id = ? AND professional_id = ?', [companyId, professionalId]);
      if (rules.length) {
        await query('INSERT INTO availability_rules (company_id, professional_id, weekday, start_time, end_time) VALUES ?',
          [rules.map(rule => [companyId, professionalId, rule.weekday, rule.start_time, rule.end_time])]);
      }
    });
    return this.listRules(companyId, { professional_id: professionalId });
  },

  async deleteRule(companyId, id) {
    const result = await functions.executeSql('DELETE FROM availability_rules WHERE id = ? AND company_id = ?', [id, companyId]);
    if (!result.affectedRows) throw new HttpError(404, 'Regra não encontrada.');
  },

  // ---- Bloqueios / feriados ----
  // professional_id: bloqueios do profissional + bloqueios da empresa inteira (professional_id NULL);
  // include_company_blocks=false deixa só os do profissional. Horas de parede formatadas no SQL.
  async listBlocks(companyId, { from, to, professional_id: professionalId, include_company_blocks: includeCompany = true } = {}) {
    const params = [companyId];
    let sql = `SELECT id, professional_id, DATE_FORMAT(starts_at, '%Y-%m-%d %H:%i:%s') AS starts_at,
      DATE_FORMAT(ends_at, '%Y-%m-%d %H:%i:%s') AS ends_at, reason FROM time_blocks WHERE company_id = ?`;
    if (professionalId) {
      sql += includeCompany === false ? ' AND professional_id = ?' : ' AND (professional_id = ? OR professional_id IS NULL)';
      params.push(professionalId);
    }
    if (from) { sql += ' AND ends_at > ?'; params.push(normalizeWall(from)); }
    if (to) { sql += ' AND starts_at < ?'; params.push(normalizeWall(to)); }
    return functions.executeSql(`${sql} ORDER BY time_blocks.starts_at, id LIMIT 1000`, params);
  },

  async createBlock(companyId, data) {
    const startsAt = normalizeWall(data.starts_at);
    const endsAt = normalizeWall(data.ends_at);
    if (wallMinutes(endsAt) <= wallMinutes(startsAt)) throw new HttpError(400, 'O fim do bloqueio deve ser depois do início.');
    return functions.executeTransaction(async query => {
      if (data.professional_id) await getProfessional(query, companyId, data.professional_id);
      const result = await query('INSERT INTO time_blocks (company_id, professional_id, starts_at, ends_at, reason) VALUES (?, ?, ?, ?, ?)',
        [companyId, data.professional_id || null, startsAt, endsAt, data.reason || null]);
      return { id: result.insertId, professional_id: data.professional_id || null, starts_at: startsAt, ends_at: endsAt, reason: data.reason || null };
    });
  },

  async deleteBlock(companyId, id) {
    const result = await functions.executeSql('DELETE FROM time_blocks WHERE id = ? AND company_id = ?', [id, companyId]);
    if (!result.affectedRows) throw new HttpError(404, 'Bloqueio não encontrado.');
  },
};

function normalizeWall(value) {
  return minutesToWall(wallMinutes(String(value).replace('T', ' ').slice(0, 19)));
}

function checkRange(start, end) {
  if (timeToMinutes(end) <= timeToMinutes(start)) throw new HttpError(400, 'O fim do expediente deve ser depois do início.');
}

function overlaps(a, b) {
  return a.weekday === b.weekday && timeToMinutes(a.start_time) < timeToMinutes(b.end_time) && timeToMinutes(b.start_time) < timeToMinutes(a.end_time);
}

function checkSelfOverlap(rules) {
  for (let i = 0; i < rules.length; i += 1) {
    for (let j = i + 1; j < rules.length; j += 1) {
      if (overlaps(rules[i], rules[j])) throw new HttpError(400, 'Intervalos de expediente sobrepostos no mesmo dia.');
    }
  }
}

async function assertNoOverlap(query, companyId, professionalId, rules) {
  const existing = await query(`SELECT weekday, TIME_FORMAT(start_time, '%H:%i') AS start_time, TIME_FORMAT(end_time, '%H:%i') AS end_time
    FROM availability_rules WHERE company_id = ? AND professional_id = ?`, [companyId, professionalId]);
  for (const rule of rules) if (existing.some(row => overlaps(row, rule))) throw new HttpError(400, 'Intervalos de expediente sobrepostos no mesmo dia.');
}

module.exports = professionalsService;
