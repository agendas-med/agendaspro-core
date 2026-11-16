// Validação das variáveis de ambiente na inicialização (fail-fast em produção).
// Função pura: recebe o objeto env e devolve { errors, warnings } com NOMES de variáveis e
// o motivo; nunca inclui valores. Fora de produção nada é bloqueante (só avisos).
const { resolveDatabaseConfig } = require('./database');

const isTrue = (v) => String(v || '').trim().toLowerCase() === 'true';
const filled = (v) => typeof v === 'string' && v.trim() !== '';

function validateEnv(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const errors = [];
  const warnings = [];
  // Em produção vira erro; fora dela, aviso.
  const must = (message) => (production ? errors : warnings).push(message);
  const secret = (name, { min = 32, required = true } = {}) => {
    const value = env[name];
    if (!filled(value)) {
      if (required) must(`${name}: obrigatória`);
      return false;
    }
    if (value.trim().length < min) must(`${name}: use pelo menos ${min} caracteres aleatórios`);
    return true;
  };
  const requireAll = (feature, names) => {
    for (const name of names) if (!filled(env[name])) must(`${name}: obrigatória com ${feature}`);
  };

  // --- Núcleo ---------------------------------------------------------------
  const jwtName = filled(env.JWT_SECRET) ? 'JWT_SECRET' : (filled(env.JWT_KEY) ? 'JWT_KEY' : 'JWT_SECRET');
  secret(jwtName);

  if (!filled(env.APP_ENCRYPTION_KEY)) {
    must('APP_ENCRYPTION_KEY: obrigatória (base64 de 32 bytes)');
  } else if (Buffer.from(env.APP_ENCRYPTION_KEY.trim(), 'base64').length !== 32) {
    must('APP_ENCRYPTION_KEY: deve ser base64 de exatamente 32 bytes');
  }

  secret('JOBS_TICK_TOKEN');
  if (!filled(env.ADMIN_TOKEN)) warnings.push('ADMIN_TOKEN: ausente; /health/deep e rotas administrativas ficam desligadas (503)');
  else secret('ADMIN_TOKEN');
  if (filled(env.ADMIN_TOKEN) && env.ADMIN_TOKEN === env.JOBS_TICK_TOKEN) must('ADMIN_TOKEN e JOBS_TICK_TOKEN: use valores diferentes');

  try {
    const db = resolveDatabaseConfig(env);
    if (!db.host || !db.database || !db.user) must('MYSQL_HOST/MYSQL_DATABASE/MYSQL_USER (ou JAWSDB_MARIA_URL/DATABASE_URL): banco não configurado');
  } catch (error) {
    must(`URL do banco: ${error.message}`);
  }

  const cors = String(env.CORS_ORIGINS || env.URL_SITE || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!cors.length) must('CORS_ORIGINS: obrigatória (sem allowlist o navegador do painel é bloqueado)');
  else if (production && cors.some((o) => !/^https:\/\//.test(o))) warnings.push('CORS_ORIGINS: há origem sem https:// em produção');

  // --- API pública (F3) -----------------------------------------------------
  if (!secret('PUBLIC_BOOKING_TOKEN_SECRET', { required: false })) {
    warnings.push('PUBLIC_BOOKING_TOKEN_SECRET: ausente; reservas públicas respondem 503 service_unavailable');
  }
  if (!filled(env.TURNSTILE_SECRET_KEY)) {
    warnings.push('TURNSTILE_SECRET_KEY: ausente; em produção leads/reservas/chat públicos respondem 503 (fail-closed)');
  }
  if (production && (isTrue(env.TURNSTILE_DEV_BYPASS) || env.TURNSTILE_ENABLED === 'false')) {
    warnings.push('TURNSTILE_DEV_BYPASS/TURNSTILE_ENABLED: ignoradas em produção (Turnstile sempre verificado)');
  }
  if (production && filled(env.PUBLIC_SITE_URL) === false) warnings.push('PUBLIC_SITE_URL: ausente; links de gestão de agendamento ficam sem base');

  // --- Asaas ----------------------------------------------------------------
  if (filled(env.ASAAS_API_KEY) || isTrue(env.ASAAS_SUBSCRIPTIONS_ENABLED)) {
    if (!/^[^\s]{32,255}$/.test(env.ASAAS_WEBHOOK_TOKEN || '')) must('ASAAS_WEBHOOK_TOKEN: obrigatória com Asaas (32 a 255 caracteres sem espaços)');
    if (production && env.ASAAS_ENV !== 'production') warnings.push('ASAAS_ENV: não é "production" (Asaas em sandbox)');
  }
  if (isTrue(env.ASAAS_SUBSCRIPTIONS_ENABLED)) requireAll('ASAAS_SUBSCRIPTIONS_ENABLED=true', ['ASAAS_API_KEY', 'ASAAS_MAIN_WALLET_ID', 'WEBHOOK_URL']);

  // --- WhatsApp Cloud API (F4) ----------------------------------------------
  if (isTrue(env.WHATSAPP_CLOUD_ENABLED)) {
    requireAll('WHATSAPP_CLOUD_ENABLED=true', ['META_APP_SECRET', 'META_VERIFY_TOKEN', 'META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID']);
  }
  if (production && isTrue(env.WHATSAPP_LEGACY_RELAY)) warnings.push('WHATSAPP_LEGACY_RELAY: relay legado ligado em produção');

  // --- IA (F5) --------------------------------------------------------------
  if (isTrue(env.PUBLIC_CHAT_ENABLED)) {
    requireAll('PUBLIC_CHAT_ENABLED=true', ['TURNSTILE_SECRET_KEY']);
    if (!filled(env.PUBLIC_CHAT_TOKEN_SECRET)) warnings.push('PUBLIC_CHAT_TOKEN_SECRET: ausente; derivado de PUBLIC_BOOKING_TOKEN_SECRET');
    if (!filled(env.PUBLIC_CHAT_TOKEN_SECRET) && !filled(env.PUBLIC_BOOKING_TOKEN_SECRET)) must('PUBLIC_CHAT_TOKEN_SECRET: obrigatória com PUBLIC_CHAT_ENABLED=true (ou PUBLIC_BOOKING_TOKEN_SECRET)');
  }
  if (isTrue(env.ASSISTANT_ENABLED) && !filled(env.ASSISTANT_TOKEN_SECRET)) {
    warnings.push('ASSISTANT_TOKEN_SECRET: ausente; ações de escrita do assistente ficam desligadas (503)');
  }
  if ((isTrue(env.PUBLIC_CHAT_ENABLED) || isTrue(env.ASSISTANT_ENABLED)) && !filled(env.OPENAI_API_KEY)) {
    warnings.push('OPENAI_API_KEY: ausente; chat/assistente respondem só de forma determinística');
  }
  if (isTrue(env.ASSISTANT_RAG_ENABLED) && !filled(env.OPENAI_EMBEDDING_MODEL)) warnings.push('OPENAI_EMBEDDING_MODEL: ausente; RAG desligado');

  // --- Integrações (F6) -----------------------------------------------------
  if (filled(env.INSTAGRAM_APP_ID)) requireAll('INSTAGRAM_APP_ID', ['INSTAGRAM_APP_SECRET', 'INSTAGRAM_REDIRECT_URIS']);
  if (filled(env.GOOGLE_CALENDAR_CLIENT_ID)) {
    requireAll('GOOGLE_CALENDAR_CLIENT_ID', ['GOOGLE_CALENDAR_CLIENT_SECRET', 'GOOGLE_CALENDAR_REDIRECT_URIS']);
    if (!filled(env.GOOGLE_CALENDAR_EVENT_SALT)) warnings.push('GOOGLE_CALENDAR_EVENT_SALT: ausente; defina antes do primeiro push e não troque');
  }
  if ((filled(env.INSTAGRAM_APP_ID) || filled(env.GOOGLE_CALENDAR_CLIENT_ID)) && !filled(env.OAUTH_STATE_SECRET)) {
    warnings.push('OAUTH_STATE_SECRET: ausente; derivado de APP_ENCRYPTION_KEY');
  }

  // --- Operação -------------------------------------------------------------
  if (production && isTrue(env.ENABLE_INPROCESS_CRON)) warnings.push('ENABLE_INPROCESS_CRON: cron em processo não é confiável no Eco (use o gatilho horário externo)');

  return { errors, warnings, production };
}

// Chamado só pelo server.js. Em produção, erros encerram o processo antes de abrir a porta.
function assertEnv(env = process.env, { log = console } = {}) {
  const { errors, warnings, production } = validateEnv(env);
  for (const w of warnings) log.warn(`[env] aviso: ${w}`);
  if (errors.length) {
    for (const e of errors) log.error(`[env] erro: ${e}`);
    if (production) throw new Error(`Configuração inválida para produção (${errors.length} problema(s)); veja os logs [env].`);
  }
  return { errors, warnings };
}

module.exports = { validateEnv, assertEnv };
