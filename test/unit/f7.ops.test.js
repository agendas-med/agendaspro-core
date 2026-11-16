// F7: operação (banco por URL, validação de env, desligamento, health/ready, gatilho do tick).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const { resolveDatabaseConfig, connectionLimit } = require('../../config/database');
const { validateEnv, assertEnv } = require('../../config/validateEnv');
const shutdownLib = require('../../utils/shutdown');
const jobsTick = require('../../scripts/jobs-tick');

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const urlOf = (server) => `http://127.0.0.1:${server.address().port}`;
const close = (server) => new Promise((resolve) => server.close(resolve));
const silent = { log() {}, warn() {}, error() {} };

// ---------------------------------------------------------------- banco
test('resolveDatabaseConfig: MYSQL_* explícitas têm precedência sobre URL', () => {
  const cfg = resolveDatabaseConfig({
    MYSQL_HOST: 'db.local', MYSQL_PORT: '3307', MYSQL_USER: 'u', MYSQL_PASSWORD: 'p', MYSQL_DATABASE: 'd',
    JAWSDB_MARIA_URL: 'mysql://x:y@outro:3306/z',
  });
  assert.equal(cfg.host, 'db.local');
  assert.equal(Number(cfg.port), 3307);
  assert.equal(cfg.database, 'd');
});

test('resolveDatabaseConfig: URL do add-on (ordem JAWSDB_MARIA_URL > DATABASE_URL), porta padrão e decodificação', () => {
  const cfg = resolveDatabaseConfig({
    JAWSDB_MARIA_URL: 'mysql://usr:p%40ss@host.example:3310/base_a',
    DATABASE_URL: 'mysql://outro:x@h2/base_b',
  });
  assert.deepEqual({ host: cfg.host, port: Number(cfg.port), user: cfg.user, password: cfg.password, database: cfg.database },
    { host: 'host.example', port: 3310, user: 'usr', password: 'p@ss', database: 'base_a' });
  const def = resolveDatabaseConfig({ DATABASE_URL: 'mariadb://a:b@h3/base_c' });
  assert.equal(Number(def.port), 3306);
  assert.equal(def.database, 'base_c');
});

test('resolveDatabaseConfig: URL inválida lança erro sem expor a senha', () => {
  assert.throws(() => resolveDatabaseConfig({ DATABASE_URL: 'postgres://u:segredo123@h/db' }), (error) => {
    assert.ok(!String(error.message).includes('segredo123'));
    return true;
  });
});

test('connectionLimit: padrão 10 e MYSQL_CONNECTION_LIMIT válido', () => {
  assert.equal(connectionLimit({}), 10);
  assert.equal(connectionLimit({ MYSQL_CONNECTION_LIMIT: '5' }), 5);
});

// ---------------------------------------------------------------- env
const strong = () => crypto.randomBytes(24).toString('hex'); // 48 caracteres
const validProd = () => ({
  NODE_ENV: 'production',
  JWT_SECRET: strong(),
  APP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
  JOBS_TICK_TOKEN: strong(),
  ADMIN_TOKEN: strong(),
  PUBLIC_BOOKING_TOKEN_SECRET: strong(),
  TURNSTILE_SECRET_KEY: 'turnstile-secret',
  PUBLIC_SITE_URL: 'https://site.example',
  JAWSDB_MARIA_URL: 'mysql://u:p@h.example:3306/db',
  CORS_ORIGINS: 'https://app.example',
});

test('validateEnv: produção completa não tem erros', () => {
  const { errors, production } = validateEnv(validProd());
  assert.equal(production, true);
  assert.deepEqual(errors, []);
});

test('validateEnv: produção vazia lista os obrigatórios só por nome', () => {
  const { errors } = validateEnv({ NODE_ENV: 'production' });
  const text = errors.join('\n');
  for (const name of ['JWT_SECRET', 'APP_ENCRYPTION_KEY', 'JOBS_TICK_TOKEN', 'CORS_ORIGINS', 'MYSQL_HOST']) {
    assert.match(text, new RegExp(name));
  }
});

test('validateEnv: chave de criptografia fraca, tokens iguais e segredo curto viram erro; valores não aparecem', () => {
  const env = validProd();
  env.APP_ENCRYPTION_KEY = Buffer.from('curta').toString('base64');
  env.ADMIN_TOKEN = env.JOBS_TICK_TOKEN;
  env.JWT_SECRET = 'segredo-curto';
  const { errors } = validateEnv(env);
  const text = errors.join('\n');
  assert.match(text, /APP_ENCRYPTION_KEY/);
  assert.match(text, /ADMIN_TOKEN e JOBS_TICK_TOKEN/);
  assert.match(text, /JWT_SECRET/);
  assert.ok(!text.includes(env.JOBS_TICK_TOKEN));
  assert.ok(!text.includes('segredo-curto'));
});

