# [BUG] TTY interactive input echoes secret key to terminal

**File:** [`cli/wallet.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/cli/wallet.ts#L159-L171) (lines 159, 160, 161, 162, 163, 165, 169, 170, 171)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-info-disclosure`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

When reading a keypair interactively via TTY (lines 159-172), readline.createInterface is configured with terminal: true, which echoes all typed characters to stdout. The code attempts to clear the line after Enter via rl.on('line') (lines 169-172), but: (1) the full secret key JSON is visible on screen during typing (shoulder-surfing risk), (2) terminal scrollback buffers may retain the echoed text even after clearing, and (3) the 'line' event handler fires after the question callback resolves, so subsequent console output may interleave with the clear operation. For a 64-byte Ed25519 secret key, this is a meaningful exposure window.

## Recommendation

Disable terminal echo during secret input. Read character-by-character with echo suppressed (write ANSI invisible mode or suppress rl.output writes), or use a dedicated secure-input library. Alternatively, recommend --file or --stdin (piped) as the primary import methods and deprecate the interactive TTY path.

## Recent committers (`git log`)

- irfandi marsya <join.mantap@gmail.com> (2026-06-10)
