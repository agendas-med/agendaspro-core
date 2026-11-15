const functions = require('../../utils/functions');
const { wallClock } = require('../../utils/time');

// Orçamentos de IA no banco (nada em memória): contadores diários por escopo, registro de uso
// por chamada (ai_usage) e circuit breaker. Valem para todos os recursos de IA do core.
//
// Escopos: { scope: 'global'|'company'|'session'|'ip'|<outro>, key, limitTokens?, limitCost? }.
// O global é sempre incluído por client.js com AI_GLOBAL_DAILY_TOKENS / AI_GLOBAL_DAILY_BUDGET_USD.
// Custo em micro-USD inteiro: preço em US$ por 1M tokens == micro-US$ por token.

const UNLIMITED = Number.MAX_SAFE_INTEGER;
const today = (now = new Date()) => wallClock(now).slice(0, 10);

function prices() {
  const num = (value, fallback) => (Number.isFinite(Number(value)) && value !== '' && value !== undefined ? Number(value) : fallback);
  return {
    input: num(process.env.AI_PRICE_INPUT_USD_PER_MTOK, 0.10),
    output: num(process.env.AI_PRICE_OUTPUT_USD_PER_MTOK, 0.50),
  };
}

const costMicroUsd = (tokensIn, tokensOut) => {
  const p = prices();
  return Math.ceil((Number(tokensIn) || 0) * p.input + (Number(tokensOut) || 0) * p.output);
};

function globalLimits() {
  const tokens = Number(process.env.AI_GLOBAL_DAILY_TOKENS);
  const usd = Number(process.env.AI_GLOBAL_DAILY_BUDGET_USD);
  return {
    limitTokens: Number.isFinite(tokens) && tokens >= 0 && process.env.AI_GLOBAL_DAILY_TOKENS !== '' && process.env.AI_GLOBAL_DAILY_TOKENS !== undefined ? tokens : 2000000,
    limitCost: Number.isFinite(usd) && usd >= 0 && process.env.AI_GLOBAL_DAILY_BUDGET_USD !== '' && process.env.AI_GLOBAL_DAILY_BUDGET_USD !== undefined ? Math.round(usd * 1e6) : 1000000,
  };
}

const globalScope = () => ({ scope: 'global', key: 'all', ...globalLimits() });
const limitOf = value => (Number.isFinite(Number(value)) && value !== null && value !== undefined ? Number(value) : UNLIMITED);

// Reserva em TODOS os escopos ou em nenhum (transação). Devolve { ok, scope? } (scope que estourou).
async function reserve(scopes, tokens, cost, { now = new Date(), transaction = functions.executeTransaction.bind(functions) } = {}) {
  const day = today(now);
  try {
    return await transaction(async query => {
      for (const s of scopes) {
        const key = String(s.key).slice(0, 80);
        await query('INSERT IGNORE INTO ai_budget_counters (scope, scope_key, day, tokens, cost_micro_usd, calls) VALUES (?, ?, ?, 0, 0, 0)', [s.scope, key, day]);
        const result = await query(
          `UPDATE ai_budget_counters SET tokens = tokens + ?, cost_micro_usd = cost_micro_usd + ?, calls = calls + 1
           WHERE scope = ? AND scope_key = ? AND day = ? AND tokens + ? <= ? AND cost_micro_usd + ? <= ?`,
          [tokens, cost, s.scope, key, day, tokens, limitOf(s.limitTokens), cost, limitOf(s.limitCost)],
        );
        if (!result.affectedRows) throw Object.assign(new Error('budget'), { budgetScope: s.scope });
      }
      return { ok: true };
    });
  } catch (error) {
    if (error?.budgetScope) return { ok: false, scope: error.budgetScope };
    throw error;
  }
}

// Troca a reserva pelo uso real (pode devolver tudo, com actual = 0). Sem teto: nunca falha.
async function adjust(scopes, deltaTokens, deltaCost, { now = new Date(), query = functions.executeSql.bind(functions) } = {}) {
  if (!deltaTokens && !deltaCost) return;
  const day = today(now);
  for (const s of scopes) {
    await query('UPDATE ai_budget_counters SET tokens = GREATEST(0, tokens + ?), cost_micro_usd = GREATEST(0, cost_micro_usd + ?) WHERE scope = ? AND scope_key = ? AND day = ?',
      [deltaTokens, deltaCost, s.scope, String(s.key).slice(0, 80), day]);
  }
}