test('validateEnv: features ligadas exigem seus segredos', () => {
  const env = {
    ...validProd(),
    WHATSAPP_CLOUD_ENABLED: 'true',
    ASAAS_SUBSCRIPTIONS_ENABLED: 'true',
    PUBLIC_CHAT_ENABLED: 'true',
    PUBLIC_BOOKING_TOKEN_SECRET: '',
    INSTAGRAM_APP_ID: '123',
  };
  const text = validateEnv(env).errors.join('\n');
  for (const name of ['META_APP_SECRET', 'META_VERIFY_TOKEN', 'META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID',
    'ASAAS_WEBHOOK_TOKEN', 'ASAAS_API_KEY', 'ASAAS_MAIN_WALLET_ID', 'WEBHOOK_URL',
    'PUBLIC_CHAT_TOKEN_SECRET', 'INSTAGRAM_APP_SECRET', 'INSTAGRAM_REDIRECT_URIS']) {
    assert.match(text, new RegExp(name), name);
  }
});

test('validateEnv/assertEnv: fora de produção nada bloqueia; em produção com erro lança', () => {
  const dev = validateEnv({ NODE_ENV: 'development' });
  assert.deepEqual(dev.errors, []);
  assert.ok(dev.warnings.length > 0);
  assert.doesNotThrow(() => assertEnv({ NODE_ENV: 'development' }, { log: silent }));
  assert.throws(() => assertEnv({ NODE_ENV: 'production' }, { log: silent }), /Configuração inválida/);
  assert.doesNotThrow(() => assertEnv(validProd(), { log: silent }));
});

// ---------------------------------------------------------------- desligamento
test('createShutdown: fecha servidor e pool, sai com 0 e é idempotente', async (t) => {
  t.after(() => shutdownLib.resetForTests());
  const server = await listen((req, res) => res.end('ok'));
  const exits = [];
  let poolClosed = 0;
  const shutdown = shutdownLib.createShutdown({
    server, closePool: async () => { poolClosed++; }, graceMs: 50, hardMs: 2000, log: silent, exit: (code) => exits.push(code),
  });
  const p1 = shutdown('teste');
  const p2 = shutdown('de novo');
  assert.equal(p1, p2);
  assert.equal(shutdownLib.isShuttingDown(), true);
  assert.equal(await p1, 0);
  assert.equal(server.listening, false);
  assert.equal(poolClosed, 1);
  assert.deepEqual(exits, [0]);
});

test('createShutdown: falha ao fechar o pool sai com 1; conexão keep-alive é encerrada após a graça', async (t) => {
  t.after(() => shutdownLib.resetForTests());
  const server = await listen((req, res) => { res.write('parcial'); }); // resposta nunca termina
  const agent = new http.Agent({ keepAlive: true });
  await new Promise((resolve) => {
    const req = http.get(`${urlOf(server)}/`, { agent }, (res) => { res.once('data', resolve); res.on('error', () => {}); });
    req.on('error', () => {});
  });
  const exits = [];
  const shutdown = shutdownLib.createShutdown({
    server, closePool: async () => { throw new Error('pool'); }, graceMs: 30, hardMs: 2000, log: silent, exit: (code) => exits.push(code),
  });
  assert.equal(await shutdown('teste'), 1);
  assert.deepEqual(exits, [1]);
  agent.destroy();
});

test('connectionCloseWhileShuttingDown: só marca Connection: close durante o desligamento', async (t) => {
  t.after(() => shutdownLib.resetForTests());
  const headers = {};
  const res = { set: (k, v) => { headers[k] = v; } };
  let nexts = 0;
  shutdownLib.connectionCloseWhileShuttingDown({}, res, () => nexts++);
  assert.equal(headers.Connection, undefined);
  await shutdownLib.createShutdown({ server: null, log: silent, exit: () => {} })('teste');
  shutdownLib.connectionCloseWhileShuttingDown({}, res, () => nexts++);
  assert.equal(headers.Connection, 'close');
  assert.equal(nexts, 2);
});

