const crypto = require('node:crypto');
const functions = require('../../utils/functions');
const budget = require('../ai/budget');
const { getProvider, embeddingModel } = require('../ai/provider');
const { config } = require('./config');

// RAG só para TEXTO NÃO ESTRUTURADO (FAQ/políticas/regras da clínica, descrições e observações de
// serviços, observações de agendamentos, textos da página). Dados estruturados (agenda, financeiro,
// estoque) vão por ferramentas SQL e nunca são vetorizados. Tudo sempre filtrado por company_id.

const sha = text => crypto.createHash('sha256').update(String(text)).digest('hex');

// ---------- vectorStore (interface) ----------
// upsert(companyId, rows[]) | removeSource(companyId, type, id) | removeKeys(companyId, keys[])
// hashes(companyId) -> Map(key -> {hash, model}) | count(companyId) | search(companyId, vector, {model, topK, minScore})
// Implementação padrão: Float32 little-endian em BLOB por empresa + cosseno no Node.

function toBlob(vector) {
  const f = Float32Array.from(vector);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}
function fromBlob(buf) {
  // Cópia alinhada: o Buffer do driver pode não começar em múltiplo de 4.
  const copy = new Uint8Array(buf.length);
  copy.set(buf);
  return new Float32Array(copy.buffer, 0, Math.floor(buf.length / 4));
}
function cosine(a, b) {
  // Dimensões diferentes (troca de modelo) não são comparáveis.
  if (!a || !b || a.length !== b.length) return 0;
  const n = a.length;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
const keyOf = r => `${r.source_type}:${r.source_id}:${r.chunk}`;

const blobStore = {
  async upsert(companyId, rows) {
    for (const r of rows) {
      await functions.executeSql(
        `INSERT INTO assistant_embeddings (company_id, source_type, source_id, chunk, content_hash, model, dims, content, vector) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE content_hash = VALUES(content_hash), model = VALUES(model), dims = VALUES(dims), content = VALUES(content), vector = VALUES(vector)`,
        [companyId, r.source_type, r.source_id, r.chunk, r.content_hash, r.model, r.vector.length, r.content, toBlob(r.vector)],
      );
    }
  },
  async removeSource(companyId, sourceType, sourceId) {
    await functions.executeSql('DELETE FROM assistant_embeddings WHERE company_id = ? AND source_type = ? AND source_id = ?', [companyId, sourceType, sourceId]);
  },
  async removeKeys(companyId, keys) {
    for (const key of keys) {
      const [type, sid, chunk] = key.split(':');
      await functions.executeSql('DELETE FROM assistant_embeddings WHERE company_id = ? AND source_type = ? AND source_id = ? AND chunk = ?', [companyId, type, sid, chunk]);
    }
  },
  async hashes(companyId) {
    const rows = await functions.executeSql('SELECT source_type, source_id, chunk, content_hash, model FROM assistant_embeddings WHERE company_id = ?', [companyId]);
    return new Map(rows.map(r => [keyOf(r), { hash: r.content_hash, model: r.model }]));
  },
  async count(companyId) {
    const [row] = await functions.executeSql('SELECT COUNT(*) AS total FROM assistant_embeddings WHERE company_id = ?', [companyId]);
    return Number(row.total) || 0;
  },
  async search(companyId, vector, { model, topK = 4, minScore = 0.25 } = {}) {
    const rows = await functions.executeSql('SELECT source_type, source_id, content, vector FROM assistant_embeddings WHERE company_id = ? AND model = ?', [companyId, model]);
    return rows
      .map(r => ({ source_type: r.source_type, source_id: Number(r.source_id), content: r.content, score: cosine(vector, fromBlob(r.vector)) }))
      .filter(r => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  },
};
let store = blobStore;
const setStore = s => { store = s || blobStore; };

// ---------- fontes de texto livre ----------

function chunks(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const out = [];
  for (let i = 0; i < clean.length && out.length < 5; i += max) out.push(clean.slice(i, i + max));
  return out;
}

async function sources(companyId) {
  const q = functions.executeSql.bind(functions);
  const includeNotes = config().ragIncludeNotes;
  const [knowledge, services, notes, company] = await Promise.all([
    q('SELECT id, kind, title, content FROM assistant_knowledge WHERE company_id = ? AND active = 1 ORDER BY id LIMIT 500', [companyId]),
    q('SELECT id, name, observations, public_description FROM services WHERE company_id = ? LIMIT 500', [companyId]),
    !includeNotes ? [] : q(`SELECT a.id, a.observations, DATE_FORMAT(a.date, '%Y-%m-%d') AS day FROM appointments a JOIN customers c ON c.id = a.customer_id AND c.company_id = a.company_id
       WHERE a.company_id = ? AND a.observations IS NOT NULL AND a.observations <> '' AND c.anonymized_at IS NULL ORDER BY a.date DESC LIMIT 500`, [companyId]),
    q('SELECT id, public_description, public_hours FROM companies WHERE id = ?', [companyId]),
  ]);
  const out = [];
  for (const k of knowledge) out.push({ source_type: 'knowledge', source_id: k.id, text: `${k.kind}: ${k.title}\n${k.content}` });
  for (const s of services) {
    const body = [s.observations, s.public_description].filter(Boolean).join('\n');
    if (body.trim()) out.push({ source_type: 'service', source_id: s.id, text: `Serviço ${s.name}: ${body}` });
  }
  for (const n of notes) out.push({ source_type: 'appointment_note', source_id: n.id, text: `Observação do agendamento #${n.id} (${n.day}): ${n.observations}` });
  for (const c of company) {
    const body = [c.public_description, c.public_hours && `Horários: ${c.public_hours}`].filter(Boolean).join('\n');
    if (body.trim()) out.push({ source_type: 'company', source_id: c.id, text: body });
  }
  return out;
}

// ---------- embeddings com orçamento ----------

async function embed(companyId, inputs, feature) {
  const provider = getProvider();
  const model = embeddingModel();
  if (!provider?.embed || !model || !inputs.length) return null;
  if (await budget.circuitOpen('provider').catch(() => true)) return null;
  const estTokens = Math.ceil(inputs.reduce((n, t) => n + t.length, 0) / 3);
  const scopes = [budget.globalScope(), { scope: 'company', key: `assistant:${companyId}`, limitTokens: config().companyDailyTokens }];
  const reserved = await budget.reserve(scopes, estTokens, budget.costMicroUsd(estTokens, 0)).catch(() => ({ ok: false }));
  if (!reserved.ok) {
    await budget.recordUsage({ companyId, feature, provider: provider.name, model, status: 'blocked' }).catch(() => {});
    return null;
  }
  const started = Date.now();
  try {
    const out = await provider.embed({ model, input: inputs });
    const used = Number(out.usage?.input) || estTokens;
    await budget.adjust(scopes, used - estTokens, budget.costMicroUsd(used, 0) - budget.costMicroUsd(estTokens, 0)).catch(() => {});
    await budget.circuitSuccess('provider').catch(() => {});
    await budget.recordUsage({ companyId, feature, provider: provider.name, model, tokensIn: used, status: 'ok', latencyMs: Date.now() - started }).catch(() => {});
    if (!Array.isArray(out.vectors) || out.vectors.length !== inputs.length) return null;
    return { model, vectors: out.vectors };
  } catch (error) {
    await budget.adjust(scopes, -estTokens, -budget.costMicroUsd(estTokens, 0)).catch(() => {});
    await budget.circuitFailure('provider', error?.timeout ? 'timeout' : 'error').catch(() => {});
    await budget.recordUsage({ companyId, feature, provider: provider.name, model, status: error?.timeout ? 'timeout' : 'error', latencyMs: Date.now() - started }).catch(() => {});
    console.error('[assistant] embeddings indisponíveis:', error?.status || error?.code || 'erro');
    return null;
  }
}

// Indexação incremental por hash de conteúdo. Remove o que sumiu (inclui anonimizado/excluído).
async function reconcile(companyId) {
  const cfg = config();
  const desired = new Map();
  for (const s of await sources(companyId)) {
    chunks(s.text, cfg.ragMaxChunkChars).forEach((content, chunk) => {
      desired.set(`${s.source_type}:${s.source_id}:${chunk}`, { source_type: s.source_type, source_id: s.source_id, chunk, content, content_hash: sha(content) });
    });
  }
  const existing = await store.hashes(companyId);
  const model = embeddingModel();
  const stale = [...existing.keys()].filter(k => !desired.has(k));
  if (stale.length) await store.removeKeys(companyId, stale);
  if (!cfg.ragEnabled || !model) return { removed: stale.length, indexed: 0 };
  let room = cfg.ragMaxChunksPerCompany - (existing.size - stale.length);
  const todo = [...desired.entries()].filter(([k, v]) => {
    const cur = existing.get(k);
    if (cur && cur.hash === v.content_hash && cur.model === model) return false;
    if (!cur) { if (room <= 0) return false; room--; }
    return true;
  }).map(([, v]) => v);
  let indexed = 0;
  for (let i = 0; i < todo.length; i += cfg.ragBatch) {
    const batch = todo.slice(i, i + cfg.ragBatch);
    const out = await embed(companyId, batch.map(b => b.content), 'assistant_embedding');
    if (!out) break;
    await store.upsert(companyId, batch.map((b, j) => ({ ...b, model: out.model, vector: out.vectors[j] })));
    indexed += batch.length;
  }
  return { removed: stale.length, indexed };
}

async function search(companyId, query) {
  const cfg = config();
  if (!cfg.ragEnabled) return [];
  const out = await embed(companyId, [String(query).slice(0, 500)], 'assistant_rag_query');
  if (!out) return [];
  let hits = await store.search(companyId, out.vectors[0], { model: out.model, topK: cfg.ragTopK + (cfg.ragIncludeNotes ? 0 : cfg.ragTopK), minScore: cfg.ragMinScore });
  // Flag desligada: vetores de observação antigos (ainda não reconciliados) nunca voltam no contexto.
  if (!cfg.ragIncludeNotes) hits = hits.filter(h => h.source_type !== 'appointment_note').slice(0, cfg.ragTopK);
  return hits.map(h => ({ source_type: h.source_type, source_id: h.source_id, score: Math.round(h.score * 1000) / 1000, text: String(h.content).slice(0, cfg.ragMaxChunkChars) }));
}

// Gatilho após escrita: agenda um reconcile da empresa (no máximo 1 por hora). Nunca bloqueia.
function hourKey(companyId, now = new Date()) {
  return `assistant_rag:${companyId}:${now.toISOString().slice(0, 13)}`;
}
function touch(companyId) {
  if (!config().ragEnabled || !companyId) return;
  require('../jobsService').enqueue('assistant_rag_reconcile', { company_id: Number(companyId) }, { dedupeKey: hourKey(companyId), maxAttempts: 3 }).catch(() => {});
}

// Remoção imediata (LGPD): fontes ligadas a um cliente anonimizado/excluído.
async function removeCustomerSources(companyId, customerId) {
  const rows = await functions.executeSql('SELECT id FROM appointments WHERE company_id = ? AND customer_id = ?', [companyId, customerId]);
  await removeAppointmentSources(companyId, rows.map(r => r.id));
}
// Por IDs já coletados (exclusão: os agendamentos somem em cascata antes da limpeza).
async function removeAppointmentSources(companyId, appointmentIds) {
  for (const id of appointmentIds || []) await store.removeSource(companyId, 'appointment_note', id);
}

// Producer horário: reconcilia empresas que usam o assistente (conversa ou base de conhecimento).
async function enqueueReconciles(jobs) {
  if (!config().ragEnabled) return 0;
  const rows = await functions.executeSql(
    `SELECT DISTINCT company_id FROM (SELECT company_id FROM assistant_conversations WHERE updated_at >= NOW() - INTERVAL 30 DAY
      UNION SELECT company_id FROM assistant_knowledge UNION SELECT company_id FROM assistant_embeddings) t LIMIT 500`,
  );
  let n = 0;
  for (const r of rows) if (await jobs.enqueue('assistant_rag_reconcile', { company_id: r.company_id }, { dedupeKey: hourKey(r.company_id), maxAttempts: 3 })) n++;
  return n;
}
async function handleJob(payload) {
  const companyId = Number(payload?.company_id);
  if (!Number.isInteger(companyId) || companyId <= 0) return;
  await reconcile(companyId);
}

const removeSource = (companyId, sourceType, sourceId) => store.removeSource(companyId, sourceType, sourceId);

module.exports = { search, reconcile, touch, removeSource, removeCustomerSources, removeAppointmentSources, enqueueReconciles, handleJob, sources, setStore, blobStore, cosine, toBlob, fromBlob, hourKey };
