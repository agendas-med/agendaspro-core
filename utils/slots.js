const { wallMinutes, wallWeekday, minutesToWall, timeToMinutes } = require('./time');

// Cálculo puro de horários livres (sem banco), usado pela disponibilidade pública.
// A reserva continua validada por ensureSlot dentro da transação: esta função só sugere horários,
// com a mesma regra de conflito (mesmo profissional ou agendamento sem profissional; bloqueio da
// empresa ou do profissional; dentro do expediente cadastrado).
//
// Todas as horas são "parede" no fuso da empresa, em minutos (wallMinutes).
// - professionals: ids candidatos (já filtrados por serviço);
// - rules: [{ professional_id, weekday, start_time:'HH:mm', end_time:'HH:mm' }];
// - busy/blocks: [{ start, end, professional_id|null }] em minutos;
// - minStart: primeiro minuto aceitável (agora + antecedência mínima).
const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && aEnd > bStart;
const touches = (item, professionalId) => item.professional_id === null || item.professional_id === undefined || Number(item.professional_id) === Number(professionalId);

function isFree({ professionalId, start, end, busy = [], blocks = [] }) {
  return !busy.some(item => touches(item, professionalId) && overlaps(start, end, item.start, item.end))
    && !blocks.some(item => touches(item, professionalId) && overlaps(start, end, item.start, item.end));
}

function daySlots({ date, professionals, duration, step, minStart, maxStart = Infinity, rules, busy, blocks }) {
  const dayStart = wallMinutes(`${date} 00:00`);
  const weekday = wallWeekday(`${date} 00:00`);
  const out = [];
  for (const professionalId of professionals) {
    const windows = rules.filter(rule => Number(rule.professional_id) === Number(professionalId) && Number(rule.weekday) === weekday);
    const seen = new Set();
    for (const rule of windows) {
      const ruleStart = timeToMinutes(rule.start_time);
      const ruleEnd = timeToMinutes(rule.end_time);
      for (let t = ruleStart; t + duration <= ruleEnd; t += step) {
        const start = dayStart + t;
        if (start < minStart || start > maxStart || seen.has(t)) continue;
        if (!isFree({ professionalId, start, end: start + duration, busy, blocks })) continue;
        seen.add(t);
        out.push({ start: minutesToWall(start).slice(11, 16), professional_id: Number(professionalId), _t: t });
      }
    }
  }
  out.sort((a, b) => a._t - b._t || a.professional_id - b.professional_id);
  return out.map(({ _t, ...slot }) => slot);
}

// Lista de datas YYYY-MM-DD de from até to (inclusivo).
function dateRange(from, to) {
  const days = [];
  for (let m = wallMinutes(`${from} 00:00`), end = wallMinutes(`${to} 00:00`); m <= end; m += 1440) days.push(minutesToWall(m).slice(0, 10));
  return days;
}

module.exports = { daySlots, isFree, dateRange, overlaps };
