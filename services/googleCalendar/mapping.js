const crypto = require('node:crypto');
const { wallClock } = require('../../utils/time');

// Funções puras do Google Agenda (F6): id determinístico do evento, corpo do evento exportado,
// hash de conteúdo (reconciliação idempotente) e classificação de eventos importados como ocupado.
const APP_MARK = 'agendaspro';

// base32hex (a-v, 0-9), 5..1024 caracteres. Inclui um sal por instalação para não ser adivinhável
// entre ambientes e para não colidir entre empresas/agendamentos.
const B32HEX = '0123456789abcdefghijklmnopqrstuv';
function base32hex(buffer) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32HEX[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32HEX[(value << (5 - bits)) & 31];
  return out;
}

function eventId(companyId, appointmentId) {
  const salt = process.env.GOOGLE_CALENDAR_EVENT_SALT || 'agendaspro-gcal-v1';
  const digest = crypto.createHash('sha256').update(`${salt}:${companyId}:${appointmentId}`).digest().subarray(0, 20);
  return `ap${base32hex(digest)}`; // "ap" + 32 caracteres
}

// "2026-11-16 09:30" (parede) + minutos -> "2026-11-16T10:30:00" (sem offset; timeZone vai junto).
function addMinutesWall(wall, minutes) {
  const [d, t] = String(wall).replace('T', ' ').split(' ');
  const [y, m, day] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  const date = new Date(Date.UTC(y, m - 1, day, hh, mm + Number(minutes || 0)));
  return date.toISOString().slice(0, 19);
}

const firstName = name => String(name || '').trim().split(/\s+/)[0]?.slice(0, 40) || 'Cliente';

// Minimização (LGPD): primeiro nome do cliente, serviços e profissional. Sem telefone, e-mail,
// endereço ou observações.
function eventBody(appt, { timeZone, appUrl } = {}) {
  const services = (appt.services || []).filter(Boolean).slice(0, 5);
  const summary = `${firstName(appt.customer_name)}${services.length ? ` · ${services.join(', ')}` : ''}`.slice(0, 200);
  const lines = [];
  if (appt.professional_name) lines.push(`Profissional: ${appt.professional_name}`);
  if (services.length) lines.push(`Serviços: ${services.join(', ')}`);
  if (appUrl) lines.push(`Gerencie no AgendasPRO: ${appUrl}`);
  return {
    summary,
    description: lines.join('\n') || undefined,
    start: { dateTime: addMinutesWall(appt.date, 0), timeZone },
    end: { dateTime: addMinutesWall(appt.date, Number(appt.duration) > 0 ? appt.duration : 30), timeZone },
    status: 'confirmed', // PUT reativa um evento apagado no Google (o AgendasPRO é a fonte da verdade)
    transparency: 'opaque',
    visibility: 'private',
    reminders: { useDefault: false },
    extendedProperties: { private: { [APP_MARK]: '1', appointment_id: String(appt.id) } },
  };
}

function contentHash(body, calendarId) {
  return crypto.createHash('sha256').update(JSON.stringify([calendarId, body.summary, body.description || '', body.start, body.end])).digest('hex');
}

// Evento importado -> intervalo ocupado ou motivo para ignorar.
// Ignora: cancelado, transparente (livre), recusado pelo dono, dia inteiro "livre", duração zero e
// eventos criados pelo próprio app (anti-eco).
function busyInterval(event, { ownEventIds } = {}) {
  if (!event || event.status === 'cancelled') return { skip: 'cancelled' };
  if (event.extendedProperties?.private?.[APP_MARK] === '1') return { skip: 'own' };
  if (ownEventIds && ownEventIds.has(event.id)) return { skip: 'own' };
  if (event.transparency === 'transparent') return { skip: 'free' };
  const self = (event.attendees || []).find(a => a.self);
  if (self && self.responseStatus === 'declined') return { skip: 'declined' };
  const start = event.start?.dateTime || (event.start?.date ? `${event.start.date}T00:00:00` : null);
  const end = event.end?.dateTime || (event.end?.date ? `${event.end.date}T00:00:00` : null);
  if (!start || !end) return { skip: 'invalid' };
  const allDay = !event.start?.dateTime;
  return { start, end, allDay, timeZone: event.start?.timeZone || null };
}

// Instante (ISO com offset) ou data local ("YYYY-MM-DDT00:00:00", dia inteiro) -> parede da empresa.
function toCompanyWall(value, tz, allDay) {
  if (allDay) return String(value).replace('T', ' ').slice(0, 16);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return wallClock(date, tz).slice(0, 16);
}

module.exports = { APP_MARK, base32hex, eventId, addMinutesWall, eventBody, contentHash, busyInterval, toCompanyWall, firstName };
