-- F1: segurança e infraestrutura. Cada instrução é idempotente (DDL do MariaDB faz commit
-- implícito; se a migração parar no meio, basta rodar de novo).

-- Segredos cifrados (AES-256-GCM + base64) não cabem em VARCHAR(255).
ALTER TABLE companies MODIFY COLUMN asaas_api_key TEXT NULL;
ALTER TABLE asaas_wallets MODIFY COLUMN asaas_api_key TEXT NOT NULL;
-- Dono da subconta: só o mesmo usuário pode reaproveitar a carteira de um CPF/CNPJ.
ALTER TABLE asaas_wallets ADD COLUMN IF NOT EXISTS owner_user_id INT NULL;

-- Refresh tokens rotativos (apenas o hash SHA-256 é armazenado).
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id BIGINT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  family_id CHAR(32) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  replaced_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_refresh_tokens_hash (token_hash),
  KEY idx_refresh_tokens_user (user_id),
  KEY idx_refresh_tokens_family (family_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rate limit em banco (janela fixa por chave).
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket VARCHAR(191) NOT NULL,
  hits INT NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  PRIMARY KEY (bucket),
  KEY idx_rate_limits_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Fila de jobs drenada por POST /internal/jobs/tick (Eco dyno: sem cron confiável).
CREATE TABLE IF NOT EXISTS jobs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  type VARCHAR(100) NOT NULL,
  payload LONGTEXT NULL,
  status ENUM('pending','running','done','failed') NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  due_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_until DATETIME NULL,
  lock_token CHAR(32) NULL,
  dedupe_key VARCHAR(191) NULL,
  last_error TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_jobs_dedupe (dedupe_key),
  KEY idx_jobs_claim (status, due_at),
  KEY idx_jobs_lock (lock_token)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Eventos recebidos de provedores externos (Asaas agora; Meta depois), com dedupe por id externo.
CREATE TABLE IF NOT EXISTS inbound_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  provider VARCHAR(30) NOT NULL,
  external_id VARCHAR(191) NOT NULL,
  event_type VARCHAR(100) NULL,
  payload LONGTEXT NULL,
  status ENUM('received','processed','failed','ignored') NOT NULL DEFAULT 'received',
  attempts INT NOT NULL DEFAULT 0,
  last_error VARCHAR(500) NULL,
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inbound_events_external (provider, external_id),
  KEY idx_inbound_events_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Convites: token aleatório de 32 bytes, só o hash persiste; expira em 7 dias; uso único.
ALTER TABLE company_invitations MODIFY COLUMN token VARCHAR(50) NULL;
ALTER TABLE company_invitations ADD COLUMN IF NOT EXISTS token_hash CHAR(64) NULL;
ALTER TABLE company_invitations ADD COLUMN IF NOT EXISTS expires_at DATETIME NULL;
ALTER TABLE company_invitations ADD COLUMN IF NOT EXISTS used_at DATETIME NULL;
CREATE INDEX IF NOT EXISTS idx_company_invitations_token_hash ON company_invitations (token_hash);
UPDATE company_invitations SET token_hash = SHA2(token, 256), expires_at = COALESCE(expires_at, invitation_date + INTERVAL 7 DAY), token = NULL
  WHERE token IS NOT NULL AND token_hash IS NULL;

-- Redefinição de senha: só o hash do token persiste.
ALTER TABLE password_requests MODIFY COLUMN token VARCHAR(100) NULL;
ALTER TABLE password_requests ADD COLUMN IF NOT EXISTS token_hash CHAR(64) NULL;
CREATE INDEX IF NOT EXISTS idx_password_requests_token_hash ON password_requests (token_hash);
UPDATE password_requests SET token_hash = SHA2(token, 256), token = NULL WHERE token IS NOT NULL AND token_hash IS NULL;

-- Webhooks Asaas: estorno/chargeback marcam o pagamento sem apagar o histórico.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_at DATETIME NULL;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS external_status VARCHAR(40) NULL;

-- LGPD mínima.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS anonymized_at DATETIME NULL;
CREATE TABLE IF NOT EXISTS consents (
  id BIGINT NOT NULL AUTO_INCREMENT,
  company_id INT NOT NULL,
  customer_id INT NOT NULL,
  purpose VARCHAR(50) NOT NULL,
  granted TINYINT(1) NOT NULL DEFAULT 1,
  source VARCHAR(30) NULL,
  granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_consents_company_customer (company_id, customer_id),
  CONSTRAINT fk_consents_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_consents_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Índices de tenant usados pelas novas consultas.
CREATE INDEX IF NOT EXISTS idx_appointments_reminder ON appointments (notified_1h, canceled, date);
