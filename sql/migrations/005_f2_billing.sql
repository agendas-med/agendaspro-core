-- F2: planos, assinatura (Asaas) e comissão por venda. Valores em centavos (INT) e bps.
-- Cada instrução é idempotente; o seed usa INSERT IGNORE (re-executar não sobrescreve ajustes).

CREATE TABLE IF NOT EXISTS plans (
  id INT NOT NULL AUTO_INCREMENT,
  code VARCHAR(30) NOT NULL,
  name VARCHAR(60) NOT NULL,
  price_cents INT NOT NULL DEFAULT 0,
  commission_bps INT NOT NULL,
  billing_cycle VARCHAR(20) NOT NULL DEFAULT 'MONTHLY',
  features LONGTEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_plans_code (code),
  CONSTRAINT chk_plans_features CHECK (JSON_VALID(features)),
  CONSTRAINT chk_plans_money CHECK (price_cents >= 0 AND commission_bps BETWEEN 0 AND 10000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Limites: null = ilimitado. Preço do Premium pode ser sobrescrito por PLAN_PREMIUM_PRICE_CENTS.
INSERT IGNORE INTO plans (code, name, price_cents, commission_bps, sort_order, features) VALUES
('free', 'Free', 0, 500, 1, '{"max_professionals":1,"max_team_users":2,"whatsapp_monthly_messages":50,"assistant_monthly_interactions":30,"history_months":6,"public_page":true,"public_page_branding":true,"theme_custom":false,"whatsapp_confirmation":true,"whatsapp_reminder_24h":true,"whatsapp_reminder_2h":false,"post_service_message":false,"birthday_message":false,"waitlist":false,"reactivation":false,"nps_review":false,"deposit_pix":true,"instagram":false,"google_calendar":false,"assistant_actions":false,"reports_advanced":false,"reports_csv":false}'),
('premium', 'Premium', 4990, 50, 2, '{"max_professionals":null,"max_team_users":null,"whatsapp_monthly_messages":null,"assistant_monthly_interactions":1000,"history_months":null,"public_page":true,"public_page_branding":false,"theme_custom":true,"whatsapp_confirmation":true,"whatsapp_reminder_24h":true,"whatsapp_reminder_2h":true,"post_service_message":true,"birthday_message":true,"waitlist":true,"reactivation":true,"nps_review":true,"deposit_pix":true,"instagram":true,"google_calendar":true,"assistant_actions":true,"reports_advanced":true,"reports_csv":true}');

-- Uma assinatura (intenção de plano pago) por empresa. O plano EFETIVO não vem daqui:
-- é calculado na leitura a partir das faturas pagas (subscription_invoices).
CREATE TABLE IF NOT EXISTS company_subscriptions (
  id INT NOT NULL AUTO_INCREMENT,
  company_id INT NOT NULL,
  plan_id INT NOT NULL,
  status ENUM('pending','active','canceled') NOT NULL DEFAULT 'pending',
  billing_type VARCHAR(20) NOT NULL DEFAULT 'UNDEFINED',
  price_cents INT NOT NULL,
  provider VARCHAR(20) NOT NULL DEFAULT 'asaas',
  provider_customer_id VARCHAR(100) NULL,
  provider_subscription_id VARCHAR(100) NULL,
  next_due_date DATE NULL,
  canceled_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_company_subscriptions_company (company_id),
  UNIQUE KEY uq_company_subscriptions_provider (provider_subscription_id),
  CONSTRAINT fk_company_subscriptions_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_company_subscriptions_plan FOREIGN KEY (plan_id) REFERENCES plans (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Faturas da assinatura (uma por cobrança do Asaas; UNIQUE no id externo garante idempotência
-- entre PAYMENT_CONFIRMED e PAYMENT_RECEIVED da mesma cobrança).
CREATE TABLE IF NOT EXISTS subscription_invoices (
  id INT NOT NULL AUTO_INCREMENT,
  company_id INT NOT NULL,
  subscription_id INT NOT NULL,
  plan_id INT NOT NULL,
  provider_payment_id VARCHAR(100) NOT NULL,
  amount_cents INT NOT NULL,
  status ENUM('pending','paid','overdue','canceled','refunded') NOT NULL DEFAULT 'pending',
  due_date DATE NOT NULL,
  period_start DATETIME NULL,
  period_end DATETIME NULL,
  paid_at DATETIME NULL,
  invoice_url VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_subscription_invoices_provider (provider_payment_id),
  KEY idx_subscription_invoices_company (company_id, status, period_end),
  CONSTRAINT fk_subscription_invoices_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_subscription_invoices_subscription FOREIGN KEY (subscription_id) REFERENCES company_subscriptions (id) ON DELETE CASCADE,
  CONSTRAINT fk_subscription_invoices_plan FOREIGN KEY (plan_id) REFERENCES plans (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Comissão da plataforma por venda online (Pix Asaas): bps e centavos congelados na criação da
-- cobrança, conforme o plano efetivo naquele momento.
CREATE TABLE IF NOT EXISTS sale_commissions (
  id INT NOT NULL AUTO_INCREMENT,
  company_id INT NOT NULL,
  sale_id INT NOT NULL,
  provider_payment_id VARCHAR(100) NOT NULL,
  plan_code VARCHAR(30) NOT NULL,
  commission_bps INT NOT NULL,
  gross_cents INT NOT NULL,
  commission_cents INT NOT NULL,
  split_applied TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('pending','settled','canceled','refunded') NOT NULL DEFAULT 'pending',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  settled_at DATETIME NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sale_commissions_payment (provider_payment_id),
  KEY idx_sale_commissions_company (company_id, status, created_at),
  KEY idx_sale_commissions_sale (sale_id),
  CONSTRAINT fk_sale_commissions_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_sale_commissions_sale FOREIGN KEY (sale_id) REFERENCES sales (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Contadores de uso por empresa/mês (mensagens WhatsApp, interações de IA...). Em banco: nada de
-- contador em memória (regra 3 do Eco).
CREATE TABLE IF NOT EXISTS usage_counters (
  company_id INT NOT NULL,
  metric VARCHAR(50) NOT NULL,
  period CHAR(7) NOT NULL,
  used INT NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, metric, period),
  CONSTRAINT fk_usage_counters_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
