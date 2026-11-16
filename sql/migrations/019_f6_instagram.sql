-- F6: Instagram (API with Instagram Login), estados OAuth assinados e atribuição de conversão (UTM).
-- Idempotente. Tokens só cifrados (AES-256-GCM, APP_ENCRYPTION_KEY); nada de token em jobs/logs.

-- Free: conexão + perfil + últimos posts (cache). Premium (feature "instagram" já semeada): insights,
-- histórico, conversão e comparativo.
UPDATE plans SET features = JSON_SET(features, '$.instagram_basic', true) WHERE JSON_EXTRACT(features, '$.instagram_basic') IS NULL;
UPDATE plans SET features = JSON_SET(features, '$.instagram_posts_limit', 6) WHERE code = 'free' AND JSON_EXTRACT(features, '$.instagram_posts_limit') IS NULL;
-- Planos pagos: sem "instagram_posts_limit" = sem limite (até INSTAGRAM_MAX_POSTS).

-- Estado OAuth de uso único (nonce do state HMAC). code_verifier (PKCE) cifrado.
CREATE TABLE IF NOT EXISTS oauth_states (
  id BIGINT NOT NULL AUTO_INCREMENT,
  nonce CHAR(43) NOT NULL,
  provider VARCHAR(30) NOT NULL,
  company_id INT NOT NULL,
  user_id INT NOT NULL,
  redirect_uri VARCHAR(500) NOT NULL,
  code_verifier_enc TEXT DEFAULT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_oauth_states_nonce (nonce),
  KEY idx_oauth_states_expires (expires_at),
  KEY idx_oauth_states_company (company_id),
  CONSTRAINT fk_oauth_states_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS instagram_accounts (
  id INT NOT NULL AUTO_INCREMENT,
  company_id INT NOT NULL,
  ig_user_id VARCHAR(64) NOT NULL,
  app_user_id VARCHAR(64) DEFAULT NULL,
  username VARCHAR(100) DEFAULT NULL,
  name VARCHAR(150) DEFAULT NULL,
  account_type VARCHAR(30) DEFAULT NULL,
  profile_picture_url VARCHAR(1000) DEFAULT NULL,
  followers_count INT DEFAULT NULL,
  follows_count INT DEFAULT NULL,
  media_count INT DEFAULT NULL,
  access_token_enc TEXT DEFAULT NULL,
  token_expires_at DATETIME DEFAULT NULL,
  token_refreshed_at DATETIME DEFAULT NULL,
  scopes VARCHAR(500) DEFAULT NULL,
  status ENUM('active','reauth_required') NOT NULL DEFAULT 'active',
  last_error_code VARCHAR(60) DEFAULT NULL,
  rate_limited_until DATETIME DEFAULT NULL,
  connected_by_user_id INT DEFAULT NULL,
  connected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  profile_synced_at DATETIME DEFAULT NULL,
  media_synced_at DATETIME DEFAULT NULL,
  insights_synced_at DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_instagram_accounts_company (company_id),
  KEY idx_instagram_accounts_ig_user (ig_user_id),
  KEY idx_instagram_accounts_app_user (app_user_id),
  KEY idx_instagram_accounts_token (status, token_expires_at),
  CONSTRAINT fk_instagram_accounts_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Posts (cache + insights por post). Legenda truncada; sem dados de terceiros (comentários não são guardados).
CREATE TABLE IF NOT EXISTS instagram_media (
  company_id INT NOT NULL,
  media_id VARCHAR(64) NOT NULL,
  caption VARCHAR(2200) DEFAULT NULL,
  media_type VARCHAR(30) DEFAULT NULL,
  media_product_type VARCHAR(30) DEFAULT NULL,
  permalink VARCHAR(500) DEFAULT NULL,
  thumbnail_url VARCHAR(1000) DEFAULT NULL,
  posted_at DATETIME DEFAULT NULL,
  like_count INT DEFAULT NULL,
  comments_count INT DEFAULT NULL,
  reach INT DEFAULT NULL,
  views INT DEFAULT NULL,
  saved INT DEFAULT NULL,
  shares INT DEFAULT NULL,
  total_interactions INT DEFAULT NULL,
  insights_at DATETIME DEFAULT NULL,
  fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, media_id),
  KEY idx_instagram_media_posted (company_id, posted_at),
  CONSTRAINT fk_instagram_media_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Série histórica diária (Premium) para gráficos. Data local da empresa.
CREATE TABLE IF NOT EXISTS instagram_snapshots (
  company_id INT NOT NULL,
  snapshot_date DATE NOT NULL,
  followers_count INT DEFAULT NULL,
  follows_count INT DEFAULT NULL,
  media_count INT DEFAULT NULL,
  reach INT DEFAULT NULL,
  views INT DEFAULT NULL,
  accounts_engaged INT DEFAULT NULL,
  total_interactions INT DEFAULT NULL,
  profile_links_taps INT DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, snapshot_date),
  CONSTRAINT fk_instagram_snapshots_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Pedidos de exclusão de dados (callback da Meta). Guarda só hash do id do usuário.
CREATE TABLE IF NOT EXISTS instagram_deletion_requests (
  id INT NOT NULL AUTO_INCREMENT,
  confirmation_code CHAR(22) NOT NULL,
  user_hash CHAR(64) NOT NULL,
  kind ENUM('deletion','deauthorize') NOT NULL,
  accounts_removed INT NOT NULL DEFAULT 0,
  status ENUM('completed') NOT NULL DEFAULT 'completed',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_instagram_deletion_code (confirmation_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Links UTM gerados para a página pública (/b/:slug). Ficam após desconectar (dado de marketing da empresa).
CREATE TABLE IF NOT EXISTS marketing_links (
  id INT NOT NULL AUTO_INCREMENT,
  company_id INT NOT NULL,
  utm_source VARCHAR(40) NOT NULL,
  utm_medium VARCHAR(40) NOT NULL,
  utm_campaign VARCHAR(80) NOT NULL,
  utm_content VARCHAR(80) NOT NULL DEFAULT '',
  label VARCHAR(120) DEFAULT NULL,
  created_by_user_id INT DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_marketing_links (company_id, utm_source, utm_medium, utm_campaign, utm_content),
  CONSTRAINT fk_marketing_links_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Visitas à página pública por dia e UTM (contador agregado; sem IP nem PII).
CREATE TABLE IF NOT EXISTS public_page_visits (
  company_id INT NOT NULL,
  visit_date DATE NOT NULL,
  utm_source VARCHAR(40) NOT NULL DEFAULT '',
  utm_medium VARCHAR(40) NOT NULL DEFAULT '',
  utm_campaign VARCHAR(80) NOT NULL DEFAULT '',
  utm_content VARCHAR(80) NOT NULL DEFAULT '',
  visits INT NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, visit_date, utm_source, utm_medium, utm_campaign, utm_content),
  CONSTRAINT fk_public_page_visits_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Atribuição do agendamento público (opcional, compatível: reservas antigas ficam sem linha).
CREATE TABLE IF NOT EXISTS booking_attributions (
  appointment_id INT NOT NULL,
  company_id INT NOT NULL,
  utm_source VARCHAR(40) NOT NULL DEFAULT '',
  utm_medium VARCHAR(40) NOT NULL DEFAULT '',
  utm_campaign VARCHAR(80) NOT NULL DEFAULT '',
  utm_content VARCHAR(80) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (appointment_id),
  KEY idx_booking_attributions_company (company_id, utm_source, created_at),
  CONSTRAINT fk_booking_attributions_appointment FOREIGN KEY (appointment_id) REFERENCES appointments (id) ON DELETE CASCADE,
  CONSTRAINT fk_booking_attributions_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
