-- Core follow-up 1: TTL deslizante do chat público, com teto.
-- O token continua imutável (expires_at_ms = exp assinado). renewed_until_ms guarda a validade
-- efetiva depois de cada mensagem aceita, limitada a expires_at_ms + PUBLIC_CHAT_SESSION_MAX_EXTENSION_MIN.
-- Idempotente (MariaDB: ADD COLUMN IF NOT EXISTS).
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS renewed_until_ms BIGINT NULL AFTER expires_at_ms;
