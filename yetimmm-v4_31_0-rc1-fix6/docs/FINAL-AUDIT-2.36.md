# Final audit — v4.22.0 / EA 2.36

## Changed
- App: removed browser-side Telegram sender and postMessage channel; no default currency (USD), contract size (100) or "$" suffix when the EA did not report them.
- Worker: no 0.30 tolerance fallback, no XAUUSD symbol fallback; stale PAIR_CODE documentation fixed.
- Deploy: refuses a plain-variable PAIR_CODE and missing secrets; no longer deletes the PAIR_CODE secret.
- EA: removed PlacementOk, CheckModifiable, TgAddId, VirtualInside, InpTgPollSec and six unused globals.
- Removed rollback/Yetimmm.v2.34.mq5. Tests 163/163, check passes. EA NOT compiled here (F7 + Demo required).

## Not removed (needs MetaEditor feedback or an owner decision)
1. Direct-Telegram code in the EA (TgCall / getUpdates / TgPoll): unreachable by default (InpTgViaWorker=true, token never sent unless ALLOW_EA_BOT_TOKEN=1).
2. Market-order machinery (TryMarketReverse, Catch*, Virtual*): disabled by YT_REAL_ORDERS_ONLY=true.
3. Local simulation engine in index.html (CONFIG.mode is "live").
4. Confirm these deployment values are yours: index.html CONFIG.api.baseUrl and wrangler.toml ALLOWED_ORIGIN.
5. InpMoneyScale=0 (AUTO) detects cent accounts by currency code; set it explicitly (1 or 100) for a deterministic result.
