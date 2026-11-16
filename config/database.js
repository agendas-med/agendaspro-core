// Configuração de conexão com o MariaDB/MySQL.
// Precedência: MYSQL_HOST (variáveis MYSQL_* explícitas) vence; sem ele, a primeira URL
// presente entre JAWSDB_MARIA_URL, JAWSDB_URL, CLEARDB_DATABASE_URL e DATABASE_URL
// (formato mysql://usuario:senha@host:porta/banco, como os add-ons do Heroku definem).
// A URL nunca é registrada em log (contém a senha).
const URL_VARS = ['JAWSDB_MARIA_URL', 'JAWSDB_URL', 'CLEARDB_DATABASE_URL', 'DATABASE_URL'];

function fromUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('URL do banco inválida (esperado mysql://usuario:senha@host:porta/banco).');
  }
  if (!/^(mysql|mariadb):$/.test(url.protocol)) {
    throw new Error('URL do banco precisa usar o esquema mysql:// ou mariadb://.');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!url.hostname || !database) throw new Error('URL do banco sem host ou nome do banco.');
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

function resolveDatabaseConfig(env = process.env) {
  if (env.MYSQL_HOST) {
    return {
      host: env.MYSQL_HOST,
      port: env.MYSQL_PORT ? Number(env.MYSQL_PORT) : 3306,
      user: env.MYSQL_USER,
      password: env.MYSQL_PASSWORD,
      database: env.MYSQL_DATABASE,
      source: 'MYSQL_*',
    };
  }
  const name = URL_VARS.find((key) => env[key]);
  if (name) return { ...fromUrl(env[name]), source: name };
  return { host: undefined, port: undefined, user: undefined, password: undefined, database: undefined, source: null };
}

function connectionLimit(env = process.env) {
  const n = Number(env.MYSQL_CONNECTION_LIMIT);
  return Number.isInteger(n) && n > 0 ? n : 10;
}

module.exports = { resolveDatabaseConfig, connectionLimit, URL_VARS };
