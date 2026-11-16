const crypto = require('node:crypto');
const functions = require('../../utils/functions');
const jobs = require('../jobsService');
const { entitlement } = require('../plansService');
const provider = require('./provider');
const mapping = require('./mapping');
const gcal = require('./service');

// Sincronização do Google Agenda (F6), toda via fila de jobs (tick horário, Heroku Eco):
// - gcal_push {company_id}: reconcilia agendamentos da janela -> eventos (insert/update/delete por
//   hash de conteúdo; id determinístico torna a criação idempotente mesmo após queda no meio).
// - gcal_pull {link_id}: eventos ocupados de um calendário "busy" -> time_blocks (source='google'),
//   incremental por syncToken; 410 = token expirado -> limpa e refaz a sincronização completa.
//   Também renova o canal de push (watch) quando GOOGLE_CALENDAR_WEBHOOK_URL está configurada.
// Payloads só com ids. Falha de autenticação marca reauth_required e não é retentada.
const q = (sql, params = []) => functions.executeSql(sql, params);
const pushDays = () => Math.min(Number(process.env.GOOGLE_CALENDAR_PUSH_DAYS) || 90, 365);
const busyDays = () => Math.min(Number(process.env.GOOGLE_CALENDAR_BUSY_DAYS) || 180, 365);
const maxOps = () => Number(process.env.GOOGLE_CALENDAR_PUSH_MAX_OPS) || 100;
const MAX_PAGES = 40;
const hourBucket = () => Math.floor(Date.now() / 3600000);
const minuteBucket = () => Math.floor(Date.now() / 60000);

async function enqueuePush(companyId, { soon = false } = {}) {
  return jobs.enqueue('gcal_push', { company_id: Number(companyId) }, { dedupeKey: `gcal_push:${companyId}:${soon ? `m${minuteBucket()}` : `h${hourBucket()}`}`, maxAttempts: 5 });
}

async function enqueuePull(linkId, { soon = false } = {}) {
  return jobs.enqueue('gcal_pull', { link_id: Number(linkId) }, { dedupeKey: `gcal_pull:${linkId}:${soon ? `m${minuteBucket()}` : `h${hourBucket()}`}`, maxAttempts: 5 });
}

async function entitled(companyId) {
  const ent = await entitlement(companyId);
  return ent?.features?.[gcal.FEATURE] === true;
}

// Erro de provedor dentro de job: auth -> reauth e encerra; limite/indisponível -> retry com backoff.
async function jobFailure(account, error) {
  if (error?.kind === 'auth' || error?.code === 'google_calendar_reauth_required') {
    if (error.kind === 'auth' && !error.code) await gcal.markReauth(account, error.providerCode);
    return 'reauth';
  }
  throw error;
}

// ---------- push: agendamentos -> Google ----------

async function desiredAppointments(companyId) {
  const rows = await q(
    `SELECT a.id, a.customer_name, DATE_FORMAT(a.date, '%Y-%m-%d %H:%i') AS date, a.duration, a.professional_id, p.name AS professional_name,
            GROUP_CONCAT(s.name ORDER BY s.name SEPARATOR '\\n') AS services
       FROM appointments a
       LEFT JOIN professionals p ON p.id = a.professional_id
       LEFT JOIN appointment_services aps ON aps.appointment_id = a.id
       LEFT JOIN services s ON s.id = aps.service_id
      WHERE a.company_id = ? AND a.canceled = 0 AND a.hold_expires_at IS NULL
        AND a.date >= NOW() - INTERVAL 1 DAY AND a.date < NOW() + INTERVAL ? DAY
      GROUP BY a.id ORDER BY a.date, a.id LIMIT 3000`,
    [companyId, pushDays()],
  );
  return rows.map(r => ({ ...r, services: r.services ? String(r.services).split('\n') : [] }));
}

async function saveMapping(companyId, apptId, link, eventId, hash) {
  await q(
    `INSERT INTO google_calendar_events (company_id, appointment_id, link_id, calendar_id, event_id, content_hash, status, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, 'synced', NOW())
     ON DUPLICATE KEY UPDATE link_id = VALUES(link_id), calendar_id = VALUES(calendar_id), event_id = VALUES(event_id),
       content_hash = VALUES(content_hash), status = 'synced', synced_at = NOW()`,
    [companyId, apptId, link.id, link.calendar_id, eventId, hash],
  );
}

async function upsertEvent(token, link, eventId, body) {
  try {
    await provider.insertEvent(token, link.calendar_id, { id: eventId, ...body });
  } catch (error) {
    if (error.kind !== 'conflict') throw error;
    await provider.updateEvent(token, link.calendar_id, eventId, body); // já existia (retry após queda ou apagado no Google)
  }
}

