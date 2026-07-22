import { createLogger } from "./logger.js";

// bigint-buffer's node entry prints this on every startup when its native addon
// cannot load (always true inside the single-file release bundle, where
// require('bindings') resolves to nothing). The pure-JS fallback it announces is
// bit-for-bit identical (verified: the native addon only accelerates
// toBigIntLE/toBigIntBE/toBufferLE/toBufferBE), so the warning is noise. Bundles
// avoid it entirely via the tsdown alias to bigint-buffer's bindings-free browser
// entry; this filter silences the residual source-run path where a module-load
// warn can still fire before the alias matters.
const BIGINT_BINDINGS_MARKER = "bigint: Failed to load bindings";

const logger = createLogger("bigint-warning-filter");

let installed = false;
let savedOriginalWarn: typeof console.warn | null = null;

/**
 * Patch console.warn to drop only the bigint-buffer bindings warning, passing
 * every other warning through untouched. Logs a single debug line the first time
 * it suppresses, so the fallback is still recorded in the audit trail. Idempotent:
 * a second call is a no-op (the filter is installed exactly once).
 */
export function installBigintWarningFilter(): void {
  if (installed) return;
  installed = true;

  const originalWarn = console.warn.bind(console);
  savedOriginalWarn = originalWarn;
  let loggedOnce = false;

  console.warn = ((...args: unknown[]): void => {
    const first = args[0];
    if (typeof first === "string" && first.includes(BIGINT_BINDINGS_MARKER)) {
      if (!loggedOnce) {
        loggedOnce = true;
        logger.debug(
          "bigint-buffer native addon unavailable — using pure-JS fallback (identical results)",
        );
      }
      return;
    }
    originalWarn(...args);
  }) as typeof console.warn;
}

/**
 * TEST-ONLY: undo the process-wide singleton so a test file that installed the
 * filter does not leak its console.warn patch into other test files run in the
 * same process. Restores the console.warn captured before install (if any) and
 * resets the installed state so a later install can patch again. Production
 * never calls this — the filter is meant to live for the process lifetime.
 */
export function resetBigintWarningFilterForTest(): void {
  if (savedOriginalWarn !== null) {
    console.warn = savedOriginalWarn;
  }
  installed = false;
  savedOriginalWarn = null;
}
