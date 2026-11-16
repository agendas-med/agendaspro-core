const crypto = require('node:crypto');
const functions = require('../utils/functions');
const appointments = require('./appointmentsService');
const sales = require('./salesService');
const plans = require('./plansService');
const tokens = require('./publicTokens');
const { daySlots, dateRange } = require('../utils/slots');
const { wallClock, wallMinutes, minutesToWall, resolveTimezone } = require('../utils/time');
const { toCents, centsToDecimal } = require('../utils/money');

// API pública de agendamento (F3). Regras:
// - company_id nunca vem do cliente: é derivado do slug (página habilitada) ou do manage_token;
// - respostas só trazem dados da própria reserva e dados públicos da empresa (nada de outros clientes);
// - estado derivado do tempo é calculado na leitura (reserva com sinal vencida = cancelada, sem cron).
const pub = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const notFound = (message = 'Página de agendamento não encontrada.') => pub(404, 'not_found', message);
const slotTakenError = (message = 'Este horário não está mais disponível. Escolha outro.') => pub(409, 'slot_taken', message);

const OCCUPYING = 'a.canceled = 0 AND (a.hold_expires_at IS NULL OR a.hold_expires_at > NOW())';
const clamp = (value, min, max, fallback) => (Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback);
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

// Telefone BR: aceita +55 DDD número (E.164) ou DDD número. Devolve dígitos nacionais (10/11).
function normalizePhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) digits = digits.slice(2);
  return digits.length === 10 || digits.length === 11 ? digits : null;
}

function policyOf(company) {
  return {
    minNotice: clamp(company.booking_min_notice_minutes, 0, 60 * 24 * 30, 120),
    cancelNotice: clamp(company.booking_cancel_notice_minutes, 0, 60 * 24 * 30, 120),
    hold: clamp(company.booking_hold_minutes, 5, 60, 15),
    step: clamp(company.booking_slot_step_minutes, 5, 240, 30),
    horizon: clamp(company.booking_horizon_days, 1, 365, 60),
  };
}

const nowWallMinutes = tz => wallMinutes(wallClock(new Date(), resolveTimezone(tz)));

const COMPANY_FIELDS = `id, name, slug, address, address_number, city, state, phone, timezone, public_description, logo_url,
  instagram_url, public_hours, theme_primary_color, asaas_status, asaas_api_key IS NOT NULL AS has_asaas_key,
  booking_min_notice_minutes, booking_cancel_notice_minutes, booking_hold_minutes, booking_slot_step_minutes, booking_horizon_days`;

async function companyBySlug(slug, { query = functions.executeSql, lock = false } = {}) {
  if (typeof slug !== 'string' || !/^[a-z0-9-]{3,60}$/.test(slug)) return null;
  const [company] = await query(`SELECT ${COMPANY_FIELDS} FROM companies WHERE slug = ? AND public_page_enabled = 1${lock ? ' FOR UPDATE' : ''}`, [slug]);
  if (!company) return null;
  const ent = await plans.entitlement(company.id, { query });
  if (ent.features?.public_page === false) return null;
  return { company, ent };
}

const paymentsReady = (company, ent) => !!company.has_asaas_key && company.asaas_status === 'APPROVED' && ent.features?.deposit_pix !== false;

function fullAddress(company) {
  const street = [company.address, company.address_number].filter(Boolean).join(', ');
  const city = [company.city, company.state].filter(Boolean).join('/');
  return [street, city].filter(Boolean).join(' - ') || null;
}

// Serviços oferecidos online. Serviço com sinal só aparece se a empresa puder cobrar Pix.
async function onlineServices(query, company, ent, ids = null) {
  const rows = await query(`SELECT id, name, public_description, duration, value, deposit_cents FROM services
    WHERE company_id = ? AND online_booking = 1${ids ? ' AND id IN (?)' : ''} ORDER BY name, id`, ids ? [company.id, ids] : [company.id]);
  const canCharge = paymentsReady(company, ent);
  return rows.filter(row => Number(row.duration) > 0 && (Number(row.deposit_cents) === 0 || canCharge));
}

