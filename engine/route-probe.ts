export const ROUTE_PROBE_NOTIONAL_USD = 1;

function isValidProbeInput(priceUsd: number, decimals: number, notionalUsd: number): boolean {
  return (
    Number.isFinite(priceUsd) &&
    priceUsd > 0 &&
    Number.isInteger(decimals) &&
    decimals >= 0 &&
    decimals <= 18 &&
    Number.isFinite(notionalUsd) &&
    notionalUsd > 0
  );
}

function probeAmountFromUnits(units: number, decimals: number): bigint {
  if (!Number.isFinite(units) || units <= 0) return 0n;
  const wholeUnits = Math.floor(units);
  if (wholeUnits > Number.MAX_SAFE_INTEGER) return 0n;
  const scale = 10n ** BigInt(decimals);
  const fractionalAtomic = BigInt(Math.floor((units - wholeUnits) * Number(scale)));
  const amountAtomic = BigInt(wholeUnits) * scale + fractionalAtomic;
  return amountAtomic > 0n ? amountAtomic : 1n;
}

export function routeProbeAmountAtomic(
  priceUsd: number,
  decimals: number,
  notionalUsd: number = ROUTE_PROBE_NOTIONAL_USD,
): bigint {
  if (!isValidProbeInput(priceUsd, decimals, notionalUsd)) return 0n;
  return probeAmountFromUnits(notionalUsd / priceUsd, decimals);
}
