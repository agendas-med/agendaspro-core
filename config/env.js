// Carrega o .env local uma única vez. Em testes (NODE_ENV=test) o .env real nunca é lido:
// os testes definem apenas as variáveis de que precisam.
if (process.env.NODE_ENV !== 'test') require('dotenv').config();
module.exports = process.env;