// Profissionais ativos que atendem TODOS os serviços pedidos.
async function professionalsFor(query, companyId, serviceIds, professionalId = null) {
  return query(`SELECT p.id, p.name FROM professionals p
    JOIN professional_services ps ON ps.professional_id = p.id AND ps.company_id = p.company_id
    WHERE p.company_id = ? AND p.active = 1 AND ps.service_id IN (?)${professionalId ? ' AND p.id = ?' : ''}
    GROUP BY p.id, p.name HAVING COUNT(DISTINCT ps.service_id) = ? ORDER BY p.id`,
  professionalId ? [companyId, serviceIds, professionalId, serviceIds.length] : [companyId, serviceIds, serviceIds.length]);
}

// GET /public/b/:slug
async function getBusiness(slug) {
  const found = await companyBySlug(slug);
  if (!found) throw notFound();
  const { company, ent } = found;
  const query = functions.executeSql;
  const services = await onlineServices(query, company, ent);
  const serviceIds = services.map(s => s.id);
  const professionals = serviceIds.length ? await query(`SELECT p.id, p.name, p.photo_url FROM professionals p
    WHERE p.company_id = ? AND p.active = 1 AND EXISTS (SELECT 1 FROM availability_rules r WHERE r.professional_id = p.id AND r.company_id = p.company_id)
    ORDER BY p.name, p.id`, [company.id]) : [];
  const links = professionals.length ? await query('SELECT professional_id, service_id FROM professional_services WHERE company_id = ? AND professional_id IN (?) AND service_id IN (?)',
    [company.id, professionals.map(p => p.id), serviceIds]) : [];
  return {
    company: {
      name: company.name,
      slug: company.slug,
      logo_url: company.logo_url || null,
      description: company.public_description || null,
      address: fullAddress(company),
      phone: company.phone || null,
      timezone: resolveTimezone(company.timezone),
      hours: company.public_hours || null,
      instagram_url: company.instagram_url || null,
      theme: { primary_color: ent.features?.theme_custom === true ? company.theme_primary_color || null : null },
      // Free mostra "feito com AgendasPRO"; Premium remove (feature public_page_branding do plano).
      powered_by: ent.features?.public_page_branding !== false,
    },
    services: services.map(s => {
      const price = toCents(Number(s.value) || 0);
      const deposit = Math.min(Number(s.deposit_cents) || 0, price || Number(s.deposit_cents) || 0);
      return { id: s.id, name: s.name, description: s.public_description || null, duration_min: Number(s.duration), price_cents: price, deposit_cents: deposit, requires_payment: deposit > 0 };
    }),
    professionals: professionals
      .map(p => ({ id: p.id, name: p.name, photo_url: p.photo_url || null, service_ids: links.filter(l => l.professional_id === p.id).map(l => l.service_id) }))
      .filter(p => p.service_ids.length),
  };
}

// GET /public/b/:slug/availability?service_id&professional_id&from&to (máx. 14 dias)
async function availability(slug, { serviceIds, professionalId = null, from, to }) {
  const found = await companyBySlug(slug);
  if (!found) throw notFound();
  const { company, ent } = found;
  const query = functions.executeSql;
  const tz = resolveTimezone(company.timezone);
  const policy = policyOf(company);
  if (to < from) throw pub(400, 'validation_error', 'Período inválido.');
  const days = dateRange(from, to);
  if (days.length > 14) throw pub(400, 'validation_error', 'Consulte no máximo 14 dias por vez.');

  const services = await onlineServices(query, company, ent, serviceIds);
  if (services.length !== serviceIds.length) throw pub(400, 'validation_error', 'Serviço inválido.');
  const duration = services.reduce((sum, s) => sum + Number(s.duration), 0);
  const professionals = await professionalsFor(query, company.id, serviceIds, professionalId);
  if (professionalId && !professionals.length) throw pub(400, 'validation_error', 'Profissional inválido para este serviço.');

  const nowMin = nowWallMinutes(tz);
  const minStart = nowMin + policy.minNotice;
  const maxStart = wallMinutes(`${minutesToWall(nowMin).slice(0, 10)} 00:00`) + (policy.horizon + 1) * 1440 - 1;
  const rangeStart = `${from} 00:00:00`;
  const rangeEnd = `${minutesToWall(wallMinutes(`${to} 00:00`) + 1440)}`;
  const ids = professionals.map(p => p.id);
  if (!ids.length) return { timezone: tz, days: days.map(date => ({ date, slots: [] })) };

  const [rules, busyRows, blockRows] = await Promise.all([
    query('SELECT professional_id, weekday, TIME_FORMAT(start_time, "%H:%i") AS start_time, TIME_FORMAT(end_time, "%H:%i") AS end_time FROM availability_rules WHERE company_id = ? AND professional_id IN (?)', [company.id, ids]),
    query(`SELECT a.professional_id, DATE_FORMAT(a.date, '%Y-%m-%d %H:%i:%s') AS wall, a.duration FROM appointments a
      WHERE a.company_id = ? AND ${OCCUPYING} AND a.date < ? AND DATE_ADD(a.date, INTERVAL a.duration MINUTE) > ?`, [company.id, rangeEnd, rangeStart]),
    query(`SELECT professional_id, DATE_FORMAT(starts_at, '%Y-%m-%d %H:%i:%s') AS s, DATE_FORMAT(ends_at, '%Y-%m-%d %H:%i:%s') AS e FROM time_blocks
      WHERE company_id = ? AND starts_at < ? AND ends_at > ?`, [company.id, rangeEnd, rangeStart]),
  ]);
  const busy = busyRows.map(row => ({ professional_id: row.professional_id, start: wallMinutes(row.wall), end: wallMinutes(row.wall) + Number(row.duration) }));
  const blocks = blockRows.map(row => ({ professional_id: row.professional_id, start: wallMinutes(row.s), end: wallMinutes(row.e) }));
  return {
    timezone: tz,
    days: days.map(date => ({ date, slots: daySlots({ date, professionals: ids, duration, step: policy.step, minStart, maxStart, rules, busy, blocks }) })),
  };
}

