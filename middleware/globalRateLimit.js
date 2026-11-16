// Limite global por IP, em memória (um único dyno web): contenção barata de abuso/flood antes
// das rotas. Os limites finos por rota (login, /public, chat) continuam no rateLimit.js (banco).
// GLOBAL_RATE_LIMIT_PER_MIN: requisições por IP por minuto (padrão 300; 0 desliga).
// Desligado por padrão em NODE_ENV=test. Webhooks e /health ficam de fora (Meta/Asaas/monitores).
const SKIP = /^\/(health|webhook|internal\/jobs\/tick)(\/|$|\?)/;

function createGlobalRateLimit({ env = process.env, now = () => Date.now(), windowMs = 60000 } = {}) {
  const fallback = env.NODE_ENV === 'test' ? 0 : 300;
  const parsed = Number.parseInt(env.GLOBAL_RATE_LIMIT_PER_MIN ?? '', 10);
  const limit = Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
  const hits = new Map();
  let sweepAt = now() + windowMs;

  function middleware(req, res, next) {
    if (!limit || SKIP.test(req.path || req.url || '')) return next();
    const t = now();
    if (t >= sweepAt) {
      for (const [key, entry] of hits) if (entry.reset <= t) hits.delete(key);
      sweepAt = t + windowMs;
    }
    const key = req.ip || 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.reset <= t) {
      entry = { count: 0, reset: t + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > limit) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((entry.reset - t) / 1000))));
      return res.status(429).json({ message: 'Muitas requisições. Tente novamente em instantes.' });
    }
    return next();
  }
  middleware.limit = limit;
  return middleware;
}

module.exports = { createGlobalRateLimit };
