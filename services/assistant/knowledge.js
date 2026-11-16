const functions = require('../../utils/functions');
const { HttpError } = require('../../middleware/errorHandler');
const rag = require('./rag');

// Base de conhecimento da empresa (FAQ, políticas, regras, modelos de texto) usada pelo RAG.
// Sempre filtrada por company_id da sessão. Remoção apaga também os embeddings.
// Follow-up 1: `active` (inativo sai do RAG na hora; reativar reagenda a indexação).
const MAX_ITEMS = 500;
const view = r => ({ id: r.id, kind: r.kind, title: r.title, content: r.content, active: r.active === undefined ? true : Boolean(Number(r.active)), created_at: r.created_at, updated_at: r.updated_at });

async function list(companyId) {
  const rows = await functions.executeSql('SELECT * FROM assistant_knowledge WHERE company_id = ? ORDER BY id DESC LIMIT ?', [companyId, MAX_ITEMS]);
  return rows.map(view);
}

async function create(companyId, userId, { kind, title, content, active }) {
  const [{ n }] = await functions.executeSql('SELECT COUNT(*) AS n FROM assistant_knowledge WHERE company_id = ?', [companyId]);
  if (Number(n) >= MAX_ITEMS) throw new HttpError(400, `Limite de ${MAX_ITEMS} itens na base de conhecimento.`);
  const isActive = active === undefined ? 1 : (active ? 1 : 0);
  const result = await functions.executeSql('INSERT INTO assistant_knowledge (company_id, kind, title, content, active, created_by) VALUES (?, ?, ?, ?, ?, ?)', [companyId, kind, title, content, isActive, userId]);
  if (isActive) rag.touch(companyId);
  const [row] = await functions.executeSql('SELECT * FROM assistant_knowledge WHERE id = ? AND company_id = ?', [result.insertId, companyId]);
  return view(row);
}

// Atualização parcial: campos ausentes mantêm o valor atual (PUT com os 3 campos segue igual ao F5-B).
async function update(companyId, id, fields) {
  const [current] = await functions.executeSql('SELECT * FROM assistant_knowledge WHERE id = ? AND company_id = ?', [id, companyId]);
  if (!current) throw new HttpError(404, 'Item não encontrado.');
  const next = {
    kind: fields.kind ?? current.kind,
    title: fields.title ?? current.title,
    content: fields.content ?? current.content,
    active: fields.active === undefined ? Number(current.active) : (fields.active ? 1 : 0),
  };
  const result = await functions.executeSql('UPDATE assistant_knowledge SET kind = ?, title = ?, content = ?, active = ? WHERE id = ? AND company_id = ?', [next.kind, next.title, next.content, next.active, id, companyId]);
  if (!result.affectedRows) throw new HttpError(404, 'Item não encontrado.');
  if (next.active) rag.touch(companyId);
  else await rag.removeSource(companyId, 'knowledge', id);
  const [row] = await functions.executeSql('SELECT * FROM assistant_knowledge WHERE id = ? AND company_id = ?', [id, companyId]);
  return view(row);
}
async function remove(companyId, id) {
  const result = await functions.executeSql('DELETE FROM assistant_knowledge WHERE id = ? AND company_id = ?', [id, companyId]);
  if (!result.affectedRows) throw new HttpError(404, 'Item não encontrado.');
  await rag.removeSource(companyId, 'knowledge', id);
  return { id, deleted: true };
}

module.exports = { list, create, update, remove };
