const crypto = require('node:crypto');

// Slug da página pública (/b/:slug): minúsculas, dígitos e hífen; 3 a 60 caracteres;
// sem hífen no início/fim nem duplo. Palavras reservadas não podem ser usadas.
const SLUG_RE = /^(?!.*--)[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;
const RESERVED = new Set([
  'admin', 'api', 'app', 'agendaspro', 'agenda', 'b', 'blog', 'booking', 'bookings', 'cadastro', 'contato', 'dashboard',
  'help', 'internal', 'login', 'logout', 'novo', 'planos', 'precos', 'privacidade', 'public', 'root', 'signup', 'static',
  'suporte', 'support', 'system', 'termos', 'teste', 'test', 'webhook', 'www',
]);

function isValidSlug(value) {
  return typeof value === 'string' && SLUG_RE.test(value) && !RESERVED.has(value);
}

function slugify(name) {
  const base = String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 48).replace(/-+$/g, '');
  return base.length >= 3 && !RESERVED.has(base) ? base : `negocio${base ? `-${base}` : ''}`.slice(0, 48).replace(/-+$/g, '');
}

// Sufixo aleatório curto para desempate (evita revelar quantas empresas têm o mesmo nome).
function withSuffix(base) {
  return `${base}-${crypto.randomBytes(3).toString('hex').slice(0, 5)}`;
}

module.exports = { isValidSlug, slugify, withSuffix, RESERVED, SLUG_RE };
