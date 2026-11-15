const test = require('node:test');
const assert = require('node:assert/strict');
const Joi = require('joi');
const budget = require('../../services/ai/budget');
const providerMod = require('../../services/ai/provider');
const client = require('../../services/ai/client');

// Tabela ai_budget_counters em memória, só com os comandos que budget.js emite.
function fakeCounters() {
  const rows = new Map();
  const k = (scope, key, day) => `${scope}|${key}|${day}`;
  async function query(sql, p) {
    if (/^INSERT IGNORE INTO ai_budget_counters/.test(sql)) {
      const id = k(p[0], p[1], p[2]);
      if (!rows.has(id)) rows.set(id, { tokens: 0, cost: 0, calls: 0 });
      return { affectedRows: 1 };
    }
    if (/^UPDATE ai_budget_counters SET tokens = tokens \+ \?/.test(sql)) {
      const [tokens, cost, scope, key, day, t2, limT, c2, limC] = p;
      const row = rows.get(k(scope, key, day));
      if (!row || row.tokens + t2 > limT || row.cost + c2 > limC) return { affectedRows: 0 };
      row.tokens += tokens; row.cost += cost; row.calls += 1;
      return { affectedRows: 1 };
    }
    if (/^UPDATE ai_budget_counters SET tokens = GREATEST/.test(sql)) {
      const [dt, dc, scope, key, day] = p;
      const row = rows.get(k(scope, key, day));
      if (row) { row.tokens = Math.max(0, row.tokens + dt); row.cost = Math.max(0, row.cost + dc); }
      return { affectedRows: row ? 1 : 0 };
    }
    if (/^SELECT tokens, cost_micro_usd, calls FROM ai_budget_counters/.test(sql)) {
      const row = rows.get(k(p[0], p[1], p[2]));
      return row ? [{ tokens: row.tokens, cost_micro_usd: row.cost, calls: row.calls }] : [];
    }
    throw new Error(`SQL inesperado: ${sql}`);
  }
  // Transação: aplica em cópia e só "commita" se não lançar.
  async function transaction(fn) {
    const snapshot = new Map([...rows].map(([id, r]) => [id, { ...r }]));
    try { return await fn(query); } catch (error) { rows.clear(); for (const [id, r] of snapshot) rows.set(id, r); throw error; }
  }
  return { rows, query, transaction };
}

test('custo em micro-USD a partir do preço por 1M tokens', () => {
  assert.equal(budget.costMicroUsd(1000, 100), 150); // 1000*0.10 + 100*0.50
  process.env.AI_PRICE_INPUT_USD_PER_MTOK = '1';
  try { assert.equal(budget.costMicroUsd(10, 0), 10); } finally { delete process.env.AI_PRICE_INPUT_USD_PER_MTOK; }
  assert.equal(budget.costMicroUsd(0, 0), 0);
});

test('teto global padrão e por env', () => {
  assert.deepEqual(budget.globalLimits(), { limitTokens: 2000000, limitCost: 1000000 });
  process.env.AI_GLOBAL_DAILY_TOKENS = '0';
  process.env.AI_GLOBAL_DAILY_BUDGET_USD = '0.5';
  try { assert.deepEqual(budget.globalLimits(), { limitTokens: 0, limitCost: 500000 }); } finally {
    delete process.env.AI_GLOBAL_DAILY_TOKENS; delete process.env.AI_GLOBAL_DAILY_BUDGET_USD;
  }
});

test('reserve: tudo ou nada entre escopos; respeita tokens e custo', async () => {
  const db = fakeCounters();
  const opts = { transaction: db.transaction };
  const scopes = [{ scope: 'global', key: 'all', limitTokens: 1000, limitCost: 1000 }, { scope: 'session', key: 's1', limitTokens: 300 }];
  assert.deepEqual(await budget.reserve(scopes, 200, 10, opts), { ok: true });
  // a sessão estoura: o global não pode ficar com a reserva
  assert.deepEqual(await budget.reserve(scopes, 200, 10, opts), { ok: false, scope: 'session' });
  const day = budget.today();
  assert.equal(db.rows.get(`global|all|${day}`).tokens, 200);
  assert.equal(db.rows.get(`session|s1|${day}`).tokens, 200);
  // teto por custo
  assert.deepEqual(await budget.reserve([{ scope: 'ip', key: 'h', limitCost: 5 }], 1, 6, opts), { ok: false, scope: 'ip' });
  // sem limite definido = ilimitado
  assert.deepEqual(await budget.reserve([{ scope: 'company', key: '9' }], 10 ** 9, 10 ** 9, opts), { ok: true });
});

