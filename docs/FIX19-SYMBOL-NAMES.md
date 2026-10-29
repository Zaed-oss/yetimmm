# FIX19 - gold symbol names (GOLDm#, GOLD, XAUUSD.pro ...)

## Problem
`OnInit` returned `INIT_FAILED` (code 1) for any symbol whose name did not contain `XAUUSD`, so the EA was removed from XM's `GOLDm#` chart. `DoStart` had a second check with different rules (no upper-casing).

## Fix
| Area | Change |
|---|---|
| EA `YtClassifySymbol()` | One evidence-based classifier (score >= 3): base currency XAU (+3), name contains XAUUSD (+3), name starts with XAU / GOLD (+2), path GOLD / METAL (+1), description GOLD (+1). Rejects stocks calc mode, silver, GOLDMAN. |
| EA `OnInit` / `DoStart` | Both use the classifier; the refusal text contains the reason and the way out. |
| Input `InpSymbolPolicy` | `AUTO` (default), `STRICT_GOLD` (old behaviour: name must contain XAUUSD), `ANY` (guard off). |
| Logging | `Symbol check | <symbol> | policy | GOLD / NOT gold | score=... base=... path=... desc=... calc=...` on every start. |
| Symbol change | The saved cycle is keyed by Magic only; a different symbol name with an open cycle raises `SYMCHG` (the ledger is carried over; use Reset / New Cycle if unwanted). |
| Heartbeat | `bs.bccy` (base currency) and `bs.cls` (`gold` / `other`) are sent next to `pccy`. |

## Verification (required, not done here)
1. Compile (F7) in MetaEditor - this package was NOT compiled.
2. Demo account, attach to `GOLDm#`: Experts must show `Symbol check | GOLDm# | ... | GOLD | score=...`, then START from the Mini App.
3. Attach to EURUSD: must be refused with a readable reason. With `STRICT_GOLD` on `GOLDm#`: refused with the STRICT message.
4. `npm test` and `npm run check`.

## Not changed / open points
- Strategy inputs and all entry / lot / SL / TP / ledger code are untouched (the 2.39 input guard tests ignore only the new symbol-validation input).
- Price-point inputs (deviation, spread ...) are in points; with a broker that uses 3 digits instead of 2 for gold, review them (report section 3-d).
- The remaining "XAUUSD" texts in `index.html`, `worker/worker.js` and `scripts/setup-bot.mjs` are cosmetic descriptions and were left as they are.
