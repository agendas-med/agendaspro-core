-- F4: WhatsApp Cloud API oficial (Meta) como módulo do core.
-- Número único da plataforma hoje; whatsapp_accounts já comporta número próprio por empresa.
-- Idempotente: cada comando pode ser reexecutado.

-- Números conectados. company_id NULL = número da plataforma (compartilhado).
-- access_token_enc: token cifrado (utils/crypto, enc:v1:); NULL = usa META_ACCESS_TOKEN do ambiente.
CREATE TABLE IF NOT EXISTS whatsapp_accounts (
  id INT NOT NULL AUTO_INCREMENT,
  company_id INT NULL,
  phone_number_id VARCHAR(64) NOT NULL,
  waba_id VARCHAR(64) NULL,
  display_phone VARCHAR(32) NULL,
  access_token_enc TEXT NULL,
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_wa_accounts_phone (phone_number_id),
  KEY idx_wa_accounts_company (company_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Contato = telefone (wa_id) na plataforma. Opt-out vale para a plataforma inteira (LGPD).
CREATE TABLE IF NOT EXISTS whatsapp_contacts (
  id INT NOT NULL AUTO_INCREMENT,
  wa_id VARCHAR(20) NOT NULL,
  profile_name VARCHAR(120) NULL,
  opt_in_at DATETIME NULL,
  opt_in_source VARCHAR(40) NULL,
  opted_out_at DATETIME NULL,
  last_inbound_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_wa_contacts_wa_id (wa_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Uma conversa por (número, contato). company_id = clínica identificada (NULL = ainda não).
-- lease_*: trava curta por conversa (duas mensagens seguidas não avançam o estado em paralelo).
CREATE TABLE IF NOT EXISTS whatsapp_conversations (
  id INT NOT NULL AUTO_INCREMENT,
  account_id INT NOT NULL,
  contact_id INT NOT NULL,
  company_id INT NULL,
  state VARCHAR(40) NOT NULL DEFAULT 'start',
  context LONGTEXT NULL,
  mode ENUM('bot','human') NOT NULL DEFAULT 'bot',
  assigned_user_id INT NULL,
  handoff_at DATETIME NULL,
  last_inbound_at DATETIME NULL,
  last_message_at DATETIME NULL,
  lease_token VARCHAR(40) NULL,
  lease_until DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_wa_conv (account_id, contact_id),
  KEY idx_wa_conv_company (company_id, last_message_at),
  CONSTRAINT chk_wa_conv_context CHECK (context IS NULL OR JSON_VALID(context))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Mensagens (entrada e saída). company_id gravado por mensagem: a caixa de entrada de uma
-- empresa só vê as mensagens trocadas enquanto a conversa estava com ela.
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id BIGINT NOT NULL AUTO_INCREMENT,
  conversation_id INT NOT NULL,
  company_id INT NULL,
  direction ENUM('in','out') NOT NULL,
  author ENUM('customer','bot','agent','system') NOT NULL,
  user_id INT NULL,
  wamid VARCHAR(191) NULL,
  type VARCHAR(20) NOT NULL DEFAULT 'text',
  body TEXT NULL,
  template_name VARCHAR(80) NULL,
  status ENUM('received','queued','sent','delivered','read','failed') NOT NULL,
  error_code VARCHAR(40) NULL,
  attempts INT NOT NULL DEFAULT 0,
  billable TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_wa_messages_wamid (wamid),
  KEY idx_wa_messages_conv (conversation_id, id),
  KEY idx_wa_messages_company (company_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Modelos (templates) da plataforma. status reflete a aprovação na Meta
-- (POST /internal/whatsapp/templates/sync). Só 'approved' é enviado.
CREATE TABLE IF NOT EXISTS whatsapp_templates (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(80) NOT NULL,
  language VARCHAR(10) NOT NULL DEFAULT 'pt_BR',
  category VARCHAR(20) NOT NULL DEFAULT 'UTILITY',
  purpose VARCHAR(40) NOT NULL,
  body_preview TEXT NOT NULL,
  param_count INT NOT NULL DEFAULT 0,
  status ENUM('pending','approved','rejected','disabled') NOT NULL DEFAULT 'pending',
  synced_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_wa_templates (name, language),
  KEY idx_wa_templates_purpose (purpose)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO whatsapp_templates (name, language, category, purpose, body_preview, param_count) VALUES
('agendamento_lembrete', 'pt_BR', 'UTILITY', 'reminder', 'Olá, {{1}}! Lembrete do seu agendamento na {{2}} em {{3}} às {{4}}. Para cancelar ou remarcar, responda esta mensagem.', 4),
('agendamento_confirmado', 'pt_BR', 'UTILITY', 'booking_confirmed', 'Olá, {{1}}! Seu agendamento na {{2}} está confirmado para {{3}} às {{4}}. Ver, cancelar ou remarcar: {{5}}', 5),
('agendamento_remarcado', 'pt_BR', 'UTILITY', 'booking_rescheduled', 'Olá, {{1}}! Seu agendamento na {{2}} foi remarcado para {{3}} às {{4}}. Ver, cancelar ou remarcar: {{5}}', 5),
('atendimento_retomar', 'pt_BR', 'UTILITY', 'agent_reopen', 'Olá! A equipe da {{1}} quer continuar o seu atendimento. Responda esta mensagem para conversar.', 1),
('lead_novo', 'pt_BR', 'UTILITY', 'lead_notify', 'Novo lead no site AgendasPRO: {{1}} ({{2}}), segmento {{3}}, origem {{4}}.', 4);

-- Configuração do bot por empresa.
CREATE TABLE IF NOT EXISTS whatsapp_settings (
  company_id INT NOT NULL,
  bot_enabled TINYINT(1) NOT NULL DEFAULT 1,
  ai_enabled TINYINT(1) NOT NULL DEFAULT 1,
  welcome_text VARCHAR(300) NULL,
  ai_daily_token_limit INT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Orçamento diário de tokens de IA por empresa (reserva atômica antes da chamada).
CREATE TABLE IF NOT EXISTS ai_usage_daily (
  company_id INT NOT NULL,
  day DATE NOT NULL,
  tokens_used INT NOT NULL DEFAULT 0,
  calls INT NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Teto diário de tokens de IA por plano (a empresa pode baixar em whatsapp_settings).
UPDATE plans SET features = JSON_SET(features, '$.whatsapp_ai_daily_tokens', 4000) WHERE code = 'free' AND JSON_EXTRACT(features, '$.whatsapp_ai_daily_tokens') IS NULL;
UPDATE plans SET features = JSON_SET(features, '$.whatsapp_ai_daily_tokens', 40000) WHERE code = 'premium' AND JSON_EXTRACT(features, '$.whatsapp_ai_daily_tokens') IS NULL;
