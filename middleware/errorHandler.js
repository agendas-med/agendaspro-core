const crypto = require('node:crypto');

// Tratamento central de erros: mensagem genérica + correlation id para falhas internas;
// nunca devolve stack, SQL, detalhes de AxiosError ou segredos.
const GENERIC_MESSAGE = 'Erro interno. Informe o código de correlação ao suporte.';

function correlationId(req) {
  if (!req.correlationId) req.correlationId = crypto.randomBytes(8).toString('hex');
  return req.correlationId;
}

function isInternal(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.isAxiosError || error.response?.data || error.config?.headers) return true;
  if (error.sql || error.sqlMessage || error.sqlState) return true;
  if (typeof error.code === 'string' && /^(ER_|ECONN|ETIMEDOUT|ENOTFOUND|PROTOCOL_|EAI_)/.test(error.code)) return true;
  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError || error instanceof RangeError) return true;
  return false;
}

// Log sem PII/segredos: só tipo, código e uma mensagem curta (sem SQL).
function logInternal(req, error) {
  const code = typeof error?.code === 'string' ? error.code : undefined;
  const status = error?.response?.status;
  const message = error?.sqlMessage ? 'database error' : String(error?.message || error).slice(0, 200);
  console.error(`[erro ${correlationId(req)}] ${req.method} ${req.baseUrl || ''}${req.route?.path || req.path}`, JSON.stringify({ name: error?.name, code, status, message }));
}

function internalBody(req) {
  return { message: GENERIC_MESSAGE, correlation_id: correlationId(req) };
}

// Usado pelas rotas legadas no lugar de `res.status(x).send(error)`.
// - objeto no formato createResponse (erro de negócio): devolvido como está;
// - Error de negócio (new Error('...')): devolve a mensagem com o status indicado;
// - erro interno (banco, rede, Axios, bug): 500 genérico com correlation id.
function sendError(req, res, error, status = 500, { text = false } = {}) {
  if (res.headersSent) return undefined;
  if (error && typeof error === 'object' && !(error instanceof Error) && error.request && 'message' in error) {
    return res.status(Number(error.request.status) || status).send(error);
  }
  if (isInternal(error) || !(error instanceof Error || typeof error === 'string')) {
    logInternal(req, error);
    return text ? res.status(500).send(`${GENERIC_MESSAGE} (${correlationId(req)})`) : res.status(500).send(internalBody(req));
  }
  const message = typeof error === 'string' ? error : error.message;
  const finalStatus = Number(error.status) >= 400 && Number(error.status) < 500 ? Number(error.status) : status;
  return text ? res.status(finalStatus).send(message) : res.status(finalStatus).send({ message });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(error, req, res, next) {
  if (res.headersSent) return undefined;
  if (error?.type === 'entity.too.large') return res.status(413).send({ message: 'Corpo da requisição muito grande.' });
  if (error?.type === 'entity.parse.failed') return res.status(400).send({ message: 'JSON inválido.' });
  if (error?.status === 404 && error.expose !== false) return res.status(404).send({ message: 'Não encontrado' });
  if (Number(error?.status) >= 400 && Number(error?.status) < 500 && !isInternal(error)) {
    return res.status(Number(error.status)).send({ message: error.message });
  }
  logInternal(req, error);
  return res.status(500).send(internalBody(req));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = { errorHandler, sendError, isInternal, HttpError, GENERIC_MESSAGE, logInternal, correlationId };
