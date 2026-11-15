require('./config/env');
// Falha no boot se o segredo do JWT estiver ausente (ou fraco em produção).
require('./config/jwt').assertJwtSecret();
const http = require('http');
const app = require('./app');
const port = process.env.PORT || 3001;
const server = http.createServer(app);

server.listen(port);
