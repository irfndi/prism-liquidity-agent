/**
 * Stable EXIT taxonomy for portfolio history / paper staging review.
 * Prefer `[tag] detail` on every new EXIT; legacy untagged prefixes still map.
 */

/** Wrap an EXIT detail with a stable bracket tag. */
export function taggedExitReason(tag: string, detail: string): string {
  const cleanTag = tag.trim().replace(/^\[|\]$/g, "");
  const cleanDetail = detail.trim();
  return `[${cleanTag}] ${cleanDetail}`;
}

/** Untagged deterministic-EXIT reasoning prefixes → tag (longest first). */
const UNTAGGED_EXIT_REASONS: ReadonlyArray<readonly [string, string]> = [
  ["High volatility", "volatility"],
  ["Trailing stop", "trailing-stop"],
  ["IL dominance", "il-dominance"],
  ["TVL dropped", "tvl-drop"],
  ["Volume authenticity", "volume-authenticity"],
  ["Fee/IL ratio", "fee-il"],
  ["Rotation:", "rotation"],
  ["W15 fast EXIT", "w15"],
];

/**
 * First `[bracket]` tag, or a known untagged EXIT shape prefix.
 * "unknown" only when neither matches.
 */
export function exitReasonTag(reason: string | null | undefined): string {
  if (reason == null) return "unknown";
  const match = reason.match(/\[([^\]]+)\]/);
  if (match?.[1] != null && match[1].length > 0) return match[1];
  for (const [prefix, tag] of UNTAGGED_EXIT_REASONS) {
    if (reason.startsWith(prefix)) return tag;
  }
  return "unknown";
}
