-- F3: API pública de agendamento (página /b/:slug), leads do site e sinal via Pix.
-- Retrocompatível: colunas novas são NULLable/DEFAULT; a página pública é opt-in (public_page_enabled = 0).

-- Página pública da empresa. slug é único e gerado no cadastro (ou sob demanda em /companies/public-page).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS slug VARCHAR(60) NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_companies_slug ON companies (slug);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS public_page_enabled TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS public_description VARCHAR(600) NULL;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_url VARCHAR(500) NULL;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS instagram_url VARCHAR(255) NULL;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS public_hours VARCHAR(255) NULL;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS theme_primary_color VARCHAR(7) NULL;
-- Política de agendamento online (minutos/dias).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS booking_min_notice_minutes INT NOT NULL DEFAULT 120;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS booking_cancel_notice_minutes INT NOT NULL DEFAULT 120;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS booking_hold_minutes INT NOT NULL DEFAULT 15;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS booking_slot_step_minutes INT NOT NULL DEFAULT 30;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS booking_horizon_days INT NOT NULL DEFAULT 60;

-- Serviço: descrição pública, visibilidade online e sinal (0 = sem sinal; mínimo do Asaas = 500).
ALTER TABLE services ADD COLUMN IF NOT EXISTS public_description VARCHAR(600) NULL;
ALTER TABLE services ADD COLUMN IF NOT EXISTS online_booking TINYINT(1) NOT NULL DEFAULT 1;
ALTER TABLE services ADD COLUMN IF NOT EXISTS deposit_cents INT NOT NULL DEFAULT 0;

-- Reserva com sinal pendente: o horário fica retido até hold_expires_at (instante, comparado com NOW()).
-- Vencido sem pagamento, o agendamento passa a ser tratado como cancelado na leitura (sem cron).
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS hold_expires_at DATETIME NULL;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS source VARCHAR(20) NULL;
CREATE INDEX IF NOT EXISTS idx_appointments_hold ON appointments (company_id, hold_expires_at);

-- Agendamentos criados pela página pública. public_id compõe o manage_token (HMAC, ver publicTokens.js).
-- UNIQUE (company_id, idempotency_key) garante que reenvio não duplica a reserva.
CREATE TABLE IF NOT EXISTS public_bookings (
  id INT NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(32) NOT NULL,
  company_id INT NOT NULL,
  appointment_id INT NOT NULL,
  customer_id INT NOT NULL,
  sale_id INT NULL,
  idempotency_key VARCHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  source VARCHAR(20) NOT NULL,
  deposit_cents INT NOT NULL DEFAULT 0,
  token_expires_at DATETIME NOT NULL,
  canceled_at DATETIME NULL,
  cancel_reason VARCHAR(30) NULL,
  conflict_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_public_bookings_public_id (public_id),
  UNIQUE KEY uq_public_bookings_appointment (appointment_id),
  UNIQUE KEY uq_public_bookings_idempotency (company_id, idempotency_key),
  KEY idx_public_bookings_sale (sale_id),
  CONSTRAINT fk_public_bookings_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_public_bookings_appointment FOREIGN KEY (appointment_id) REFERENCES appointments (id) ON DELETE CASCADE,
  CONSTRAINT fk_public_bookings_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Leads do site institucional (POST /public/leads). Sem vínculo com empresa.
CREATE TABLE IF NOT EXISTS leads (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  whatsapp VARCHAR(20) NOT NULL,
  email VARCHAR(255) NULL,
  segment VARCHAR(60) NOT NULL,
  source VARCHAR(80) NOT NULL,
  message VARCHAR(1000) NULL,
  consent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_leads_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A view appointment_status_view (sql/appointment-status-view.sql, recriada a cada migração) passa a
-- tratar reserva com sinal vencida como cancelada.
