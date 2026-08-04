# [BUG] Unbounded stdout/line buffer and sessionText accumulation from ACP agent process

**File:** [`engine/acp-transport.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/acp-transport.ts#L239-L296) (lines 239, 296)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-unbounded-buffer`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

`onData` (L239) appends every chunk to `this.buffer` with no size cap and only resets it when a newline arrives. If the agent process emits a large stream without a newline (or emits a huge line), the buffer grows without bound. Similarly, `sessionText` (L296) accumulates every `agent_message_chunk` text with no cap, and is only reset at the start of each prompt — a chatty or misbehaving agent can stream unbounded text during a single prompt, exhausting memory. The sibling MCP server (mcp-server.ts L10, L365) explicitly caps its stdin buffer at 65536 bytes, showing this class of issue is recognized in this codebase, but the ACP transport has no equivalent guard. The agent process is operator-installed (Hermes), so this is a robustness/resource-exhaustion defect rather than a remote vulnerability, but a compromised or buggy agent can crash the engine by growing memory without bound.

## Recommendation

Cap the line buffer (e.g., discard/error when `this.buffer` exceeds a fixed limit like the MCP server's 65536) and cap `sessionText` accumulation (e.g., truncate at a max length per prompt, mirroring the response-size limits used elsewhere).

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-21)
