const guard = require('../ai/guard');

// Roteador determinístico: perguntas frequentes viram consultas pré-definidas + templates, sem IA.
// Só intenções de LEITURA. Qualquer verbo de escrita desvia para o classificador (que no máximo
// propõe uma ação para confirmação humana).

const fold = text => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const WRITE_VERBS = /\b(marcar|marque|marca|agendar|agende|agenda (um|uma|o|a) |criar|crie|cria|cadastrar|cadastre|cancelar|cancele|cancela|desmarcar|desmarque|remarcar|remarque|reagendar|reagende|alterar|altere|altera|editar|edite|mudar|mude|muda|ajustar|ajuste|adicionar|adicione|acrescentar|acrescente|remover|remova|retirar|bloquear|bloqueie|bloqueia|excluir|exclua|apagar|apague|deletar|delete|dar entrada|dar baixa|lancar|lance|trocar|troque|mover|mova|atualizar|atualize)\b/;
const CONFIRM_TEXT = /^(sim|ok|pode|confirmo|confirmar|confirma|confirmado|pode (executar|fazer|confirmar|seguir)|execute|executar|faz|faca|manda ver|aprovo|aprovado)\b/;

function period(text) {
  if (/\bmes passado\b|\bultimo mes\b/.test(text)) return 'last_month';
  if (/\bamanha\b/.test(text)) return 'tomorrow';
  if (/\b(esta|essa|nesta|nessa|da|proxima|proximos 7 dias|na) semana\b|\bsemana\b/.test(text)) return 'week';
  if (/\b(este|esse|neste|nesse|do|no) mes\b|\bmes\b|\bmensal\b/.test(text)) return 'month';
  if (/\bhoje\b|\bdo dia\b/.test(text)) return 'today';
  return null;
}

const RULES = [
  {
    intent: 'next_appointment',
    test: t => /\bproxim[oa]s? (cliente|clientes|atendimento|atendimentos|agendamento|agendamentos|paciente|pacientes|horario)\b|\bquem (e|eh) (o|a) proxim[oa]\b/.test(t),
    tool: 'next_appointment', args: () => ({}),
  },
  {
    intent: 'low_stock',
    test: t => /\b(estoque|insumos?|produtos?|materia(l|is))\b/.test(t) && /\b(baix[oa]s?|acabando|faltando|falta|minimo|repor|reposicao|zerad[oa]s?|vazios?|esgotad[oa]s?|comprar)\b/.test(t),
    tool: 'list_stock', args: () => ({ only_low: true }),
  },
  {
    intent: 'stock',
    test: t => /^(como (esta|anda) (o|meu) )?(meu |o )?estoque\??$|\b(ver|mostrar?|mostre|liste|lista|qual|como esta) (o |meu )?estoque\b/.test(t),
    tool: 'list_stock', args: () => ({}),
  },
  {
    intent: 'revenue',
    test: t => /\b(faturamento|faturei|faturou|receita|financeiro|a receber|recebid[oa]s?|quanto (eu )?(ganhei|recebi|faturei|vendi|entrou)|resumo financeiro)\b/.test(t),
    tool: 'financial_summary', args: t => ({ period: period(t) || 'month' }),
  },
  {
    intent: 'appointments_report',
    test: t => /\b(quantos|quantas|relatorio|total de) (agendamentos|atendimentos|consultas|horarios)\b/.test(t) && !!period(t),
    tool: 'appointments_report', args: t => ({ period: period(t) || 'month' }),
  },
  {
    intent: 'schedule',
    test: t => /\b(agenda|agendamentos?|atendimentos?|compromissos?|consultas?|horarios marcados|clientes)\b/.test(t) && ['today', 'tomorrow', 'week'].includes(period(t)),
    tool: 'get_schedule', args: t => ({ period: period(t) }),
  },
  {
    intent: 'services',
    test: t => /\b(quais|liste|lista|listar|mostre|mostrar|ver|meus) (os |meus )?(servicos|procedimentos)\b|\btabela de precos\b|^servicos\??$/.test(t),
    tool: 'list_services', args: () => ({}),
  },
];

// Devolve { kind:'read', intent, tool, args } | { kind:'confirm_text' } | null (ambíguo => IA).
function match(raw) {
  const text = fold(raw);
  if (!text) return null;
  if (CONFIRM_TEXT.test(text) && text.length <= 60) return { kind: 'confirm_text', intent: 'confirm_text' };
  if (WRITE_VERBS.test(text)) return null;
  for (const rule of RULES) if (rule.test(text)) return { kind: 'read', intent: rule.intent, tool: rule.tool, args: rule.args(text) };
  return null;
}

// ---------- templates (sem IA) ----------

