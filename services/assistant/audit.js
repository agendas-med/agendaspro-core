const functions = require('../../utils/functions');

// Trilha de auditoria do assistente (quem, o quê, parâmetros, resultado, tokens). Nunca derruba a requisição.
async function log({ companyId, userId, conversationId = null, actionId = null, event, tool = null, params = null, result = null, detail = null, tokens = 0 }) {
  try {
    await functions.executeSql(
      'INSERT INTO assistant_audit (company_id, user_id, conversation_id, action_id, event, tool, params, result, detail, tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [companyId, userId, conversationId, actionId, String(event).slice(0, 30), tool, params ? JSON.stringify(params).slice(0, 20000) : null, result ? String(result).slice(0, 40) : null, detail ? String(detail).slice(0, 300) : null, Number(tokens) || 0],
    );
  } catch (error) {
    console.error('[assistant] auditoria indisponível:', error?.code || 'erro');
  }
}

module.exports = { log };
