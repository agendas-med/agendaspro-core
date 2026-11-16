-- Follow-up 1 (assistente): item da base de conhecimento ativo/inativo. Inativo sai do RAG. Idempotente.
ALTER TABLE assistant_knowledge ADD COLUMN IF NOT EXISTS active TINYINT(1) NOT NULL DEFAULT 1 AFTER content;
