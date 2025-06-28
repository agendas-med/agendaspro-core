INSERT INTO business_types (name) VALUES
('Agronegócio'),
('Alimentação'),
('Automotivo'),
('Beleza e Estética'),
('Comércio'),
('Construção Civil'),
('Educação'),
('Entretenimento'),
('Esportes e Fitness'),
('Financeiro'),
('Imobiliário'),
('Indústria'),
('Moda e Vestuário'),
('Saúde'),
('Serviços'),
('Tecnologia'),
('Turismo e Hotelaria'),
('Transporte e Logística');

insert into preferences (code, name)
values
("notificate_scheduling", "Notificar agendamentos realizados"),
("notificate_in_app_payment", "Aceitar pagamento in-app"),
("notificate_scheduling_cancelation", "Notificar agendamentos cancelados"),
("auto_finish_appointments", "Finalizar agendamentos automaticamente");

SET time_zone = '-03:00';