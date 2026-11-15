// Fuso por empresa. As datas de agendamento no banco são "hora de parede" no fuso da empresa
// (companies.timezone; fallback APP_TIMEZONE; padrão America/Sao_Paulo). Não usamos CONVERT_TZ
// com nomes IANA (as tabelas de fuso podem não existir no banco de produção): o "agora" local
// de cada empresa é calculado em Node com Intl.
const DEFAULT_TZ = 'America/Sao_Paulo';

function defaultTimezone() {
  const env = process.env.APP_TIMEZONE;
  return env && isValidTimezone(env) ? env : DEFAULT_TZ;
}

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function resolveTimezone(tz) {
  return tz && isValidTimezone(tz) ? tz : defaultTimezone();
}

// Date (instante) -> "YYYY-MM-DD HH:mm:ss" no fuso informado.
function wallClock(date, tz = defaultTimezone()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: resolveTimezone(tz), hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

// "YYYY-MM-DD HH:mm[:ss]" -> minutos desde a época tratando a hora de parede como UTC.
// Serve para comparar/somar horas de parede de um mesmo fuso sem depender do fuso do processo.
function wallMinutes(value) {
  const text = value instanceof Date ? null : String(value);
  if (text === null) throw new TypeError('Use hora de parede em texto.');
  const m = WALL_RE.exec(text);
  if (!m) throw Object.assign(new Error('Data/hora inválida (use YYYY-MM-DD HH:mm).'), { status: 400 });
  const [, y, mo, d, h, mi, s = '0'] = m;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== +y || check.getUTCMonth() !== +mo - 1 || check.getUTCDate() !== +d || +h > 23 || +mi > 59 || +s > 59) {
    throw Object.assign(new Error('Data/hora inválida.'), { status: 400 });
  }
  return Math.floor(ms / 60000);
}

function minutesToWall(minutes) {
  return new Date(minutes * 60000).toISOString().slice(0, 19).replace('T', ' ');
}

// Dia da semana (0 = domingo) de uma hora de parede.
function wallWeekday(value) {
  return new Date(wallMinutes(value) * 60000).getUTCDay();
}

// "HH:mm[:ss]" -> minutos do dia.
function timeToMinutes(value) {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value));
  if (!m || +m[1] > 24 || +m[2] > 59) throw Object.assign(new Error('Horário inválido (use HH:mm).'), { status: 400 });
  return +m[1] * 60 + +m[2];
}

// Normaliza Date (lido do banco) ou texto para "YYYY-MM-DD HH:mm:ss" de parede.
// O driver lê DATETIME com timezone '-03:00' (mysql.js); para voltar à parede do banco,
// formatamos no mesmo deslocamento fixo.
function dbWall(value) {
  if (value instanceof Date) return minutesToWall(Math.floor(value.getTime() / 60000) - 180);
  return minutesToWall(wallMinutes(String(value).slice(0, 19)));
}

module.exports = { DEFAULT_TZ, defaultTimezone, isValidTimezone, resolveTimezone, wallClock, wallMinutes, minutesToWall, wallWeekday, timeToMinutes, dbWall };
