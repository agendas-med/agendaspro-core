const axios = require('axios');

// Cloudflare Turnstile nas rotas públicas que criam dados (leads e agendamentos).
// Regras (fail closed):
// - produção: sempre verifica; sem TURNSTILE_SECRET_KEY responde 503 (nunca libera);
// - fora de produção: só pula com TURNSTILE_ENABLED=false E TURNSTILE_DEV_BYPASS=true (as duas explícitas);
// - token ausente/inválido: 400 turnstile_failed; erro de rede/timeout no verificador: 503.
const DEFAULT_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const failed = () => Object.assign(new Error('Verificação de segurança falhou. Recarregue a página e tente novamente.'), { status: 400, code: 'turnstile_failed' });
const unavailable = reason => Object.assign(new Error('Verificação de segurança indisponível. Tente novamente em instantes.'), { status: 503, code: 'service_unavailable', internalReason: reason });

function mode() {
  const production = process.env.NODE_ENV === 'production';
  if (!production && process.env.TURNSTILE_ENABLED === 'false' && process.env.TURNSTILE_DEV_BYPASS === 'true') return 'bypass';
  return 'verify';
}

async function verify(token, remoteIp, { post = axios.post } = {}) {
  if (mode() === 'bypass') return { bypassed: true };
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) throw unavailable('turnstile_secret_missing');
  if (typeof token !== 'string' || !token || token.length > 2048) throw failed();
  let data;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);
    ({ data } = await post(process.env.TURNSTILE_VERIFY_URL || DEFAULT_VERIFY_URL, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000,
    }));
  } catch {
    throw unavailable('turnstile_unreachable');
  }
  if (!data || data.success !== true) throw failed();
  return { success: true };
}

module.exports = { verify, mode };
