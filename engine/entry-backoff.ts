const ENTRY_FAILURE_COOLDOWN_BASE_MS = 30 * 60 * 1000;
const ENTRY_FAILURE_COOLDOWN_MAX_MS = 6 * 60 * 60 * 1000;

export interface EntryFailureBackoff {
  readonly failures: number;
  readonly nextAttemptAt: number;
}

export function isInsufficientTokenBalanceError(error: string | undefined): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return (
    normalized.includes("insufficient token balance") ||
    normalized.includes("insufficient_usdc_balance") ||
    normalized.includes("insufficient_balance_after_swap")
  );
}

export function nextEntryFailureBackoff(
  previous: EntryFailureBackoff | undefined,
  now = Date.now(),
): EntryFailureBackoff {
  const failures = (previous?.failures ?? 0) + 1;
  const cooldownMs = Math.min(
    ENTRY_FAILURE_COOLDOWN_MAX_MS,
    ENTRY_FAILURE_COOLDOWN_BASE_MS * 2 ** (failures - 1),
  );
  return { failures, nextAttemptAt: now + cooldownMs };
}
