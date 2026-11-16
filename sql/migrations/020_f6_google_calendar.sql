-- F6: Google Agenda (Premium). OAuth2 + PKCE, refresh token cifrado (AES-256-GCM, APP_ENCRYPTION_KEY).
-- AgendasPRO -> Google: um evento por agendamento (id determinístico) num calendário "push".
-- Google -> AgendasPRO: eventos ocupados de calendários "busy" viram time_blocks (source = 'google').
-- Idempotente.

CREATE TABLE IF NOT EXISTS google_calendar_accounts (
  id INT NOT NULL AUTO_INCREMENT,
  company_id INT NOT NULL,
  account_email VARCHAR(255) DEFAULT NULL,
  refresh_token_enc TEXT DEFAULT NULL,
  access_token_enc TEXT DEFAULT NULL,
  access_expires_at DATETIME DEFAULT NULL,
  scopes VARCHAR(500) DEFAULT NULL,
  status ENUM('active','reauth_required') NOT NULL DEFAULT 'active',
  last_error_code VARCHAR(60) DEFAULT NULL,
  connected_by_user_id INT DEFAULT NULL,
  connected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_push_at DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gcal_accounts_company (company_id),
  CONSTRAINT fk_gcal_accounts_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Calendários vinculados. role=push: destino dos agendamentos (professional_id NULL = padrão da empresa).
-- role=busy: origem de bloqueios; professional_id NULL só com opt-in explícito (bloqueia a empresa toda).
CREATE TABLE IF NOT EXISTS google_calendar_links (
  id INT NOT NULL AUTO_INCREMENT,
  company_id INT NOT NULL,
  account_id INT NOT NULL,
  role ENUM('push','busy') NOT NULL,
  professional_id INT DEFAULT NULL,
  pro_key INT AS (COALESCE(professional_id, 0)) STORED,
  calendar_id VARCHAR(190) NOT NULL,
  calendar_summary VARCHAR(255) DEFAULT NULL,
  created_by_app TINYINT(1) NOT NULL DEFAULT 0,
  sync_token TEXT DEFAULT NULL,
  last_sync_at DATETIME DEFAULT NULL,
  last_full_sync_at DATETIME DEFAULT NULL,
  channel_id VARCHAR(64) DEFAULT NULL,
  channel_token_hash CHAR(64) DEFAULT NULL,
  channel_resource_id VARCHAR(255) DEFAULT NULL,
  channel_expires_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gcal_links (company_id, role, pro_key, calendar_id),
  UNIQUE KEY uq_gcal_links_channel (channel_id),
  KEY idx_gcal_links_account (account_id),
  CONSTRAINT fk_gcal_links_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_gcal_links_account FOREIGN KEY (account_id) REFERENCES google_calendar_accounts (id) ON DELETE CASCADE,
  CONSTRAINT fk_gcal_links_professional FOREIGN KEY (professional_id) REFERENCES professionals (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Mapeamento agendamento -> evento exportado. Sem FK para appointments de propósito: um agendamento
-- apagado ainda precisa ter o evento removido do Google na próxima reconciliação.
CREATE TABLE IF NOT EXISTS google_calendar_events (
  company_id INT NOT NULL,
  appointment_id INT NOT NULL,
  link_id INT DEFAULT NULL,
  calendar_id VARCHAR(190) NOT NULL,
  event_id VARCHAR(64) NOT NULL,
  content_hash CHAR(64) DEFAULT NULL,
  status ENUM('synced','deleted') NOT NULL DEFAULT 'synced',
  synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, appointment_id),
  KEY idx_gcal_events_event (event_id),
  CONSTRAINT fk_gcal_events_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bloqueios importados: origem + referência externa (link:evento) para upsert/remoção idempotentes.
ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'manual';
ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS external_ref VARCHAR(255) DEFAULT NULL;
ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS link_id INT DEFAULT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_time_blocks_external ON time_blocks (company_id, source, external_ref);
CREATE INDEX IF NOT EXISTS idx_time_blocks_link ON time_blocks (link_id);
