// Replacer that stringifies BigInt values. Use with JSON.stringify whenever
// the value graph may contain bigints (e.g. DLMM SDK PoolMetrics, BinArray).
// Standard JSON.stringify throws on bigint; this is the standard workaround.
export function bigintReplacer<T>(_key: string, value: T): string | T {
  return Object.prototype.toString.call(value) === "[object BigInt]"
    ? (value as bigint).toString()
    : value;
}

export function stringifySafe<T>(value: T, space?: string | number): string {
  return JSON.stringify(value, bigintReplacer, space);
}

// JSON.parse cannot reconstruct bigints; this reviver converts decimal strings
// back to BigInt for the fields we know are bigint in our domain types.
const BIGINT_FIELDS = new Set(["reserveX", "reserveY", "liquiditySupply", "liquidityShares"]);

export function bigintReviver<T>(key: string, value: T): string | bigint | T {
  if (Object.prototype.toString.call(value) === "[object String]" && BIGINT_FIELDS.has(key)) {
    try {
      return BigInt(value as string);
    } catch {
      return value;
    }
  }
  return value;
}

export function parseBigIntSafe<T = unknown>(text: string): T {
  return JSON.parse(text, bigintReviver) as T;
}
