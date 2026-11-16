require('./config/env');
// Fail-fast: em produção, variáveis obrigatórias ausentes/fracas abortam o boot (só nomes no log).
try {
  require('./config/validateEnv').assertEnv();
  // Falha no boot se o segredo do JWT estiver ausente (ou fraco em produção).
  require('./config/jwt').assertJwtSecret();
} catch (error) {
  console.error(`[boot] ${error.message}`);
  process.exit(1);
}
const http = require('http');
const app = require('./app');
const { createShutdown } = require('./utils/shutdown');

const port = process.env.PORT || 3001;
const server = http.createServer(app);
// Abaixo do timeout de 30 s do roteador do Heroku e acima do keep-alive dele.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

const shutdown = createShutdown({
  server,
  closePool: () => new Promise((resolve, reject) => {
    require('./mysql').pool.end((error) => (error ? reject(error) : resolve()));
  }),
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// Erros não tratados: registra só a mensagem (sem stack/PII) e encerra de forma ordenada;
// o Heroku reinicia o dyno.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', String(reason?.message || reason).slice(0, 300));
  shutdown('unhandledRejection');
});
process.on('uncaughtException', (error) => {
  console.error('[fatal] uncaughtException:', String(error?.message || error).slice(0, 300));
  shutdown('uncaughtException');
});

server.listen(port, () => console.log(`[boot] ouvindo na porta ${port}`));
