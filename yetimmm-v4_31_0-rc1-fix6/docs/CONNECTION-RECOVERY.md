# Connection recovery (v4.31.0 fix7) — what changed and how to prove it

Source: the technical audit "Fied.pdf" (19 Oct 2026). Scope: EA bridge, Cloudflare Worker, Mini App. Trading, risk and order logic are untouched.

## What the audit found and where it is fixed
| # | Finding | Fix |
|---|---|---|
| 1 | `OnInit()` checked the bridge URL before `LoadAutoConfig()` -> false "INACTIVE" | `ea/Yetimmm.mq5` `OnInit`: load, then `BrConfigProblem()`, states `CONFIG_*` |
| 2 | "Connected" = last sync is young; no distinction between causes | `BrSuccess()` only after verified `ok:true`; Worker `outages` + `eaNet` |
| 3 | One failure could look like a total outage in the app | `Bridge.fail()` / `link()` -> "Reconnecting" for < 20 s, session never cleared |
| 4 | Recovery never proven in a real run | tests below + the field plan |

## Not changed on purpose
`EA_STALE_SEC=30` stays: it is the detection rule, not the cause. Raising it would only hide real outages. Re-evaluate after the field tests, with the recorded `outages`.

## Field tests (document each result with the outage and recovery time)
Deploy: `npm run deploy`, compile `ea/Yetimmm.mq5` (F7), reload the EA. Read the numbers from the Experts log ("recovered automatically after N s") and from `/state` -> `outages`.

| # | Scenario | Expected |
|---|---|---|
| 1 | EA with valid settings | `CONFIG_READY` -> `CONNECTING` -> `CONNECTED`, no "INACTIVE" |
| 2 | EA with a missing / wrong URL | `CONFIG_INVALID` naming the exact setting |
| 3 | Disconnect the PC 10 s | `RETRYING`, then recovery, no manual action |
| 4 | Disconnect the PC 60 s | `OFFLINE` after 30 s, recovers by itself, an entry in `outages` |
| 5 | Restart MT5 | reconnects, same session |
| 6 | Close / reopen the app | session and state restored, no re-login |
| 7 | Phone offline only | app says "your phone is offline", EA stays "connected" |
| 8 | Stop the EA | app says EA offline after the stale window |
| 9 | Worker restart / temporary 5xx | EA `RETRYING` then `CONNECTED` |
| 10 | 12 h run | no growing error count, no manual intervention |

## Automated
`npm test` (364): Worker behaviour is executed; EA and app are checked structurally. The EA is not compiled here: **press F7 in MetaEditor**.