const brl = v => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;
const dm = d => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '');
const hm = w => (w ? String(w).slice(11, 16) : '');
const name = v => guard.oneLine(v, 60);
const STATUS = { agendado: 'agendado', pendente_pagamento: 'pagamento pendente', em_andamento: 'em andamento', concluido: 'concluído', cancelado: 'cancelado' };
const PERIOD_LABEL = { today: 'hoje', tomorrow: 'amanhã', week: 'nos próximos 7 dias', month: 'neste mês', last_month: 'no mês passado' };
const rangeLabel = (args, range) => PERIOD_LABEL[args.period] || (range.from === range.to ? `em ${dm(range.from)}` : `de ${dm(range.from)} a ${dm(range.to)}`);

function apptLine(a) {
  const services = (a.services || []).map(name).join(', ');
  return `• ${dm(a.start)} ${hm(a.start)}–${hm(a.end)} · ${name(a.customer_name)}${services ? ` · ${services}` : ''} · ${STATUS[a.status] || a.status}`;
}

const TEMPLATES = {
  get_schedule(data, args) {
    const items = data.items.filter(a => a.status !== 'cancelado');
    if (!items.length) return `Nenhum agendamento ${rangeLabel(args, data.range)}.`;
    const lines = items.slice(0, 15).map(apptLine);
    const more = items.length > 15 ? `\n… e mais ${items.length - 15}.` : '';
    return `Agenda ${rangeLabel(args, data.range)}: ${items.length} agendamento(s).\n${lines.join('\n')}${more}`;
  },
  next_appointment(data) {
    if (!data.items.length) return 'Não há próximos atendimentos marcados.';
    const [first, ...rest] = data.items;
    return `Próximo atendimento: ${name(first.customer_name)} em ${dm(first.start)} às ${hm(first.start)}${first.services.length ? ` (${first.services.map(name).join(', ')})` : ''}.${rest.length ? `\nDepois: ${rest.map(a => `${name(a.customer_name)} às ${hm(a.start)} (${dm(a.start)})`).join('; ')}.` : ''}`;
  },
  list_stock(data, args) {
    if (!data.items.length) return args.only_low ? `Nenhum insumo com estoque baixo (limite: ${data.threshold}).` : 'Nenhum insumo cadastrado.';
    const lines = data.items.slice(0, 20).map(p => `• ${name(p.name)}: ${p.quantity}${p.unit ? ` ${p.unit}` : ''}${p.low && !args.only_low ? ' (baixo)' : ''}`);
    return `${args.only_low ? `Insumos com estoque baixo (≤ ${data.threshold})` : 'Estoque'}: ${data.items.length} item(ns).\n${lines.join('\n')}${data.items.length > 20 ? `\n… e mais ${data.items.length - 20}.` : ''}`;
  },
  financial_summary(data, args) {
    return `Financeiro ${rangeLabel(args, data.range)} (${data.appointments} atendimento(s)): total ${brl(data.total)}, recebido ${brl(data.received)}, em aberto ${brl(data.open)}, atrasado ${brl(data.overdue)}.`;
  },
  appointments_report(data, args) {
    const parts = Object.entries(data.by_status).map(([k, v]) => `${STATUS[k] || k}: ${v}`);
    return `Agendamentos ${rangeLabel(args, data.range)}: ${data.total}${parts.length ? ` (${parts.join(', ')})` : ''}.`;
  },
  list_services(data) {
    if (!data.items.length) return 'Nenhum serviço cadastrado.';
    return `Serviços (${data.items.length}):\n${data.items.slice(0, 25).map(s => `• ${name(s.name)}: ${brl(s.value)} · ${s.duration_min} min`).join('\n')}`;
  },
  find_customers(data) {
    if (!data.items.length) return 'Nenhum cliente encontrado.';
    return `Clientes encontrados (${data.total}):\n${data.items.slice(0, 10).map(c => `• #${c.id} ${name(c.name)}${c.phone_end ? ` (tel. ${c.phone_end})` : ''}`).join('\n')}`;
  },
  check_availability(data) {
    const days = data.days.filter(d => d.slots.length);
    if (!days.length) return 'Não encontrei horários livres no período.';
    return `Horários livres (${data.duration_min} min):\n${days.map(d => `• ${dm(d.date)}: ${[...new Set(d.slots.map(s => s.start))].slice(0, 10).join(', ')}`).join('\n')}`;
  },
  search_knowledge(data) {
    if (!data.items.length) return 'Não encontrei nada sobre isso nas informações cadastradas.';
    return `Encontrei nas informações cadastradas:\n${data.items.slice(0, 3).map(i => `• ${guard.oneLine(i.text, 200)}`).join('\n')}`;
  },
};

function render(tool, data, args = {}) {
  const fn = TEMPLATES[tool];
  return fn ? fn(data, args) : 'Consulta concluída.';
}

const HELP = 'Posso responder, por exemplo: "agenda de hoje", "próximo cliente", "faturamento do mês", "estoque baixo", "meus serviços". No plano Premium também preparo ações (agendar, remarcar, cancelar, ajustar estoque) para você confirmar.';

module.exports = { match, render, fold, HELP, period };
