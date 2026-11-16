// LGPD (follow-up 1): remove identificadores de um cliente do histórico do assistente
// (mensagens, títulos/resumos de conversa, ações propostas e auditoria) da MESMA empresa.
//
// Estratégia: o MariaDB filtra as linhas candidatas com um padrão REGEXP amplo (só ASCII/PCRE
// básico) e o Node aplica a substituição precisa. Colunas JSON nunca recebem substituição parcial
// (um número removido no meio do JSON o tornaria inválido): a linha inteira vira um objeto fixo.
// Limitação documentada: só o nome COMPLETO cadastrado é removido (primeiro nome isolado, apelidos
// e grafias diferentes permanecem); nomes com menos de 5 letras são ignorados para não apagar
// palavras comuns. Telefone/CPF exigem >= 8 dígitos.

const REDACTED = '[dado removido]';
const REDACTED_JSON = JSON.stringify({ redacted: true });
const MIN_NAME_LETTERS = 5;
const MIN_DIGITS = 8;

const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function nameTerm(name) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ');
  if ((clean.match(/\p{L}/gu) || []).length < MIN_NAME_LETTERS) return null;
  if (/^cliente anonimizado$/i.test(clean)) return null;
  return clean.split(' ').map(escapeRe).join('\\s+');
}

function digitTerms(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < MIN_DIGITS) return [];
  const variants = new Set([digits]);
  if (digits.startsWith('55') && digits.length >= 12) variants.add(digits.slice(2));
  return [...variants].map(d => d.split('').join('[\\s().+-]{0,3}'));
}

// Padrões: `sql` (superset, para REGEXP no MariaDB) e `js` (substituição precisa, com limites).
function patterns(subject) {
  const names = [...new Set((subject.names || []).map(nameTerm).filter(Boolean))];
  const digits = [...new Set([...digitTerms(subject.tel), ...digitTerms(subject.cpf)])];
  const email = subject.email && String(subject.email).trim().length >= 5 ? escapeRe(String(subject.email).trim()) : null;
  const parts = [...names, ...digits, ...(email ? [email] : [])];
  if (!parts.length) return null;
  const jsParts = [
    ...names.map(n => `(?<![\\p{L}\\p{N}])${n}(?![\\p{L}\\p{N}])`),
    ...digits.map(d => `(?<!\\d)${d}(?!\\d)`),
    ...(email ? [email] : []),
  ];
  return {
    sql: `(?i)(${parts.join('|')})`,
    js: new RegExp(jsParts.join('|'), 'giu'),
  };
}

const scrubText = (text, re) => (text == null ? text : String(text).replace(re, REDACTED));
const asText = v => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

async function scrubCustomer(query, companyId, subject) {
  const p = patterns(subject);
  const customerRef = subject.customerId ? `"customer_id"\\s*:\\s*"?${Number(subject.customerId)}(?![0-9])` : null;
  const out = { messages: 0, conversations: 0, actions: 0, audit: 0 };

  if (p) {
    const msgs = await query('SELECT id, content FROM assistant_messages WHERE company_id = ? AND content REGEXP ?', [companyId, p.sql]);
    for (const m of msgs) {
      await query('UPDATE assistant_messages SET content = ? WHERE id = ? AND company_id = ?', [scrubText(m.content, p.js), m.id, companyId]);
      out.messages++;
    }
    const convs = await query('SELECT id, title, summary FROM assistant_conversations WHERE company_id = ? AND (title REGEXP ? OR summary REGEXP ?)', [companyId, p.sql, p.sql]);
    for (const c of convs) {
      await query('UPDATE assistant_conversations SET title = ?, summary = ? WHERE id = ? AND company_id = ?', [scrubText(c.title, p.js), scrubText(c.summary, p.js), c.id, companyId]);
      out.conversations++;
    }
  }

  // Ações: por PII no texto/JSON ou por referência ao customer_id nos parâmetros.
  const actionPattern = [p && p.sql.slice(4), customerRef].filter(Boolean);
  if (actionPattern.length) {
    const re = `(?i)(${actionPattern.join('|')})`;
    const acts = await query(
      `SELECT id, summary, error_message, status FROM assistant_actions WHERE company_id = ?
         AND (summary REGEXP ? OR params REGEXP ? OR COALESCE(result, '') REGEXP ? OR COALESCE(error_message, '') REGEXP ?)`,
      [companyId, re, re, re, re]);
    for (const a of acts) {
      // Pendente envolvendo o titular nunca mais executa (o hash de params também deixa de bater).
      await query(
        `UPDATE assistant_actions SET summary = ?, error_message = ?, params = ?, result = IF(result IS NULL, NULL, ?),
           status = IF(status = 'pending', 'expired', status) WHERE id = ? AND company_id = ?`,
        [p ? scrubText(a.summary, p.js) : a.summary, p ? scrubText(a.error_message, p.js) : a.error_message, REDACTED_JSON, REDACTED_JSON, a.id, companyId]);
      out.actions++;
    }
    const audits = await query(
      'SELECT id, detail, params FROM assistant_audit WHERE company_id = ? AND (COALESCE(detail, \'\') REGEXP ? OR COALESCE(params, \'\') REGEXP ?)',
      [companyId, re, re]);
    for (const a of audits) {
      const paramsHit = new RegExp(re.slice(4), 'i').test(asText(a.params));
      await query('UPDATE assistant_audit SET detail = ?, params = ? WHERE id = ? AND company_id = ?',
        [p ? scrubText(a.detail, p.js) : a.detail, paramsHit ? REDACTED_JSON : a.params == null ? null : asText(a.params), a.id, companyId]);
      out.audit++;
    }
  }
  return out;
}

module.exports = { scrubCustomer, patterns, REDACTED };