// ---------- visão da reserva (manage_token) ----------

const VIEW_SQL = `SELECT pb.public_id, pb.company_id, pb.appointment_id, pb.customer_id, pb.sale_id, pb.deposit_cents, pb.cancel_reason, pb.token_expires_at,
    DATE_FORMAT(a.date, '%Y-%m-%d %H:%i') AS wall, a.duration, a.canceled, a.payment_status, a.checkin, a.checkout, a.professional_id, a.hold_expires_at,
    (a.hold_expires_at IS NOT NULL AND a.hold_expires_at <= NOW()) AS hold_expired,
    pr.name AS professional_name, c.name AS company_name, c.slug, c.address, c.address_number, c.city, c.state, c.phone, c.timezone,
    c.booking_cancel_notice_minutes, c.booking_min_notice_minutes, c.booking_horizon_days, s.pix_asaas_id, s.pix_payload, s.pix_encoded_image
  FROM public_bookings pb
  JOIN appointments a ON a.id = pb.appointment_id AND a.company_id = pb.company_id
  JOIN companies c ON c.id = pb.company_id
  LEFT JOIN professionals pr ON pr.id = a.professional_id AND pr.company_id = pb.company_id
  LEFT JOIN sales s ON s.id = pb.sale_id AND s.company_id = pb.company_id
  WHERE pb.public_id = ?`;

// Status no vocabulário do site: confirmed | pending_payment | cancelled | completed.
function deriveStatus(row) {
  if (Number(row.canceled) === 1) return { status: 'cancelled', reason: row.cancel_reason || 'company' };
  if (row.payment_status === 'pendente' && Number(row.hold_expired) === 1) return { status: 'cancelled', reason: 'payment_expired' };
  if (row.checkin || row.checkout) return { status: 'completed' };
  if (row.payment_status === 'pendente') return { status: 'pending_payment' };
  return { status: 'confirmed' };
}

const isoLocal = wall => wall.replace(' ', 'T').slice(0, 16);

async function loadView(publicId, query = functions.executeSql) {
  const [row] = await query(VIEW_SQL, [publicId]);
  if (!row) return null;
  const services = await query(`SELECT s.id, s.name FROM appointment_services aps JOIN services s ON s.id = aps.service_id AND s.company_id = ?
    WHERE aps.appointment_id = ? ORDER BY s.id`, [row.company_id, row.appointment_id]);
  return { row, services };
}

