-- Follow-up 1 (assistente): versão do confirm_token. Reemitir incrementa e invalida o token anterior. Idempotente.
ALTER TABLE assistant_actions ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0 AFTER payload_hash;
