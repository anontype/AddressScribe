export function formatUnits(value, decimals, maximumFractionDigits = 6) {
  let amount;
  try {
    amount = BigInt(value);
  } catch {
    return null;
  }
  if (amount < 0n) amount = -amount;
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const fraction = (amount % base).toString().padStart(decimals, "0").slice(0, maximumFractionDigits).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function compareBigInt(left, right) {
  const a = BigInt(left ?? 0);
  const b = BigInt(right ?? 0);
  return a === b ? 0 : a > b ? 1 : -1;
}
