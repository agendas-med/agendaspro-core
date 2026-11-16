// Erro normalizado dos provedores OAuth (F6). kind: 'auth' (token inválido/revogado → reautenticar),
// 'rate_limit', 'unavailable' (rede/5xx, pode tentar de novo), 'not_found', 'gone' (410), 'bad_request'.
// A mensagem nunca carrega token, URL com query nem corpo bruto da resposta.
class ProviderError extends Error {
  constructor(message, { kind = 'bad_request', providerCode = null, httpStatus = null, retryAfterSec = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.providerCode = providerCode;
    this.httpStatus = httpStatus;
    this.retryAfterSec = retryAfterSec;
    this.retryable = kind === 'rate_limit' || kind === 'unavailable';
  }
}

module.exports = { ProviderError };
