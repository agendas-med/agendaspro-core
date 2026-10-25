function transition(current, status = 'agendado') {
  if (!['agendado', 'iniciado', 'realizado', 'cancelado', 'pendente_pagamento'].includes(status)) {
    throw new Error('Status de agendamento inválido.');
  }
  if (current.payment_status === 'pendente' && ['iniciado', 'realizado'].includes(status)) {
    throw new Error('Confirme o pagamento antes de iniciar o atendimento.');
  }
  return {
    canceled: status === 'cancelado' ? 1 : 0,
    checkin: ['iniciado', 'realizado'].includes(status) ? current.checkin || new Date() : null,
    checkout: status === 'realizado' ? current.checkout || new Date() : null,
    payment_status: status === 'pendente_pagamento' && current.payment_status !== 'pago'
      ? 'pendente' : current.payment_status || 'isento',
  };
}
module.exports = { transition };
