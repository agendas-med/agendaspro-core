const functions = require('../../utils/functions');
const { HttpError } = require('../../middleware/errorHandler');
const rag = require('./rag');

// Base de conhecimento da empresa (FAQ, políticas, regras, modelos de texto) usada pelo RAG.
// Sempre filtrada por company_id da sessão. Remoção apaga também os embeddings.
const MAX_ITEMS = 500;
const view = r => ({ id: r.id, kind: r.kind, title: r.title, content: r.content, created_at: r.created_at, updated_at: r.updated_at });

async function list(companyId) {
  const rows = await functions.executeSql('SELECT * FROM assistant_knowledge WHERE company_id = ? ORDER BY id DESC LIMIT ?', [companyId, MAX_ITEMS]);
  return rows.map(view);
}

async function create(companyId, userId, { kind, title, content }) {
  const [{ n }] = await functions.executeSql('SELECT COUNT(*) AS n FROM assistant_knowledge WHERE company_id = ?', [companyId]);
  if (Number(n) >= MAX_ITEMS) throw new HttpError(400, `Limite de ${MAX_ITEMS} itens na base de conhecimento.`);
  const result = await functions.executeSql('INSERT INTO assistant_knowledge (company_id, kind, title, content, created_by) VALUES (?, ?, ?, ?, ?)', [companyId, kind, title, content, userId]);
  rag.touch(companyId);
  const [row] = await functions.executeSql('SELECT * FROM assistant_knowledge WHERE id = ? AND company_id = ?', [result.insertId, companyId]);
  return view(row);
}

async function update(companyId, id, { kind, title, content }) {
  const result = await functions.executeSql('UPDATE assistant_knowledge SET kind = ?, title = ?, content = ? WHERE id = ? AND company_id = ?', [kind, title, content, id, companyId]);
  if (!result.affectedRows) throw new HttpError(404, 'Item não encontrado.');
  rag.touch(companyId);
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
