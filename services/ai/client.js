const budget = require('./budget');
const { getProvider, chatModel } = require('./provider');

// Chamada única e segura ao provedor: circuit breaker -> reserva de orçamento em todos os escopos
// (global sempre) -> chamada com timeout/retry limitado -> JSON validado por Joi -> ajuste ao uso
// real e registro em ai_usage. Nunca lança: devolve { ok:true, value, usage } ou { ok:false, reason }.
// reason: disabled | circuit_open | budget (com scope) | error | timeout | invalid.

// ≈ 1 token a cada 3 caracteres (conservador para pt-BR) + saída máxima.
const estimateTokens = (messages, maxTokens) => Math.ceil(messages.reduce((n, m) => n + String(m.content || '').length, 0) / 3) + maxTokens;

async function complete({ feature, companyId = null, sessionId = null, scopes = [], messages, schema, validator, maxTokens = 200, model = chatModel(), provider = getProvider() }) {
  if (!provider) return { ok: false, reason: 'disabled' };
  const started = Date.now();
  const allScopes = [budget.globalScope(), ...scopes];
  try {
    if (await budget.circuitOpen('provider')) return { ok: false, reason: 'circuit_open' };
    const estTokens = estimateTokens(messages, maxTokens);
    const estCost = budget.costMicroUsd(estTokens - maxTokens, maxTokens);
    const reserved = await budget.reserve(allScopes, estTokens, estCost);
    if (!reserved.ok) {
      await budget.recordUsage({ companyId, sessionId, feature, provider: provider.name, model, status: 'blocked' }).catch(() => {});
      return { ok: false, reason: 'budget', scope: reserved.scope };
    }

    let response;
    try {
      response = await provider.chat({ model, messages, maxTokens, schema });
    } catch (error) {
      const status = error?.timeout ? 'timeout' : 'error';
      await budget.adjust(allScopes, -estTokens, -estCost).catch(() => {});
      await budget.circuitFailure('provider', status).catch(() => {});
      await budget.recordUsage({ companyId, sessionId, feature, provider: provider.name, model, status, latencyMs: Date.now() - started }).catch(() => {});
      console.error(`[ai] ${feature}: falha no provedor:`, error?.status || error?.code || status);
      return { ok: false, reason: status };
    }

    const tokensIn = Number(response.usage?.input) || 0;
    const tokensOut = Number(response.usage?.output) || 0;
    const actualTokens = tokensIn + tokensOut || Number(response.usage?.total) || estTokens;
    const actualCost = budget.costMicroUsd(tokensIn, tokensOut);
    await budget.adjust(allScopes, actualTokens - estTokens, actualCost - estCost).catch(() => {});
    await budget.circuitSuccess('provider').catch(() => {});

    let value;
    try {
      const parsed = JSON.parse(response.content || '');
      const checked = validator ? validator.validate(parsed, { abortEarly: true, allowUnknown: false, convert: false }) : { value: parsed };
      if (checked.error) throw checked.error;
      value = checked.value;
    } catch {
      await budget.recordUsage({ companyId, sessionId, feature, provider: provider.name, model: response.model, tokensIn, tokensOut, status: 'invalid', latencyMs: Date.now() - started }).catch(() => {});
      return { ok: false, reason: 'invalid', usage: { tokens: actualTokens } };
    }
    await budget.recordUsage({ companyId, sessionId, feature, provider: provider.name, model: response.model, tokensIn, tokensOut, status: 'ok', latencyMs: Date.now() - started }).catch(() => {});
    return { ok: true, value, usage: { tokensIn, tokensOut, tokens: actualTokens, cost: actualCost } };
  } catch (error) {
    console.error(`[ai] ${feature}: erro inesperado:`, error?.code || 'erro');
    return { ok: false, reason: 'error' };
  }
}

module.exports = { complete, estimateTokens };
