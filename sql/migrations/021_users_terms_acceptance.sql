-- Aceite dos Termos de Uso e da Política de Privacidade (LGPD / prova de consentimento). Idempotente.
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at DATETIME NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version VARCHAR(20) NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accept_ip VARCHAR(45) NULL;