async function pushJob({ company_id: companyId }) {
  const account = await gcal.accountOf(companyId);
  if (!account || account.status !== 'active') return { skipped: 'not_connected' };
  if (!(await entitled(companyId))) return { skipped: 'plan' };
  const links = await q("SELECT * FROM google_calendar_links WHERE company_id = ? AND role = 'push'", [companyId]);
  if (!links.length) return { skipped: 'no_push_calendar' };
  const byPro = new Map(links.map(l => [Number(l.pro_key), l]));
  const timeZone = await gcal.companyTimezone(companyId);
  const appUrl = process.env.URL_SITE ? String(process.env.URL_SITE).replace(/\/+$/, '') : undefined;

  let token;
  try { token = await gcal.accessToken(account); } catch (error) { return { skipped: await jobFailure(account, error) }; }

  const mapped = new Map((await q('SELECT * FROM google_calendar_events WHERE company_id = ?', [companyId])).map(m => [Number(m.appointment_id), m]));
  const stats = { inserted: 0, updated: 0, moved: 0, deleted: 0, unchanged: 0, errors: 0 };
  let ops = 0;
  const budget = maxOps();
  try {
    // Cancelados/apagados (ou hold vencido) que ainda têm evento -> remove do Google.
    const stale = await q(
      `SELECT e.* FROM google_calendar_events e
         LEFT JOIN appointments a ON a.id = e.appointment_id AND a.company_id = e.company_id
        WHERE e.company_id = ? AND (a.id IS NULL OR a.canceled <> 0 OR (a.hold_expires_at IS NOT NULL AND a.hold_expires_at <= NOW()))`,
      [companyId],
    );
    for (const row of stale) {
      if (ops >= budget) break;
      ops++;
      await provider.deleteEvent(token, row.calendar_id, row.event_id);
      await q('DELETE FROM google_calendar_events WHERE company_id = ? AND appointment_id = ?', [companyId, row.appointment_id]);
      mapped.delete(Number(row.appointment_id));
      stats.deleted++;
    }
    for (const appt of await desiredAppointments(companyId)) {
      if (ops >= budget) break;
      const link = byPro.get(Number(appt.professional_id || 0)) || byPro.get(0);
      if (!link) continue; // profissional sem destino e sem calendário padrão
      const body = mapping.eventBody(appt, { timeZone, appUrl });
      const hash = mapping.contentHash(body, link.calendar_id);
      const current = mapped.get(Number(appt.id));
      if (current && current.content_hash === hash && current.calendar_id === link.calendar_id) { stats.unchanged++; continue; }
      const eventId = current?.event_id || mapping.eventId(companyId, appt.id);
      ops++;
      try {
        if (current && current.calendar_id !== link.calendar_id) {
          await provider.deleteEvent(token, current.calendar_id, current.event_id);
          await upsertEvent(token, link, eventId, body);
          stats.moved++;
        } else if (current) {
          try {
            await provider.updateEvent(token, link.calendar_id, eventId, body);
          } catch (error) {
            if (error.kind !== 'not_found') throw error;
            await upsertEvent(token, link, eventId, body);
          }
          stats.updated++;
        } else {
          await upsertEvent(token, link, eventId, body);
          stats.inserted++;
        }
        await saveMapping(companyId, appt.id, link, eventId, hash);
      } catch (error) {
        if (error.retryable || error.kind === 'auth') throw error;
        stats.errors++; // evento recusado (ex.: calendário removido no Google): segue com os demais
        await q('UPDATE google_calendar_accounts SET last_error_code = ? WHERE id = ?', [`push:${error.providerCode || error.kind || 'error'}`.slice(0, 60), account.id]);
      }
    }
  } catch (error) {
    return { skipped: await jobFailure(account, error), stats };
  }
  await q('UPDATE google_calendar_accounts SET last_push_at = NOW() WHERE id = ?', [account.id]);
  if (ops >= budget) await enqueuePush(companyId, { soon: true }); // continua no próximo tick/drenagem
  return stats;
}

// ---------- pull: calendários "busy" -> time_blocks ----------

const externalRef = (linkId, eventId) => {
  const ref = `${linkId}:${eventId}`;
  return ref.length <= 255 ? ref : `${linkId}:h${crypto.createHash('sha256').update(String(eventId)).digest('hex')}`;
};

