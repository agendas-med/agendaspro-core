// Configuração do assistente do painel (F5-core-B). Tudo via env, com padrões seguros.
const num = (value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const n = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

function config() {
  const env = process.env;
  return {
    enabled: env.ASSISTANT_ENABLED === 'true',
    // Sem segredo próprio as ações de escrita ficam desligadas (nunca há segredo padrão no código).
    tokenSecret: env.ASSISTANT_TOKEN_SECRET && env.ASSISTANT_TOKEN_SECRET.length >= 32 ? env.ASSISTANT_TOKEN_SECRET : null,
    actionTtlMs: num(env.ASSISTANT_ACTION_TTL_MIN, 10, { min: 1, max: 30 }) * 60 * 1000,
    ratePerMin: num(env.ASSISTANT_RATE_PER_MIN, 20, { min: 1 }),
    maxMessageChars: num(env.ASSISTANT_MAX_MESSAGE_CHARS, 1000, { min: 50, max: 4000 }),
    companyDailyTokens: num(env.ASSISTANT_COMPANY_DAILY_TOKENS, 200000),
    userDailyTokens: num(env.ASSISTANT_USER_DAILY_TOKENS, 80000),
    companyMonthlyTokens: num(env.ASSISTANT_COMPANY_MONTHLY_TOKENS, 3000000),
    maxOutputTokens: num(env.ASSISTANT_MAX_OUTPUT_TOKENS, 400, { min: 50, max: 2000 }),
    historyWindow: num(env.ASSISTANT_HISTORY_WINDOW, 6, { min: 0, max: 20 }),
    lowStockThreshold: num(env.ASSISTANT_LOW_STOCK_THRESHOLD, 3),
    ragEnabled: env.ASSISTANT_RAG_ENABLED === 'true',
    ragTopK: num(env.ASSISTANT_RAG_TOP_K, 4, { min: 1, max: 10 }),
    ragMinScore: num(env.ASSISTANT_RAG_MIN_SCORE, 0.25, { min: -1, max: 1 }),
    ragMaxChunksPerCompany: num(env.ASSISTANT_RAG_MAX_CHUNKS, 2000, { min: 10 }),
    ragMaxChunkChars: num(env.ASSISTANT_RAG_CHUNK_CHARS, 800, { min: 100, max: 4000 }),
    ragBatch: num(env.ASSISTANT_RAG_BATCH, 64, { min: 1, max: 256 }),
  };
}

module.exports = { config };
