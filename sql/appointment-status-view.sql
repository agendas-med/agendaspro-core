CREATE OR REPLACE SQL SECURITY INVOKER VIEW appointment_status_view AS
SELECT a.*,
  CASE
    WHEN a.canceled = 1 THEN 'cancelado'
    -- F3: reserva com sinal pendente e prazo vencido conta como cancelada (estado derivado do tempo).
    WHEN a.payment_status = 'pendente' AND a.hold_expires_at IS NOT NULL AND a.hold_expires_at <= CURRENT_TIMESTAMP THEN 'cancelado'
    WHEN a.checkout IS NOT NULL THEN 'realizado'
    WHEN a.checkin IS NOT NULL AND EXISTS (
      SELECT 1 FROM config_companies_preferences ccp
      JOIN preferences p ON p.id = ccp.preference_id
      WHERE ccp.company_id = a.company_id
        AND p.code = 'auto_finish_appointments' AND ccp.active = 1
    ) AND CURRENT_TIMESTAMP >= a.checkin + INTERVAL a.duration MINUTE THEN 'realizado'
    WHEN a.checkin IS NOT NULL THEN 'iniciado'
    WHEN a.payment_status = 'pendente' THEN 'pendente_pagamento'
    ELSE 'agendado'
  END AS status
FROM appointments a;
