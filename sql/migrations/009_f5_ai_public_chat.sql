-- F5-core-A: camada de IA compartilhada (uso, orçamentos, circuit breaker) e chat público de texto.
-- Idempotente: cada comando pode ser reexecutado. Tempos críticos (expiração, debounce) ficam em
-- BIGINT epoch-ms calculado no Node (independe do time_zone da conexão).

-- Uma linha por chamada ao provedor de IA (qualquer recurso: chat público, bot do WhatsApp, painel).
-- company_id NULL = uso da plataforma (ex.: chat do site institucional).
CREATE TABLE IF NOT EXISTS ai_usage (
  id BIGINT NOT NULL AUTO_INCREMENT,
  company_id INT NULL,
  session_id BIGINT NULL,
  feature VARCHAR(40) NOT NULL,
  provider VARCHAR(20) NOT NULL,
  model VARCHAR(80) NOT NULL,
  tokens_in INT NOT NULL DEFAULT 0,
  tokens_out INT NOT NULL DEFAULT 0,
  cost_micro_usd BIGINT NOT NULL DEFAULT 0,
  status ENUM('ok','error','timeout','invalid','blocked') NOT NULL DEFAULT 'ok',
  latency_ms INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ai_usage_company (company_id, created_at),
  KEY idx_ai_usage_session (session_id),
  KEY idx_ai_usage_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Orçamentos diários por escopo: global | company | session | ip (+ recurso em scope_key).
-- Reserva atômica (UPDATE ... WHERE tokens + ? <= limite) e ajuste ao uso real.
CREATE TABLE IF NOT EXISTS ai_budget_counters (
  scope VARCHAR(16) NOT NULL,
  scope_key VARCHAR(80) NOT NULL,
  day DATE NOT NULL,
  tokens BIGINT NOT NULL DEFAULT 0,
  cost_micro_usd BIGINT NOT NULL DEFAULT 0,
  calls INT NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (scope, scope_key, day),
  KEY idx_ai_budget_day (day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Circuit breaker por nome (ex.: provedor). Aberto enquanto opened_until_ms > agora.
CREATE TABLE IF NOT EXISTS ai_circuit (
  name VARCHAR(40) NOT NULL,
  failures INT NOT NULL DEFAULT 0,
  opened_until_ms BIGINT NOT NULL DEFAULT 0,
  reason VARCHAR(40) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sessões do chat público. O token (HMAC) carrega public_id + exp; o IP fica só como hash.
-- company_id vem do company_slug validado na criação e nunca muda.
CREATE TABLE IF NOT EXISTS chat_sessions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(32) NOT NULL,
  audience ENUM('customer','business') NOT NULL,
  company_id INT NULL,
  ip_hash CHAR(64) NOT NULL,
  status ENUM('active','closed','blocked') NOT NULL DEFAULT 'active',
  message_count INT NOT NULL DEFAULT 0,
  tokens_used INT NOT NULL DEFAULT 0,
  max_messages INT NOT NULL,
  max_tokens INT NOT NULL,
  injection_strikes INT NOT NULL DEFAULT 0,
  blocked_until_ms BIGINT NOT NULL DEFAULT 0,
  last_user_at_ms BIGINT NOT NULL DEFAULT 0,
  summary VARCHAR(500) NULL,
  lead_captured_at DATETIME NULL,
  rating TINYINT NULL,
  rating_comment VARCHAR(500) NULL,
  expires_at_ms BIGINT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_chat_sessions_public (public_id),
  KEY idx_chat_sessions_company (company_id, created_at),
  KEY idx_chat_sessions_ip (ip_hash, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Mensagens. client_msg_id dá idempotência (reenvio devolve a mesma resposta).
-- reply_to_id liga a resposta à mensagem do usuário. flagged = tentativa de injeção (fora do histórico).
CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGINT NOT NULL AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  role ENUM('user','assistant') NOT NULL,
  content TEXT NOT NULL,
  client_msg_id VARCHAR(64) NULL,
  reply_to_id BIGINT NULL,
  source VARCHAR(20) NULL,
  intent VARCHAR(40) NULL,
  payload TEXT NULL,
  tokens_in INT NOT NULL DEFAULT 0,
  tokens_out INT NOT NULL DEFAULT 0,
  flagged TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_chat_messages_client (session_id, client_msg_id),
  KEY idx_chat_messages_session (session_id, id),
  KEY idx_chat_messages_reply (reply_to_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
