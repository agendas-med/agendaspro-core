-- F5-core-B: assistente de IA do painel (conversas, ações com confirmação humana, auditoria e RAG).
-- Idempotente. Expirações em BIGINT epoch-ms calculado no Node (independe do time_zone da conexão).

-- Conversa de um usuário dentro de uma empresa. summary = resumo incremental (texto curto).
CREATE TABLE IF NOT EXISTS assistant_conversations (
  id BIGINT NOT NULL AUTO_INCREMENT,
  public_id CHAR(32) NOT NULL,
  company_id INT NOT NULL,
  user_id INT NOT NULL,
  title VARCHAR(120) NULL,
  summary TEXT NULL,
  message_count INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_assistant_conv_public (public_id),
  KEY idx_assistant_conv_owner (company_id, user_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS assistant_messages (
  id BIGINT NOT NULL AUTO_INCREMENT,
  conversation_id BIGINT NOT NULL,
  company_id INT NOT NULL,
  role ENUM('user','assistant') NOT NULL,
  content TEXT NOT NULL,
  intent VARCHAR(40) NULL,
  source ENUM('user','template','ai','fallback') NOT NULL DEFAULT 'user',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_assistant_msg_conv (conversation_id, id),
  KEY idx_assistant_msg_company (company_id, created_at),
  CONSTRAINT fk_assistant_msg_conv FOREIGN KEY (conversation_id) REFERENCES assistant_conversations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ação de escrita proposta pela IA. Só executa via POST /assistant/actions/:id/confirm com o JWT
-- do mesmo usuário. params é imutável e payload_hash = sha256(JSON canônico de params).
CREATE TABLE IF NOT EXISTS assistant_actions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  public_id CHAR(32) NOT NULL,
  company_id INT NOT NULL,
  user_id INT NOT NULL,
  conversation_id BIGINT NULL,
  tool VARCHAR(40) NOT NULL,
  risk ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
  summary VARCHAR(300) NOT NULL,
  params JSON NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  status ENUM('pending','executing','executed','failed','rejected','expired') NOT NULL DEFAULT 'pending',
  expires_at_ms BIGINT NOT NULL,
  result JSON NULL,
  error_message VARCHAR(300) NULL,
  executed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_assistant_action_public (public_id),
  KEY idx_assistant_action_owner (company_id, user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Auditoria: quem, o quê, parâmetros, resultado e tokens.
CREATE TABLE IF NOT EXISTS assistant_audit (
  id BIGINT NOT NULL AUTO_INCREMENT,
  company_id INT NOT NULL,
  user_id INT NOT NULL,
  conversation_id BIGINT NULL,
  action_id BIGINT NULL,
  event VARCHAR(30) NOT NULL,
  tool VARCHAR(40) NULL,
  params JSON NULL,
  result VARCHAR(40) NULL,
  detail VARCHAR(300) NULL,
  tokens INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_assistant_audit_company (company_id, created_at),
  KEY idx_assistant_audit_action (action_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Base de conhecimento da clínica (FAQ, políticas, regras). Texto livre, indexado no RAG.
CREATE TABLE IF NOT EXISTS assistant_knowledge (
  id INT NOT NULL AUTO_INCREMENT,
  company_id INT NOT NULL,
  kind ENUM('faq','policy','rule','template') NOT NULL DEFAULT 'faq',
  title VARCHAR(160) NOT NULL,
  content TEXT NOT NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_assistant_knowledge_company (company_id, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Vetores (Float32 little-endian em BLOB), sempre por empresa. Só texto não estruturado.
CREATE TABLE IF NOT EXISTS assistant_embeddings (
  id BIGINT NOT NULL AUTO_INCREMENT,
  company_id INT NOT NULL,
  source_type VARCHAR(24) NOT NULL,
  source_id BIGINT NOT NULL,
  chunk SMALLINT NOT NULL DEFAULT 0,
  content_hash CHAR(64) NOT NULL,
  model VARCHAR(80) NOT NULL,
  dims SMALLINT NOT NULL,
  content TEXT NOT NULL,
  vector MEDIUMBLOB NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_assistant_emb_source (company_id, source_type, source_id, chunk),
  KEY idx_assistant_emb_company (company_id),
  KEY idx_assistant_emb_hash (company_id, content_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
