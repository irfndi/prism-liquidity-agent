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
export function mergeEnvContent(existing: string, managed: string): string {
  const managedLines = parseEnvLines(managed);
  const managedByKey = new Map<string, ParsedEnvLine>();
  for (const line of managedLines) {
    if (line.key !== null) managedByKey.set(line.key, line);
  }
  const existingValues = envValues(existing);
  const existingLines = parseEnvLines(existing);

  const out: string[] = [];
  for (const line of existingLines) {
    if (line.key === null || !managedByKey.has(line.key)) {
      out.push(line.raw);
      continue;
    }
    const managedEntry = managedByKey.get(line.key)!;
    const wizardValueEmpty = managedEntry.value === "";
    const existingHasValue = (existingValues.get(line.key) ?? "") !== "";
    if (wizardValueEmpty && existingHasValue) {
      out.push(line.raw); // keep the user's value; do not wipe
    } else {
      out.push(managedEntry.raw); // fresh wizard value (or an intentional clear)
    }
  }

  const presentKeys = new Set(
    out
      .map((raw) => {
        const t = raw.trim();
        if (t === "" || t.startsWith("#")) return null;
        const eq = t.indexOf("=");
        return eq < 0 ? null : t.slice(0, eq).trim();
      })
      .filter((k): k is string => k !== null),
  );
  const toAppend = managedLines.filter((l) => l.key !== null && !presentKeys.has(l.key!));
  if (toAppend.length > 0) {
    out.push("", "# ── Managed by `prism setup` — re-running setup updates these keys ──");
    for (const line of toAppend) out.push(line.raw);
  }
  return `${out.join("\n")}\n`;
}
