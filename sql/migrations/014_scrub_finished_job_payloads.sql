-- Follow-up 1 (LGPD): apaga o payload (texto da mensagem, telefone, nome) de jobs do WhatsApp já
-- terminados. Daqui em diante o jobsService faz isso ao concluir. Idempotente.
UPDATE jobs SET payload = '{"scrubbed":true}'
 WHERE type = 'whatsapp_inbound' AND status IN ('done', 'failed') AND payload <> '{"scrubbed":true}';
