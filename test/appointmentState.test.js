const { test } = require('node:test');
const assert = require('node:assert/strict');
const { transition } = require('../utils/appointmentState');

test('editar um atendimento iniciado preserva o check-in original', () => {
  const checkin = new Date('2026-10-24T12:00:00Z');
  assert.equal(transition({ checkin }, 'iniciado').checkin, checkin);
});
test('pagamento pendente bloqueia início e conclusão, mas permite cancelar', () => {
  assert.throws(() => transition({ payment_status: 'pendente' }, 'iniciado'), /pagamento/);
  assert.throws(() => transition({ payment_status: 'pendente' }, 'realizado'), /pagamento/);
  assert.equal(transition({ payment_status: 'pendente' }, 'cancelado').canceled, 1);
});
test('editar status não desfaz a confirmação de um pagamento', () => {
  assert.equal(transition({ payment_status: 'pago' }, 'pendente_pagamento').payment_status, 'pago');
});
