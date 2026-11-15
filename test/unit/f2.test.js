const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toCents, centsToDecimal, commissionCents } = require('../../utils/money');
const time = require('../../utils/time');
const { computeEntitlement } = require('../../services/plansService');
const { addMonth } = require('../../services/billingService');

const plans = [
  { id: 1, code: 'free', name: 'Free', commission_bps: 500, sort_order: 0, features: { max_professionals: 1, whatsapp_reminder_2h: false } },
  { id: 2, code: 'premium', name: 'Premium', commission_bps: 50, sort_order: 10, features: { max_professionals: null, whatsapp_reminder_2h: true } },
];
const paid = (start, end, extra = {}) => ({ plan_id: 2, status: 'paid', period_start: start, period_end: end, ...extra });

test('money: toCents converte por texto, sem float', () => {
  assert.equal(toCents(49.9), 4990);
  assert.equal(toCents('49,90'), 4990);
  assert.equal(toCents('1234'), 123400);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(toCents('10.005'), 1001, 'meio para cima na 3ª casa');
  assert.equal(toCents('10.004'), 1000);
  assert.equal(toCents('-3.50'), -350);
  for (const bad of ['abc', '', null, undefined, NaN, Infinity, '1.2.3', {}]) assert.ok(Number.isNaN(toCents(bad)), String(bad));
  assert.equal(centsToDecimal(4990), 49.9);
  assert.equal(centsToDecimal(5), 0.05);
  assert.equal(centsToDecimal(-350), -3.5);
  assert.throws(() => centsToDecimal(1.5), TypeError);
});

test('comissão: bps inteiros, arredondamento meio para cima', () => {
  assert.equal(commissionCents(10000, 500), 500, 'Free 5% de R$ 100');
  assert.equal(commissionCents(10000, 50), 50, 'Premium 0,5% de R$ 100');
  assert.equal(commissionCents(4990, 500), 250, '249,5 -> 250');
  assert.equal(commissionCents(4990, 50), 25, '24,95 -> 25');
  assert.equal(commissionCents(99, 50), 0, '0,495 -> 0');
  assert.equal(commissionCents(100, 50), 1, '0,5 -> 1');
  assert.equal(commissionCents(0, 500), 0);
  assert.equal(commissionCents(-100, 500), 0);
  assert.equal(commissionCents(Number.MAX_SAFE_INTEGER, 10000), Number.MAX_SAFE_INTEGER);
  assert.throws(() => commissionCents(100.5, 50), TypeError);
  assert.throws(() => commissionCents(100, 0.5), TypeError);
  assert.throws(() => commissionCents(100, 10001), TypeError);
});

test('entitlement: sem fatura paga = Free', () => {
  const ent = computeEntitlement({ plans, invoices: [], now: '2027-01-10T12:00:00Z' });
  assert.deepEqual([ent.plan_code, ent.commission_bps, ent.source, ent.paid_through], ['free', 500, 'free', null]);
  for (const status of ['pending', 'overdue', 'refunded', 'canceled']) {
    const other = computeEntitlement({ plans, invoices: [paid('2027-01-01T03:00:00Z', '2027-02-01T03:00:00Z', { status })], now: '2027-01-10T12:00:00Z' });
    assert.equal(other.plan_code, 'free', status);
  }
  assert.throws(() => computeEntitlement({ plans: plans.slice(1) }), /free/);
});

test('entitlement: período pago, limites e carência', () => {
  const invoices = [paid('2027-01-01T03:00:00Z', '2027-02-01T03:00:00Z')];
  const at = now => computeEntitlement({ plans, invoices, now, graceDays: 3 });
  assert.equal(at('2027-01-01T02:59:59Z').plan_code, 'free', 'antes do início');
  let ent = at('2027-01-01T03:00:00Z');
  assert.deepEqual([ent.plan_code, ent.commission_bps, ent.source], ['premium', 50, 'paid'], 'início inclusivo');
  assert.equal(ent.features.whatsapp_reminder_2h, true);
  assert.equal(ent.paid_through, '2027-02-01T03:00:00.000Z');
  assert.equal(ent.grace_until, '2027-02-04T03:00:00.000Z');
  ent = at('2027-02-01T03:00:00Z');
  assert.deepEqual([ent.plan_code, ent.source], ['premium', 'grace'], 'fim do período entra na carência');
  assert.equal(at('2027-02-04T02:59:59Z').source, 'grace');
  assert.equal(at('2027-02-04T03:00:00Z').plan_code, 'free', 'fim da carência exclusivo');
  assert.equal(computeEntitlement({ plans, invoices, now: '2027-02-01T03:00:00Z', graceDays: 0 }).plan_code, 'free', 'sem carência');
});

test('entitlement: renovações contíguas estendem paid_through; estorno remove', () => {
  const jan = paid('2027-01-01T03:00:00Z', '2027-02-01T03:00:00Z');
  const feb = paid('2027-02-01T03:00:00Z', '2027-03-01T03:00:00Z');
  let ent = computeEntitlement({ plans, invoices: [feb, jan], now: '2027-01-15T12:00:00Z' });
  assert.equal(ent.paid_through, '2027-03-01T03:00:00.000Z');
  assert.equal(ent.source, 'paid');
  ent = computeEntitlement({ plans, invoices: [jan, { ...feb, status: 'refunded' }], now: '2027-02-10T12:00:00Z' });
  assert.equal(ent.plan_code, 'free', 'fevereiro estornado e carência de janeiro vencida');
  ent = computeEntitlement({ plans, invoices: [{ ...jan, plan_id: 99 }], now: '2027-01-15T12:00:00Z' });
  assert.equal(ent.plan_code, 'free', 'plano desconhecido é ignorado');
});

test('billing: addMonth limita ao último dia do mês', () => {
  assert.equal(addMonth('2027-01-15'), '2027-02-15');
  assert.equal(addMonth('2027-01-31'), '2027-02-28');
  assert.equal(addMonth('2028-01-31'), '2028-02-29');
  assert.equal(addMonth('2027-12-10'), '2028-01-10');
  assert.equal(addMonth('2027-03-31'), '2027-04-30');
});

test('time: hora de parede por fuso, sem depender do fuso do processo', () => {
  const instant = new Date('2027-01-10T15:30:00Z');
  assert.equal(time.wallClock(instant, 'America/Sao_Paulo'), '2027-01-10 12:30:00');
  assert.equal(time.wallClock(instant, 'America/Manaus'), '2027-01-10 11:30:00');
  assert.equal(time.wallClock(instant, 'fuso/invalido'), time.wallClock(instant, time.defaultTimezone()));
  assert.equal(time.isValidTimezone('America/Recife'), true);
  assert.equal(time.isValidTimezone('Nada/Disso'), false);
  assert.equal(time.isValidTimezone(''), false);
  const m = time.wallMinutes('2027-01-10 23:30');
  assert.equal(time.minutesToWall(m + 60), '2027-01-11 00:30:00');
  assert.equal(time.wallWeekday('2027-01-10 10:00'), 0, '10/01/2027 é domingo');
  assert.equal(time.timeToMinutes('24:00'), 1440);
  assert.equal(time.timeToMinutes('08:30'), 510);
  assert.throws(() => time.timeToMinutes('8h'), /HH:mm/);
  assert.throws(() => time.wallMinutes('2027-02-30 10:00'), /inválida/);
  assert.equal(time.dbWall(new Date('2027-01-10T13:00:00Z')), '2027-01-10 10:00:00');
  assert.equal(time.dbWall('2027-01-10T10:00:00'), '2027-01-10 10:00:00');
});