test('adjust troca a estimativa pelo real e nunca fica negativo', async () => {
  const db = fakeCounters();
  const scope = { scope: 'session', key: 's2', limitTokens: 1000 };
  await budget.reserve([scope], 500, 50, { transaction: db.transaction });
  await budget.adjust([scope], -380, -40, { query: db.query });
  assert.deepEqual(await budget.usageOf('session', 's2', { query: db.query }), { tokens: 120, cost: 10, calls: 1 });
  await budget.adjust([scope], -9999, -9999, { query: db.query });
  assert.equal((await budget.usageOf('session', 's2', { query: db.query })).tokens, 0);
});

test('globalExhausted lê o contador do dia', async () => {
  const db = fakeCounters();
  process.env.AI_GLOBAL_DAILY_TOKENS = '100';
  try {
    assert.equal(await budget.globalExhausted({ query: db.query }), false);
    await budget.reserve([budget.globalScope()], 100, 1, { transaction: db.transaction });
    assert.equal(await budget.globalExhausted({ query: db.query }), true);
  } finally { delete process.env.AI_GLOBAL_DAILY_TOKENS; }
});

test('circuit breaker abre após N falhas e respeita o cooldown', async () => {
  const state = new Map();
  async function query(sql, p) {
    if (/^SELECT opened_until_ms FROM ai_circuit/.test(sql)) return state.has(p[0]) ? [{ opened_until_ms: state.get(p[0]).open }] : [];
    if (/^INSERT INTO ai_circuit/.test(sql)) {
      const row = state.get(p[0]) || { failures: 0, open: 0 };
      row.failures += 1; state.set(p[0], row); return {};
    }
    if (/^UPDATE ai_circuit SET opened_until_ms/.test(sql)) {
      const row = state.get(p[1]);
      if (row && row.failures >= p[2]) { row.open = p[0]; row.failures = 0; }
      return {};
    }
    if (/^UPDATE ai_circuit SET failures = 0/.test(sql)) { const row = state.get(p[0]); if (row) row.failures = 0; return {}; }
    throw new Error(`SQL inesperado: ${sql}`);
  }
  process.env.AI_BREAKER_FAILURES = '2';
  try {
    const now = 1_000_000;
    await budget.circuitFailure('p', 'error', { now, query });
    assert.equal(await budget.circuitOpen('p', { now, query }), false);
    await budget.circuitSuccess('p', { query });
    await budget.circuitFailure('p', 'error', { now, query });
    assert.equal(await budget.circuitOpen('p', { now, query }), false, 'sucesso zerou o contador');
    await budget.circuitFailure('p', 'timeout', { now, query });
    assert.equal(await budget.circuitOpen('p', { now: now + 1, query }), true);
    assert.equal(await budget.circuitOpen('p', { now: now + 300001, query }), false);
  } finally { delete process.env.AI_BREAKER_FAILURES; }
});

test('provider OpenAI: json_schema strict, max_completion_tokens e retry limitado', async () => {
  const requests = [];
  let fail = 1;
  const fake = { chat: { completions: { create: async req => {
    requests.push(req);
    if (fail-- > 0) throw Object.assign(new Error('boom'), { status: 503 });
    return { model: 'm', choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 50, completion_tokens: 5 } };
  } } } };
  const p = providerMod.createOpenAIProvider({ client: fake });
  const out = await p.chat({ messages: [{ role: 'user', content: 'x' }], maxTokens: 64, schema: { name: 's', schema: { type: 'object' } } });
  assert.equal(requests.length, 2, 'uma nova tentativa após 503');
  assert.equal(requests[0].max_completion_tokens, 64);
  assert.equal(requests[0].response_format.json_schema.strict, true);
  assert.equal(requests[0].model, 'gpt-6-luna');
  assert.deepEqual(out.usage, { input: 50, output: 5, total: 55 });

  // 400 não é repetido; timeout é marcado
  const once = []; const bad = providerMod.createOpenAIProvider({ client: { chat: { completions: { create: async () => { once.push(1); throw Object.assign(new Error('bad'), { status: 400 }); } } } } });
  await assert.rejects(bad.chat({ messages: [] }), e => e.status === 400 && e.timeout === false);
  assert.equal(once.length, 1);
  const slow = providerMod.createOpenAIProvider({ client: { chat: { completions: { create: async () => { throw Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }); } } } } });
  await assert.rejects(slow.chat({ messages: [] }), e => e.timeout === true);
});

test('timeouts ficam dentro do limite do router do Heroku', () => {
  process.env.AI_TIMEOUT_MS = '60000'; process.env.AI_MAX_RETRIES = '5';
  try {
    const { timeoutMs, retries } = providerMod.timeouts();
    assert.ok(timeoutMs * (1 + retries) + 300 < 25000);
  } finally { delete process.env.AI_TIMEOUT_MS; delete process.env.AI_MAX_RETRIES; }
});

test('getProvider: sem chave e sem override a IA fica desligada', () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  providerMod.setProvider(null);
  assert.equal(providerMod.getProvider(), null);
  if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
});