// ---------------------------------------------------------------- health/ready
test('GET /health e /health/ready: liveness sem banco, readiness com banco + migration, 503 ao desligar', async (t) => {
  const functionsPath = require.resolve('../../utils/functions');
  const original = require.cache[functionsPath];
  const fake = { mode: 'ok', calls: 0 };
  require.cache[functionsPath] = {
    id: functionsPath, filename: functionsPath, loaded: true,
    exports: {
      async executeSql(sql) {
        fake.calls++;
        if (fake.mode === 'down') throw new Error('ECONNREFUSED');
        if (/schema_migrations/.test(sql)) return fake.mode === 'pending' ? [] : [{ 1: 1 }];
        return [{ 1: 1 }];
      },
    },
  };
  const health = require('../../routes/health');
  const app = express();
  app.use('/health', health);
  const server = await listen(app);
  t.after(async () => {
    if (original) require.cache[functionsPath] = original; else delete require.cache[functionsPath];
    shutdownLib.resetForTests();
    health.resetCacheForTests();
    await close(server);
  });
  const get = async (p) => {
    const res = await fetch(`${urlOf(server)}${p}`);
    return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') };
  };

  assert.ok(/^\d{3}_/.test(health.LATEST_MIGRATION));
  const live = await get('/health');
  assert.deepEqual([live.status, live.body.status, live.cache], [200, 'ok', 'no-store']);
  assert.equal(fake.calls, 0);

  health.resetCacheForTests();
  assert.deepEqual(await get('/health/ready').then((r) => [r.status, r.body.status]), [200, 'ready']);

  fake.mode = 'pending'; health.resetCacheForTests();
  assert.deepEqual(await get('/health/ready').then((r) => [r.status, r.body]), [503, { status: 'unavailable' }]);

  fake.mode = 'down'; health.resetCacheForTests();
  assert.deepEqual(await get('/health/ready').then((r) => [r.status, r.body]), [503, { status: 'unavailable' }]);

  fake.mode = 'ok'; health.resetCacheForTests();
  await shutdownLib.createShutdown({ server: null, log: silent, exit: () => {} })('teste');
  assert.equal((await get('/health/ready')).status, 503);
});

// ---------------------------------------------------------------- gatilho do tick
test('jobs-tick: aquece /health, chama o tick com Bearer e não imprime o token', async (t) => {
  const token = strong();
  const seen = [];
  const server = await listen((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization === `Bearer ${token}` ? 'auth' : 'noauth'}`);
    if (req.url === '/health') return res.end('{"status":"ok"}');
    if (req.url === '/internal/jobs/tick' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ claimed: 2, done: 2, remaining: 0 }));
    }
    res.statusCode = 404; res.end();
  });
  t.after(() => close(server));
  const lines = [];
  const log = { log: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
  const code = await jobsTick({ env: { API_BASE_URL: `${urlOf(server)}/`, JOBS_TICK_TOKEN: token }, log });
  assert.equal(code, 0);
  assert.deepEqual(seen, ['GET /health noauth', 'POST /internal/jobs/tick auth']);
  assert.match(lines.join('\n'), /claimed=2 done=2/);
  assert.ok(!lines.join('\n').includes(token));
});

test('jobs-tick: sem configuração retorna 2; tick 401 retorna 1', async (t) => {
  assert.equal(await jobsTick({ env: {}, log: silent }), 2);
  const server = await listen((req, res) => {
    if (req.url === '/health') return res.end('ok');
    res.statusCode = 401; res.end('{}');
  });
  t.after(() => close(server));
  assert.equal(await jobsTick({ env: { API_BASE_URL: urlOf(server), JOBS_TICK_TOKEN: 'x' }, log: silent }), 1);
});

// ---------------------------------------------------------------- limite global
test('globalRateLimit: 429 com Retry-After acima do limite, janela reinicia, webhooks/health isentos, desligado em teste', () => {
  const { createGlobalRateLimit } = require('../../middleware/globalRateLimit');
  let t = 1000;
  const mw = createGlobalRateLimit({ env: { GLOBAL_RATE_LIMIT_PER_MIN: '2' }, now: () => t });
  const call = (p, ip = '1.1.1.1') => {
    const out = { status: 200, headers: {}, next: false };
    const res = {
      set: (k, v) => { out.headers[k] = v; },
      status: (s) => { out.status = s; return { json: () => out }; },
    };
    mw({ path: p, ip }, res, () => { out.next = true; });
    return out;
  };
  assert.equal(call('/users/login').next, true);
  assert.equal(call('/users/login').next, true);
  const blocked = call('/users/login');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers['Retry-After'], '60');
  assert.equal(call('/users/login', '2.2.2.2').next, true);
  assert.equal(call('/health').next, true);
  assert.equal(call('/health/ready').next, true);
  assert.equal(call('/webhook/meta').next, true);
  assert.equal(call('/webhook').next, true);
  t += 60000;
  assert.equal(call('/users/login').next, true);
  assert.equal(createGlobalRateLimit({ env: { NODE_ENV: 'test' } }).limit, 0);
  assert.equal(createGlobalRateLimit({ env: { NODE_ENV: 'production' } }).limit, 300);
  assert.equal(createGlobalRateLimit({ env: { NODE_ENV: 'production', GLOBAL_RATE_LIMIT_PER_MIN: '0' } }).limit, 0);
});

test('Procfile: release roda migrations e web sobe o servidor', () => {
  const procfile = require('node:fs').readFileSync(path.join(__dirname, '../../Procfile'), 'utf8');
  assert.match(procfile, /^release: npm run db:migrate$/m);
  assert.match(procfile, /^web: node server\.js$/m);
});
