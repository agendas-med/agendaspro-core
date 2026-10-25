INSERT INTO preferences (code, name)
SELECT 'notificate_scheduling', 'Notificar agendamentos' WHERE NOT EXISTS (SELECT 1 FROM preferences WHERE code = 'notificate_scheduling');
INSERT INTO preferences (code, name)
SELECT 'notificate_in_app_payment', 'Notificar pagamentos' WHERE NOT EXISTS (SELECT 1 FROM preferences WHERE code = 'notificate_in_app_payment');
INSERT INTO preferences (code, name)
SELECT 'notificate_scheduling_cancelation', 'Notificar cancelamentos' WHERE NOT EXISTS (SELECT 1 FROM preferences WHERE code = 'notificate_scheduling_cancelation');
INSERT INTO preferences (code, name)
SELECT 'accept_custom_location', 'Permitir atendimento em domicílio' WHERE NOT EXISTS (SELECT 1 FROM preferences WHERE code = 'accept_custom_location');
INSERT INTO preferences (code, name)
SELECT 'require_payment_on_booking', 'Exigir pagamento ao agendar' WHERE NOT EXISTS (SELECT 1 FROM preferences WHERE code = 'require_payment_on_booking');
INSERT INTO preferences (code, name)
SELECT 'auto_finish_appointments', 'Encerrar agendamentos automaticamente' WHERE NOT EXISTS (SELECT 1 FROM preferences WHERE code = 'auto_finish_appointments');
INSERT INTO business_types (name)
SELECT 'Serviços' WHERE NOT EXISTS (SELECT 1 FROM business_types);
INSERT INTO units_of_measurement (name, abbreviation)
SELECT 'Unidade', 'un' WHERE NOT EXISTS (SELECT 1 FROM units_of_measurement WHERE abbreviation = 'un');
