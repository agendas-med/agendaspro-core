const functions = require('../utils/functions');
const { wallClock, resolveTimezone } = require('../utils/time');
const { upgradeError } = require('./plansService');
const metrics = require('./instagram/metrics');

// F6: atribuição de conversão da página pública (/b/:slug) por UTM.
// - visitas: contador agregado por empresa/dia/UTM (sem IP, sem PII);
// - agendamentos: linha opcional em booking_attributions (fora do request_hash);
// - funil Instagram: visitas (utm_source=instagram) -> agendamentos (source=instagram OU UTM instagram,
//   não cancelados) -> receita estimada (valor dos serviços) e realizada (pagamentos não estornados).
const q = (sql, params = []) => functions.executeSql(sql, params);
const FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'];
const MAX = { utm_source: 40, utm_medium: 40, utm_campaign: 80, utm_content: 80 };

function normalize(utm = {}) {
  const out = {};
  for (const field of FIELDS) out[field] = String(utm[field] || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, MAX[field]);
  return out;
}
const empty = utm => FIELDS.every(field => !utm[field]);

async function recordVisit(slug, utm) {
  const { companyBySlug } = require('./publicBookingService');
  const found = await companyBySlug(slug);
  if (!found) throw Object.assign(new Error('Página não encontrada.'), { status: 404, code: 'not_found' });
  const clean = normalize(utm);
  const date = wallClock(new Date(), resolveTimezone(found.company.timezone)).slice(0, 10);
  await q(`INSERT INTO public_page_visits (company_id, visit_date, utm_source, utm_medium, utm_campaign, utm_content, visits)
           VALUES (?, ?, ?, ?, ?, ?, 1) ON DUPLICATE KEY UPDATE visits = visits + 1`,
  [found.company.id, date, clean.utm_source, clean.utm_medium, clean.utm_campaign, clean.utm_content]);
}

// Chamado dentro da transação da reserva pública.
async function recordBooking(query, companyId, appointmentId, utm) {
  const clean = normalize(utm);
  if (empty(clean)) return;
  await query(`INSERT IGNORE INTO booking_attributions (appointment_id, company_id, utm_source, utm_medium, utm_campaign, utm_content) VALUES (?, ?, ?, ?, ?, ?)`,
    [appointmentId, companyId, clean.utm_source, clean.utm_medium, clean.utm_campaign, clean.utm_content]);
}

function pageUrl(slug, utm) {
  const base = (process.env.PUBLIC_SITE_URL || process.env.URL_SITE || '').replace(/\/+$/, '');
  const params = new URLSearchParams();
  for (const field of FIELDS) if (utm[field]) params.set(field, utm[field]);
  return `${base}/b/${encodeURIComponent(slug || '')}?${params.toString()}`;
}

function linkView(row, slug) {
  const utm = { utm_source: row.utm_source, utm_medium: row.utm_medium, utm_campaign: row.utm_campaign, utm_content: row.utm_content };
  return { id: row.id, label: row.label, ...utm, url: slug ? pageUrl(slug, utm) : null, created_at: row.created_at ? new Date(row.created_at).toISOString() : null };
}

async function companySlug(companyId) {
  const [row] = await q('SELECT slug FROM companies WHERE id = ?', [companyId]);
  return row?.slug || null;
}

// Bio: utm_medium=bio, campanha "perfil" (liberado no Free). post/story/campaign: Premium.
async function createInstagramLink(companyId, userId, { placement = 'bio', campaign, content, label }, ent) {
  if (placement !== 'bio' && ent?.features?.instagram !== true) {
    throw upgradeError('Links por post e campanha estão disponíveis no plano Premium.', { feature: 'instagram', plan: ent?.plan_code });
  }
  const utm = normalize({
    utm_source: 'instagram',
    utm_medium: placement === 'campaign' ? 'social' : placement,
    utm_campaign: campaign || (placement === 'bio' ? 'perfil' : 'instagram'),
    utm_content: placement === 'bio' ? '' : content || '',
  });
  await q(`INSERT INTO marketing_links (company_id, utm_source, utm_medium, utm_campaign, utm_content, label, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE label = COALESCE(VALUES(label), label)`,
  [companyId, utm.utm_source, utm.utm_medium, utm.utm_campaign, utm.utm_content, label || null, userId]);
  const [row] = await q(`SELECT * FROM marketing_links WHERE company_id = ? AND utm_source = ? AND utm_medium = ? AND utm_campaign = ? AND utm_content = ?`,
    [companyId, utm.utm_source, utm.utm_medium, utm.utm_campaign, utm.utm_content]);
  const slug = await companySlug(companyId);
  return { ...linkView(row, slug), public_page_ready: !!slug };
}

