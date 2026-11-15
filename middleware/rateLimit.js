const functions = require('../utils/functions');
const { sha256 } = require('../utils/crypto');

// Rate limit em banco (janela fixa). Funciona com vários dynos e sobrevive a restart.
// O contador é incrementado atomicamente: LAST_INSERT_ID(hits + 1) devolve o valor novo.
async function hit(key, windowSec, now = Date.now()) {
  const windowIndex = Math.floor(now / 1000 / windowSec);
  const bucket = `${sha256(key).slice(0, 40)}:${windowSec}:${windowIndex}`;
  const expiresAt = new Date((windowIndex + 1) * windowSec * 1000);
  const result = await functions.executeSql(
    'INSERT INTO rate_limits (bucket, hits, expires_at) VALUES (?, 1, ?) ON DUPLICATE KEY UPDATE hits = LAST_INSERT_ID(hits + 1)',
    [bucket, expiresAt]
  );
  // Limpeza oportunista (~1% das chamadas).
  if (Math.random() < 0.01) functions.executeSql('DELETE FROM rate_limits WHERE expires_at < NOW() LIMIT 500').catch(() => {});
  const hits = Number(result.insertId) || 1;
  return { hits, resetAt: expiresAt };
}

// key: string fixa ou função (req) => string. A chave final inclui o IP do cliente.
function rateLimit({ key, windowSec = 60, max = 10, message = 'Muitas tentativas. Tente novamente em instantes.' }) {
  return async (req, res, next) => {
    try {
      const base = typeof key === 'function' ? key(req) : key;
      const { hits, resetAt } = await hit(`${base}|${req.ip}`, windowSec);
      if (hits > max) {
        res.set('Retry-After', String(Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000))));
        return res.status(429).send({ message });
      }
      next();
    } catch (error) {
      // Falha do banco não derruba a rota (fail-open), mas é registrada.
      console.error('[rateLimit] indisponível:', error?.code || 'erro');
      next();
    }
  };
}

module.exports = rateLimit;
module.exports.hit = hit;
