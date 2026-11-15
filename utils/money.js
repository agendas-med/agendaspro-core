// Dinheiro em centavos (inteiros) e taxas em basis points (1 bps = 0,01%). Nada de aritmética
// em ponto flutuante: valores decimais só existem na borda (JSON do Asaas, colunas FLOAT legadas)
// e são convertidos por texto.

// "49.9" | 49.9 | "49,90" | "1234" -> 4990 | 4990 | 4990 | 123400. Inválido -> NaN.
function toCents(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return NaN;
    // Number -> texto com 2 casas: toFixed arredonda a representação decimal (49.9 -> "49.90").
    value = value.toFixed(2);
  }
  if (typeof value !== 'string') return NaN;
  const match = /^\s*(-)?(\d+)(?:[.,](\d{1,6}))?\s*$/.exec(value);
  if (!match) return NaN;
  const [, minus, int, frac = ''] = match;
  const padded = (frac + '000').slice(0, 3);
  let cents = Number(int) * 100 + Number(padded.slice(0, 2));
  if (Number(padded[2]) >= 5) cents += 1; // meio para cima na 3ª casa
  return minus ? -cents : cents;
}

// Centavos -> número decimal com 2 casas, só para a borda da API do Asaas.
function centsToDecimal(cents) {
  assertCents(cents);
  return Number(`${cents < 0 ? '-' : ''}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`);
}

function assertCents(cents) {
  if (!Number.isSafeInteger(cents)) throw new TypeError('Valor monetário deve ser inteiro em centavos.');
}

// Comissão = gross * bps / 10000, arredondada meio para cima (em centavos), aritmética inteira.
function commissionCents(grossCents, bps) {
  assertCents(grossCents);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw new TypeError('bps inválido.');
  if (grossCents <= 0) return 0;
  const product = BigInt(grossCents) * BigInt(bps);
  return Number((product + 5000n) / 10000n);
}

module.exports = { toCents, centsToDecimal, commissionCents, assertCents };
