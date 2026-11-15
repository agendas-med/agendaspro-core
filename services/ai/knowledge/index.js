const FAQ = require('./faq.pt-BR.json');
const plans = require('../../plansService');
const guard = require('../guard');

// Base de conhecimento do chat público: FAQ determinística versionada (faq.pt-BR.json) +
// fatos lidos do banco/env (preços, comissões, limites, URLs). Nada de preço escrito à mão:
// os textos usam placeholders {{...}} preenchidos por facts().

const AUDIENCES = ['business', 'customer'];
// Mesmo mínimo validado em routes/publicPage.js (deposit_cents 0 ou >= 500).
const MIN_DEPOSIT_CENTS = 500;
const base = env => (process.env[env] || '').replace(/\/+$/, '');

const brl = cents => {
  const value = (Number(cents) || 0) / 100;
  return `R$ ${value.toLocaleString('pt-BR', { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 })}`;
};
const pct = bps => `${((Number(bps) || 0) / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
const qty = value => (value === null || value === undefined ? 'ilimitado' : String(value));

// Fatos do produto. Se o banco falhar, os placeholders de plano ficam indisponíveis e as
// entradas que dependem deles caem para "veja a página de preços" (nunca valor inventado).
async function facts({ listPlans = () => plans.listPlans() } = {}) {
  const site = base('PUBLIC_SITE_URL');
  const out = {
    site_url: site,
    site_pricing_url: `${site}/precos`,
    site_privacy_url: `${site}/privacidade`,
    signup_url: `${base('URL_SITE')}/registro`,
    min_deposit: brl(MIN_DEPOSIT_CENTS),
  };
  try {
    const list = await listPlans();
    const free = list.find(p => p.code === 'free');
    const premium = list.find(p => p.code === 'premium');
    if (free) {
      Object.assign(out, {
        free_price: brl(free.price_cents),
        free_commission: pct(free.commission_bps),
        free_max_professionals: qty(free.features.max_professionals),
        free_max_team_users: qty(free.features.max_team_users),
        free_whatsapp_messages: qty(free.features.whatsapp_monthly_messages),
        free_ai_interactions: qty(free.features.assistant_monthly_interactions),
        free_history_months: qty(free.features.history_months),
      });
    }
    if (premium) {
      Object.assign(out, {
        premium_price: brl(premium.price_cents),
        premium_commission: pct(premium.commission_bps),
        premium_ai_interactions: qty(premium.features.assistant_monthly_interactions),
      });
    }
    if (free && premium && free.commission_bps > premium.commission_bps) {
      // Venda mensal a partir da qual a economia de comissão paga a mensalidade.
      const cents = Math.ceil((premium.price_cents - free.price_cents) * 10000 / (free.commission_bps - premium.commission_bps));
      out.breakeven = brl(Math.ceil(cents / 100) * 100);
    }
  } catch (error) {
    console.error('[ai-knowledge] Falha ao ler planos:', error?.code || 'erro');
  }
  return out;
}

const pick = (value, audience) => (value && typeof value === 'object' && !Array.isArray(value) ? value[audience] ?? value.business : value);

// Preenche {{x}}. Placeholder sem valor -> null (o chamador usa o texto de fallback).
function render(template, data) {
  if (typeof template !== 'string') return null;
  let missing = false;
  const text = template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (data[key] === undefined || data[key] === null) { missing = true; return ''; }
    return data[key];
  });
  return missing ? null : text;
}

// ---------- matcher determinístico ----------

const normalize = text => ` ${guard.fold(text).replace(/[^a-z0-9]+/g, ' ').trim()} `;
const keywordIndex = list => list.map(item => ({ item, keys: (item.keywords || []).map(k => ({ phrase: normalize(k), words: k.trim().split(/\s+/).length })) }));
const ENTRIES = keywordIndex(FAQ.entries);
const FORBIDDEN = keywordIndex(FAQ.forbidden_topics);
const SOCIAL = new Set(['greeting', 'thanks', 'bye']);

// Soma das palavras das frases casadas (frase longa = mais específica) + desempate leve
// pelo número de frases distintas.
function scoreOf(norm, keys) {
  let score = 0;
  for (const k of keys) if (norm.includes(k.phrase)) score += k.words + 0.01;
  return Math.round(score * 100) / 100;
}

// Devolve { kind: 'answer'|'forbidden'|'ambiguous'|'none', entry?, score, candidates:[{id,score}] }.
// answer: uma entrada clara; ambiguous: empate entre intenções diferentes (a IA pode desempatar);
// none: nada casou. Saudações só vencem quando nada mais casa.
function match(text, audience) {
  const norm = normalize(text);
  for (const { item, keys } of FORBIDDEN) {
    if (scoreOf(norm, keys) > 0) return { kind: 'forbidden', entry: item, score: 1, candidates: [] };
  }
  const scored = ENTRIES
    .filter(({ item }) => item.audience === 'both' || item.audience === audience)
    .map(({ item, keys }) => ({ item, score: scoreOf(norm, keys) * (SOCIAL.has(item.intent) ? 0.5 : 1) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, 5).map(s => ({ id: s.item.id, score: s.score }));
  if (!scored.length) return { kind: 'none', score: 0, candidates };
  const [best, second] = scored;
  // Saudação junto com uma pergunta: a pergunta manda.
  const real = scored.find(s => !SOCIAL.has(s.item.intent));
  if (SOCIAL.has(best.item.intent) && real) return decide(real, scored.filter(s => s !== real && !SOCIAL.has(s.item.intent))[0], candidates);
  return decide(best, second, candidates);
}

function decide(best, second, candidates) {
  if (second && second.score === best.score && second.item.intent !== best.item.intent) {
    return { kind: 'ambiguous', entry: best.item, score: best.score, candidates };
  }
  return { kind: 'answer', entry: best.item, score: best.score, candidates };
}

const byId = id => FAQ.entries.find(e => e.id === id) || null;

// Resposta pronta de uma entrada para o público, ou null se faltar fato (ex.: banco fora).
function answerFor(entry, audience, data) {
  const text = render(pick(entry.answer, audience), data);
  if (text === null) return null;
  return { text, suggestions: pick(entry.suggestions, audience) || [], action: entry.action || null, intent: entry.intent, id: entry.id };
}

// Texto de contexto para a IA: só entradas do público, já renderizadas, limitado em tamanho.
const DEFAULT_CONTEXT = {
  business: ['plans', 'free_plan', 'premium_plan', 'agenda', 'public_page', 'deposit_pix', 'whatsapp', 'getting_started'],
  customer: ['how_to_book', 'reschedule', 'cancel_booking', 'payment_customer', 'lost_link'],
};
function groundingFor(audience, data, candidateIds = [], { maxChars = 2400 } = {}) {
  const ids = [...new Set([...candidateIds, ...DEFAULT_CONTEXT[audience]])];
  const lines = [];
  let size = 0;
  for (const id of ids) {
    const entry = byId(id);
    if (!entry || (entry.audience !== 'both' && entry.audience !== audience)) continue;
    const text = render(pick(entry.answer, audience), data);
    if (!text) continue;
    const line = `- [${entry.id}] ${text}`;
    if (size + line.length > maxChars) break;
    lines.push(line); size += line.length + 1;
  }
  return lines.join('\n');
}

const fallback = audience => FAQ.fallback[audience] || FAQ.fallback.business;

module.exports = {
  FAQ, AUDIENCES, facts, render, match, answerFor, groundingFor, byId, fallback, normalize, brl, pct,
  refusal: () => FAQ.refusal, injectionRefusal: () => FAQ.injection_refusal, blockedText: () => FAQ.blocked,
  intents: () => [...new Set(FAQ.entries.map(e => e.intent))],
};