function present({ row, services }) {
  const { status, reason } = deriveStatus(row);
  const tz = resolveTimezone(row.timezone);
  const cancelNotice = clamp(row.booking_cancel_notice_minutes, 0, 60 * 24 * 30, 120);
  const startMin = wallMinutes(row.wall);
  const lead = startMin - nowWallMinutes(tz);
  const body = {
    booking: {
      id: row.public_id,
      status,
      ...(reason ? { cancellation_reason: reason } : {}),
      start: isoLocal(row.wall),
      end: isoLocal(minutesToWall(startMin + Number(row.duration))),
      service_ids: services.map(s => s.id),
      service_names: services.map(s => s.name),
      professional_id: row.professional_id || null,
      professional_name: row.professional_name || null,
      deposit_cents: Number(row.deposit_cents) || 0,
    },
    company: { name: row.company_name, slug: row.slug, address: fullAddress(row), phone: row.phone || null, timezone: tz },
    policy: {
      can_cancel: ['confirmed', 'pending_payment'].includes(status) && lead >= cancelNotice,
      can_reschedule: status === 'confirmed' && lead >= cancelNotice,
      min_notice_hours: Math.round((cancelNotice / 60) * 10) / 10,
    },
  };
  if (status === 'pending_payment') {
    body.payment = row.pix_payload ? {
      provider: 'asaas',
      amount_cents: Number(row.deposit_cents) || 0,
      pix_qr_base64: row.pix_encoded_image || null,
      pix_copy_paste: row.pix_payload,
      expires_at: row.hold_expires_at ? new Date(row.hold_expires_at).toISOString() : null,
    } : { provider: 'asaas', amount_cents: Number(row.deposit_cents) || 0, pix_qr_base64: null, pix_copy_paste: null, expires_at: row.hold_expires_at ? new Date(row.hold_expires_at).toISOString() : null };
  }
  return body;
}

// Token -> publicId (404 adulterado/inexistente; 410 expirado).
function resolveToken(token) {
  const verified = tokens.verify(token);
  if (!verified) throw pub(404, 'not_found', 'Agendamento não encontrado ou link expirado.');
  if (verified.expired) throw pub(410, 'token_expired', 'Este link expirou. Fale com o estabelecimento.');
  return verified.publicId;
}

async function getByToken(token) {
  const publicId = resolveToken(token);
  const view = await loadView(publicId);
  if (!view) throw pub(404, 'not_found', 'Agendamento não encontrado ou link expirado.');
  return present(view);
}

function withToken(view) {
  return { ...present(view), manage_token: tokens.issue(view.row.public_id, view.row.token_expires_at) };
}

// ---------- criação ----------

function requestHash(body, phone) {
  return sha256(JSON.stringify({
    s: [...body.service_ids].map(Number).sort((a, b) => a - b),
    p: body.professional_id ?? null,
    st: body.start,
    ph: phone,
    n: String(body.customer.name).trim(),
    e: body.customer.email ? String(body.customer.email).trim().toLowerCase() : null,
    src: body.source,
  }));
}

async function replay(companyId, idempotencyKey, hash) {
  const [existing] = await functions.executeSql('SELECT public_id, request_hash FROM public_bookings WHERE company_id = ? AND idempotency_key = ?', [companyId, idempotencyKey]);
  if (!existing) return null;
  if (existing.request_hash !== hash) throw pub(409, 'idempotency_conflict', 'Esta chave de idempotência já foi usada com outros dados.');
  const view = await loadView(existing.public_id);
  return view ? withToken(view) : null;
}

async function findOrCreateCustomer(query, companyId, customer, phone) {
  const [existing] = await query(`SELECT id, name, email, cpf FROM customers
    WHERE company_id = ? AND anonymized_at IS NULL AND REGEXP_REPLACE(COALESCE(tel, ''), '[^0-9]', '') IN (?, ?)
    ORDER BY id LIMIT 1 FOR UPDATE`, [companyId, phone, `55${phone}`]);
  // Cliente existente: nome/e-mail cadastrados nunca são sobrescritos pela página pública.
  if (existing) return { id: existing.id, name: existing.name, email: existing.email, cpf: existing.cpf, created: false };
  const name = String(customer.name).trim();
  const email = customer.email ? String(customer.email).trim().toLowerCase() : null;
  const result = await query('INSERT INTO customers (name, tel, email, company_id) VALUES (?, ?, ?, ?)', [name, phone, email, companyId]);
  return { id: result.insertId, name, email, cpf: null, created: true };
}

