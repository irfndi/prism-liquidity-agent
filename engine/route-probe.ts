export const ROUTE_PROBE_NOTIONAL_USD = 1;

export function routeProbeAmountAtomic(
  priceUsd: number,
  decimals: number,
  notionalUsd: number = ROUTE_PROBE_NOTIONAL_USD,
): bigint {
  if (
    !Number.isFinite(priceUsd) ||
    priceUsd <= 0 ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18 ||
    !Number.isFinite(notionalUsd) ||
    notionalUsd <= 0
  ) {
    return 0n;
  }
  const units = notionalUsd / priceUsd;
  if (!Number.isFinite(units) || units <= 0) return 0n;
  const wholeUnits = Math.floor(units);
  if (wholeUnits > Number.MAX_SAFE_INTEGER) return 0n;
  const scale = 10n ** BigInt(decimals);
  const fractionalAtomic = BigInt(Math.floor((units - wholeUnits) * Number(scale)));
  const amountAtomic = BigInt(wholeUnits) * scale + fractionalAtomic;
  return amountAtomic > 0n ? amountAtomic : 1n;
}
