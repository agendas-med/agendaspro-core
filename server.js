require('dotenv');
const http = require('http');
const app = require('./app');
const port = process.env.PORT || 3001;
const server = http.createServer(app);

initWebSocket(server);

server.listen(port);