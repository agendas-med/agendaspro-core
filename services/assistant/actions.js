const crypto = require('node:crypto');
const functions = require('../../utils/functions');
const { HttpError } = require('../../middleware/errorHandler');
const plansService = require('../plansService');
const companiesService = require('../companiesService');
const tools = require('./tools');
const audit = require('./audit');
const { config } = require('./config');

// Ações de escrita do assistente: a IA só PROPÕE (linha pending + confirm_token). Execução apenas
// por POST /assistant/actions/:id/confirm com o JWT do mesmo usuário e empresa.
// confirm_token = HMAC-SHA256(ASSISTANT_TOKEN_SECRET, JSON canônico de {action, tool, payload_hash,
// user, company, exp}). Payload imutável no banco (payload_hash), uso único (claim atômico).

const coded = (status, code, message, details) => Object.assign(new HttpError(status, message), { code, details });

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}
const hashParams = params => crypto.createHash('sha256').update(canonical(params)).digest('hex');

function sign({ publicId, tool, payloadHash, userId, companyId, expiresAtMs }, secret = config().tokenSecret) {
  if (!secret) throw coded(503, 'assistant_actions_disabled', 'Ações do assistente indisponíveis no momento.');
  const body = canonical({ a: publicId, c: Number(companyId), e: Number(expiresAtMs), h: payloadHash, t: tool, u: Number(userId) });
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}
function tokenMatches(received, expected) {
  if (typeof received !== 'string' || received.length > 200) return false;
  const a = crypto.createHash('sha256').update(received).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b) && received.length === expected.length;
}

async function isAdmin(userId, companyId) {
  try { await companiesService.checkCompanyPermission(userId, companyId); return true; } catch { return false; }
}

function publicView(row, token) {
  const out = {
    action_id: row.public_id, tool: row.tool, summary: row.summary, risk: row.risk,
    params_preview: row.preview || null, expires_at: new Date(Number(row.expires_at_ms)).toISOString(),
  };
  if (token) out.confirm_token = token;
  return out;
}

// Cria a proposta. ctx = { companyId, userId, conversationId, ent }. Lança 402/403/400 conforme o caso.
async function propose(ctx, toolName, rawArgs) {
  const tool = tools.get(toolName);
  if (!tool || tool.kind !== 'write') throw coded(400, 'assistant_tool_error', 'Ferramenta não permitida.');
  if (!config().tokenSecret) throw coded(503, 'assistant_actions_disabled', 'Ações do assistente indisponíveis no momento.');
  const ent = ctx.ent || await plansService.entitlement(ctx.companyId);
  if (ent.features.assistant_actions !== true) {
    throw plansService.upgradeError('Ações pelo assistente estão disponíveis no plano Premium.', { feature: 'assistant_actions', plan: ent.plan_code });
  }
  if (tool.admin && !(await isAdmin(ctx.userId, ctx.companyId))) {
    throw coded(403, 'assistant_forbidden', 'Você não tem permissão para esta ação.');
  }
  const args = tools.validateArgs(tool, rawArgs);
  const prepared = await tool.prepare(ctx, args);
  const { error, value: params } = tool.params.validate(prepared.params, { abortEarly: true, convert: false });
  if (error) throw coded(400, 'assistant_tool_error', 'Não foi possível preparar a ação.');
  const publicId = crypto.randomBytes(16).toString('hex');
  const expiresAtMs = Date.now() + config().actionTtlMs;
  const payloadHash = hashParams(params);
  const summary = String(prepared.summary).slice(0, 300);
  const result = await functions.executeSql(
    'INSERT INTO assistant_actions (public_id, company_id, user_id, conversation_id, tool, risk, summary, params, payload_hash, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [publicId, ctx.companyId, ctx.userId, ctx.conversationId || null, toolName, tool.risk, summary, JSON.stringify(params), payloadHash, expiresAtMs],
  );
  await audit.log({ companyId: ctx.companyId, userId: ctx.userId, conversationId: ctx.conversationId, actionId: result.insertId, event: 'action_proposed', tool: toolName, params, result: 'pending' });
  const token = sign({ publicId, tool: toolName, payloadHash, userId: ctx.userId, companyId: ctx.companyId, expiresAtMs });
  return publicView({ public_id: publicId, tool: toolName, summary, risk: tool.risk, preview: prepared.preview, expires_at_ms: expiresAtMs }, token);
}

async function load(ctx, publicId) {
  if (typeof publicId !== 'string' || !/^[a-f0-9]{32}$/.test(publicId)) throw coded(404, 'action_not_found', 'Ação não encontrada.');
  // Ação de outro usuário/empresa é indistinguível de inexistente.
  const [row] = await functions.executeSql('SELECT * FROM assistant_actions WHERE public_id = ? AND company_id = ? AND user_id = ?', [publicId, ctx.companyId, ctx.userId]);
  if (!row) throw coded(404, 'action_not_found', 'Ação não encontrada.');
  row.params = typeof row.params === 'string' ? JSON.parse(row.params) : row.params;
  return row;
}

