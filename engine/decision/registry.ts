import type { Proposal, Rule, RuleContext, RuleHit } from "./types.js";

export interface ArbitrationResult {
  readonly winner: Proposal | null;
  /** Every non-winning proposal, ranked — kept for audit attribution. */
  readonly suppressed: readonly Proposal[];
}

/** Throws on duplicate ids: attribution is only meaningful when ids are unique. */
export function assertUniqueRuleIds(rules: readonly Rule[]): void {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) {
      throw new Error(`Duplicate decision rule id: ${rule.id}`);
    }
    seen.add(rule.id);
  }
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function toProposal(rule: Rule, hit: RuleHit, context: RuleContext): Proposal {
  return {
    ruleId: rule.id,
    phase: rule.phase,
    tier: rule.tier,
    action: hit.action,
    confidence: clampConfidence(hit.confidence),
    reason: hit.reason,
    expectedValueUsd:
      hit.expectedValueUsd !== undefined && Number.isFinite(hit.expectedValueUsd)
        ? hit.expectedValueUsd
        : null,
    costsUsd: hit.costsUsd !== undefined && Number.isFinite(hit.costsUsd) ? hit.costsUsd : null,
    positionId: context.position?.positionId ?? null,
  };
}

/**
 * Evaluate every rule that applies to the current scope and return proposals.
 * Pool-scope rules run only on the positionless pass; position-scope rules run
 * only when a position is supplied. A throwing rule is a bug and propagates —
 * the adapter isolates rules per pool, not the kernel.
 */
export function evaluateRules(rules: readonly Rule[], context: RuleContext): readonly Proposal[] {
  const proposals: Proposal[] = [];
  for (const rule of rules) {
    if (rule.scope === "pool" && context.position !== null) continue;
    if (rule.scope === "position" && context.position === null) continue;
    const hit = rule.evaluate(context);
    if (hit !== null) proposals.push(toProposal(rule, hit, context));
  }
  return proposals;
}

/**
 * Rank proposals: higher tier first, then higher net expectancy (`null` last),
 * then confidence, then rule id. Total and deterministic — the input order
 * never decides the outcome.
 */
function compareProposals(a: Proposal, b: Proposal): number {
  if (a.tier !== b.tier) return b.tier - a.tier;

  if (a.expectedValueUsd !== b.expectedValueUsd) {
    if (a.expectedValueUsd === null) return 1;
    if (b.expectedValueUsd === null) return -1;
    return b.expectedValueUsd - a.expectedValueUsd;
  }

  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  return a.ruleId.localeCompare(b.ruleId);
}

export function arbitrate(proposals: readonly Proposal[]): ArbitrationResult {
  if (proposals.length === 0) return { winner: null, suppressed: [] };
  const ranked = [...proposals].sort(compareProposals);
  const [winner, ...suppressed] = ranked;
  return { winner: winner ?? null, suppressed };
}
