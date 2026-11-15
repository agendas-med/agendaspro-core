// Segredo do JWT: JWT_SECRET (novo) com fallback para JWT_KEY (legado).
// Em produção, falha no boot se ausente ou fraco (< 32 caracteres).
function getJwtSecret() {
  const secret = process.env.JWT_SECRET || process.env.JWT_KEY;
  if (!secret) throw new Error('JWT_SECRET não configurado.');
  return secret;
}

function assertJwtSecret() {
  const secret = process.env.JWT_SECRET || process.env.JWT_KEY;
  if (!secret) throw new Error('JWT_SECRET não configurado: defina-o antes de iniciar a API.');
  if (process.env.NODE_ENV === 'production' && secret.length < 32) {
    throw new Error('JWT_SECRET fraco: use pelo menos 32 caracteres aleatórios em produção.');
  }
}

const ACCESS_TOKEN_TTL = process.env.JWT_EXPIRES_IN || '8h';

module.exports = { getJwtSecret, assertJwtSecret, ACCESS_TOKEN_TTL };
