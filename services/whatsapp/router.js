const provider = require('./provider');

// Máquina de estados determinística do bot (menus, botões, listas, palavras-chave).
// step() não fala com a Meta nem grava a conversa: recebe a conversa e a entrada e devolve o
// novo estado + respostas. Dependências (agenda, IA, reservas) são injetadas -> testável.
//
// Estados: start -> menu -> book_service -> book_professional -> book_date -> book_time ->
//          book_name -> book_confirm -> menu | my_list -> my_action -> cancel_confirm |
//          resched_date -> resched_time -> menu | (human: modo atendente)
const MENU_WORDS = /^(menu|0|in[ií]cio|inicio|voltar|oi|ol[aá]|bom dia|boa tarde|boa noite)$/;
const HUMAN_WORDS = /^(atendente|humano|pessoa|falar com (um )?atendente|falar com (uma )?pessoa)$/;
const SWITCH_WORDS = /^(trocar|trocar cl[ií]nica|trocar estabelecimento|outra cl[ií]nica)$/;
const SLUG_RE = /^[a-z0-9-]{3,60}$/;
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const DAYS_AHEAD = 14;
const PAGE = 9;

const norm = text => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const brDate = date => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const weekday = date => WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
const money = cents => (Number(cents) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

const say = body => ({ message: provider.text(body), body });
const ask = (body, items) => ({ message: provider.buttons(body, items), body });
const pick = (body, label, rows) => ({ message: provider.list(body, label, rows), body: `${body}\n${rows.map(r => `- ${r.title}`).join('\n')}` });

const MENU_BUTTONS = [
  { id: 'm:book', title: 'Agendar' },
  { id: 'm:mine', title: 'Meus agendamentos' },
  { id: 'm:human', title: 'Falar com atendente' },
];

const LGPD = 'Ao confirmar, você autoriza o uso do seu nome e telefone para este agendamento e para avisos sobre ele (LGPD). Para parar de receber mensagens, responda PARAR.';

function menu(ctx, prefix = '') {
  return { state: 'menu', context: keep(ctx), replies: [ask(`${prefix}${prefix ? '\n\n' : ''}${ctx.companyName ? `*${ctx.companyName}* — ` : ''}como posso ajudar?`, MENU_BUTTONS)] };
}

// Mantém só o que identifica a empresa e o contador de fluxo entre um fluxo e outro.
const keep = ctx => ({ slug: ctx.slug, companyName: ctx.companyName, seq: ctx.seq || 0 });

function startPrompt() {
  return {
    state: 'start', companyId: null, context: {},
    replies: [say('Olá! Eu sou o assistente de agendamentos do AgendasPRO. Para começar, envie o código do estabelecimento (é o final do link de agendamento, ex.: *clinica-exemplo*).')],
  };
}

// Identifica a empresa por um token da mensagem (slug) ou por id de botão (co:<slug>).
async function identify(input, deps) {
  const candidates = [];
  if (input.replyId?.startsWith('co:')) candidates.push(input.replyId.slice(3));
  for (const token of norm(input.text).split(/[\s,;/!?]+/)) if (SLUG_RE.test(token)) candidates.push(token);
  for (const slug of [...new Set(candidates)].slice(0, 5)) {
    const found = await deps.findCompany(slug);
    if (found) return found;
  }
  return null;
}

function servicePicker(ctx, business, prefix = '') {
  if (!business.services.length) return menu(ctx, 'No momento não há serviços com agendamento online. Fale com um atendente.');
  const rows = business.services.slice(0, 10).map(s => ({
    id: `s:${s.id}`, title: s.name,
    description: `${s.duration_min} min${s.price_cents ? ` · ${money(s.price_cents)}` : ''}${s.requires_payment ? ` · sinal ${money(s.deposit_cents)}` : ''}`,
  }));
  return { state: 'book_service', context: { ...keep(ctx) }, replies: [pick(`${prefix}${prefix ? '\n\n' : ''}Qual serviço você quer agendar?`, 'Ver serviços', rows)] };
}

function professionalPicker(ctx, business) {
  const pros = business.professionals.filter(p => p.service_ids.includes(ctx.serviceId));
  if (!pros.length) return menu(ctx, 'Este serviço está sem profissional disponível no momento.');
  if (pros.length === 1) return { next: { ...ctx, professionalId: pros[0].id, professionalName: pros[0].name } };
  const rows = [{ id: 'p:any', title: 'Qualquer profissional' }, ...pros.slice(0, 9).map(p => ({ id: `p:${p.id}`, title: p.name }))];
  return { state: 'book_professional', context: ctx, replies: [pick('Com qual profissional?', 'Escolher', rows)] };
}

async function datePicker(ctx, deps, { state = 'book_date', prefix = '' } = {}) {
  const from = deps.today();
  const avail = await deps.availability(ctx.slug, { serviceIds: ctx.serviceIds || [ctx.serviceId], professionalId: ctx.professionalId || null, from, to: addDays(from, DAYS_AHEAD - 1) });
  const days = avail.days.filter(d => d.slots.length).slice(0, 10);
  if (!days.length) return menu(ctx, `${prefix}Não encontrei horários livres nos próximos ${DAYS_AHEAD} dias. Fale com um atendente.`);
  const rows = days.map(d => ({ id: `d:${d.date}`, title: `${weekday(d.date)} ${brDate(d.date)}`, description: `${d.slots.length} horário(s)` }));
  return { state, context: ctx, replies: [pick(`${prefix}${prefix ? '\n\n' : ''}Escolha o dia:`, 'Ver dias', rows)] };
}

async function timePicker(ctx, deps, { state = 'book_time', offset = 0, prefix = '' } = {}) {
  const avail = await deps.availability(ctx.slug, { serviceIds: ctx.serviceIds || [ctx.serviceId], professionalId: ctx.professionalId || null, from: ctx.date, to: ctx.date });
  const times = [...new Set((avail.days[0]?.slots || []).map(s => s.start))];
  if (!times.length) return datePicker({ ...ctx, date: null }, deps, { state: state === 'book_time' ? 'book_date' : 'resched_date', prefix: 'Esse dia não tem mais horários livres.' });
  const page = times.slice(offset, offset + PAGE);
  const rows = page.map(t => ({ id: `t:${t}`, title: t }));
  if (times.length > offset + PAGE) rows.push({ id: `t:more:${offset + PAGE}`, title: 'Mais horários' });
  return { state, context: { ...ctx, timeOffset: offset }, replies: [pick(`${prefix}${prefix ? '\n\n' : ''}Horários em ${weekday(ctx.date)} ${brDate(ctx.date)}:`, 'Ver horários', rows)] };
}

function confirmPrompt(ctx) {
  const lines = [
    'Confere os dados:',
    `*${ctx.serviceName}*`,
    `${weekday(ctx.date)} ${brDate(ctx.date)} às *${ctx.time}*`,
    ctx.professionalName ? `Com: ${ctx.professionalName}` : 'Com: primeiro profissional disponível',
    `Nome: ${ctx.name}`,
    ctx.depositCents ? `Sinal via Pix: ${money(ctx.depositCents)} (o horário fica reservado até o pagamento)` : null,
    '', LGPD,
  ].filter(v => v !== null).join('\n');
  return { state: 'book_confirm', context: ctx, replies: [ask(lines, [{ id: 'c:yes', title: 'Confirmar' }, { id: 'c:no', title: 'Cancelar' }])] };
}

// Interpreta "16/11", "16/11/2026" ou "2026-11-16".
function parseDate(text, todayDate) {
  const t = norm(text);
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return null;
  let year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : Number(todayDate.slice(0, 4));
  const candidate = `${year}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  if (!m[3] && candidate < todayDate) year += 1;
  return `${year}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}

const parseTime = text => {
  const m = norm(text).match(/^(\d{1,2})(?::|h)?(\d{2})?$/);
  if (!m || Number(m[1]) > 23) return null;
  return `${String(m[1]).padStart(2, '0')}:${m[2] || '00'}`;
};

async function afterProfessional(ctx, deps) {
  if (ctx.date) {
    const r = await timePicker(ctx, deps);
    if (ctx.time && r.state === 'book_time') return chooseTime(ctx, ctx.time, deps);
    return r;
  }
  return datePicker(ctx, deps);
}

async function chooseService(ctx, business, serviceId, deps) {
  const service = business.services.find(s => s.id === serviceId);
  if (!service) return servicePicker(ctx, business, 'Não encontrei esse serviço.');
  const next = { ...ctx, serviceId: service.id, serviceName: service.name, depositCents: service.deposit_cents || 0, professionalId: null, professionalName: null };
  if (ctx.professionalId && business.professionals.some(p => p.id === ctx.professionalId && p.service_ids.includes(service.id))) {
    next.professionalId = ctx.professionalId;
    next.professionalName = business.professionals.find(p => p.id === ctx.professionalId).name;
    return afterProfessional(next, deps);
  }
  const picked = professionalPicker(next, business);
  if (picked.next) return afterProfessional(picked.next, deps);
  return picked;
}

async function chooseTime(ctx, time, deps) {
  const avail = await deps.availability(ctx.slug, { serviceIds: [ctx.serviceId], professionalId: ctx.professionalId || null, from: ctx.date, to: ctx.date });
  if (!(avail.days[0]?.slots || []).some(s => s.start === time)) return timePicker(ctx, deps, { prefix: 'Esse horário não está livre.' });
  const next = { ...ctx, time };
  const known = await deps.knownCustomerName(ctx);
  if (known) return confirmPrompt({ ...next, name: known });
  return { state: 'book_name', context: next, replies: [say('Qual é o seu nome completo?')] };
}

async function book(ctx, deps) {
  const seq = (ctx.seq || 0) + 1;
  try {
    const result = await deps.createBooking(ctx.slug, {
      service_ids: [ctx.serviceId],
      professional_id: ctx.professionalId || null,
      start: `${ctx.date}T${ctx.time}`,
      customer: { name: ctx.name, phone: deps.phone },
      consent: true,
      idempotency_key: `wa${deps.conversationId}x${seq}`,
      source: 'whatsapp',
    });
    const { booking, payment } = result.body;
    const when = `${weekday(booking.start.slice(0, 10))} ${brDate(booking.start.slice(0, 10))} às ${booking.start.slice(11, 16)}`;
    const replies = [];
    if (payment?.pix_copy_paste) {
      replies.push(say(`Reserva feita para ${when}. Para confirmar, pague o sinal de ${money(payment.amount_cents)} via Pix (copia e cola abaixo). O horário fica reservado por tempo limitado.`));
      replies.push(say(payment.pix_copy_paste));
      return { ...menu({ ...ctx, seq }), replies: [...replies, ...menu({ ...ctx, seq }).replies] };
    }
    return menu({ ...ctx, seq }, `Pronto! Agendamento confirmado: *${booking.service_names.join(', ')}* em ${when}${booking.professional_name ? ` com ${booking.professional_name}` : ''}.`);
  } catch (error) {
    if (error?.code === 'slot_taken') return timePicker({ ...ctx, seq }, deps, { prefix: error.message });
    if (error?.code === 'payment_unavailable') return menu({ ...ctx, seq }, error.message);
    if (error?.status && error.status < 500) return menu({ ...ctx, seq }, error.message || 'Não foi possível concluir o agendamento.');
    throw error;
  }
}

async function myList(ctx, deps, prefix = '') {
  const bookings = await deps.listBookings(ctx);
  if (!bookings.length) return menu(ctx, `${prefix}${prefix ? '\n' : ''}Você não tem agendamentos futuros aqui.`);
  const rows = bookings.slice(0, 10).map(b => ({
    id: `b:${b.public_id}`, title: `${weekday(b.wall.slice(0, 10))} ${brDate(b.wall.slice(0, 10))} ${b.wall.slice(11, 16)}`,
    description: `${b.services}${b.status === 'pending_payment' ? ' · aguardando Pix' : ''}`,
  }));
  return { state: 'my_list', context: keep(ctx), replies: [pick(`${prefix}${prefix ? '\n\n' : ''}Seus próximos agendamentos:`, 'Ver', rows)] };
}

async function handleAiIntent(ctx, business, result, deps) {
  switch (result?.intent) {
    case 'book': {
      const next = { ...keep(ctx), professionalId: result.professional_id || null, date: result.date && result.date >= deps.today() ? result.date : null, time: result.time };
      if (result.service_id) return chooseService(next, business, result.service_id, deps);
      return servicePicker(next, business);
    }
    case 'my_bookings':
    case 'cancel':
    case 'reschedule':
      return myList(ctx, deps);
    case 'human':
      return { handoff: true };
    case 'menu':
    case 'greeting':
      return menu(ctx);
    default:
      return null;
  }
}

// Texto livre sem correspondência: IA (se houver empresa e orçamento) ou nova pergunta.
async function fallback(conv, ctx, input, deps, reprompt) {
  if (conv.company_id && input.text && deps.classify) {
    const business = await deps.business(ctx.slug);
    const result = await deps.classify({ companyId: conv.company_id, companyName: ctx.companyName, services: business.services, professionals: business.professionals, text: input.text });
    const handled = result && !result.budgetExceeded ? await handleAiIntent(ctx, business, result, deps) : null;
    if (handled) return { ...handled, aiUsed: true };
  }
  return reprompt();
}

async function step(conv, input, deps) {
  const ctx = conv.context || {};
  const text = norm(input.text);
  const replyId = input.replyId || '';

  // Palavras-chave globais.
  if (SWITCH_WORDS.test(text)) return startPrompt();
  if (!conv.company_id || conv.state === 'start') {
    const found = await identify(input, deps);
    if (!found) return startPrompt();
    return { companyId: found.id, ...menu({ slug: found.slug, companyName: found.name, seq: ctx.seq || 0 }, `Você está falando com *${found.name}*.`) };
  }
  if (HUMAN_WORDS.test(text) || replyId === 'm:human') return { handoff: true };
  if (MENU_WORDS.test(text) || replyId === 'm:menu') return menu(ctx);

  const business = () => deps.business(ctx.slug);
  switch (conv.state) {
    case 'menu':
      if (replyId === 'm:book' || /^(agendar|marcar|1)$/.test(text)) return servicePicker(ctx, await business());
      if (replyId === 'm:mine' || /^(meus agendamentos|agendamentos|2)$/.test(text)) return myList(ctx, deps);
      return fallback(conv, ctx, input, deps, () => menu(ctx, 'Não entendi.'));

    case 'book_service': {
      const biz = await business();
      let serviceId = replyId.startsWith('s:') ? Number(replyId.slice(2)) : null;
      if (!serviceId && text) serviceId = biz.services.find(s => norm(s.name) === text)?.id || null;
      if (serviceId) return chooseService(ctx, biz, serviceId, deps);
      return fallback(conv, ctx, input, deps, () => servicePicker(ctx, biz, 'Escolha um serviço da lista.'));
    }

    case 'book_professional': {
      const biz = await business();
      if (replyId === 'p:any') return afterProfessional({ ...ctx, professionalId: null, professionalName: null }, deps);
      const id = replyId.startsWith('p:') ? Number(replyId.slice(2)) : biz.professionals.find(p => norm(p.name) === text)?.id;
      const pro = biz.professionals.find(p => p.id === id && p.service_ids.includes(ctx.serviceId));
      if (pro) return afterProfessional({ ...ctx, professionalId: pro.id, professionalName: pro.name }, deps);
      return professionalPicker(ctx, biz);
    }

    case 'book_date':
    case 'resched_date': {
      const date = replyId.startsWith('d:') ? replyId.slice(2) : parseDate(input.text, deps.today());
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= deps.today()) {
        return timePicker({ ...ctx, date }, deps, { state: conv.state === 'book_date' ? 'book_time' : 'resched_time' });
      }
      return datePicker(ctx, deps, { state: conv.state, prefix: 'Escolha um dia da lista (ou escreva no formato 16/11).' });
    }

    case 'book_time':
    case 'resched_time': {
      const timeState = conv.state;
      if (replyId.startsWith('t:more:')) return timePicker(ctx, deps, { state: timeState, offset: Number(replyId.slice(7)) || 0 });
      const time = replyId.startsWith('t:') ? replyId.slice(2) : parseTime(input.text);
      if (!time) return timePicker(ctx, deps, { state: timeState, offset: ctx.timeOffset || 0, prefix: 'Escolha um horário da lista.' });
      if (timeState === 'book_time') return chooseTime(ctx, time, deps);
      try {
        await deps.reschedule(ctx.publicId, `${ctx.date}T${time}`);
        return menu(ctx, `Remarcado para ${weekday(ctx.date)} ${brDate(ctx.date)} às ${time}.`);
      } catch (error) {
        if (error?.code === 'slot_taken') return timePicker(ctx, deps, { state: timeState, prefix: error.message });
        if (error?.status && error.status < 500) return menu(ctx, error.message);
        throw error;
      }
    }

    case 'book_name': {
      const name = String(input.text || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (name.length < 2 || name.length > 80 || !/\p{L}/u.test(name)) return { state: 'book_name', context: ctx, replies: [say('Me diga seu nome (entre 2 e 80 letras).')] };
      return confirmPrompt({ ...ctx, name });
    }

    case 'book_confirm':
      if (replyId === 'c:yes' || /^(sim|confirmar|confirmo|ok)$/.test(text)) return book(ctx, deps);
      if (replyId === 'c:no' || /^(nao|cancelar)$/.test(text)) return menu(ctx, 'Tudo bem, não agendei nada.');
      return confirmPrompt(ctx);

    case 'my_list': {
      const publicId = replyId.startsWith('b:') ? replyId.slice(2) : null;
      const bookings = publicId ? await deps.listBookings(ctx) : [];
      const chosen = bookings.find(b => b.public_id === publicId);
      if (!chosen) return myList(ctx, deps, 'Escolha um agendamento da lista.');
      const buttons = [{ id: 'a:cancel', title: 'Cancelar' }];
      if (chosen.status === 'confirmed') buttons.push({ id: 'a:resched', title: 'Remarcar' });
      buttons.push({ id: 'm:menu', title: 'Menu' });
      return {
        state: 'my_action',
        context: { ...keep(ctx), publicId: chosen.public_id, serviceIds: chosen.service_ids, professionalId: chosen.professional_id },
        replies: [ask(`${chosen.services} em ${weekday(chosen.wall.slice(0, 10))} ${brDate(chosen.wall.slice(0, 10))} às ${chosen.wall.slice(11, 16)}. O que deseja?`, buttons)],
      };
    }

    case 'my_action':
      if (replyId === 'a:cancel' || text === 'cancelar') {
        return { state: 'cancel_confirm', context: ctx, replies: [ask('Confirma o cancelamento?', [{ id: 'x:yes', title: 'Sim, cancelar' }, { id: 'x:no', title: 'Não' }])] };
      }
      if (replyId === 'a:resched' || text === 'remarcar') return datePicker(ctx, deps, { state: 'resched_date' });
      return myList(ctx, deps);

    case 'cancel_confirm':
      if (replyId === 'x:yes' || text === 'sim') {
        try {
          await deps.cancel(ctx.publicId);
          return menu(ctx, 'Agendamento cancelado.');
        } catch (error) {
          if (error?.status && error.status < 500) return menu(ctx, error.message);
          throw error;
        }
      }
      return menu(ctx, 'Ok, mantive o agendamento.');

    default:
      return menu(ctx);
  }
}

module.exports = { step, parseDate, parseTime, norm, addDays, LGPD, MENU_BUTTONS };
