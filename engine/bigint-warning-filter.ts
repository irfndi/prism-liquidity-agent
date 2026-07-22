// bigint-buffer's node entry prints this on every startup when its native addon
// cannot load (always true inside the single-file release bundle, where
// require('bindings') resolves to nothing). The pure-JS fallback it announces is
// bit-for-bit identical (verified: the native addon only accelerates
// toBigIntLE/toBigIntBE/toBufferLE/toBufferBE), so the warning is noise. Bundles
// avoid it entirely via the tsdown alias to bigint-buffer's bindings-free browser
// entry; this filter silences the residual source-run path where a module-load
// warn can still fire before the alias matters.
const BIGINT_BINDINGS_MARKER = "bigint: Failed to load bindings";

// Once-per-process note announcing the (silent) fallback. Emitted through the
// ORIGINAL console.warn — the stderr channel the suppressed warning itself used —
// NOT the engine logger: logger.debug writes via console.log UNCONDITIONALLY
// (AGENTS.md: the logger always emits regardless of level), so it put a timestamped
// debug line on STDOUT before intended output and broke stdout-parsing scripts
// (e.g. `prism --version`). Routing the note through stderr matches the warning
// being replaced; the audit-trail file no longer records the note — an acceptable
// trade for a clean stdout. Exported so tests can assert on the exact channel/text.
export const BIGINT_FALLBACK_NOTE =
  "bigint-buffer native addon unavailable — using pure-JS fallback (identical results)";

let installed = false;
let savedOriginalWarn: typeof console.warn | null = null;

/**
 * Patch console.warn to drop only the bigint-buffer bindings warning, passing
 * every other warning through untouched. The first time it suppresses, it emits a
 * single BIGINT_FALLBACK_NOTE through the captured original console.warn (stderr —
 * the same channel the warning used), keeping stdout clean for output parsers.
 * Idempotent: a second call is a no-op (the filter is installed exactly once).
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
        // stderr channel (the original console.warn) — NOT logger.debug, which
        // writes via console.log and would pollute stdout (see BIGINT_FALLBACK_NOTE
        // above). Non-marker text passes straight through the patch, so this reaches
        // the real console.warn untouched.
        originalWarn(BIGINT_FALLBACK_NOTE);
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