// Soma sem teto (uso já feito por um recurso com orçamento próprio, ex.: bot do WhatsApp).
async function add(scopes, tokens, cost, { now = new Date(), query = functions.executeSql.bind(functions) } = {}) {
  const day = today(now);
  for (const s of scopes) {
    await query(`INSERT INTO ai_budget_counters (scope, scope_key, day, tokens, cost_micro_usd, calls) VALUES (?, ?, ?, ?, ?, 1)
      ON DUPLICATE KEY UPDATE tokens = tokens + VALUES(tokens), cost_micro_usd = cost_micro_usd + VALUES(cost_micro_usd), calls = calls + 1`,
    [s.scope, String(s.key).slice(0, 80), day, tokens, cost]);
  }
}

async function usageOf(scope, key, { now = new Date(), query = functions.executeSql.bind(functions) } = {}) {
  const [row] = await query('SELECT tokens, cost_micro_usd, calls FROM ai_budget_counters WHERE scope = ? AND scope_key = ? AND day = ?', [scope, String(key).slice(0, 80), today(now)]);
  return { tokens: Number(row?.tokens) || 0, cost: Number(row?.cost_micro_usd) || 0, calls: Number(row?.calls) || 0 };
}

// Teto global do dia (tokens ou custo) atingido? Calculado na leitura.
async function globalExhausted(opts = {}) {
  const { limitTokens, limitCost } = globalLimits();
  const used = await usageOf('global', 'all', opts);
  return used.tokens >= limitTokens || used.cost >= limitCost;
}

// Uma linha por chamada. Best-effort: falha ao registrar não derruba a resposta.
async function recordUsage({ companyId = null, sessionId = null, feature, provider = 'openai', model, tokensIn = 0, tokensOut = 0, status = 'ok', latencyMs = null }, { query = functions.executeSql.bind(functions) } = {}) {
  const cost = costMicroUsd(tokensIn, tokensOut);
  await query('INSERT INTO ai_usage (company_id, session_id, feature, provider, model, tokens_in, tokens_out, cost_micro_usd, status, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [companyId, sessionId, String(feature).slice(0, 40), String(provider).slice(0, 20), String(model || '').slice(0, 80), tokensIn, tokensOut, cost, status, latencyMs]);
  return cost;
}

// ---------- circuit breaker (provedor) ----------
// N falhas seguidas abrem o circuito por AI_BREAKER_COOLDOWN_MS; um sucesso zera o contador.
const breakerFailures = () => Math.max(1, Number(process.env.AI_BREAKER_FAILURES) || 5);
const breakerCooldown = () => Math.max(1000, Number(process.env.AI_BREAKER_COOLDOWN_MS) || 300000);

async function circuitOpen(name = 'provider', { now = Date.now(), query = functions.executeSql.bind(functions) } = {}) {
  const [row] = await query('SELECT opened_until_ms FROM ai_circuit WHERE name = ?', [name]);
  return !!row && Number(row.opened_until_ms) > now;
}

async function circuitFailure(name = 'provider', reason = 'error', { now = Date.now(), query = functions.executeSql.bind(functions) } = {}) {
  await query(`INSERT INTO ai_circuit (name, failures, opened_until_ms, reason) VALUES (?, 1, 0, ?)
    ON DUPLICATE KEY UPDATE failures = failures + 1, reason = VALUES(reason)`, [name, String(reason).slice(0, 40)]);
  await query('UPDATE ai_circuit SET opened_until_ms = ?, failures = 0 WHERE name = ? AND failures >= ?', [now + breakerCooldown(), name, breakerFailures()]);
}

async function circuitSuccess(name = 'provider', { query = functions.executeSql.bind(functions) } = {}) {
  await query('UPDATE ai_circuit SET failures = 0 WHERE name = ? AND failures > 0', [name]);
}

module.exports = {
  reserve, adjust, add, usageOf, globalExhausted, globalScope, globalLimits, recordUsage, costMicroUsd, prices, today,
  circuitOpen, circuitFailure, circuitSuccess, UNLIMITED,
};
