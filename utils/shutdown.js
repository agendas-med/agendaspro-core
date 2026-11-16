// Desligamento gracioso (Heroku manda SIGTERM e mata com SIGKILL 30 s depois).
// 1) marca "desligando" (readiness passa a 503 e respostas levam Connection: close);
// 2) para de aceitar conexões e fecha as ociosas;
// 3) após graceMs, encerra à força as conexões restantes (SSE/keep-alive);
// 4) fecha o pool do banco e sai; um timer de segurança (hardMs) força a saída antes do SIGKILL.
const state = { shuttingDown: false };

function isShuttingDown() {
  return state.shuttingDown;
}

function createShutdown({
  server,
  closePool = async () => {},
  graceMs = 10000,
  hardMs = 25000,
  log = console,
  exit = (code) => process.exit(code),
} = {}) {
  let promise = null;
  return function shutdown(reason = 'shutdown') {
    if (promise) return promise;
    state.shuttingDown = true;
    log.log(`[shutdown] ${reason}: encerrando (graça ${graceMs} ms)`);
    const hard = setTimeout(() => {
      log.error('[shutdown] tempo esgotado; saindo à força');
      exit(1);
    }, hardMs);
    if (hard.unref) hard.unref();

    promise = new Promise((resolve) => {
      let force = null;
      const finish = async (code) => {
        if (force) clearTimeout(force);
        try {
          await closePool();
        } catch (error) {
          log.error('[shutdown] falha ao fechar o pool:', String(error?.message || error).slice(0, 200));
          code = 1;
        }
        clearTimeout(hard);
        log.log('[shutdown] concluído');
        exit(code);
        resolve(code);
      };
      if (!server || !server.listening) return finish(0);
      server.close((error) => finish(error ? 1 : 0));
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      force = setTimeout(() => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      }, graceMs);
      if (force.unref) force.unref();
    });
    return promise;
  };
}

// Middleware: durante o desligamento pede ao cliente/roteador para não reusar a conexão.
function connectionCloseWhileShuttingDown(req, res, next) {
  if (state.shuttingDown) res.set('Connection', 'close');
  next();
}

function resetForTests() {
  state.shuttingDown = false;
}

module.exports = { createShutdown, isShuttingDown, connectionCloseWhileShuttingDown, resetForTests };
