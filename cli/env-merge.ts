/** @file Merge-preserving .env writer for `prism setup`.
 *
 * Re-running setup must NEVER wipe user configuration. The wizard only
 * manages a fixed set of keys; everything else in an existing `.env`
 * (WATCHLIST_POOLS, MARKET_SCAN_*, AGENTIC_MODE, custom comments, ordering)
 * is preserved verbatim. Managed keys take the freshly-entered value, EXCEPT
 * when the wizard's new value is empty and the existing value is non-empty —
 * an empty wizard default must not wipe a user's setting.
 */

export interface ParsedEnvLine {
  readonly key: string | null;
  readonly value: string;
  readonly raw: string;
}

export function parseEnvLines(content: string): ReadonlyArray<ParsedEnvLine> {
  return content.split("\n").map((raw) => {
    const t = raw.trim();
    if (t === "" || t.startsWith("#")) return { key: null, value: "", raw };
    const eq = t.indexOf("=");
    if (eq < 0) return { key: null, value: "", raw };
    return { key: t.slice(0, eq).trim(), value: t.slice(eq + 1).trim(), raw };
  });
}

/** Extract `{KEY: value}` for all KEY=value lines (last occurrence wins). */
export function envValues(content: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const line of parseEnvLines(content)) {
    if (line.key !== null) map.set(line.key, line.value);
  }
  return map;
}

/**
 * Merge `managed` (the setup wizard template) into `existing` (the current
 * `.env`):
 * - Non-managed lines (unknown keys, comments, blanks) are preserved in place.
 * - A managed key's line is replaced by the wizard's fresh value, unless the
 *   wizard value is empty AND the existing value is non-empty (keep existing).
 * - Managed keys absent from the existing file are appended at the end under
 *   a banner so new defaults introduced by upgrades actually appear.
 */
function managedEntriesByKey(managed: string): ReadonlyMap<string, ParsedEnvLine> {
  const byKey = new Map<string, ParsedEnvLine>();
  for (const line of parseEnvLines(managed)) {
    if (line.key !== null) byKey.set(line.key, line);
  }
  return byKey;
}

function mergeExistingLines(
  existing: string,
  managedByKey: ReadonlyMap<string, ParsedEnvLine>,
  existingValues: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = [];
  for (const line of parseEnvLines(existing)) {
    const managedEntry = line.key === null ? undefined : managedByKey.get(line.key);
    if (managedEntry === undefined) {
      out.push(line.raw);
      continue;
    }
    const keepUserValue =
      managedEntry.value === "" && (existingValues.get(managedEntry.key!) ?? "") !== "";
    out.push(keepUserValue ? line.raw : managedEntry.raw);
  }
  return out;
}

function envKeyOfLine(raw: string): string | null {
  const t = raw.trim();
  if (t === "" || t.startsWith("#")) return null;
  const eq = t.indexOf("=");
  return eq < 0 ? null : t.slice(0, eq).trim();
}

function appendMissingManagedKeys(out: string[], managed: string): void {
  const present = new Set<string>();
  for (const raw of out) {
    const key = envKeyOfLine(raw);
    if (key !== null) present.add(key);
  }
  const missing = parseEnvLines(managed).filter((l) => l.key !== null && !present.has(l.key));
  if (missing.length === 0) return;
  out.push("", "# ── Managed by `prism setup` — re-running setup updates these keys ──");
  for (const line of missing) out.push(line.raw);
}

export function mergeEnvContent(existing: string, managed: string): string {
  const managedByKey = managedEntriesByKey(managed);
  const out = mergeExistingLines(existing, managedByKey, envValues(existing));
  appendMissingManagedKeys(out, managed);
  return `${out.join("\n")}\n`;
}
