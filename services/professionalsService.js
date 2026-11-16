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

// Um usuário fica vinculado a no máximo um profissional ativo por empresa (chamado com a empresa travada).
async function assertUserFree(query, companyId, userId, professionalId = 0) {
  if (userId === null || userId === undefined) return;
  const [taken] = await query('SELECT id FROM professionals WHERE company_id = ? AND user_id = ? AND active = 1 AND id <> ? LIMIT 1', [companyId, userId, professionalId]);
  if (taken) {
    throw Object.assign(new Error('Este usuário já está vinculado a outro profissional.'), {
      status: 409, code: 'professional_user_taken', details: { professional_id: taken.id },
    });
  }
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

// Foto: só PNG/JPEG/WebP, reconhecidos pelos primeiros bytes (o tipo declarado tem de bater). SVG/GIF recusados.
const PHOTO_PATH = '/files/professional-photo';
const photoMaxBytes = () => Number(process.env.PROFESSIONAL_PHOTO_MAX_BYTES) || 1024 * 1024;
function sniffImage(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
function parsePhoto(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl || ''));
  if (!match) throw new HttpError(400, 'Envie a imagem como data URL base64 (PNG, JPEG ou WebP).');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > photoMaxBytes()) throw new HttpError(413, `Imagem acima de ${Math.round(photoMaxBytes() / 1024)} KB.`);
  const mime = sniffImage(bytes);
  const declared = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  if (!mime || mime !== declared) throw new HttpError(400, 'O conteúdo não é uma imagem PNG, JPEG ou WebP válida.');
  return { mime, bytes, sha256: require('crypto').createHash('sha256').update(bytes).digest('hex') };
}
const photoUrl = (id, sha256) => `${(process.env.PUBLIC_API_URL || '').replace(/\/$/, '')}${PHOTO_PATH}/${id}/${sha256.slice(0, 16)}`;

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
      await assertUserFree(query, companyId, data.user_id);
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
      const finalUser = data.user_id !== undefined ? data.user_id : current.user_id;
      const finalActive = data.active !== undefined ? data.active : !!current.active;
      if (finalActive && (data.user_id !== undefined || data.active === true)) await assertUserFree(query, companyId, finalUser, id);
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

  // ---- Vínculo profissional <-> usuário (follow-up 1) ----
  // Membros da empresa com o profissional ativo vinculado (para o seletor do painel).
  async members(companyId) {
    const rows = await functions.executeSql(
      `SELECT u.id AS user_id, u.name, u.email,
              (SELECT p.id FROM professionals p WHERE p.company_id = cm.company_id AND p.user_id = u.id AND p.active = 1 ORDER BY p.id LIMIT 1) AS professional_id
         FROM company_members cm INNER JOIN users u ON u.id = cm.user_id
        WHERE cm.company_id = ? ORDER BY u.name, u.id`, [companyId]);
    return rows.map(r => ({ user_id: r.user_id, name: r.name, email: r.email, professional_id: r.professional_id ?? null }));
  },

  // Profissional ativo do usuário logado nesta empresa (null se não houver).
  async mine(companyId, userId) {
    const [row] = await functions.executeSql('SELECT id FROM professionals WHERE company_id = ? AND user_id = ? AND active = 1 ORDER BY id LIMIT 1', [companyId, userId]);
    return row ? this.get(companyId, row.id) : null;
  },

  // ---- Foto (follow-up 1): data URL base64 -> valida pelos bytes (magic number) -> banco ----
  async setPhoto(companyId, id, dataUrl) {
    const image = parsePhoto(dataUrl);
    await functions.executeTransaction(async query => {
      await getProfessional(query, companyId, id, { lock: true });
      await query(`INSERT INTO professional_photos (professional_id, company_id, mime, bytes, sha256) VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE mime = VALUES(mime), bytes = VALUES(bytes), sha256 = VALUES(sha256)`, [id, companyId, image.mime, image.bytes, image.sha256]);
      await query('UPDATE professionals SET photo_url = ? WHERE id = ? AND company_id = ?', [photoUrl(id, image.sha256), id, companyId]);
    });
    return this.get(companyId, id);
  },

  async removePhoto(companyId, id) {
    await functions.executeTransaction(async query => {
      await getProfessional(query, companyId, id, { lock: true });
      await query('DELETE FROM professional_photos WHERE professional_id = ? AND company_id = ?', [id, companyId]);
      await query('UPDATE professionals SET photo_url = NULL WHERE id = ? AND company_id = ? AND photo_url LIKE ?', [id, companyId, `%${PHOTO_PATH}/${id}/%`]);
    });
    return this.get(companyId, id);
  },

  // Leitura pública (a foto já aparece na página pública): exige o hash da versão atual.
  async photo(id, hash) {
    const [row] = await functions.executeSql('SELECT mime, bytes, sha256 FROM professional_photos WHERE professional_id = ?', [id]);
    if (!row || row.sha256.slice(0, 16) !== hash) return null;
    return row;
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
      DATE_FORMAT(ends_at, '%Y-%m-%d %H:%i:%s') AS ends_at, reason, source FROM time_blocks WHERE company_id = ?`;
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
    // F6: bloqueios importados do Google Agenda são geridos pela sincronização (some ao apagar/recusar
    // o evento no Google ou ao desvincular o calendário); apagar aqui voltaria na próxima sincronização.
    const [row] = await functions.executeSql('SELECT source FROM time_blocks WHERE id = ? AND company_id = ?', [id, companyId]);
    if (!row) throw new HttpError(404, 'Bloqueio não encontrado.');
    if (row.source && row.source !== 'manual') throw new HttpError(409, 'Bloqueio sincronizado do Google Agenda: remova o evento no Google ou desvincule o calendário.');
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
