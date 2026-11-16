-- Follow-up 1: foto do profissional guardada no banco (dyno Heroku tem disco efêmero; não depende de S3).
-- Servida por GET /files/professional-photo/:id/:hash (hash = versão; cache imutável).
CREATE TABLE IF NOT EXISTS professional_photos (
  professional_id INT NOT NULL,
  company_id INT NOT NULL,
  mime VARCHAR(20) NOT NULL,
  bytes MEDIUMBLOB NOT NULL,
  sha256 CHAR(64) NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (professional_id),
  KEY idx_professional_photos_company (company_id),
  CONSTRAINT fk_professional_photos_professional FOREIGN KEY (professional_id) REFERENCES professionals (id) ON DELETE CASCADE,
  CONSTRAINT fk_professional_photos_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
