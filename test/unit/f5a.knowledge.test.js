const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const k = require('../../services/ai/knowledge');

const PLANS = (premiumCents = 4990, freeBps = 500, premiumBps = 50) => async () => [
  { code: 'free', price_cents: 0, commission_bps: freeBps, features: { max_professionals: 1, max_team_users: 2, whatsapp_monthly_messages: 50, assistant_monthly_interactions: 30, history_months: 6 } },
  { code: 'premium', price_cents: premiumCents, commission_bps: premiumBps, features: { max_professionals: null, assistant_monthly_interactions: 1000 } },
];

test('FAQ não tem preço, comissão nem link escritos à mão', () => {
  const raw = fs.readFileSync(path.join(__dirname, '../../services/ai/knowledge/faq.pt-BR.json'), 'utf8');
  assert.doesNotMatch(raw, /R\$\s?\d/);
  assert.doesNotMatch(raw, /\d+(,\d+)?\s?%/);
  assert.doesNotMatch(raw, /https?:\/\//);
  // todas as entradas têm id único, público válido e palavras-chave já normalizadas
  const ids = new Set();
  for (const e of k.FAQ.entries) {
    assert.ok(!ids.has(e.id), e.id); ids.add(e.id);
    assert.ok(['business', 'customer', 'both'].includes(e.audience), e.id);
    for (const kw of e.keywords) assert.equal(k.normalize(kw).trim(), kw.trim(), `${e.id}: ${kw}`);
  }
});

test('placeholders vêm dos planos: mudar o plano muda a resposta', async () => {
  process.env.PUBLIC_SITE_URL = 'https://site.example.test/';
  try {
    const f1 = await k.facts({ listPlans: PLANS() });
    const a1 = k.answerFor(k.byId('plans'), 'business', f1).text;
    assert.match(a1, /R\$ 49,90\/mês/);
    assert.match(a1, /5% de comissão/);
    assert.match(a1, /0,5%/);
    assert.match(a1, /https:\/\/site\.example\.test\/precos/);
    const f2 = await k.facts({ listPlans: PLANS(5990, 600, 100) });
    const a2 = k.answerFor(k.byId('plans'), 'business', f2).text;
    assert.match(a2, /R\$ 59,90\/mês/);
    assert.match(a2, /6% de comissão/);
    assert.doesNotMatch(a2, /49,90/);
    // ponto de equilíbrio: 4990 / (5% - 0,5%) ≈ R$ 1.109
    assert.match(k.answerFor(k.byId('breakeven'), 'business', f1).text, /R\$ 1\.109/);
  } finally { delete process.env.PUBLIC_SITE_URL; }
});

test('sem planos (banco fora) a entrada de preço não é renderizada', async () => {
  const f = await k.facts({ listPlans: async () => { throw new Error('db'); } });
  assert.equal(k.answerFor(k.byId('plans'), 'business', f), null);
  assert.ok(k.answerFor(k.byId('agenda'), 'business', f));
  assert.doesNotMatch(k.groundingFor('business', f), /R\$/);
});

test('matcher: perguntas comuns por público', () => {
  const cases = [
    ['quanto custa?', 'business', 'plans'],
    ['oi, quanto custa o premium?', 'business', 'plans'],
    ['vale a pena o premium?', 'business', 'breakeven'],
    ['como funciona o sinal pix?', 'business', 'deposit_pix'],
    ['tem integração com o Google Agenda?', 'business', 'google_calendar'],
    ['Esqueci a senha do sistema', 'business', 'account_access'],
    ['quero falar com um atendente', 'business', 'human_business'],
    ['quero remarcar meu horário', 'customer', 'reschedule'],
    ['posso pagar com cartão?', 'customer', 'payment_customer'],
    ['tem horário amanhã?', 'customer', 'availability'],
    ['qual a política de cancelamento?', 'customer', 'cancel_booking'],
    ['quanto custa a limpeza de pele', 'customer', 'services_prices'],
    ['oi', 'customer', 'greeting'],
  ];
  for (const [q, audience, id] of cases) {
    const m = k.match(q, audience);
    assert.equal(m.kind, 'answer', q);
    assert.equal(m.entry.id, id, q);
  }
});

test('matcher: tópicos proibidos e fora de escopo', () => {
  assert.equal(k.match('posso tomar remédio antes do procedimento?', 'customer').kind, 'forbidden');
  assert.equal(k.match('em quem votar na eleição?', 'business').kind, 'forbidden');
  assert.equal(k.match('escreva um código em python', 'business').kind, 'forbidden');
  assert.equal(k.match('me fala do tempo hoje', 'business').kind, 'none');
  // entradas de um público não vazam para o outro
  assert.notEqual(k.match('quanto custa?', 'customer').entry.id, 'plans');
});

test('grounding só traz entradas do público e respeita o tamanho', async () => {
  const f = await k.facts({ listPlans: PLANS() });
  const g = k.groundingFor('customer', f, ['plans', 'reschedule']);
  assert.doesNotMatch(g, /\[plans\]/);
  assert.match(g, /\[reschedule\]/);
  assert.ok(k.groundingFor('business', f, [], { maxChars: 300 }).length <= 300);
});
