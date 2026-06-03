// Replacer that stringifies BigInt values. Use with JSON.stringify whenever
// the value graph may contain bigints (e.g. DLMM SDK PoolMetrics, BinArray).
// Standard JSON.stringify throws on bigint; this is the standard workaround.
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function stringifySafe(value: unknown, space?: string | number): string {
  return JSON.stringify(value, bigintReplacer, space);
}