// ---------- client.complete com budget/circuito simulados ----------
function withBudget(overrides, fn) {
  const saved = {};
  const base = {
    circuitOpen: async () => false,
    reserve: async () => ({ ok: true }),
    adjust: async () => {},
    circuitFailure: async () => {},
    circuitSuccess: async () => {},
    recordUsage: async () => 0,
  };
  const all = { ...base, ...overrides };
  for (const key of Object.keys(all)) { saved[key] = budget[key]; budget[key] = all[key]; }
  return Promise.resolve(fn()).finally(() => { for (const key of Object.keys(saved)) budget[key] = saved[key]; });
}

const validator = Joi.object({ intent: Joi.string().valid('plans', 'refuse').required() });
const messages = [{ role: 'system', content: 'abc' }, { role: 'user', content: 'def' }];

test('client: sem provider -> disabled', async () => {
  assert.deepEqual(await client.complete({ feature: 't', messages, provider: null }), { ok: false, reason: 'disabled' });
});

test('client: circuito aberto ou orçamento estourado não chamam o provedor', async () => {
  const stub = providerMod.createStubProvider(() => ({ intent: 'plans' }));
  await withBudget({ circuitOpen: async () => true }, async () => {
    assert.equal((await client.complete({ feature: 't', messages, provider: stub, validator })).reason, 'circuit_open');
  });
  const usage = [];
  await withBudget({ reserve: async () => ({ ok: false, scope: 'session' }), recordUsage: async u => { usage.push(u); return 0; } }, async () => {
    assert.deepEqual(await client.complete({ feature: 't', messages, provider: stub, validator }), { ok: false, reason: 'budget', scope: 'session' });
  });
  assert.equal(stub.calls.length, 0);
  assert.equal(usage[0].status, 'blocked');
});

test('client: sucesso ajusta a reserva ao uso real e registra', async () => {
  const stub = providerMod.createStubProvider(() => ({ content: '{"intent":"plans"}', usage: { input: 100, output: 10 } }));
  const adjusts = []; const usage = []; let reservedScopes;
  await withBudget({
    reserve: async (scopes, tokens, cost) => { reservedScopes = scopes; adjusts.push(['reserve', tokens, cost]); return { ok: true }; },
    adjust: async (scopes, dt, dc) => { adjusts.push(['adjust', dt, dc]); },
    recordUsage: async u => { usage.push(u); return 0; },
  }, async () => {
    const out = await client.complete({ feature: 'public_chat', sessionId: 7, scopes: [{ scope: 'session', key: '7', limitTokens: 10 ** 6 }], messages, maxTokens: 50, provider: stub, validator });
    assert.equal(out.ok, true);
    assert.deepEqual(out.value, { intent: 'plans' });
    assert.equal(out.usage.tokens, 110);
    assert.equal(out.usage.cost, budget.costMicroUsd(100, 10));
  });
  assert.equal(reservedScopes[0].scope, 'global');
  const reserved = adjusts[0][1];
  assert.equal(reserved, client.estimateTokens(messages, 50));
  assert.equal(adjusts[1][1], 110 - reserved);
  assert.equal(usage.at(-1).status, 'ok');
  assert.equal(usage.at(-1).sessionId, 7);
  assert.equal(stub.calls[0].maxTokens, 50);
});

test('client: JSON inválido ou fora do schema -> invalid; erro devolve a reserva e conta falha', async () => {
  const usage = [];
  await withBudget({ recordUsage: async u => { usage.push(u); return 0; } }, async () => {
    for (const content of ['não é json', '{"intent":"hack"}', '{"intent":"plans","extra":1}']) {
      const stub = providerMod.createStubProvider(() => ({ content }));
      assert.equal((await client.complete({ feature: 't', messages, provider: stub, validator })).reason, 'invalid', content);
    }
  });
  assert.ok(usage.every(u => u.status === 'invalid'));

  const adjusts = []; let failures = 0;
  await withBudget({ adjust: async (s, dt) => { adjusts.push(dt); }, circuitFailure: async () => { failures++; } }, async () => {
    const stub = providerMod.createStubProvider(() => Object.assign(new Error('x'), { timeout: true }));
    assert.equal((await client.complete({ feature: 't', messages, provider: stub, validator, maxTokens: 10 })).reason, 'timeout');
  });
  assert.equal(adjusts[0], -client.estimateTokens(messages, 10));
  assert.equal(failures, 1);
});

test('client: erro inesperado no banco não lança', async () => {
  const stub = providerMod.createStubProvider(() => ({ intent: 'plans' }));
  await withBudget({ circuitOpen: async () => { throw new Error('db down'); } }, async () => {
    assert.deepEqual(await client.complete({ feature: 't', messages, provider: stub, validator }), { ok: false, reason: 'error' });
  });
});