async function listLinks(companyId, source) {
  const rows = await q('SELECT * FROM marketing_links WHERE company_id = ? AND utm_source = ? ORDER BY id DESC LIMIT 200', [companyId, source]);
  const slug = await companySlug(companyId);
  return rows.map(row => linkView(row, slug));
}

const day = value => (value instanceof Date ? value.toISOString().slice(0, 10) : value);

async function instagramConversion(companyId, { from, to, utm_campaign: campaign } = {}) {
  const [company] = await q('SELECT timezone FROM companies WHERE id = ?', [companyId]);
  const today = wallClock(new Date(), resolveTimezone(company?.timezone)).slice(0, 10);
  const end = to ? day(to) : today;
  const start = from ? day(from) : new Date(new Date(`${end}T12:00:00Z`).getTime() - 29 * 86400000).toISOString().slice(0, 10);
  const campaignSql = campaign ? ' AND utm_campaign = ?' : '';
  const campaignArgs = campaign ? [campaign] : [];

  const visitRows = await q(`SELECT visit_date, utm_campaign, SUM(visits) AS visits FROM public_page_visits
     WHERE company_id = ? AND utm_source = 'instagram' AND visit_date BETWEEN ? AND ?${campaignSql}
     GROUP BY visit_date, utm_campaign`, [companyId, start, end, ...campaignArgs]);

  // Agendamentos atribuídos: data da reserva (created_at da reserva pública) no período.
  const bookingRows = await q(`SELECT a.id, COALESCE(ba.utm_campaign, '') AS utm_campaign, DATE(pb.created_at) AS booked_date,
       (SELECT COALESCE(SUM(s.value * aps.quantity), 0) FROM appointment_services aps JOIN services s ON s.id = aps.service_id WHERE aps.appointment_id = a.id) AS estimated,
       (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.sale_id = pb.sale_id AND p.refunded_at IS NULL) AS paid
     FROM public_bookings pb
     JOIN appointments a ON a.id = pb.appointment_id AND a.company_id = pb.company_id
     LEFT JOIN booking_attributions ba ON ba.appointment_id = pb.appointment_id
     WHERE pb.company_id = ? AND a.canceled = 0 AND pb.canceled_at IS NULL
       AND (pb.source = 'instagram' OR ba.utm_source = 'instagram')
       AND DATE(pb.created_at) BETWEEN ? AND ?${campaign ? ' AND ba.utm_campaign = ?' : ''}`, [companyId, start, end, ...campaignArgs]);

  const cents = value => Math.round(Number(value || 0) * 100);
  const visits = visitRows.reduce((sum, row) => sum + Number(row.visits), 0);
  const totals = metrics.funnel({
    visits,
    bookings: bookingRows.length,
    revenue_estimated_cents: bookingRows.reduce((sum, row) => sum + cents(row.estimated), 0),
    revenue_paid_cents: bookingRows.reduce((sum, row) => sum + cents(row.paid), 0),
  });

  const [snap] = await q(`SELECT SUM(profile_links_taps) AS taps, COUNT(profile_links_taps) AS n FROM instagram_snapshots
     WHERE company_id = ? AND snapshot_date BETWEEN ? AND ?`, [companyId, start, end]);
  totals.profile_links_taps = Number(snap?.n) > 0 ? Number(snap.taps) : null;

  const byCampaign = new Map();
  const slot = name => {
    if (!byCampaign.has(name)) byCampaign.set(name, { utm_campaign: name, visits: 0, bookings: 0, revenue_estimated_cents: 0 });
    return byCampaign.get(name);
  };
  for (const row of visitRows) slot(row.utm_campaign).visits += Number(row.visits);
  for (const row of bookingRows) { const item = slot(row.utm_campaign); item.bookings += 1; item.revenue_estimated_cents += cents(row.estimated); }

  return { period: { from: start, to: end }, totals, by_campaign: [...byCampaign.values()].sort((a, b) => b.bookings - a.bookings || b.visits - a.visits) };
}

module.exports = { normalize, recordVisit, recordBooking, createInstagramLink, listLinks, instagramConversion, pageUrl };
