-- F2: profissionais, regras de disponibilidade, bloqueios/feriados, fuso por empresa e lembrete 2h.
-- Retrocompatível: colunas novas são NULLable/DEFAULT; agendamentos antigos ficam sem profissional.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NULL;

CREATE TABLE IF NOT EXISTS professionals (
  id INT NOT NULL AUTO_INCREMENT,
  company_id INT NOT NULL,
  user_id INT NULL,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(255) NULL,
  phone VARCHAR(20) NULL,
  photo_url VARCHAR(500) NULL,
  color VARCHAR(7) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_professionals_company (company_id, active),
  CONSTRAINT fk_professionals_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_professionals_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS professional_services (
  professional_id INT NOT NULL,
  service_id INT NOT NULL,
  company_id INT NOT NULL,
  PRIMARY KEY (professional_id, service_id),
  KEY idx_professional_services_company (company_id),
  KEY idx_professional_services_service (service_id),
  CONSTRAINT fk_professional_services_professional FOREIGN KEY (professional_id) REFERENCES professionals (id) ON DELETE CASCADE,
  CONSTRAINT fk_professional_services_service FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE CASCADE,
  CONSTRAINT fk_professional_services_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Expediente semanal por profissional (weekday 0 = domingo). Horas de parede no fuso da empresa.
CREATE TABLE IF NOT EXISTS availability_rules (
  id INT NOT NULL AUTO_INCREMENT,
  company_id INT NOT NULL,
  professional_id INT NOT NULL,
  weekday TINYINT NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_availability_rules_company (company_id),
  KEY idx_availability_rules_professional (professional_id, weekday),
  CONSTRAINT fk_availability_rules_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_availability_rules_professional FOREIGN KEY (professional_id) REFERENCES professionals (id) ON DELETE CASCADE,
  CONSTRAINT chk_availability_rules CHECK (weekday BETWEEN 0 AND 6 AND end_time > start_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bloqueios (folga, feriado). professional_id NULL = empresa inteira.
CREATE TABLE IF NOT EXISTS time_blocks (
  id INT NOT NULL AUTO_INCREMENT,
  company_id INT NOT NULL,
  professional_id INT NULL,
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NOT NULL,
  reason VARCHAR(160) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_time_blocks_company (company_id, starts_at, ends_at),
  KEY idx_time_blocks_professional (professional_id),
  CONSTRAINT fk_time_blocks_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_time_blocks_professional FOREIGN KEY (professional_id) REFERENCES professionals (id) ON DELETE CASCADE,
  CONSTRAINT chk_time_blocks CHECK (ends_at > starts_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS professional_id INT NULL;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS notified_2h TINYINT(1) NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_appointments_professional ON appointments (company_id, professional_id, date);
CREATE INDEX IF NOT EXISTS idx_appointments_reminder_2h ON appointments (notified_2h, canceled, date);
ALTER TABLE appointments ADD CONSTRAINT fk_appointments_professional FOREIGN KEY IF NOT EXISTS (professional_id) REFERENCES professionals (id) ON DELETE SET NULL;
