CREATE TABLE IF NOT EXISTS mp_connections (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  environment VARCHAR(10) NOT NULL,
  collector_id VARCHAR(30) NOT NULL,
  nickname VARCHAR(150) NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  active TINYINT NOT NULL DEFAULT 1,
  connected_by INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_mp_connection (company_id, environment, collector_id),
  FOREIGN KEY (company_id) REFERENCES companies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mp_oauth_states (
  state_hash CHAR(64) NOT NULL PRIMARY KEY,
  company_id INT NOT NULL,
  user_id INT NOT NULL,
  environment VARCHAR(10) NOT NULL,
  verifier TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mp_subscriptions (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  environment VARCHAR(10) NOT NULL,
  external_reference VARCHAR(50) NOT NULL UNIQUE,
  idempotency_key VARCHAR(100) NOT NULL UNIQUE,
  provider_id VARCHAR(100) NULL UNIQUE,
  request_body TEXT NOT NULL,
  checkout_url TEXT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'creating',
  cancel_requested TINYINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_mp_subscription_company (company_id, environment)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mp_subscription_invoices (
  provider_id VARCHAR(100) NOT NULL PRIMARY KEY,
  subscription_id INT NOT NULL,
  payment_id VARCHAR(100) NOT NULL UNIQUE,
  status VARCHAR(30) NOT NULL,
  period_start DATETIME NOT NULL,
  period_end DATETIME NOT NULL,
  amount_cents INT NOT NULL,
  FOREIGN KEY (subscription_id) REFERENCES mp_subscriptions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
