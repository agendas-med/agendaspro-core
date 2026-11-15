-- F1: sessões. Troca de senha invalida tokens emitidos antes dela.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at DATETIME NULL;