function statusError(row, now) {
  if (row.status === 'pending' && Number(row.expires_at_ms) <= now) return coded(410, 'action_expired', 'Esta ação expirou. Peça novamente ao assistente.');
  if (row.status === 'expired') return coded(410, 'action_expired', 'Esta ação expirou. Peça novamente ao assistente.');
  if (row.status !== 'pending') return coded(409, 'action_already_processed', 'Esta ação já foi processada.', { status: row.status });
  return null;
}

async function confirm(ctx, publicId, confirmToken) {
  const row = await load(ctx, publicId);
  const now = Date.now();
  const tool = tools.get(row.tool);
  const deny = async (error, detail) => {
    await audit.log({ companyId: ctx.companyId, userId: ctx.userId, conversationId: row.conversation_id, actionId: row.id, event: 'action_denied', tool: row.tool, result: error.code, detail });
    throw error;
  };
  // Token amarrado a payload, usuário, empresa e expiração. Payload alterado no banco => hash diverge.
  const currentHash = hashParams(row.params);
  const expected = sign({ publicId: row.public_id, tool: row.tool, payloadHash: currentHash, userId: ctx.userId, companyId: ctx.companyId, expiresAtMs: row.expires_at_ms });
  if (!tool || currentHash !== row.payload_hash || !tokenMatches(confirmToken, expected)) {
    return deny(coded(403, 'invalid_confirm_token', 'Confirmação inválida.'), currentHash !== row.payload_hash ? 'payload_mismatch' : 'token');
  }
  const stateError = statusError(row, now);
  if (stateError) {
    if (stateError.code === 'action_expired' && row.status === 'pending') {
      await functions.executeSql("UPDATE assistant_actions SET status = 'expired' WHERE id = ? AND status = 'pending'", [row.id]);
    }
    return deny(stateError, row.status);
  }
  const ent = await plansService.entitlement(ctx.companyId);
  if (ent.features.assistant_actions !== true) {
    return deny(plansService.upgradeError('Ações pelo assistente estão disponíveis no plano Premium.', { feature: 'assistant_actions', plan: ent.plan_code }), 'plan');
  }
  if (tool.admin && !(await isAdmin(ctx.userId, ctx.companyId))) return deny(coded(403, 'assistant_forbidden', 'Você não tem permissão para esta ação.'), 'rbac');
  const { error: paramsError, value: params } = tool.params.validate(row.params, { abortEarly: true, convert: false });
  if (paramsError) return deny(coded(400, 'assistant_tool_error', 'Ação inválida.'), 'params');

  // Uso único: só um confirm consegue sair de pending (corridas/replay recebem 409).
  const claim = await functions.executeSql(
    "UPDATE assistant_actions SET status = 'executing' WHERE id = ? AND company_id = ? AND user_id = ? AND status = 'pending' AND expires_at_ms > ?",
    [row.id, ctx.companyId, ctx.userId, now],
  );
  if (!claim.affectedRows) return deny(coded(409, 'action_already_processed', 'Esta ação já foi processada.'), 'race');

  try {
    const result = await tool.execute({ companyId: ctx.companyId, userId: ctx.userId }, params);
    await functions.executeSql("UPDATE assistant_actions SET status = 'executed', result = ?, executed_at = NOW() WHERE id = ?", [JSON.stringify(result || {}), row.id]);
    await audit.log({ companyId: ctx.companyId, userId: ctx.userId, conversationId: row.conversation_id, actionId: row.id, event: 'action_executed', tool: row.tool, params, result: 'executed' });
    require('./rag').touch(ctx.companyId);
    return { action_id: row.public_id, status: 'executed', tool: row.tool, summary: row.summary, result: result || {} };
  } catch (error) {
    const message = tools.safeServiceError(error);
    await functions.executeSql("UPDATE assistant_actions SET status = 'failed', error_message = ? WHERE id = ?", [message.slice(0, 300), row.id]);
    await audit.log({ companyId: ctx.companyId, userId: ctx.userId, conversationId: row.conversation_id, actionId: row.id, event: 'action_failed', tool: row.tool, params, result: 'failed', detail: message });
    if (error && (error.sql || error.sqlMessage || error.errno)) console.error('[assistant] falha ao executar ação:', error?.code || 'erro');
    throw coded(422, 'action_failed', message);
  }
}

async function reject(ctx, publicId) {
  const row = await load(ctx, publicId);
  const result = await functions.executeSql("UPDATE assistant_actions SET status = 'rejected' WHERE id = ? AND status = 'pending'", [row.id]);
  if (!result.affectedRows) throw coded(409, 'action_already_processed', 'Esta ação já foi processada.', { status: row.status });
  await audit.log({ companyId: ctx.companyId, userId: ctx.userId, conversationId: row.conversation_id, actionId: row.id, event: 'action_rejected', tool: row.tool, result: 'rejected' });
  return { action_id: row.public_id, status: 'rejected' };
}

module.exports = { propose, confirm, reject, sign, hashParams, canonical, isAdmin };