function blockFor(event, { tz, ownEventIds, now }) {
  const busy = mapping.busyInterval(event, { ownEventIds });
  if (busy.skip) return null;
  const startMs = new Date(busy.allDay ? `${busy.start}Z` : busy.start).getTime();
  const endMs = new Date(busy.allDay ? `${busy.end}Z` : busy.end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (endMs < now - 86400000 || startMs > now + busyDays() * 86400000) return null; // fora da janela
  const startsAt = mapping.toCompanyWall(busy.start, tz, busy.allDay);
  const endsAt = mapping.toCompanyWall(busy.end, tz, busy.allDay);
  if (!startsAt || !endsAt || endsAt <= startsAt) return null; // duração zero/negativa (CHECK do banco)
  return { startsAt, endsAt };
}

async function upsertBlock(link, ref, block) {
  await q(
    `INSERT INTO time_blocks (company_id, professional_id, starts_at, ends_at, reason, source, external_ref, link_id)
     VALUES (?, ?, ?, ?, 'Ocupado (Google Agenda)', 'google', ?, ?)
     ON DUPLICATE KEY UPDATE professional_id = VALUES(professional_id), starts_at = VALUES(starts_at), ends_at = VALUES(ends_at), link_id = VALUES(link_id)`,
    [link.company_id, link.professional_id || null, block.startsAt, block.endsAt, ref, link.id],
  );
}

async function clearLinkBlocks(link) {
  await q("DELETE FROM time_blocks WHERE company_id = ? AND source = 'google' AND link_id = ?", [link.company_id, link.id]);
}

async function readAll(token, link, { syncToken }) {
  const items = [];
  let pageToken = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await provider.listEventsPage(token, link.calendar_id, syncToken ? { syncToken, pageToken } : { timeMin: new Date(Date.now() - 86400000).toISOString(), pageToken });
    items.push(...res.items);
    if (res.nextPageToken) { pageToken = res.nextPageToken; continue; }
    return { items, nextSyncToken: res.nextSyncToken };
  }
  return { items, nextSyncToken: null }; // calendário enorme: aplica o que leu; sem token, tenta completo de novo
}

async function pullJob({ link_id: linkId }) {
  const [link] = await q("SELECT * FROM google_calendar_links WHERE id = ? AND role = 'busy'", [linkId]);
  if (!link) return { skipped: 'no_link' };
  const account = await gcal.accountOf(link.company_id);
  if (!account || account.status !== 'active') return { skipped: 'not_connected' };
  if (!(await entitled(link.company_id))) {
    // Plano sem a feature: bloqueios importados deixam de valer (não ficam bloqueando agenda velha).
    await clearLinkBlocks(link);
    await q('UPDATE google_calendar_links SET sync_token = NULL WHERE id = ?', [link.id]);
    return { skipped: 'plan' };
  }
  let token;
  try { token = await gcal.accessToken(account); } catch (error) { return { skipped: await jobFailure(account, error) }; }
  const tz = await gcal.companyTimezone(link.company_id);
  const ownEventIds = new Set((await q('SELECT event_id FROM google_calendar_events WHERE company_id = ? ORDER BY synced_at DESC LIMIT 5000', [link.company_id])).map(r => r.event_id));
  const now = Date.now();
  const stats = { full: !link.sync_token, upserted: 0, removed: 0, reset: false };
  try {
    let result;
    try {
      result = await readAll(token, link, { syncToken: link.sync_token });
    } catch (error) {
      if (error.kind !== 'gone') throw error;
      stats.reset = true; // 410: syncToken inválido -> descarta e refaz completo
      stats.full = true;
      await q('UPDATE google_calendar_links SET sync_token = NULL WHERE id = ?', [link.id]);
      result = await readAll(token, link, { syncToken: null });
    }
    const seen = [];
    for (const event of result.items) {
      if (!event?.id) continue;
      const ref = externalRef(link.id, event.id);
      const block = blockFor(event, { tz, ownEventIds, now });
      if (block) {
        await upsertBlock(link, ref, block);
        seen.push(ref);
        stats.upserted++;
      } else if (!stats.full) {
        const del = await q("DELETE FROM time_blocks WHERE company_id = ? AND source = 'google' AND external_ref = ?", [link.company_id, ref]);
        stats.removed += del.affectedRows || 0;
      }
    }
    if (stats.full && result.nextSyncToken) {
      // Completo: o que não veio não existe mais (ou saiu da janela).
      const del = seen.length
        ? await q("DELETE FROM time_blocks WHERE company_id = ? AND source = 'google' AND link_id = ? AND external_ref NOT IN (?)", [link.company_id, link.id, seen])
        : await q("DELETE FROM time_blocks WHERE company_id = ? AND source = 'google' AND link_id = ?", [link.company_id, link.id]);
      stats.removed += del.affectedRows || 0;
    }
    await q(
      `UPDATE google_calendar_links SET sync_token = ?, last_sync_at = NOW(), last_full_sync_at = IF(?, NOW(), last_full_sync_at) WHERE id = ?`,
      [result.nextSyncToken || null, stats.full ? 1 : 0, link.id],
    );
  } catch (error) {
    return { skipped: await jobFailure(account, error), stats };
  }
  await ensureChannel(token, link).catch(() => {}); // canal é otimização: o tick horário é o fallback
  return stats;
}

