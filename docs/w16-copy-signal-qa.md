# W16 Copy-Signal Manual QA

Date: 2026-07-19

Command:

```bash
bun -e 'import { parseCopySignalPayload, applyCopySignalBoost } from "./engine/copy-trading-signals.ts"; const wallet = "11111111111111111111111111111111"; const signals = parseCopySignalPayload([{ wallet, poolAddress: "pool", action: "ENTER", confidence: 0.9, observedAt: Date.now() }]); const decision = applyCopySignalBoost({ action: "ENTER", poolAddress: "pool", confidence: 0.7, reasoning: "base" }, { boost: signals.length > 0 ? 0.05 : 0, wallets: [wallet], ignored: 0 }); console.log(JSON.stringify({ observations: signals.length, action: decision.action, confidence: decision.confidence, bounded: decision.confidence <= 0.75 }));'
```

Observed output:

```text
{"observations":1,"action":"ENTER","confidence":0.75,"bounded":true}
```

This exercises boundary ingestion and the capped decision effect. The production path applies the same transform before the existing risk evaluation; paper mode still uses the existing paper executor and wallet signals never authorize transactions.

Additional checks:

- A disabled configuration or empty signal set returns zero boost and leaves the decision unchanged.
- The pure transform preserves `EXIT` exactly and clamps boosts to `0.05`.
- Malformed, stale, unauthorized, and duplicate observations are filtered before scoring; fetch timeout/HTTP/parse failures return zero boost.
- The temporary QA script was removed after execution; no listener, database, or network mock remains.
