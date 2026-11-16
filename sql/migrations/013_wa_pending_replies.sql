-- Follow-up 1: respostas do bot ainda não entregues, guardadas na mensagem recebida que as gerou.
-- Se o envio falha, o job tenta de novo e a reentrega (wamid duplicado) reenvia só o que faltou.
-- Limpo (NULL) assim que tudo é entregue.
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS pending_replies MEDIUMTEXT NULL AFTER body;