// ---------- canal de notificações (watch) ----------

function webhookAddress() {
  const url = process.env.GOOGLE_CALENDAR_WEBHOOK_URL;
  return url && /^https:\/\//.test(url) ? url : null;
}

async function ensureChannel(token, link) {
  const address = webhookAddress();
  if (!address) return null;
  const renewBefore = Date.now() + 24 * 3600000;
  if (link.channel_id && link.channel_expires_at && new Date(link.channel_expires_at).getTime() > renewBefore) return null;
  if (link.channel_id && link.channel_resource_id) {
    await provider.stopChannel(token, { id: link.channel_id, resourceId: link.channel_resource_id }).catch(() => {});
  }
  const id = `gc${gcal.randomToken(24)}`;
  const channelToken = gcal.randomToken(32);
  const ttlSec = Number(process.env.GOOGLE_CALENDAR_WATCH_TTL_SEC) || 7 * 86400;
  const res = await provider.watch(token, link.calendar_id, { id, address, channelToken, ttlSec });
  const expires = res.expiration || new Date(Date.now() + ttlSec * 1000);
  await q('UPDATE google_calendar_links SET channel_id = ?, channel_token_hash = ?, channel_resource_id = ?, channel_expires_at = ? WHERE id = ?',
    [id, gcal.sha256(channelToken), res.resourceId, expires, link.id]);
  return id;
}

// Notificação do Google (headers X-Goog-*). Retorna o status HTTP. Valida canal + token (hash, tempo
// constante) + resourceId; "sync" só confirma o canal; demais estados enfileiram um pull (dedupe por
// canal/mensagem em inbound_events e por minuto na fila).
async function handleNotification(headers) {
  const channelId = String(headers['x-goog-channel-id'] || '');
  const channelToken = String(headers['x-goog-channel-token'] || '');
  const resourceId = String(headers['x-goog-resource-id'] || '');
  const state = String(headers['x-goog-resource-state'] || '');
  const messageNumber = String(headers['x-goog-message-number'] || '');
  if (!channelId || channelId.length > 64 || !channelToken || channelToken.length > 256) return 400;
  const [link] = await q('SELECT id, company_id, channel_token_hash, channel_resource_id FROM google_calendar_links WHERE channel_id = ?', [channelId]);
  if (!link || !link.channel_token_hash) return 404;
  const a = Buffer.from(gcal.sha256(channelToken));
  const b = Buffer.from(String(link.channel_token_hash));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 403;
  if (link.channel_resource_id && resourceId && resourceId !== link.channel_resource_id) return 403;
  if (state === 'sync') return 204;
  if (messageNumber) {
    const ins = await q("INSERT IGNORE INTO inbound_events (provider, external_id, event_type, payload, status) VALUES ('google_calendar', ?, ?, NULL, 'processed')",
      [`${channelId}:${messageNumber}`.slice(0, 190), state.slice(0, 60) || 'exists']);
    if (!ins.affectedRows) return 204; // reentrega
  }
  await enqueuePull(link.id, { soon: true });
  jobs.drainSoon();
  return 204;
}

// ---------- produtores horários ----------

async function enqueuePushes() {
  const rows = await q(`SELECT a.company_id FROM google_calendar_accounts a
     WHERE a.status = 'active' AND EXISTS (SELECT 1 FROM google_calendar_links l WHERE l.company_id = a.company_id AND l.role = 'push')`);
  let n = 0;
  for (const row of rows) if (await enqueuePush(row.company_id)) n++;
  return n;
}

async function enqueuePulls() {
  const rows = await q(`SELECT l.id FROM google_calendar_links l JOIN google_calendar_accounts a ON a.id = l.account_id
     WHERE l.role = 'busy' AND a.status = 'active'`);
  let n = 0;
  for (const row of rows) if (await enqueuePull(row.id)) n++;
  return n;
}

module.exports = { enqueuePush, enqueuePull, pushJob, pullJob, handleNotification, ensureChannel, enqueuePushes, enqueuePulls, externalRef, blockFor };