// guard(): Turnstile + rate limit, chamado só quando não é reenvio idempotente.
async function createBooking(slug, body, { guard = async () => {}, companyLookup } = {}) {
  if (body.consent !== true) throw pub(400, 'consent_required', 'É necessário aceitar o tratamento de dados para agendar.');
  const phone = normalizePhone(body.customer?.phone);
  if (!phone) throw pub(400, 'validation_error', 'Informe um WhatsApp válido com DDD.');
  const found = companyLookup ? await companyLookup() : await companyBySlug(slug);
  if (!found) throw notFound();
  const { company } = found;
  const hash = requestHash(body, phone);

  // 1) Reenvio com a mesma chave devolve a mesma reserva (antes do Turnstile: o token é de uso único).
  const replayed = await replay(company.id, body.idempotency_key, hash);
  if (replayed) return { status: 200, body: replayed };

  // 2) Turnstile e limites (IP e telefone).
  await guard({ companyId: company.id, phone });

  const serviceIds = [...new Set(body.service_ids.map(Number))];
  const startWall = `${body.start.slice(0, 10)} ${body.start.slice(11, 16)}:00`;
  const startMin = wallMinutes(startWall);
  const tz = resolveTimezone(company.timezone);
  const policy = policyOf(company);

  let created;
  try {
    created = await functions.executeTransaction(async query => {
      // Trava a empresa primeiro (mesma ordem de ensureSlot): serializa reservas concorrentes.
      const [locked] = await query(`SELECT ${COMPANY_FIELDS} FROM companies WHERE id = ? AND public_page_enabled = 1 FOR UPDATE`, [company.id]);
      if (!locked) throw notFound();
      const ent = await plans.entitlement(locked.id, { query });
      const [again] = await query('SELECT public_id, request_hash FROM public_bookings WHERE company_id = ? AND idempotency_key = ?', [locked.id, body.idempotency_key]);
      if (again) return { replayPublicId: again.public_id, replayHash: again.request_hash };

      const nowMin = nowWallMinutes(tz);
      if (startMin < nowMin + policy.minNotice) throw slotTakenError(`Escolha um horário com pelo menos ${Math.ceil(policy.minNotice / 60)}h de antecedência.`);
      const lastDay = wallMinutes(`${minutesToWall(nowMin).slice(0, 10)} 00:00`) + (policy.horizon + 1) * 1440;
      if (startMin >= lastDay) throw slotTakenError('Horário fora do período aberto para agendamento.');

      const services = await onlineServices(query, locked, ent, serviceIds);
      if (services.length !== serviceIds.length) throw pub(400, 'validation_error', 'Serviço inválido.');
      const duration = services.reduce((sum, s) => sum + Number(s.duration), 0);
      const totalCents = services.reduce((sum, s) => sum + (toCents(Number(s.value) || 0) || 0), 0);
      let depositCents = services.reduce((sum, s) => sum + (Number(s.deposit_cents) || 0), 0);
      if (totalCents > 0) depositCents = Math.min(depositCents, totalCents);
      if (depositCents > 0 && !paymentsReady(locked, ent)) throw pub(503, 'payment_unavailable', 'Pagamento online indisponível no momento.');

      const candidates = await professionalsFor(query, locked.id, serviceIds, body.professional_id || null);
      if (!candidates.length) throw pub(400, 'validation_error', 'Profissional inválido para o serviço escolhido.');
      let professional = null;
      for (const candidate of candidates) {
        try {
          await appointments.ensureSlot(query, locked.id, startWall, duration, 0, { professionalId: candidate.id, verified: true, requireRules: true });
          professional = candidate;
          break;
        } catch (error) {
          if (error?.code !== 'slot_taken') throw error;
        }
      }
      if (!professional) throw slotTakenError();

      const customer = await findOrCreateCustomer(query, locked.id, body.customer, phone);
      const holdUntil = depositCents > 0 ? new Date(Date.now() + policy.hold * 60000) : null;
      const appt = await query(`INSERT INTO appointments
        (company_id, customer_id, customer_name, date, duration, observations, checkin, checkout, canceled, payment_status, professional_id, hold_expires_at, source)
        VALUES (?, ?, ?, ?, ?, '', NULL, NULL, 0, ?, ?, ?, ?)`,
      [locked.id, customer.id, customer.name, startWall, duration, depositCents > 0 ? 'pendente' : 'isento', professional.id, holdUntil, body.source]);
      await appointments.saveServices(query, appt.insertId, services.map(s => ({ id: s.id, quantity: 1 })));
      const sale = await query("INSERT INTO sales (company_id, customer_id, appointment_id, status) VALUES (?, ?, ?, 'em_aberto')", [locked.id, customer.id, appt.insertId]);
      const publicId = tokens.newPublicId();
      await query(`INSERT INTO public_bookings (public_id, company_id, appointment_id, customer_id, sale_id, idempotency_key, request_hash, source, deposit_cents, token_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [publicId, locked.id, appt.insertId, customer.id, sale.insertId, body.idempotency_key, hash, body.source, depositCents, tokens.expiryFromNow()]);
      // F6: atribuição opcional (UTM da página pública). Fora do request_hash: reenvio sem ela é o mesmo pedido.
      if (body.attribution) await require('./attributionService').recordBooking(query, locked.id, appt.insertId, body.attribution);
      // LGPD: registro do consentimento dado na página pública.
      await query('INSERT INTO consents (company_id, customer_id, purpose, granted, source) VALUES (?, ?, ?, 1, ?)',
        [locked.id, customer.id, 'public_booking', `public:${body.source}`.slice(0, 30)]);
      return { publicId, appointmentId: appt.insertId, saleId: sale.insertId, customer, depositCents, companyId: locked.id };
    });
  } catch (error) {
    // Corrida entre dois reenvios com a mesma chave: a UNIQUE resolve; devolve a reserva já criada.
    if (error?.code === 'ER_DUP_ENTRY' && /idempotency/.test(String(error.sqlMessage || ''))) {
      const again = await replay(company.id, body.idempotency_key, hash);
      if (again) return { status: 200, body: again };
    }
    throw error;
  }
  if (created.replayPublicId) {
    if (created.replayHash !== hash) throw pub(409, 'idempotency_conflict', 'Esta chave de idempotência já foi usada com outros dados.');
    return { status: 200, body: withToken(await loadView(created.replayPublicId)) };
  }

  if (created.depositCents > 0) {
    await createDepositCharge(created, body.customer);
  } else {
    await enqueueConfirmation(created.appointmentId);
  }
  return { status: 201, body: withToken(await loadView(created.publicId)) };
}

// Pix do sinal: fora da trava da empresa (chamada externa). Falha -> reserva cancelada e 503.
async function createDepositCharge(created, customerInput) {
  const asaas = require('./asaasService');
  const billing = require('./billingService');
  const { decryptKey } = require('./asaasKeys');
  let pix = null;
  let apiKey = null;
  try {
    const [company] = await functions.executeSql('SELECT asaas_api_key FROM companies WHERE id = ?', [created.companyId]);
    apiKey = decryptKey(company.asaas_api_key);
    const cpf = created.customer.cpf || (customerInput?.cpf ? String(customerInput.cpf).replace(/\D/g, '') : null);
    const customerAsaasId = await asaas.getOrCreateCustomer({ name: created.customer.name, cpf, tel: customerInput.phone, email: created.customer.email }, apiKey);
    const commission = await billing.commissionFor(created.companyId, created.depositCents);
    pix = await asaas.createPixCharge({
      customerAsaasId, value: centsToDecimal(commission.gross_cents), split: commission.split,
      externalReference: `SALE_${created.saleId}`, description: `Sinal do agendamento #${created.appointmentId} no AgendasPRO`,
    }, apiKey);
    await functions.executeTransaction(async query => {
      await query('UPDATE sales SET pix_asaas_id = ?, pix_payload = ?, pix_expiration_date = ?, pix_encoded_image = ? WHERE id = ? AND company_id = ?',
        [pix.paymentId, pix.payload, pix.expirationDate, pix.encodedImage, created.saleId, created.companyId]);
      await query("INSERT INTO accounts_receivable (sale_id, customer_id, amount, payment_type, status) VALUES (?, ?, ?, 'pix_asaas', 'EM ABERTO')",
        [created.saleId, created.customer.id, centsToDecimal(created.depositCents)]);
      await billing.recordCommission(query, { companyId: created.companyId, saleId: created.saleId, providerPaymentId: pix.paymentId, commission });
    });
  } catch (error) {
    console.error('[public] Falha ao gerar Pix do sinal:', JSON.stringify({ appointment: created.appointmentId, code: error?.code, status: error?.response?.status }));
    if (pix?.paymentId && apiKey) await asaas.cancelCharge(pix.paymentId, apiKey).catch(() => {});
    await functions.executeTransaction(async query => {
      await query("UPDATE appointments SET canceled = 1 WHERE id = ? AND company_id = ?", [created.appointmentId, created.companyId]);
      await query("UPDATE public_bookings SET canceled_at = NOW(), cancel_reason = 'payment_failed' WHERE appointment_id = ?", [created.appointmentId]);
      await query('UPDATE sales SET pix_asaas_id = NULL, pix_payload = NULL, pix_expiration_date = NULL, pix_encoded_image = NULL WHERE id = ? AND company_id = ?', [created.saleId, created.companyId]);
      await sales.setAppointmentCancellation(query, created.companyId, created.appointmentId, true);
    }).catch(() => {});
    throw pub(503, 'payment_unavailable', 'Não foi possível gerar o Pix agora. Tente novamente em instantes.');
  }
}

async function enqueueConfirmation(appointmentId, kind = 'confirmed', suffix = '') {
  const jobs = require('./jobsService');
  await jobs.enqueue('booking_confirmation', { appointment_id: appointmentId, kind }, { dedupeKey: `booking_${kind}:${appointmentId}${suffix}`, maxAttempts: 3 }).catch(error => {
    console.error('[public] Falha ao enfileirar confirmação:', error?.code || 'erro');
  });
  jobs.drainSoon();
}

// ---------- cancelar / remarcar ----------

async function lockedBooking(query, publicId) {
  const [ref] = await query('SELECT company_id FROM public_bookings WHERE public_id = ?', [publicId]);
  if (!ref) throw pub(404, 'not_found', 'Agendamento não encontrado ou link expirado.');
  await query('SELECT id FROM companies WHERE id = ? FOR UPDATE', [ref.company_id]);
  await query('SELECT id FROM appointments WHERE id = (SELECT appointment_id FROM public_bookings WHERE public_id = ?) FOR UPDATE', [publicId]);
  return loadView(publicId, query);
}

async function cancelByToken(token) {
  const publicId = resolveToken(token);
  const result = await functions.executeTransaction(async query => {
    const view = await lockedBooking(query, publicId);
    const { status } = deriveStatus(view.row);
    if (status === 'cancelled') throw pub(409, 'already_cancelled', 'Este agendamento já foi cancelado.');
    if (status === 'completed') throw pub(409, 'not_allowed', 'Este atendimento já foi realizado.');
    const lead = wallMinutes(view.row.wall) - nowWallMinutes(view.row.timezone);
    const notice = clamp(view.row.booking_cancel_notice_minutes, 0, 60 * 24 * 30, 120);
    if (lead < notice) throw pub(409, 'cancel_window_closed', `Cancelamento online só até ${Math.round(notice / 60 * 10) / 10}h antes. Fale com o estabelecimento.`);
    await query('UPDATE appointments SET canceled = 1 WHERE id = ? AND company_id = ?', [view.row.appointment_id, view.row.company_id]);
    await query("UPDATE public_bookings SET canceled_at = NOW(), cancel_reason = 'customer' WHERE public_id = ?", [publicId]);
    await sales.setAppointmentCancellation(query, view.row.company_id, view.row.appointment_id, true);
    return view.row;
  });
  // Pix ainda em aberto: cancela a cobrança (melhor esforço) e encerra a venda.
  if (result.pix_asaas_id && result.sale_id) {
    try {
      await require('./paymentsService').cancelPix(result.company_id, result.sale_id);
      await functions.executeTransaction(query => sales.setAppointmentCancellation(query, result.company_id, result.appointment_id, true));
    } catch (error) {
      console.error('[public] Falha ao cancelar Pix do sinal:', error?.code || error?.response?.status || 'erro');
    }
  }
  return present(await loadView(publicId));
}

async function rescheduleByToken(token, start) {
  const publicId = resolveToken(token);
  const newWall = `${start.slice(0, 10)} ${start.slice(11, 16)}:00`;
  const appointmentId = await functions.executeTransaction(async query => {
    const view = await lockedBooking(query, publicId);
    const { row } = view;
    const { status } = deriveStatus(row);
    if (status === 'cancelled') throw pub(409, 'already_cancelled', 'Este agendamento foi cancelado.');
    if (status !== 'confirmed') throw pub(409, 'not_allowed', 'Este agendamento não pode ser remarcado online.');
    const tz = resolveTimezone(row.timezone);
    const nowMin = nowWallMinutes(tz);
    const notice = clamp(row.booking_cancel_notice_minutes, 0, 60 * 24 * 30, 120);
    if (wallMinutes(row.wall) - nowMin < notice) throw pub(409, 'cancel_window_closed', 'Remarcação online encerrada para este horário. Fale com o estabelecimento.');
    const minNotice = clamp(row.booking_min_notice_minutes, 0, 60 * 24 * 30, 120);
    const horizon = clamp(row.booking_horizon_days, 1, 365, 60);
    const newMin = wallMinutes(newWall);
    if (newMin < nowMin + minNotice) throw slotTakenError(`Escolha um horário com pelo menos ${Math.ceil(minNotice / 60)}h de antecedência.`);
    if (newMin >= wallMinutes(`${minutesToWall(nowMin).slice(0, 10)} 00:00`) + (horizon + 1) * 1440) throw slotTakenError('Horário fora do período aberto para agendamento.');
    try {
      await appointments.ensureSlot(query, row.company_id, newWall, Number(row.duration), row.appointment_id, { professionalId: row.professional_id, requireRules: true });
    } catch (error) {
      if (error?.code === 'slot_taken' || Number(error?.status) === 400) throw slotTakenError();
      throw error;
    }
    await query('UPDATE appointments SET date = ?, notified_1h = 0, notified_2h = 0 WHERE id = ? AND company_id = ?', [newWall, row.appointment_id, row.company_id]);
    return row.appointment_id;
  });
  await enqueueConfirmation(appointmentId, 'rescheduled', `:${newWall.replace(/\D/g, '')}`);
  return present(await loadView(publicId));
}

// ---------- webhook: sinal pago ----------
// Chamado por paymentsService.confirm dentro da transação, depois de registrar o pagamento.
// Libera a retenção (hold) e tira o agendamento de 'pendente'. Pagamento após o prazo: revalida
// o horário; se outro cliente já ocupou, marca conflito (estorno manual pela empresa).
async function onDepositPaid(query, sale) {
  const [pb] = await query('SELECT appointment_id, deposit_cents FROM public_bookings WHERE sale_id = ? AND company_id = ?', [sale.id, sale.company_id]);
  if (!pb || !Number(pb.deposit_cents)) return null;
  const [appt] = await query(`SELECT id, company_id, DATE_FORMAT(date, '%Y-%m-%d %H:%i:%s') AS wall, duration, canceled, payment_status, professional_id,
    (hold_expires_at IS NOT NULL AND hold_expires_at <= NOW()) AS hold_expired FROM appointments WHERE id = ? AND company_id = ? FOR UPDATE`, [pb.appointment_id, sale.company_id]);
  if (!appt) return null;
  let conflict = Number(appt.canceled) === 1;
  if (!conflict && Number(appt.hold_expired) === 1) {
    try {
      await appointments.ensureSlot(query, appt.company_id, appt.wall, Number(appt.duration), appt.id, { professionalId: appt.professional_id, verified: true });
    } catch (error) {
      if (error?.code !== 'slot_taken') throw error;
      conflict = true;
    }
  }
  if (conflict) {
    await query("UPDATE appointments SET canceled = 1, hold_expires_at = NULL, payment_status = IF(payment_status = 'pendente', 'sinal_pago', payment_status) WHERE id = ?", [appt.id]);
    await query("UPDATE public_bookings SET conflict_at = COALESCE(conflict_at, NOW()), cancel_reason = COALESCE(cancel_reason, 'paid_after_expiry'), canceled_at = COALESCE(canceled_at, NOW()) WHERE appointment_id = ?", [appt.id]);
    console.warn('[public] Sinal pago após o prazo com horário ocupado; estorno manual necessário.', JSON.stringify({ appointment: appt.id }));
    return { appointmentId: appt.id, conflict: true };
  }
  await query("UPDATE appointments SET hold_expires_at = NULL, payment_status = IF(payment_status = 'pendente', 'sinal_pago', payment_status) WHERE id = ?", [appt.id]);
  return { appointmentId: appt.id, confirmed: true };
}

module.exports = {
  getBusiness, availability, createBooking, getByToken, cancelByToken, rescheduleByToken, onDepositPaid, enqueueConfirmation,
  companyBySlug, normalizePhone, deriveStatus, policyOf, requestHash, present, loadView,
};
