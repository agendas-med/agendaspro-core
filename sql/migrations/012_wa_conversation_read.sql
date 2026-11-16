-- Follow-up 1: marcador de leitura da caixa de entrada do WhatsApp (compartilhado pela equipe).
-- Não lidas = mensagens recebidas (direction='in') com id acima deste marcador.
ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS last_read_message_id BIGINT NULL AFTER assigned_user_id;
