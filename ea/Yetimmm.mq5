//+------------------------------------------------------------------+
//|                                                     Yetimmm.mq5  |
//|  Yetimmm - XAUUSD continuous risk-sequence Expert Advisor        |
//|  MetaTrader 5 | Telegram control | State recovery | Trade log    |
//+------------------------------------------------------------------+
#property copyright "Yetimmm"
#property version   "2.46"
#property description "Yetimmm | XAUUSD | Two-level Stop Buy / Stop Sell switch + risk sequence | Telegram integration"

#include <Trade\Trade.mqh>

//--- v2.46 (NETWORK = OLD BEHAVIOUR): new input InpNetSilence=false. The v2.30 "hot market" network silence (NetHot) made the Mini App show "EA offline" every few seconds whenever the price sat near the levels (always the case with Buy/Sell Stop). With the default the EA again sends the heartbeat every second and polls Telegram every InpTgPollMs, never silenced - same as EA 2.30. The silence code is kept intact behind InpNetSilence=true. No entry / lot / SL / TP / ledger code changed.
//--- fix15 (CYCLE END IS FINAL): Cancel with a KEPT position now also ends the cycle (flag CANCELEND stays until that position's result is booked, TryPlace sends nothing meanwhile, so no recovery order of the old debt is ever armed); Mini App Cancel works on a STOPPED bot. A new cycle never inherits the old accumulated loss.
//--- fix13 (CANCEL ENDS THE CYCLE): a full /cancel from the Telegram bot is the second way a cycle ends (the first is CycleNet >= target). Ledger zeroed, levels deleted, state IDLE: the next /set starts from ZERO and inherits nothing. STOP stays a pause. See CycleEndByUser / CancelEndTry.
//--- v2.45.1 (TELEGRAM ORDER CONTROL): /orders now lists live orders AND levels waiting for the price (current price, trigger, remaining distance); new /del BUY|SELL|TICKET and /mod BUY|SELL PRICE act on ONE order and answer with the real outcome. Reuses ExecDeleteLevel / ExecDeleteOrder / ApplyLevels (no new trading path; no entry / lot / SL / TP / ledger code changed).
//--- v2.45 (CONFIRMATION PATH): a Mini App command is confirmed within ~1 s. (1) a WAITING side silences the network only NEAR its trigger (3 x InpHotZone), not whenever it exists; (2) a pending command result (ack) is sent with priority unless the market itself is hot; (3) InpNetMaxDeferSec 20 -> 5 so the heartbeat never approaches the Worker offline limit. No entry / lot / SL / TP / ledger code changed.
//--- v2.38 (CYCLE LEDGER): every trading cycle now has an explicit, independent ledger (CycleId / CycleNet / CycleLosses / CycleState, saved with the closing-deal id).
//---   A cycle ends ONLY when the NET result of the whole cycle (profit + commission + swap + fees of every trade that belongs to it) reaches the target (strict,
//---   no 98% tolerance). A TP or a repaid debt alone never ends it. ONE completion routine (CycleComplete) serves every closing path: it cancels the cycle's pending
//---   orders, records the result, zeroes the ledger and waits for the user (WAITING_USER). A position of an older cycle is never booked into a newer one.
//--- v2.37 (field fix, STOP-AND-REVERSE ON THE SERVER): the Sell Stop at the SL level of a Buy (and the Buy Stop at the SL level of a Sell) used to be DELETED the moment the first
//---   order filled and was only re-created AFTER the SL. By then the price had already touched / crossed the level, so a simple touch of the level never opened the reverse trade.
//---   Now (InpPreArmReverse, hedging accounts) the OPPOSITE Stop order stays a REAL pending order on the server for the whole life of the position, sized for the NEXT recovery
//---   step (predicted loss of the open trade at its SL). The broker triggers it on the very tick that triggers the SL (same price, no EA latency, no market order sent by the EA).
//---   Netting accounts keep the previous behaviour automatically. Details: docs/STOP-AND-REVERSE.md
//--- v2.22 (field fix): (1) InpBreachPolicy default = BREACH_MARKET: after a verified SL the opposite direction is opened AT ONCE (with WAIT the Sell Stop at the SL level
//---   cannot exist because the price is already through it, so the whole reversal was missed). (2) ATOMIC PAIR: a lone Buy/Sell Stop is withdrawn if its partner could not be placed
//---   together with it. (3) ZONE TOO NARROW alert. (4) InpBrPollSec 3 -> 1 (Mini App price lag).
//--- v2.21 (audit fixes): InpBreachPolicy now defaults to BREACH_WAIT = the literal philosophy (SL of a Buy Stop -> a Sell Stop is placed at that SL level and
//---   waits; no market reverse unless you opt in). New InpBrPairCode: explicit EA<->account PAIRING (the Worker mints the EA secret, MathRand is no longer the secret).
//---   The state now carries tick size / point / position id (exact order-alert matching) and MT5 link diagnostics (connected / AutoTrading / account trading).
//--- v2.19: EDGE-TRIGGERED ALERTS (a condition is reported once, re-armed after it clears / 1 h), FROZEN PRICE while STOPPED (state carries frz/frzT),
//---   DELETE / EDIT of a WAITING level from the Mini App (side only, no ticket), duplicate-command guard (3 s), cached closure scan (no global-variable scan per sync)
//--- v2.18: ZONE GATE (InpZoneGate). In a trending market one of the two stop levels is always placeable (e.g. the Sell Stop below a falling price) while the other is not;
//---   sending the lone order would trade one side only. Now, when BOTH orders are missing and either cannot be placed yet, NEITHER is sent: the bot keeps both levels,
//---   caches both trigger prices and places the pair together the tick the price is inside the zone (Ask <= Buy trigger AND Bid >= Sell trigger).
//--- v2.17: SMART WAITING + COMMAND LIFECYCLE. A level that waits for the market is a first-class object, never a "failure":
//---   * the trigger price (level -/+ max(StopsLevel, tick) + an adaptive safety buffer) is computed once and cached; OnTick compares ONE number per tick
//---     and wakes the synchroniser the very tick the price crosses it (no blind retry loop, no HTTP/trade traffic while waiting)
//---   * a "market moved while sending" race never becomes a failure: the buffer of that side widens (bounded), retries back off, the side stays WAITING
//---   * a Mini App command that was accepted but is waiting keeps the state "wait" in the app log and is updated IN PLACE:
//---     wait -> done (activated, ticket + time) | sup (superseded by a newer level) | cancel (bot stopped / orders cancelled). Persisted in the commands CSV.
//---   * the state JSON carries "st" / "wb" / "ws" per command and ver 2.17
//--- v2.16: WAIT-FOR-PRICE levels. A Buy/Sell level that is on the wrong side of the market (Buy Stop under the Ask, Sell Stop over the Bid, or inside the Stops Level)
//---   is no longer rejected by APPLY / the Mini App: the level is ACCEPTED and kept, the side shows WAITING, and the real pending order is placed automatically
//---   (checked every tick, 300 ms) the moment the broker rules allow it. Structural errors (bad tick, trading disabled, Buy<=Sell, lot) are still rejected.
//---   When an EXISTING order is moved to a level that cannot be placed yet, the old order is REMOVED (never left at the stale price) and the new one waits.
//---   The state / Telegram / Mini App show exactly what the side waits for ("Ask must fall to X"). Trading logic, SL/TP, risk sequence and protections are unchanged.
//--- v2.15: Mini App: new commands cancel / modify / place (real MT5 execution), account block (balance/equity/margin) and extended statistics in the state; bridge URL+key pre-filled
//--- v2.14: MINI APP COMMAND LOG + DELETE ORDER (every Mini App command is logged and sent back to the app as a log entry; new "delete" command removes ONE pending Stop order from MT5 and the bot keeps working without re-creating it)
//--- v2.13: FAST TELEGRAM EXECUTION (millisecond timer, ms polling, command executed + answered immediately, callback answered AFTER execution, slow monitors split from the fast path)
//--- v2.12: SECURITY + SETUP FIXES (hardcoded bot token removed, bridge/Telegram enabled by default, startup self-check of the bridge settings)
//--- v2.11: SECOND REVIEW FIXES
//---   * BREACH_MARKET slippage is now REAL: the market request carries the expected price (so Max Slippage Check acts as a price guard)
//---     AND the fill is compared with that expected price after execution (Deviation was always 0 before). A rejected reversal returns
//---     to WAITING_REENTRY (direction is not lost) and is retried after a cooldown.
//---   * History recovery no longer depends on a fixed 1-hour window: the scan marker advances ONLY after every position found in the
//---     scanned range was registered (6 h safety overlap, last processed deal time as fallback). Positions are registered AND processed
//---     in chronological order, so a long outage with several trades rebuilds the risk sequence in the right order.
//---   * Netting: a position that absorbed foreign volume while the bot was OFFLINE is now detected from its history (foreign entry deals)
//---     and treated as TAINTED even when it was already closed before the bot returned.
//---   * Combined margin check: a missing Buy Stop / Sell Stop pair is placed only when the margin of BOTH missing orders is available
//---     (InpCombinedMargin) - no more "one side exists, the other is rejected for NO MONEY".
//---   * Market reversal: permanent failures (invalid volume, long/short only, close only, volume limit) and failures that persist
//---     (YT_REV_MAX_HARD attempts) switch the bot to ERROR / MANUAL ACTION instead of retrying forever. /start or new levels resume the reversal.
//---   * InpPriceFallback can no longer turn a manual / stop-out / EA close into an "SL" or "TP": it is used only when the deal reason is unknown.

//--- v2.10: HARDENING (review fixes)
//---   * Netting: external volume merged into the bot position is DETECTED, persisted (per position) and NEVER closed by the bot;
//---     every automatic close is refused while tainted and the contaminated result does NOT feed the risk sequence.
//---   * BREACH_MARKET: full pre-flight (SL/TP side, Stops Level, volume, margin) against the REAL market price; the lot is sized from the
//---     REAL execution price to the SL level (so the risk stays = requested risk); TP = real entry + real SL distance x R/R.
//---     Default policy is now BREACH_MARKET (SL hit -> the opposite direction is opened at once, even when the price already crossed the level).
//---   * Position without SL/TP = CRITICAL PROTECTION FAILURE: aggressive retry, critical alert, sequence frozen, emergency close after a timeout.
//---   * Magic Number guard: orphan Yetimmm orders/positions of a previous Magic block the start (no silent abandonment).
//---   * Cleanup: InpSLDistance / g_sld / g_recheckOrders removed; labels say what they really do (post-fill check, alert-only spread, recovery target).

//--- v2.00: LEVEL-SWITCH PHILOSOPHY (Upper = Buy Entry + Sell SL | Lower = Sell Entry + Buy SL)
//---   * SL of each order is the OPPOSITE level (no SL distance input any more); TP = (Upper-Lower) x Risk/Reward
//---   * ONE position at most: the unwanted pending order is removed when one fills; extra positions are closed (oldest kept)
//---   * Verified Stop-Loss close (DEAL_REASON_SL) -> BOTH Buy Stop @Upper and Sell Stop @Lower are prepared again (WAITING_REENTRY
//---     until both are on the server). TP ends the sequence (TP_RESET). Any other close reason -> no automatic re-creation.
//---   * Optional BREACH_MARKET: when the stop-out itself already crossed the opposite level (a pending order cannot exist there)
//---     the opposite direction is opened at market instead of waiting.
//--- v1.31: STOP sweep (orders first, then positions, verified) | DeleteOrder classifies by History (never "DELETED" for a FILLED order)
//---        tracked ticket == the ONLY actual order (panel + reconcile) | levels change the REAL pending order during a sequence
//---        (queued only while a real position is open) | SL/RR settings reconcile immediately
//--- v1.30: REAL MT5 state only (no virtual state)
//---   Every panel value == the real pending order on the server (ticket, price, SL, TP, volume).
//---   APPLY: Validate (incl. broker rules) -> Compare with ACTUAL MT5 -> CREATE / MODIFY / REMOVE / NOTHING
//---          -> Server retcode -> Verify the order on the server -> Panel.   No "wait for a tick" for user requests.
//---   Real tickets are tracked; manual MT5 edits / deletions are DETECTED and handled by an explicit policy.
//--- v1.20: dynamic Stop Buy / Stop Sell control
//---   Desired State -> Validate -> Reconcile -> Modify/Create/Remove -> Verify -> Sync
//---   Existing pending orders are MODIFIED in place (same ticket) instead of delete + re-create.

//--- bot states (no "cycle" concept anywhere)
enum ENUM_YT_STATE
  {
   YT_IDLE=0,
   YT_ARMED=1,
   YT_BUY_ACTIVE=2,
   YT_SELL_ACTIVE=3,
   YT_WAITING_REENTRY=4,
   YT_TP_RESET=5,
   YT_STOPPED=6,
   YT_ERROR=7
  };

//--- v2.38: state of the cycle LEDGER (separate from the order state machine above)
enum ENUM_YT_CYCLE
  {
   YC_IDLE=0,          // fresh ledger, nothing booked yet
   YC_ACTIVE=1,        // the cycle is running (orders / trades / a partial result)
   YC_COMPLETING=2,    // target reached: orders are being cancelled and the ledger zeroed (persisted, so a restart finishes it)
   YC_WAITING_USER=3,  // cycle finished and recorded; nothing starts until the user sends START / levels
   YC_ERROR=4
  };
#define YT_MONEY_EPS 1e-6   // v2.38: the ONLY tolerance of the target test - floating point noise, not a "98%" allowance

//--- what to do when a pending order fills with slippage above the Max Slippage Check
//--- (MT5 cannot cap slippage on server-triggered stop orders, so it is enforced right after the fill)
enum ENUM_YT_DEV_ACTION
  {
   YT_DEV_REJECT=0,   // Reject: close the position immediately
   YT_DEV_ALERT=1     // Alert only (legacy behaviour)
  };

//--- synchronisation status of one pending order (Desired State vs Actual State on the server)
enum ENUM_YT_SYNC
  {
   YS_IDLE=0,         // no order desired on this side
   YS_SYNCED=1,       // server holds exactly the desired order
   YS_UPDATING=2,     // MODIFY in progress / awaiting server confirmation
   YS_CREATING=3,     // CREATE in progress
   YS_REMOVING=4,     // REMOVE in progress
   YS_FAILED=5,       // the server rejected the last request (old state kept)
   YS_WAITING=6,      // desired, but NOT on the server (shown as NOT PLACED + reason)
   YS_PLACED=7,       // sent AND found on the server with the requested values (shown briefly, then SYNCED)
   YS_MISSING=8,      // the tracked ticket vanished from the server (deleted / expired outside the EA)
   YS_EXTERNAL=9,     // the order was changed outside the EA (in the MT5 terminal)
   YS_FILLED=10,      // the pending order was triggered by MT5 -> real position
   YS_REMOVED=11      // the pending order was deleted and the deletion was verified on the server
  };

//--- what to do when the user moves a pending order manually in MT5
enum ENUM_YT_EXT
  {
   YT_EXT_ADOPT=0,    // MT5 is authoritative: the new price is adopted into the panel level (SL/TP re-derived)
   YT_EXT_RESTORE=1,  // the panel is authoritative: the order is moved back
   YT_EXT_HOLD=2      // do nothing automatically: flag it and wait for APPLY
  };

//--- APPLY of new levels while a risk sequence is running
enum ENUM_YT_SEQ
  {
   YT_SEQ_APPLY_NOW=0, // the REAL pending order(s) are moved immediately; only while a real POSITION is open they wait for its close
   YT_SEQ_QUEUE=1      // legacy: new levels always wait for the next TP
  };

//--- what to do when the user deletes a pending order manually in MT5
enum ENUM_YT_MISS
  {
   YT_MISS_HOLD=0,    // flag MISSING, manual intervention (APPLY / START) required
   YT_MISS_RECREATE=1 // flag MISSING and place it again (strategy allows it)
  };

//--- after a verified SL: what if the OPPOSITE level has already been crossed (a stop order cannot be placed there)?
enum ENUM_YT_ENTRY
  {
   ENTRY_PENDING=0,   // classic: a Buy Stop + a Sell Stop are placed on the server (needs Stops Level room, zone gate, both orders at once)
   ENTRY_VIRTUAL=1    // v2.22 DEFAULT: the EA stores the zone and watches the price tick by tick; the moment the price crosses a level it opens that side AT MARKET (SL = opposite level)
  };

enum ENUM_YT_BREACH
  {
   BREACH_WAIT=0,     // DEFAULT (v2.21): the strategy's literal philosophy - pending orders only: the opposite Stop is placed at the SL level and waits for price (after a gap the move may be MISSED)
   BREACH_MARKET=1    // ADVANCED / opt-in: open the opposite direction at market right after the SL when the price already crossed the level (pre-flighted, lot from the real price)
  };

//--- v2.23 Risk policy when the broker minimum volume risks MORE than the requested risk
enum ENUM_YT_RISKPOL
  {
   YT_RISK_STRICT=0,     // DEFAULT: never exceed the requested risk. No legal volume -> WAITING_VOLUME (no order, no error, no stop, no spam)
   YT_RISK_CLAMP_MIN=1   // use the broker minimum volume and SAY SO: Requested Risk / Effective Risk are both shown and logged
  };

#define YT_VER "2.46"
#define YT_REAL_ORDERS_ONLY true   // v2.33: the EA NEVER opens a trade at market by its own decision. Every entry is a REAL Buy Stop / Sell Stop order on the server, created only from the levels the user sent (Telegram / Mini App). Virtual entry, Fast Catch and Market Reversal are disabled.
#define YT_DUP_HALT_SEC 30     // v2.29: the Worker keeps reporting another live copy for this long -> this copy halts
#define YT_VANISH_WAIT_SEC 90  // v2.29: a vanished position keeps the SAFE state (no orders, sequence untouched) and the history is re-read every 5 s for this long
#define YT_INST_STALE_SEC 15   // v2.28: a copy that has not refreshed its heartbeat for this long is considered dead

//--- which pending orders the bot must keep alive
#define YM_NONE 0
#define YM_BOTH 1
#define YM_BUY  2
#define YM_SELL 3

//+------------------------------------------------------------------+
//| Inputs                                                           |
//+------------------------------------------------------------------+

input group "=== Trading Levels ==="
input double InpBuyStop        = 0.0;     // (DEPRECATED v2.27 - IGNORED) orders come ONLY from the Telegram Mini App
input double InpSellStop       = 0.0;     // (DEPRECATED v2.27 - IGNORED) orders come ONLY from the Telegram Mini App

input group "=== Risk Management ==="
input double InpInitialRisk    = 1.0;     // Initial Risk ($) - lot is rounded DOWN to the broker step: real risk <= requested
input double InpTargetProfit   = 20.0;    // Recovery Target ($) - extra profit the NEXT trade must earn on top of the accumulated loss (sizes the next risk; does NOT stop the EA)
input double InpRiskReward     = 20.0;    // Risk/Reward (TP = SL distance x this)
input bool   InpResetRiskOnStart = false; // v2.43 DEFAULT false. Even when true it NEVER clears an open debt: START / levels after STOP keep the cycle ledger. A debt is cleared ONLY by the explicit, confirmed Reset / New Cycle command from the Mini App

input group "=== Risk / Broker engine (v2.23) ==="
input ENUM_YT_RISKPOL InpRiskPolicy = YT_RISK_STRICT; // STRICT = never exceed the requested risk (WAITING_VOLUME when the broker minimum lot risks more) | CLAMP_TO_MIN = use the broker minimum lot and report the Effective Risk
input bool   InpOrderCheck     = true;    // Run OrderCheck (server pre-flight) before every pending OrderSend
input int    InpMaxSpread      = 0;       // Max Spread to ARM (points, live Ask-Bid). 0 = off. Above it NEW orders wait (WAITING_SPREAD); open trades are never touched
input double InpMaxRevGap      = 0.0;     // Max Reversal Distance ($, BREACH_MARKET/VIRTUAL only): market entry farther than this from the level is skipped. 0 = off
input bool   InpTpResetNetOnly = true;    // (DEPRECATED v2.38 - IGNORED) a cycle now ends ONLY when the cycle NET reaches the target; a TP alone never resets it

input group "=== Recovery Plan Guard (v2.24) ==="
input int    InpMaxSeqLosses   = 0;       // v2.43 DEFAULT 0 = OFF (the cycle never stops by a loss COUNT; it ends only when the cycle NET reaches the target). Optional cap: when reached, NEW orders wait (WAITING_SEQCAP) and the debt is KEPT; open trades are never touched
input double InpMaxLot         = 0.0;     // v2.31 Max lot allowed for ONE trade (hard safety cap for recovery sizing). 0 = broker maximum only. Above it NEW orders wait (WAITING_VOLUME) - the lot is never forced beyond it
input bool   InpRecoveryRoundUp = true;   // v2.31 In a recovery cycle the lot is rounded UP to the broker step so the TP repays ALL accumulated losses + the Recovery Target (otherwise rounding down leaves a small debt)
input double InpRoundUpMaxOverPct = 0.0;  // v2.47 Broker-neutral guard for the recovery round-up: the lot is rounded UP one step only if its risk stays within this % above the requested risk (0 = no limit, the previous behaviour). With a coarse lot step a limit keeps the growth smooth; the ledger carries the shortfall to the next step
input double InpMaxRiskPctBal  = 0.0;     // Max risk of ONE trade as % of the account balance. 0 = off. If the next planned risk is above it, NEW orders wait (WAITING_RISKCAP). Report recommendation: 2-3
input bool   InpPlanLog        = true;    // Print the exact recovery plan (risk / target / cumulative loss / balance needed) in the Experts log at start AND write the full per-trade table (lot, margin, net at TP) to Yetimmm_<magic>_Plan.csv
input double InpMaxAccLoss     = 0.0;     // v2.34 Max ACCUMULATED loss allowed in one cycle ($, main units). 0 = off. When (accumulated loss + the next planned risk) would exceed it, NEW orders wait (WAITING_ACCLOSSCAP); open trades are never touched
input double InpMinMarginLevel = 0.0;     // v2.34 Minimum Margin Level (%) required to place NEW orders. 0 = off. Below it NEW orders wait (WAITING_MARGINLVL); only checked while the account really uses margin
input bool   InpCostAware      = true;    // v2.34 COST-AWARE LOT: the lot also covers the round-trip commission so the NET profit at TP (not the gross one) repays the accumulated loss + the Recovery Target
input double InpCommPerLot     = 0.0;     // v2.34 Round-trip commission per 1.00 lot ($, main units). 0 = AUTO (learned from the last closed trade; 0 until the first trade closes). Used only when Cost-Aware is ON
input double InpMaxRiskUSD      = 0.0;     // v2.36 Max risk ($, main units) of ONE trade, judged on the FINAL (rounded) lot at the SL. 0 = off. Above it NEW orders wait (WAITING_RISKCAP); the lot is never forced
input double InpMaxDailyLoss    = 0.0;     // v2.36 Daily loss limit ($, main units): today's realized net loss (server day) + the loss at SL of the FINAL lot may not exceed it. 0 = off. Above it NEW orders wait (WAITING_DAYLOSS) until the next server day; open trades are never touched
input bool   InpCountManualResults = true; // v2.36 LEDGER POLICY: the NET result (profit+commission+swap) of EVERY closed position of this EA (manual / mobile / web close, stop-out, protection close, rejected fill, stale TP) enters the recovery ledger. false = old behaviour (only SL / TP / extra-position closes count)
input bool   InpOneCyclePerDay = false;   // v2.34 After a cycle ends with a TP (net result reached) no NEW cycle starts until the next server day (WAITING_NEXTDAY). Reset / New Cycle from the Mini App overrides it

input group "=== Execution ==="
input int    InpMaxDeviation   = 30;      // Max Slippage Check (points) - checked AFTER every fill (stop orders cannot be capped by MT5); a market reversal also sends it as a price guard
input ENUM_YT_DEV_ACTION InpDevAction = YT_DEV_REJECT; // Action when a fill exceeds the Max Slippage Check
input int    InpWarnSpread     = 60;      // Spread Alert (points) - ALERT ONLY, trading is never blocked
input double InpMinLevelGap    = 0.0;     // Minimum gap between Buy/Sell levels ($)
input ENUM_YT_ENTRY InpEntryMode = ENTRY_PENDING; // v2.23 DEFAULT = PENDING (real Buy Stop + Sell Stop on the server = the strategy). VIRTUAL = stored zone + tick trigger + market execution (advanced, opt-in)
input bool   InpZoneGate     = true;    // v2.18 ZONE GATE: when BOTH Buy Stop and Sell Stop are missing, place them TOGETHER only when the price is inside the zone (no lone order in a trending market)
input ENUM_YT_BREACH InpBreachPolicy = BREACH_WAIT; // After an SL: WAIT (DEFAULT v2.23: pending pair re-armed, WAITING_REENTRY until both Stops are placeable - Market Reversal OFF) or MARKET (advanced: opens the opposite side at market; a different strategy with a different SL distance)
input bool   InpPriceFallback  = true;    // v2.28 DEFAULT = ON: classify SL/TP by exit price ONLY when the deal reason is unknown (never for manual / stop-out / EA closes). Prevents a broker SL with slippage from being labelled "Other" (which used to stop the sequence)
input bool   InpPreArmReverse   = true;    // v2.37 STOP-AND-REVERSE: while a position is open the OPPOSITE Stop order (at the SL level) stays a REAL pending order sized for the next recovery step, so the broker opens the reverse trade on the very tick the SL is touched. HEDGING accounts only (Netting = automatically off). false = old behaviour (re-armed after the SL)
input bool   InpCombinedMargin  = true;    // Place a missing Buy Stop / Sell Stop pair only when the margin of BOTH missing orders is available (off = each order is checked alone)
input int    InpProtectCloseSec = 20;     // Position WITHOUT SL/TP: emergency-close after N seconds of failed protection. TRADING DECISION: 20 = "never stay unprotected" (a transient connection problem can close the trade at a loss larger than the planned risk); 0 = never force-close (alert + retry only; the position may stay unprotected)

input group "=== Fast Execution (v2.30) ==="
input bool   InpFastCatch      = false;   // v2.33 DISABLED (ignored: real orders only). v2.30 FAST CATCH: a level that the price has ALREADY crossed while no pending order of that side is on the server is entered AT MARKET on that very tick (SL = opposite level, lot sized from the real entry, risk unchanged)
input bool   InpCatchAfterSL   = false;   // (ignored, v2.33) FAST CATCH also right after a Stop Loss (WAITING_REENTRY). false = only when the price was seen INSIDE the zone first
input double InpCatchMaxGap    = 0.0;     // FAST CATCH: skip the market entry when the price is farther than this ($) beyond the level. 0 = no limit (the lot shrinks with the distance, risk stays)
input int    InpCatchDeviation = 300;     // FAST CATCH: max slippage (points) sent with the market order AND tolerated after the fill (a fast market needs a wide window or the broker re-quotes / rejects)
input int    InpFastMovePts    = 80;      // A price range of at least this many points inside 1 second = FAST MARKET: no network calls (Telegram / Mini App) so every tick is processed. 0 = off
input bool   InpNetSilence    = false;   // v2.46: false (default) = the network is NEVER silenced: Mini App heartbeat every 1 s + Telegram every InpTgPollMs (the behaviour of EA 2.30 / app 4.17.1, no "EA offline" flapping). true = legacy hot-market silence (InpHotZone / InpFastMovePts / InpNetMaxDeferSec below)
input double InpHotZone        = 1.5;     // No network calls while the price is within this distance ($) of a level (or outside the zone) - WebRequest blocks the EA and ticks are lost. 0 = off
input int    InpHotHoldSec     = 3;       // Seconds the network stays silent after a fast move
input int    InpNetMaxDeferSec = 5;       // Network is never silent longer than this: one call is allowed every N seconds even in a hot market. v2.45: 20 -> 5 (20 s equalled the Worker's offline limit and delayed Mini App confirmations)
input double InpMoneyScale     = 0.0;     // v2.30 CENT SUPPORT: account-currency units per 1 main unit. 0 = AUTO (USC/EUC/GBC/AUC... = 100), 1 = off, 100 = force (e.g. a cent account that reports "USD"). With it, EVERY money figure (Risk, Target, losses, balance, margin, panel, Telegram, Mini App) is in MAIN units ($), so a cent account runs the SAME system as a standard one (Risk 1 / Target 20) with its smaller lot sizes
input int    InpNetTimeoutMs   = 2000;    // WebRequest timeout (ms, 500..5000) - was 3000; it is the longest time the EA can be blind

input group "=== Manual changes in MT5 ==="
input ENUM_YT_EXT  InpExtPolicy  = YT_EXT_ADOPT;   // Order moved in MT5 (ADOPT = MT5 sets ENTRY only; SL/TP re-derived)
input ENUM_YT_MISS InpMissPolicy = YT_MISS_HOLD;   // Pending order deleted manually in MT5
input ENUM_YT_SEQ  InpSeqPolicy  = YT_SEQ_APPLY_NOW; // Levels changed during a sequence

input group "=== System ==="
input long   InpMagic          = 20260101; // Magic Number (changing it while Yetimmm orders/positions of the old Magic exist blocks the start)
input bool   InpIgnoreOrphans  = false;    // Start even if orders/positions of ANOTHER Magic carry the "Yetimmm" comment (second instance / deliberate)
input bool   InpShowPanel      = true;     // Show Yetimmm panel

input group "=== Telegram ==="
input bool   InpTgEnable       = true;    // Enable Telegram
input bool   InpTgNotify       = true;    // Telegram Notifications
input bool   InpTgControl      = true;    // Telegram Control Enabled
input bool   InpTgViaWorker    = true;    // v2.23: notifications go EA -> Worker (unique event id) -> Telegram. The Bot Token is NEVER sent to / stored in MT5 and the EA never polls Telegram
input bool   InpTgMenu         = false;   // v2.25: attach the START/STOP/CANCEL/STATUS... inline keyboard to every bot message. Default OFF (clean messages). Typing /menu always shows it on demand; every /command and callback keeps working
input bool   InpTgAutoHeal     = true;    // Self-heal: single poller per token, auto-clear webhook on 409, auto-pause polling if another instance owns the token
input int    InpTgPollMs       = 1000;     // Telegram fast polling interval (ms, 100..2000). Lower = faster commands but more HTTP calls

input group "=== Mini App Bridge (Cloudflare Worker) ==="
input bool   InpBrEnable       = true;    // Enable Mini App bridge
input string InpBrUrl      = "";      // Worker URL. LEAVE EMPTY (v2.27): read automatically from Common\Files\Yetimmm.cfg written by `npm run setup`. Fill only to override.
input string InpBrPairCode   = "";      // Pairing code. LEAVE EMPTY (v2.27): read automatically from Common\Files\Yetimmm.cfg written by `npm run setup`. Fill only to override.
input bool   InpBrResetPw    = false;   // Set TRUE once (then back to FALSE) to sign every device out of this account (a normal EA restart does NOT sign anyone out since v4.1)
input int    InpCmdTtlSec      = 30;      // v2.23: a Mini App command older than this when it reaches the EA is EXPIRED (acked, never executed)
input int    InpBrPollSec      = 1;       // Bridge sync interval (sec) - v2.22: 1 s (was 3) so the Mini App price follows the broker closely
string g_brUrl="", g_brPair="";   // resolved at OnInit: input if filled, else Common\Files\Yetimmm.cfg (url=... / pair=...)

//+------------------------------------------------------------------+
//| Constants                                                        |
//+------------------------------------------------------------------+
#define UI "YTP_"
#define YT_REV_MAX_HARD    20       // market-reversal attempts that fail for a NON-transient reason before the bot goes to ERROR / MANUAL ACTION
#define YT_ALERT_REARM_SEC 3600     // v2.19: a persistent condition is reported ONCE; it may be reported again only after it cleared (ClearAlert) or after this many seconds
#define YT_SCAN_BUFFER_SEC 21600    // history recovery safety overlap (6 h): every position is registered / logged once, so an overlap is harmless
const string TRADE_HEADER="TradeNo;OrderTicket;DealIn;DealOut;PositionID;Type;ExecType;Entry;Exit;SL;TP;Lot;RequestedRisk;TheoLossAtSL;TheoProfitAtTP;GrossProfit;Commission;Swap;NetPL;SpreadAtOpen;DeviationPts;OpenTime;CloseTime;CloseReason;BalanceBefore;BalanceAfter;AccLossBefore;AccLossAfter;RiskBefore;NextRisk;OrigBuyLevel;OrigSellLevel;Magic;Symbol;Status;Notes";
const string ORDER_HEADER="Time;Event;Side;OrderType;Price;Lot;Ticket;Magic;Symbol;Retcode;Note";

//+------------------------------------------------------------------+
//| Types                                                            |
//+------------------------------------------------------------------+
struct SStats
  {
   int    total,wins,losses,buys,sells,winBuy,loseBuy,winSell,loseSell;
   double totProfit,totLoss,net,avgProfit,avgLoss,maxProfit,maxLoss;
   double commission,swap,volume,highRisk,highLot,winRate;
   int    streak,consSL,consTP;
  };

//+------------------------------------------------------------------+
//| Globals                                                          |
//+------------------------------------------------------------------+
CTrade        g_trade;
string        g_sym;
long          g_magic=0;
int           g_digits=2;
int           g_lotDigits=2;
string        g_riskCode="";            // v2.23: code of the LAST risk computation (RISK_BELOW_MIN_VOLUME ...)
string        g_riskAlertKey="";        // alert key raised for the current risk condition (cleared when it resolves)
string        g_wcode="";               // v2.23: machine-readable WAITING_* code shown to the Mini App
string        g_evId[], g_evK[], g_evT[], g_evB[];   // v2.23 event outbox (EA -> Worker -> Telegram), acked by the Worker
long          g_evSeq=0;
string        g_bsSig="";               // last broker-spec signature (change detection)
double        g_point=0.01;
double        g_tick=0.01;

ENUM_YT_STATE g_state=YT_IDLE;
int           g_mode=YM_NONE;
double        g_buyLevel=0.0;
double        g_sellLevel=0.0;
double        g_initRisk=1.0;
double        g_curRisk=1.0;
double        g_accLoss=0.0;       // = max(0,-g_cycNet): the open DEBT of the cycle (kept for the caps / reports)
long          g_cycId=1;           // v2.38: unique id of the CURRENT cycle (a new id on every reset / completion)
double        g_cycNet=0.0;        // v2.38: NET of every closed trade of this cycle (profit +, loss -, after commission/swap/fees)
double        g_cycLosses=0.0;     // v2.38: sum of the net LOSSES inside this cycle (never the account history)
int           g_cycTrades=0;       // v2.38: closed trades booked in this cycle
int           g_cycState=YC_IDLE;  // v2.38: ENUM_YT_CYCLE
int           g_seq=0;
long          g_tradeNo=0;
bool          g_fresh=false;
ulong         g_lastDeal=0;
int           g_lastSLSide=0;      // 1 = a Buy was stopped out, 2 = a Sell was stopped out (0 = none)
ulong         g_nextExtraMs=0;

bool          g_connected=true;
bool          g_dirty=true;
bool          g_busy=false;
//--- v2.30 fast execution state
double        g_hkLo=0.0, g_hkHi=0.0;       // price range of the current 1-second window
ulong         g_hkMs=0;                     // start of that window
ulong         g_fastUntil=0;                // network silent until (fast market seen)
ulong         g_netDeferSince=0;            // when the network went silent
bool          g_netAckWait=false;           // v2.45: a Mini App command result (ack) is waiting to leave: it must not sit behind a quiet-market silence
ulong         g_brNetMs=0;                  // v2.45.1: when the LAST bridge request really left (own allowance: Telegram polling can no longer use up the bridge's turn)
ulong         g_netPrioMs=0;                // v2.45: last priority (ack) call, throttles it to 1 per 500 ms
ulong         g_nextCatchMs=0;              // fast-catch throttle
bool          g_catchArmed=false;           // the price was inside the zone (or a sequence is re-entering): crossing a level may now be caught
double        g_catchLb=0.0, g_catchLs=0.0; // levels the flag belongs to
int           NetTimeout();                 // forward declaration (defined with the network-silence helpers)
double        g_mscale=1.0;                 // v2.30: account-currency units per 1 MAIN unit (cent account = 100)
double        AcM(const double v) { return v/g_mscale; }   // account-currency money -> main-currency money (the unit of every figure the bot shows / stores)
ulong         g_nextPlaceMs=0;
ulong         g_lastSyncMs=0;
int           g_failCount=0;
string        g_blockReason="";
string        g_waitReason="";
datetime      g_activeNoPosSince=0;
int           g_lastPosCount=0;
bool          g_spreadWarned=false;
bool          g_stateRecovered=false;

//--- Desired vs Actual synchronisation (index 0 = BUY STOP, 1 = SELL STOP)
int           g_sync[2]={0,0};              // ENUM_YT_SYNC per side
string        g_syncMsg[2]={"",""};
bool          g_reqBusy[2]={false,false};   // a server request for this side is in flight: no second one is sent
ulong         g_retryMs[2]={0,0};           // earliest time a failed / unconfirmed request may be repeated
int           g_failCnt[2]={0,0};
double        g_failLvl[2]={0.0,0.0};       // desired level of the last failed request (a NEW level bypasses the back-off)
bool          g_vArmed=false;               // v2.22 virtual entry: the price has been INSIDE the zone since arming (edge trigger, like a real Stop order)
bool          g_zoneGate=false;             // v2.18: both orders are held back until the price is inside the zone
bool          g_unconf[2]={false,false};    // server accepted the modify but the order does not show the new values yet
ulong         g_nextDelMs=0;

//--- REAL tickets (buyStopTicket / sellStopTicket) + the last snapshot verified on the server (index 0 = BUY STOP, 1 = SELL STOP)
ulong         g_stopTicket[2]={0,0};
double        g_snapPx[2]={0.0,0.0};
double        g_snapSL[2]={0.0,0.0};
double        g_snapTP[2]={0.0,0.0};
double        g_snapVol[2]={0.0,0.0};
int           g_raceCnt[2]={0,0};           // v2.16: quiet retries when the market moved between the check and the request
bool          g_hold[2]={false,false};      // external change / missing order: no automatic action until APPLY / START
double        g_waitBuf[2]={0.0,0.0};       // v2.17: adaptive safety buffer added to the trigger distance after a "market moved" race (decays after a success)
ulong         g_trigMs[2]={0,0};            // v2.17: moment the price first reached the trigger (execution latency is measured from it)
double        g_trig[2]={0.0,0.0};          // v2.17: cached trigger price of a waiting side (0 = not waiting). Buy: Ask <= trig, Sell: Bid >= trig
double        g_deferLvl[2]={0.0,0.0};      // v2.16: level for which the "waiting for the market" notice was already sent (one notice per level)
ulong         g_missMs[2]={0,0};            // first time a tracked ticket was not found (history may lag behind)
ulong         g_guardMs[2]={0,0};           // server said DONE but the order is not visible yet: do not send a second one
ulong         g_guardTk[2]={0,0};
bool          g_restartPass=false;          // a fill was registered inside Reconcile: stop this pass, re-evaluate from the new state
ulong         g_placedMs[2]={0,0};          // PLACED stays visible for a few seconds before it becomes SYNCED
string        g_uiMsg="";
color         g_uiMsgCol=clrSilver;
string        g_applyNote="";
bool          g_uiChanged=false;
string        g_uiTxt[];                    // panel cache: only changed rows are written
color         g_uiCol[];

//--- runtime configuration (inputs are the defaults; the panel can override and the values persist in a config file)
double        g_target=20.0;
double        g_lastLossLot=0.0;            // v2.48: volume / net / side of the LAST stop-loss booked in the ledger (used only by RecoveryTrace to explain a lot that did not grow)
double        g_lastLossNet=0.0;
bool          g_lastLossBuy=false;
string        g_lcHow="";                   // v2.48: how the last lot was quantised (FLOOR / ROUND_UP / FLOOR_STEP_TOO_COARSE / CLAMP_MIN)
string        g_rtKey="";                   // v2.48: RecoveryTrace de-duplication
ulong         g_clRelLogged=0;              // v2.48: one release log per pending closure
double        g_commLot=0.0;                // v2.34: learned round-trip commission per 1.00 lot (main units, >= 0); 0 = unknown yet
double        g_rr=20.0;
int           g_maxDev=30;
int           g_warn=60;
bool          g_tgEn=false;
bool          g_tgNot=true;
bool          g_tgCtl=true;
string        g_tgTok="";
string        g_tgAuth="";
string        g_tgPub="";     // public mode: chats that talked to the bot are registered here automatically
string        g_ckKey[];
string        g_ckVal[];

//--- levels entered while a sequence is running: they start only after the next TP
double        g_pendBuy=0.0;
double        g_pendSell=0.0;

//--- Netting protection / contract size / deviation / panel state
bool          g_netting=false;
bool          g_extBlock=false;
bool          g_netTaint=false;
double        g_contract=0.0;
bool          g_csWarned=false;
bool          g_cmWarned=false;        // combined-margin alert state
int           g_revHard=0;             // consecutive NON-transient market-reversal failures
ulong         g_nextDevCloseMs=0;

//--- protection guard: a position without SL/TP is a CRITICAL failure for this strategy
bool          g_unprot=false;          // some own position currently lacks SL and/or TP
ulong         g_unprotPid=0;
ulong         g_unprotSinceMs=0;
ulong         g_protNextMs=0;          // earliest time of the next protection attempt
int           g_protTries=0;
ulong         g_nextRevMs=0;           // earliest time of the next market-reversal attempt
int           g_revFails=0;
int           g_page=0;
bool          g_uiTgEn=false;
bool          g_uiTgNot=false;
bool          g_uiTgCtl=false;
double        g_frzBid=0.0,g_frzAsk=0.0;   // v2.19: price frozen at the moment the bot was stopped
long          g_frzTs=0;
string        g_brSig="";                  // v2.19: duplicate-command guard
ulong         g_brSigMs=0;
int           g_gvTotal=-1;                // v2.19: cached list of registered position ids (rebuilt only when the globals change)
ulong         g_pids[];
bool          g_inited=false;      // OnInit completed: only then may OnDeinit overwrite the saved state
bool          g_instOwn=false;     // v2.28: this copy owns the single-instance lock of its Magic
bool          g_halt=false;        // v2.28: the lock was lost to another copy - this copy does nothing
ulong         g_instBeatMs=0;
ulong         g_vanishNextMs=0;      // v2.29: next history re-read while a position is missing
string        g_instId="";            // v2.29: unique id of THIS running copy (sent to the Worker, which detects a second live copy on another PC / VPS)
datetime      g_dupSince=0;           // v2.29: the Worker reports another live copy since this time (0 = none)
ulong         g_pendClPid=0;
ulong         g_pendClSince=0;        // v2.29: first time an unprocessed closed position was seen (placement waits briefly for it)
//--- v2.42 RECOVERY STATE SAFE / REQUEST JOURNAL / FAST REVERSE (report Fix_1)
bool          g_recHold=false;        // REQUIRED_RECOVERY: the saved state and the broker disagree and nothing proves which one is right - NO new order is sent, nothing is deleted
string        g_recWhy="";
ulong         g_recNextMs=0;
ulong         g_bookedPid=0;          // position id whose closing deal is already applied to the ledger AND saved (its log lines are still being written)
ulong         g_tlTrMs=0;             // tick count when the closing-deal event reached OnTradeTransaction (earliest sign of a close)
ulong         g_tlBookMs=0;           // tick count when the loss was booked and the opposite order could start
ulong         g_revPid=0;             // closed position id answered by the logical reversal in progress (one reversal per closed position)
bool          g_pvOk=false;           // prepared plan of the opposite order (Netting): data that does not depend on the final close result
ulong         g_pvPid=0, g_pvMs=0;
long          g_pvCyc=0;
double        g_pvLevel=0.0, g_pvRisk=0.0, g_pvLot=0.0;
void          RecoveryRelease(const string src);   // v2.42 (defined with the Recovery State Safe block)
void          RecoveryHoldTick();
void          FastReverseNow();
void          Reconcile();
bool          InstOkTrade(const string what);
bool          InstOk(const string what);   // v2.29: re-verifies lock ownership right before a sensitive operation (defined with the instance guard)
bool          PosSLCrossed(const ulong ticket);                               // v2.37 (defined with the stop-and-reverse block)

//--- v2.37 STOP-AND-REVERSE
bool          g_revCtx=false;         // true ONLY while the reverse order is created / replaced (TryPlace may then run next to ONE open position)
bool          g_revSwap=false;        // true while g_accLoss / g_curRisk / g_seq hold the PREDICTED next-step values (SaveState is frozen meanwhile)
ulong         g_revOffPid=0;          // position id whose pending orders the user cancelled (its reverse order is not re-created)
int           g_revSide=-1;           // side index (0 buy / 1 sell) of the reverse order wanted right now, -1 = none
ulong         g_revNextMs=0;          // retry cooldown of the REVERSE order (kept apart from g_nextPlaceMs so a failed reverse never delays the normal re-entry)

bool          g_stopCleanup=false;
int           g_stopTries=0;
int           g_stopCode=1;
long          g_stopChat=0;
datetime      g_stopLastTry=0;

SStats        g_st;
ulong         g_loggedPos[];
ulong         g_loggedDeal[];

string        g_alKey[];
datetime      g_alTime[];

//--- Telegram
long          g_tgIds[];
long          g_tgLast=0;
int           g_tgLastCode=0;      // last WebRequest/HTTP code of TgCall (diagnostics)
ulong         g_tgBackoffUntil=0;
int           g_tg409=0;           // consecutive 409 conflicts
datetime      g_tgWhTry=0;         // last deleteWebhook attempt
datetime      g_tgPausedUntil=0;   // polling paused (another instance owns the token) - notifications keep working  // ms tick: pause polling after a failed getUpdates
bool          g_tgOk=false;
ulong         g_tgLastPollMs=0;    // v2.13: millisecond polling gate
ulong         g_slowMs=0;          // v2.13: gate of the 1-second slow cycle
datetime      g_tgLastErrLog=0;
string        g_qText[];
long          g_qChat[];
string        g_qMarkup[];
int           g_qTry[];
string        g_lastCmdKey="";
datetime      g_lastCmdTime=0;
string        g_confAction="";
string        g_confNonce="";
datetime      g_confExpire=0;

//--- panel
string        g_rowKeys[32]={"Bot Status","Symbol",
                             "BUY STOP  Requested","BUY STOP  MT5 Actual","BUY STOP  Status",
                             "SELL STOP Requested","SELL STOP MT5 Actual","SELL STOP Status",
                             "Current Position","Current Order","Last Action",
                             "Trade Sequence","Current Risk","Current Lot","Accumulated Loss","Next Risk","Theoretical TP Profit",
                             "Risk/Reward","Connection","Spread","Current Trade #","Total Trades","Winning Trades",
                             "Losing Trades","Total Profit","Total Loss","Net P/L","Win Rate","Telegram",
                             "BUY STOP  SL | TP | Lot","SELL STOP SL | TP | Lot","Position SL | TP | Ticket"};

//+------------------------------------------------------------------+
//| Small helpers                                                    |
//+------------------------------------------------------------------+
void YLog(const string s) { Print("[Yetimmm] ",s); }
string D2(const double v) { return DoubleToString(v,2); }
string PX(const double v) { return DoubleToString(v,g_digits); }
string LotS(const double v) { return DoubleToString(v,g_lotDigits); }
string Money(const double v) { return (v<0.0?"-$":"+$")+DoubleToString(MathAbs(v),2); }
string TNo(const long n) { return StringFormat("%04d",(int)n); }
string UL(const ulong v) { return StringFormat("%I64u",v); }
string Clean(const string s) { string r=s; StringReplace(r,";",","); StringReplace(r,"\r"," "); StringReplace(r,"\n"," "); return r; }
double NP(const double p) { return NormalizeDouble(p,g_digits); }
double RoundTick(const double p)
  {
   if(g_tick>0.0) return NormalizeDouble(MathRound(p/g_tick)*g_tick,g_digits);
   return NP(p);
  }
bool PriceEq(const double a,const double b) { return MathAbs(a-b)<(g_tick>0.0?g_tick/2.0:g_point/2.0); }

string StateText()
  {
   switch(g_state)
     {
      case YT_IDLE:            return "IDLE";
      case YT_ARMED:           return "ARMED";
      case YT_BUY_ACTIVE:      return "BUY_ACTIVE";
      case YT_SELL_ACTIVE:     return "SELL_ACTIVE";
      case YT_WAITING_REENTRY: return "WAITING_REENTRY";
      case YT_TP_RESET:        return "TP_RESET";
      case YT_STOPPED:         return "STOPPED";
      case YT_ERROR:           return "ERROR";
     }
   return "UNKNOWN";
  }

string RunStatus()
  {
   if(g_state==YT_STOPPED) return "STOPPED";
   if(g_state==YT_ERROR)   return "ERROR";
   if(g_state==YT_IDLE || g_state==YT_TP_RESET) return "RUNNING (WAITING FOR LEVELS)";
   return "RUNNING";
  }

//+------------------------------------------------------------------+
//| Global-variable persistence                                      |
//+------------------------------------------------------------------+
string GN(const string k) { return "YT"+IntegerToString(g_magic)+"_"+k; }
bool   GHas(const string k) { return GlobalVariableCheck(GN(k)); }
double GV(const string k,const double def=0.0) { string n=GN(k); if(GlobalVariableCheck(n)) return GlobalVariableGet(n); return def; }
void   GS(const string k,const double v) { GlobalVariableSet(GN(k),v); }

string PNm(const ulong pid,const string k) { return GN("P"+UL(pid)+"_"+k); }
bool   PHas(const ulong pid,const string k) { return GlobalVariableCheck(PNm(pid,k)); }
double PGV(const ulong pid,const string k,const double def=0.0) { string n=PNm(pid,k); if(GlobalVariableCheck(n)) return GlobalVariableGet(n); return def; }
void   PSet(const ulong pid,const string k,const double v) { GlobalVariableSet(PNm(pid,k),v); if(k=="N") g_gvTotal=-1; }

void ClearPosGV(const ulong pid)
  {
   string keys[]={"N","R","AL","BB","SP","DV","SLP","TPP","LOT","LB","LS","TY","ET","CRC","ENT","ORD","PM","TAINT","CY","CT","RL","CO"};
   for(int i=0;i<ArraySize(keys);i++) GlobalVariableDel(PNm(pid,keys[i]));
   g_gvTotal=-1;
  }

//+------------------------------------------------------------------+
//| Runtime configuration (panel-editable, persisted in a file)      |
//| Rule: if an EA input was changed since the last run, the input   |
//| wins; otherwise the value saved from the panel is restored.      |
//+------------------------------------------------------------------+
void CfgSet(const string k,const string v)
  {
   for(int i=0;i<ArraySize(g_ckKey);i++)
      if(g_ckKey[i]==k) { g_ckVal[i]=v; return; }
   int n=ArraySize(g_ckKey);
   ArrayResize(g_ckKey,n+1);
   ArrayResize(g_ckVal,n+1);
   g_ckKey[n]=k;
   g_ckVal[n]=v;
  }

bool CfgHas(const string k)
  {
   for(int i=0;i<ArraySize(g_ckKey);i++) if(g_ckKey[i]==k) return true;
   return false;
  }

string CfgGet(const string k,const string def="")
  {
   for(int i=0;i<ArraySize(g_ckKey);i++) if(g_ckKey[i]==k) return g_ckVal[i];
   return def;
  }

string CfgFile() { return "Yetimmm_"+IntegerToString(g_magic)+"_Config.cfg"; }

void CfgLoadFile()
  {
   ArrayResize(g_ckKey,0);
   ArrayResize(g_ckVal,0);
   int h=FileOpen(CfgFile(),FILE_READ|FILE_TXT|FILE_ANSI|FILE_SHARE_READ|FILE_SHARE_WRITE);
   if(h==INVALID_HANDLE) return;
   while(!FileIsEnding(h))
     {
      string line=FileReadString(h);
      StringTrimRight(line);
      int p=StringFind(line,"=");
      if(p<=0) continue;
      CfgSet(StringSubstr(line,0,p),StringSubstr(line,p+1));
     }
   FileClose(h);
  }

void CfgSaveFile()
  {
   int h=FileOpen(CfgFile(),FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_SHARE_READ|FILE_SHARE_WRITE);
   if(h==INVALID_HANDLE)
     {
      YLog("Config file error ("+CfgFile()+") code "+IntegerToString(GetLastError()));
      return;
     }
   for(int i=0;i<ArraySize(g_ckKey);i++) FileWriteString(h,g_ckKey[i]+"="+g_ckVal[i]+"\r\n");
   FileClose(h);
  }

double CfgD(const string key,const double inp)
  {
   bool changed=(!CfgHas("in_"+key) || MathAbs(StringToDouble(CfgGet("in_"+key))-inp)>1e-9);
   double eff=(changed || !CfgHas(key))?inp:StringToDouble(CfgGet(key));
   CfgSet("in_"+key,DoubleToString(inp,8));
   CfgSet(key,DoubleToString(eff,8));
   return eff;
  }

bool CfgB(const string key,const bool inp)
  {
   bool changed=(!CfgHas("in_"+key) || (CfgGet("in_"+key)=="1")!=inp);
   bool eff=(changed || !CfgHas(key))?inp:(CfgGet(key)=="1");
   CfgSet("in_"+key,inp?"1":"0");
   CfgSet(key,eff?"1":"0");
   return eff;
  }

string CfgS(const string key,const string inp)
  {
   bool changed=(!CfgHas("in_"+key) || CfgGet("in_"+key)!=inp);
   string eff=(changed || !CfgHas(key))?inp:CfgGet(key);
   CfgSet("in_"+key,inp);
   CfgSet(key,eff);
   return eff;
  }

void CfgPutAll()
  {
   CfgSet("target",DoubleToString(g_target,8));
   CfgSet("rr",DoubleToString(g_rr,8));
   CfgSet("maxdev",DoubleToString((double)g_maxDev,8));
   CfgSet("warn",DoubleToString((double)g_warn,8));
   CfgSet("tgen",g_tgEn?"1":"0");
   CfgSet("tgnot",g_tgNot?"1":"0");
   CfgSet("tgctl",g_tgCtl?"1":"0");
   CfgSet("tgtok",InpTgViaWorker?"":g_tgTok);
   CfgSet("tgauth",g_tgAuth);
   CfgSet("tgpub",g_tgPub);
  }

void CfgInit()
  {
   CfgLoadFile();
   g_target=CfgD("target",InpTargetProfit);
   g_rr=CfgD("rr",InpRiskReward);
   g_maxDev=(int)CfgD("maxdev",(double)InpMaxDeviation);
   g_warn=(int)CfgD("warn",(double)InpWarnSpread);
   g_tgEn=CfgB("tgen",InpTgEnable);
   g_tgNot=CfgB("tgnot",InpTgNotify);
   g_tgCtl=CfgB("tgctl",InpTgControl);
   g_tgTok=InpTgViaWorker?"":CfgS("tgtok","");
   g_tgAuth=CfgS("tgauth","");
   g_tgPub=CfgS("tgpub","");
   //--- a corrupted/edited config file must never produce unusable parameters
   if(!MathIsValidNumber(g_rr) || g_rr<=0.0 ||
      !MathIsValidNumber(g_target) || g_target<0.0 || g_maxDev<0 || g_warn<0)
     {
      YLog("Config file values invalid - falling back to EA inputs.");
      g_target=InpTargetProfit; g_rr=InpRiskReward;
      g_maxDev=InpMaxDeviation; g_warn=InpWarnSpread;
      g_tgEn=InpTgEnable; g_tgNot=InpTgNotify; g_tgCtl=InpTgControl;
      CfgPutAll();
     }
   CfgSaveFile();
  }

void SaveState()
  {
   if(!InstOk("save the state")) return;      // v2.29: a copy without the lock never writes the shared state
   if(g_revSwap) return;                      // v2.37: the ledger holds PREDICTED values for a moment - they must never reach the saved state
   GS("STATE",(double)g_state);
   GS("MODE",(double)g_mode);
   GS("BL",g_buyLevel);
   GS("SLV",g_sellLevel);
   GS("IR",g_initRisk);
   GS("CRK",g_curRisk);
   GS("AL",g_accLoss);
   GS("CYCID",(double)g_cycId);                                // v2.38: the cycle ledger is saved TOGETHER with the closing-deal id (LDEAL below)
   GS("CYCNET",g_cycNet);
   GS("CYCLS",g_cycLosses);
   GS("CYCTR",(double)g_cycTrades);
   GS("CYCST",(double)g_cycState);
   GS("SEQ",(double)g_seq);
   GS("TNO",(double)g_tradeNo);
   GS("FRESH",g_fresh?1.0:0.0);
   GS("LDEAL",(double)g_lastDeal);
   GS("PBL",g_pendBuy);
   GS("PSL",g_pendSell);
   GS("LSLS",(double)g_lastSLSide);
   GS("CPL",g_commLot);                                        // v2.34 learned commission per lot
   GS("USERDEL",(g_mode==YM_BUY || g_mode==YM_SELL)?1.0:0.0);   // v2.14: single-side mode comes ONLY from a user "delete order"
   GlobalVariablesFlush();
  }

void LoadState()
  {
   if(GHas("STATE"))
     {
      g_state=(ENUM_YT_STATE)(int)GV("STATE",0);
      g_mode=(int)GV("MODE",0);
      g_buyLevel=GV("BL",0);
      g_sellLevel=GV("SLV",0);
      g_initRisk=GV("IR",InpInitialRisk);
      g_curRisk=GV("CRK",g_initRisk);
      g_accLoss=GV("AL",0);
      if(GHas("CYCNET"))
        {
         g_cycId=(long)GV("CYCID",1); if(g_cycId<1) g_cycId=1;
         g_cycNet=GV("CYCNET",0.0); g_cycLosses=GV("CYCLS",0.0); g_cycTrades=(int)GV("CYCTR",0);
         g_cycState=(int)GV("CYCST",(double)YC_IDLE);
        }
      else        // migration from a version without the cycle ledger: the open debt IS the (negative) cycle net
        {
         g_cycId=1; g_cycNet=-MathMax(g_accLoss,0.0); g_cycLosses=MathMax(g_accLoss,0.0); g_cycTrades=(int)GV("SEQ",0);
         g_cycState=(g_accLoss>1e-9 || GV("SEQ",0)>0)?YC_ACTIVE:YC_IDLE;
        }
      g_seq=(int)GV("SEQ",0);
      g_tradeNo=(long)GV("TNO",0);
      g_fresh=(GV("FRESH",0)>0.5);
      g_lastDeal=(ulong)GV("LDEAL",0);
      g_pendBuy=GV("PBL",0);
      g_pendSell=GV("PSL",0);
      g_lastSLSide=(int)GV("LSLS",0);
      //--- v2.00 migration: a single-side re-entry saved by an older version becomes "both sides"
      if((g_state==YT_ARMED || g_state==YT_WAITING_REENTRY) && (g_mode==YM_BUY || g_mode==YM_SELL) && GV("USERDEL",0)<0.5) g_mode=YM_BOTH;
      g_stateRecovered=true;
     }
   else
     {
      g_state=YT_IDLE; g_mode=YM_NONE; g_buyLevel=0; g_sellLevel=0;
      g_initRisk=InpInitialRisk; g_curRisk=InpInitialRisk; g_accLoss=0; g_seq=0;
      g_cycId=1; g_cycNet=0.0; g_cycLosses=0.0; g_cycTrades=0; g_cycState=YC_IDLE;
      g_tradeNo=(long)GV("TNO",0); g_fresh=false; g_lastDeal=0; g_pendBuy=0; g_pendSell=0; g_lastSLSide=0;
      g_stateRecovered=false;
     }
   if(g_state==YT_BUY_ACTIVE || g_state==YT_SELL_ACTIVE) g_activeNoPosSince=0;
   g_commLot=MathMax(GV("CPL",0.0),0.0);                         // v2.34
  }

//--- v2.38: starts a NEW, EMPTY cycle ledger (new CycleId). Nothing - no loss, no balance, no profit - is inherited from the previous cycle.
void ResetRisk()
  {
   g_accLoss=0.0;
   g_seq=0;
   g_curRisk=g_initRisk;
   g_cycNet=0.0; g_cycLosses=0.0; g_cycTrades=0;
   g_cycId++;
   g_cycState=YC_IDLE;
  }

bool CycleMet(const double cycNet) { return cycNet>=g_target-YT_MONEY_EPS; }     // v2.38: STRICT target test (19.99 of 20.00 is NOT met)
bool CycFresh() { return (g_accLoss<=1e-9 && MathAbs(g_cycNet)<=1e-9); }          // v2.38: nothing booked in this cycle yet
void CycTouch() { if(g_cycState!=YC_COMPLETING) g_cycState=YC_ACTIVE; }
string CycStateText()
  {
   switch(g_cycState)
     {
      case YC_IDLE: return "IDLE";
      case YC_ACTIVE: return "ACTIVE";
      case YC_COMPLETING: return "COMPLETING";
      case YC_WAITING_USER: return "WAITING_USER";
     }
   return "ERROR";
  }

//--- v2.29: every EXPLICIT reset of the loss sequence records the values BEFORE and AFTER (Experts log, Orders log, Telegram),
//--- and remembers the trade number at which it happened (the sequence audit ignores older trades).
void ResetRiskLogged(const string src)
  {
   double oa=g_accLoss, oc=g_curRisk;
   int os=g_seq;
   ResetRisk();
   GS("RSTNO",(double)g_tradeNo);
   string t="Risk sequence RESET ("+src+") | BEFORE: Seq "+IntegerToString(os)+", Acc.Loss "+D2(oa)+", Risk "+D2(oc)+" | AFTER: Seq "+IntegerToString(g_seq)+", Acc.Loss "+D2(g_accLoss)+", Risk "+D2(g_curRisk);
   YLog(t);
   LogOrder("RESET_SEQUENCE",-1,0.0,0.0,0,0,t);
   if(oa>1e-9 || os>0) TgQueue("♻️ RISK SEQUENCE RESET ("+src+")\nBefore: Seq "+IntegerToString(os)+" | Acc.Loss $"+D2(oa)+" | Risk $"+D2(oc)+"\nAfter: Seq "+IntegerToString(g_seq)+" | Acc.Loss $"+D2(g_accLoss)+" | Risk $"+D2(g_curRisk));
  }

//--- v2.43 (report Fix_2, problem 2): START / levels after STOP must NEVER wipe the debt. InpResetRiskOnStart may only touch a ledger that holds
//--- nothing to lose (no debt, no booked net, no sequence). Otherwise the ledger is KEPT and the decision is logged. Only the explicit, confirmed
//--- Mini App Reset / New Cycle command (cmd reset with confirm=1) clears a debt.
void ImplicitResetGuarded(const string src)
  {
   if(!InpResetRiskOnStart) return;
   if(g_accLoss>1e-9 || MathAbs(g_cycNet)>1e-9 || g_seq>0)
     {
      string t="DEBT KEPT ("+src+"): Reset-on-Start is ON but the cycle holds Acc.Loss "+D2(g_accLoss)+", Cycle Net "+D2(g_cycNet)+", Seq "+IntegerToString(g_seq)+" - NOT cleared. Use the confirmed Reset / New Cycle in the Mini App to clear it.";
      YLog(t);
      LogOrder("DEBT_KEPT",-1,0.0,0.0,0,0,t);
      return;
     }
   ResetRiskLogged(src);
  }

//--- v2.38: the risk of the next step is planned from the net the cycle STILL needs (target - cycle net).
//--- net < 0 (debt): (L+target)/RR exactly as before. net > 0 (partial profit, target not met yet): remaining/RR, never below the initial risk
//--- (a smaller risk could fall under the broker minimum lot and stall a cycle that is already in profit).
double NextRiskForNet(const double net)
  {
   if(MathAbs(net)<=1e-9) return g_initRisk;
   double rem=g_target-net;
   if(rem<=1e-9) return g_initRisk;
   double r=rem/g_rr;
   if(net>0.0 && r<g_initRisk) r=g_initRisk;
   return r;
  }
double NextRiskFor(const double L) { return NextRiskForNet(-L); }          // pure: a hypothetical debt L (plan tables / previews)

//+------------------------------------------------------------------+
//| Alerts                                                           |
//+------------------------------------------------------------------+
bool AlertThrottle(const string key,const int sec)
  {
   for(int i=0;i<ArraySize(g_alKey);i++)
      if(g_alKey[i]==key)
        {
         if(TimeLocal()-g_alTime[i]<sec) return false;
         g_alTime[i]=TimeLocal();
         return true;
        }
   int n=ArraySize(g_alKey);
   ArrayResize(g_alKey,n+1);
   ArrayResize(g_alTime,n+1);
   g_alKey[n]=key;
   g_alTime[n]=TimeLocal();
   return true;
  }

void ClearAlert(const string key)
  {
   for(int i=0;i<ArraySize(g_alKey);i++)
      if(g_alKey[i]==key) g_alTime[i]=0;
  }

void RaiseAlert(const string key,const string msg,const bool popup=true,const bool tg=true)
  {
   if(!AlertThrottle(key,YT_ALERT_REARM_SEC)) return;
   Print("[Yetimmm] ALERT: ",msg);
   if(popup && !MQLInfoInteger(MQL_TESTER)) Alert("Yetimmm: ",msg);
   if(tg) TgQueue("⚠️ "+msg);
  }

//+------------------------------------------------------------------+
//| File logging (Orders log / Trades log)                           |
//+------------------------------------------------------------------+
string TradeFile() { return "Yetimmm_"+IntegerToString(g_magic)+"_Trades.csv"; }
string OrderFile() { return "Yetimmm_"+IntegerToString(g_magic)+"_Orders.csv"; }

void AppendLine(const string file,const string header,const string line)
  {
   int h=FileOpen(file,FILE_READ|FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_SHARE_READ|FILE_SHARE_WRITE);
   if(h==INVALID_HANDLE)
     {
      YLog("File error ("+file+") code "+IntegerToString(GetLastError()));
      return;
     }
   if(FileSize(h)==0) FileWriteString(h,header+"\r\n");
   FileSeek(h,0,SEEK_END);
   FileWriteString(h,line+"\r\n");
   FileFlush(h);
   FileClose(h);
  }

string OTypeStr(const long t)
  {
   switch((int)t)
     {
      case ORDER_TYPE_BUY_STOP:  return "BUY_STOP";
      case ORDER_TYPE_SELL_STOP: return "SELL_STOP";
      case ORDER_TYPE_BUY:       return "BUY";
      case ORDER_TYPE_SELL:      return "SELL";
      case ORDER_TYPE_BUY_LIMIT: return "BUY_LIMIT";
      case ORDER_TYPE_SELL_LIMIT:return "SELL_LIMIT";
     }
   return "OTHER";
  }

void LogOrder(const string ev,const long otype,const double price,const double lot,const ulong ticket,const uint rc,const string note)
  {
   string side="";
   if(otype==ORDER_TYPE_BUY_STOP || otype==ORDER_TYPE_BUY) side="BUY";
   else if(otype==ORDER_TYPE_SELL_STOP || otype==ORDER_TYPE_SELL) side="SELL";
   string line=TimeToString(TimeCurrent(),TIME_DATE|TIME_SECONDS)+";"+ev+";"+side+";"+OTypeStr(otype)+";"+PX(price)+";"+LotS(lot)+";"+
               UL(ticket)+";"+IntegerToString(g_magic)+";"+g_sym+";"+IntegerToString((int)rc)+";"+Clean(note);
   AppendLine(OrderFile(),ORDER_HEADER,line);
  }

//+------------------------------------------------------------------+
//| v2.48 CYCLE LIFECYCLE JOURNAL + OWNERSHIP CENSUS                 |
//| Every cycle has ONE life: OPEN -> trades (each with its passport:|
//| cycle id, target, role, ledger at open) -> bookings -> CLOSE.    |
//| One CSV line per event; nothing here changes a lot, a state or a |
//| ledger value (journal only).                                     |
//| Ownership = Symbol + Magic (what is MINE) + the cycle id saved   |
//| on the position (WHICH cycle). Anything else is FOREIGN: seen,   |
//| logged once, never counted, never touched.                       |
//+------------------------------------------------------------------+
string LifeFile() { return "Yetimmm_"+IntegerToString(g_magic)+"_CycleLife.csv"; }
const string LIFE_HEADER="Time;CycleId;Event;Trade;Position;Side;Lot;Role;Owner;NetBefore;NetAfter;Target;Seq;Note";
long          g_bookTno=0;            // trade being booked right now (set by ProcessClosedPosition, read by CycleBook, then cleared)
ulong         g_bookPid=0;
string        g_bookSide="", g_bookRole="";
double        g_bookLot=0.0;
ulong         g_fgSeen[32];           // foreign tickets already reported (each is logged once)
int           g_fgPos=0;
ulong         g_censusMs=0;

void CycLife(const long cyc,const string ev,const long tno,const ulong pid,const string side,const double lot,const string role,const string owner,
             const double nb,const double na,const string note)
  {
   string line=TimeToString(TimeCurrent(),TIME_DATE|TIME_SECONDS)+";"+IntegerToString((int)cyc)+";"+ev+";"+(tno>0?IntegerToString((int)tno):"")+";"+(pid>0?UL(pid):"")+";"+side+";"+
               (lot>0.0?DoubleToString(lot,g_lotDigits):"")+";"+role+";"+owner+";"+D2(nb)+";"+D2(na)+";"+D2(g_target)+";"+IntegerToString(g_seq)+";"+note;
   AppendLine(LifeFile(),LIFE_HEADER,line);
  }

//--- the first trade (or first booking) of a cycle opens its life: start time, target, initial risk, RR
void CycOpenIfNeeded(const string why)
  {
   if((long)GV("CYCOP",0.0)==g_cycId) return;
   GS("CYCOP",(double)g_cycId);
   GS("CYCT0",(double)TimeCurrent());
   const string t="CYCLE #"+IntegerToString((int)g_cycId)+" OPENED | target "+D2(g_target)+" | initial risk "+D2(g_initRisk)+" | RR "+D2(g_rr)+" | "+why;
   YLog(t);
   CycLife(g_cycId,"CYCLE_OPEN",0,0,"",0.0,"","MINE",g_cycNet,g_cycNet,t);
  }

//--- the end of a cycle's life (TARGET_MET / CANCELLED_BY_USER): a full summary of what it was
void CycCloseLife(const long id,const string result,const double cnet,const int trades,const int steps,const double losses)
  {
   if((long)GV("CYCOP",0.0)!=id) return;                       // a cycle that never opened has no life to close
   const datetime t0=(datetime)GV("CYCT0",(double)TimeCurrent());
   const long mins=(long)((TimeCurrent()-t0)/60);
   const string t="CYCLE #"+IntegerToString((int)id)+" CLOSED "+result+" | opened "+TimeToString(t0,TIME_DATE|TIME_SECONDS)+" | lasted "+IntegerToString((int)mins)+" min | trades "+IntegerToString(trades)+
                  " | SL steps "+IntegerToString(steps)+" | cycle losses "+D2(losses)+" | net "+D2(cnet)+" vs target "+D2(g_target);
   YLog(t);
   CycLife(id,"CYCLE_CLOSE",0,0,"",0.0,"","MINE",cnet,cnet,t);
   GS("CYCOP",0.0);
  }

bool FgSeen(const ulong tk)
  {
   for(int i=0;i<32;i++) if(g_fgSeen[i]==tk) return true;
   g_fgSeen[g_fgPos]=tk; g_fgPos=(g_fgPos+1)%32;
   return false;
  }

//--- what is mine and what is not: counted by cycle, foreign ones reported once. Read-only (selects positions, changes nothing).
void CycleCensus(const string src,const bool force)
  {
   const ulong now=GetTickCount64();
   if(!force && now-g_censusMs<30000) return;
   g_censusMs=now;
   int mine=0, oldc=0, unreg=0, fgn=0, ownOrd=0, fgnOrd=0;
   const int n=PositionsTotal();
   for(int i=0;i<n;i++)
     {
      const ulong t=PositionGetTicket(i);
      if(t==0) continue;
      if(PositionGetString(POSITION_SYMBOL)!=g_sym) continue;
      const ulong pid=(ulong)PositionGetInteger(POSITION_IDENTIFIER);
      if((long)PositionGetInteger(POSITION_MAGIC)!=g_magic)
        {
         fgn++;
         if(!FgSeen(t))
           {
            const string w="FOREIGN position #"+UL(t)+" on "+g_sym+" (magic "+IntegerToString((int)PositionGetInteger(POSITION_MAGIC))+", "+(PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY?"BUY ":"SELL ")+DoubleToString(PositionGetDouble(POSITION_VOLUME),g_lotDigits)+
                           ") is NOT mine: not counted in cycle #"+IntegerToString((int)g_cycId)+", not touched"+(g_netting?" (Netting: it can merge with mine - the Netting taint rules apply)":"");
            YLog(w);
            CycLife(g_cycId,"FOREIGN_SEEN",0,t,(PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY?"BUY":"SELL"),PositionGetDouble(POSITION_VOLUME),"","FOREIGN",g_cycNet,g_cycNet,w);
           }
         continue;
        }
      const long pc=(long)PGV(pid,"CY",0.0);
      if(pc==0) unreg++;
      else if(pc!=g_cycId)
        {
         oldc++;
         if(!FgSeen(t))
           {
            const string w="Position #"+UL(t)+" is MINE but belongs to OLD cycle #"+IntegerToString((int)pc)+" (current #"+IntegerToString((int)g_cycId)+"): its result will NOT be booked in the current cycle";
            YLog(w);
            CycLife(pc,"OLD_CYCLE_POSITION",(long)PGV(pid,"N",0.0),t,"",PositionGetDouble(POSITION_VOLUME),"","MINE_OLD_CYCLE",g_cycNet,g_cycNet,w);
           }
        }
      else mine++;
     }
   for(int i=OrdersTotal()-1;i>=0;i--)
     {
      const ulong t=OrderGetTicket(i);
      if(t==0) continue;
      if(OrderGetString(ORDER_SYMBOL)!=g_sym) continue;
      if((long)OrderGetInteger(ORDER_MAGIC)==g_magic) ownOrd++; else fgnOrd++;
     }
   if(force)
     {
      const string t="CENSUS ["+src+"] cycle #"+IntegerToString((int)g_cycId)+" ("+CycStateText()+") net "+D2(g_cycNet)+" of target "+D2(g_target)+" | positions: mine in this cycle "+IntegerToString(mine)+", mine in an old cycle "+IntegerToString(oldc)+
                     ", mine not registered yet "+IntegerToString(unreg)+", FOREIGN "+IntegerToString(fgn)+" | pending orders: mine "+IntegerToString(ownOrd)+", foreign "+IntegerToString(fgnOrd);
      YLog(t);
      LogOrder("CYCLE_CENSUS",-1,0.0,0.0,0,0,t);
     }
  }


bool IsLoggedPos(const ulong pid)
  {
   for(int i=0;i<ArraySize(g_loggedPos);i++) if(g_loggedPos[i]==pid) return true;
   return false;
  }
bool IsLoggedDeal(const ulong d)
  {
   if(d==0) return false;
   for(int i=0;i<ArraySize(g_loggedDeal);i++) if(g_loggedDeal[i]==d) return true;
   return false;
  }
void MarkLogged(const ulong pid,const ulong d)
  {
   int n=ArraySize(g_loggedPos); ArrayResize(g_loggedPos,n+1); g_loggedPos[n]=pid;
   n=ArraySize(g_loggedDeal);    ArrayResize(g_loggedDeal,n+1); g_loggedDeal[n]=d;
  }

void StatsReset()
  {
   ZeroMemory(g_st);
  }

void StatsAdd(const double net,const double comm,const double swap,const string type,const double lot,const double risk,const string reason)
  {
   g_st.total++;
   bool buy=(type=="BUY");
   bool rej=(reason=="Deviation Reject");
   if(buy) g_st.buys++; else g_st.sells++;
   if(net>0.0)
     {
      g_st.wins++; g_st.totProfit+=net;
      if(net>g_st.maxProfit) g_st.maxProfit=net;
      if(buy) g_st.winBuy++; else g_st.winSell++;
      if(!rej) g_st.streak=(g_st.streak>0)?g_st.streak+1:1;
     }
   else if(net<0.0)
     {
      g_st.losses++; g_st.totLoss+=MathAbs(net);
      if(MathAbs(net)>g_st.maxLoss) g_st.maxLoss=MathAbs(net);
      if(buy) g_st.loseBuy++; else g_st.loseSell++;
      if(!rej) g_st.streak=(g_st.streak<0)?g_st.streak-1:-1;
     }
   g_st.net=g_st.totProfit-g_st.totLoss;
   g_st.commission+=comm;
   g_st.swap+=swap;
   g_st.volume+=lot;
   if(risk>g_st.highRisk) g_st.highRisk=risk;
   if(lot>g_st.highLot) g_st.highLot=lot;
   if(reason=="SL") g_st.consSL++; else if(!rej) g_st.consSL=0;
   if(reason=="TP") g_st.consTP++; else if(!rej) g_st.consTP=0;
   g_st.avgProfit=(g_st.wins>0)?g_st.totProfit/g_st.wins:0.0;
   g_st.avgLoss=(g_st.losses>0)?g_st.totLoss/g_st.losses:0.0;
   g_st.winRate=(g_st.total>0)?100.0*g_st.wins/g_st.total:0.0;
  }

//--- load the persistent trade log: fills the dedupe arrays and the statistics
void LoadTradeLog()
  {
   ArrayResize(g_loggedPos,0);
   ArrayResize(g_loggedDeal,0);
   StatsReset();
   int h=FileOpen(TradeFile(),FILE_READ|FILE_TXT|FILE_ANSI|FILE_SHARE_READ|FILE_SHARE_WRITE);
   if(h==INVALID_HANDLE) return;
   bool first=true;
   while(!FileIsEnding(h))
     {
      string line=FileReadString(h);
      if(StringLen(line)==0) continue;
      if(first) { first=false; continue; }
      string f[];
      int c=StringSplit(line,';',f);
      if(c<30) continue;
      ulong pid=(ulong)StringToInteger(f[4]);
      ulong dout=(ulong)StringToInteger(f[3]);
      MarkLogged(pid,dout);
      if(c>34 && StringFind(f[34],"TAINTED")>=0) continue;     // Netting-contaminated rows are not part of the statistics
      StatsAdd(StringToDouble(f[18]),StringToDouble(f[16]),StringToDouble(f[17]),f[5],StringToDouble(f[11]),StringToDouble(f[12]),f[23]);
     }
   FileClose(h);
  }

int ReadTradeLines(string &lines[])
  {
   ArrayResize(lines,0);
   int h=FileOpen(TradeFile(),FILE_READ|FILE_TXT|FILE_ANSI|FILE_SHARE_READ|FILE_SHARE_WRITE);
   if(h==INVALID_HANDLE) return 0;
   bool first=true;
   while(!FileIsEnding(h))
     {
      string line=FileReadString(h);
      if(StringLen(line)==0) continue;
      if(first) { first=false; continue; }
      int n=ArraySize(lines);
      ArrayResize(lines,n+1);
      lines[n]=line;
     }
   FileClose(h);
   return ArraySize(lines);
  }

//+------------------------------------------------------------------+
//| Symbol / price helpers                                           |
//+------------------------------------------------------------------+
//--- v2.00: Upper = Buy Entry + Sell SL, Lower = Sell Entry + Buy SL
//--- SL distance = Upper - Lower. 0.0 when no valid pair of levels exists: a distance is never invented.
double SLDist()
  {
   if(g_buyLevel>0.0 && g_sellLevel>0.0 && g_buyLevel>g_sellLevel) return g_buyLevel-g_sellLevel;
   return 0.0;
  }
//--- 0.0 = no valid opposite level (callers treat it as "cannot compute")
double SLPrice(const bool buy,const double entry)
  {
   if(buy  && g_sellLevel>0.0 && g_sellLevel<entry) return RoundTick(g_sellLevel);
   if(!buy && g_buyLevel>0.0  && g_buyLevel>entry)  return RoundTick(g_buyLevel);
   return 0.0;
  }
double TPPrice(const bool buy,const double entry)
  {
   double d=SLDist()*g_rr;
   if(d<=0.0) return 0.0;
   return RoundTick(buy?entry+d:entry-d);
  }

//--- Contract Size: cross-check + last-resort fallback for the loss-per-lot calculation
bool ProfitCcyIsAccount()
  {
   return (SymbolInfoString(g_sym,SYMBOL_CURRENCY_PROFIT)==AccountInfoString(ACCOUNT_CURRENCY));
  }

void VerifyContract(const double dist,const double brokerPerLot)
  {
   if(g_contract<=0.0 || !ProfitCcyIsAccount() || dist<=0.0) return;
   double expected=dist*g_contract/g_mscale;
   if(MathAbs(brokerPerLot-expected)/expected>0.02 && !g_csWarned)
     {
      g_csWarned=true;
      string m="Contract Size check: broker loss per lot "+D2(brokerPerLot)+" differs from SL distance x Contract Size ("+D2(dist)+" x "+DoubleToString(g_contract,2)+" = "+D2(expected)+
               "). Lot sizing uses the broker value (OrderCalcProfit). Verify the symbol specification.";
      YLog(m);
      RaiseAlert("CSIZE",m,true,true);
     }
  }

//--- loss of ONE lot between an explicit entry and an explicit SL (broker specifications)
double PerLotLossSL(const bool buy,const double entry,const double sl)
  {
   if(sl<=0.0 || entry<=0.0 || MathAbs(entry-sl)<1e-12) return 0.0;
   double profit=0.0;
   ENUM_ORDER_TYPE ot=buy?ORDER_TYPE_BUY:ORDER_TYPE_SELL;
   if(OrderCalcProfit(ot,g_sym,1.0,entry,sl,profit) && profit<0.0)
     {
      profit=AcM(profit);                                   // v2.30: cent account -> main units
      VerifyContract(MathAbs(entry-sl),-profit);
      return -profit;
     }
   double tv=SymbolInfoDouble(g_sym,SYMBOL_TRADE_TICK_VALUE_LOSS);
   if(tv<=0.0) tv=SymbolInfoDouble(g_sym,SYMBOL_TRADE_TICK_VALUE);
   if(tv>0.0 && g_tick>0.0) return AcM(MathAbs(entry-sl)/g_tick*tv);
   if(g_contract>0.0 && ProfitCcyIsAccount()) return AcM(MathAbs(entry-sl)*g_contract);
   return 0.0;
  }

//--- stop-order sizing: entry = the level, SL = the opposite level
double PerLotLoss(const bool buy,const double entry)
  {
   return PerLotLossSL(buy,entry,SLPrice(buy,entry));
  }


//--- v2.34 COST-AWARE SIZING: the commission of a round trip is a real cost of the cycle. The lot must make the NET profit at TP
//--- (gross - commission) equal to (accumulated loss + target). With risk = (loss + target) / RR the exact condition is
//---    lot * (perLot * RR - c) >= risk * RR   <=>   lot >= risk / (perLot - c / RR)
double CommPerLotEff()
  {
   if(!InpCostAware) return 0.0;
   if(InpCommPerLot>0.0) return InpCommPerLot;
   return (g_commLot>0.0)?g_commLot:0.0;
  }
//--- effective loss-per-lot used ONLY to size the lot (never shown as the loss at SL). Falls back to perLot when the cost is unknown or absurd (> 50% of the loss).
double SizingPerLot(const double perLot)
  {
   double c=CommPerLotEff();
   if(c>0.0 && g_rr>1.0 && perLot-c/g_rr>perLot*0.5) return perLot-c/g_rr;
   return perLot;
  }
//--- server day number + 1 (0 is reserved for "none")
long DayKeyNow() { return (long)(TimeCurrent()/86400)+1; }

//--- v2.36 DAILY REALIZED NET (main units). Persisted (GlobalVariables DLD = day key, DLN = net of that day) so a restart cannot lose it.
//--- It is fed ONCE per closed position from ProcessClosedPosition (that function is already idempotent per position / closing deal).
double DayNetToday()
  {
   if((long)GV("DLD",0.0)!=DayKeyNow()) return 0.0;
   return GV("DLN",0.0);
  }
void DayNetAdd(const double net)
  {
   long dk=DayKeyNow();
   double cur=((long)GV("DLD",0.0)==dk)?GV("DLN",0.0):0.0;
   GS("DLD",(double)dk);
   GS("DLN",cur+net);
  }

//+------------------------------------------------------------------+
//| v2.23 BROKER / RISK ENGINE                                       |
//| BrokerSpec (live) -> RiskCompute -> (OrderCheck) -> OrderSend.   |
//| The EA is the authority; the Mini App only displays the result.  |
//+------------------------------------------------------------------+
struct SRiskResult
  {
   bool   valid;
   bool   clamped;
   string code;       // OK | RISK_BELOW_MIN_VOLUME | RISK_ABOVE_MAX_VOLUME | RISK_ABOVE_VOLUME_LIMIT | RISK_NO_MARGIN | RISK_NO_SPEC
   string text;
   string policy;
   bool   buy;
   double entry, sl;
   double requested, perLot, rawVol, vol, minVol, maxVol, step, limit;
   double effective, minRisk, maxRisk, margin;
  };

SRiskResult g_rk;

string AccCcyRaw() { return AccountInfoString(ACCOUNT_CURRENCY); }
//--- label of the MAIN unit: USC->USD, EUC->EUR, GBC->GBP ... (a cent account is shown in dollars, like a standard one)
string AccCcy()
  {
   string c=AccCcyRaw();
   if(g_mscale<=1.0) return c;
   string u=c; StringToUpper(u);
   if(u=="USC") return "USD";
   if(u=="EUC") return "EUR";
   if(u=="GBC") return "GBP";
   if(u=="AUC") return "AUD";
   if(u=="NZC") return "NZD";
   if(u=="CHC") return "CHF";
   if(u=="JPC") return "JPY";
   return c;
  }
//--- v2.30: 0 = auto (known cent currencies), otherwise the explicit factor
double DetectMoneyScale()
  {
   if(InpMoneyScale>0.0) return MathMax(1.0,InpMoneyScale);
   string u=AccCcyRaw(); StringToUpper(u);
   if(u=="USC" || u=="EUC" || u=="GBC" || u=="AUC" || u=="NZC" || u=="CHC" || u=="JPC") return 100.0;
   return 1.0;
  }

//--- volume already open + pending on the symbol in ONE direction (own pending orders are excluded: they are the ones being (re)placed).
//--- only called when the broker sets SYMBOL_VOLUME_LIMIT > 0
double DirVolume(const bool buy)
  {
   double v=0.0;
   for(int i=PositionsTotal()-1;i>=0;i--)
     {
      ulong t=PositionGetTicket(i);
      if(t==0) continue;
      if(PositionGetString(POSITION_SYMBOL)!=g_sym) continue;
      bool pb=(PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY);
      if(pb==buy) v+=PositionGetDouble(POSITION_VOLUME);
     }
   for(int i=OrdersTotal()-1;i>=0;i--)
     {
      ulong t=OrderGetTicket(i);
      if(t==0) continue;
      if(OrderGetString(ORDER_SYMBOL)!=g_sym) continue;
      if(OrderGetInteger(ORDER_MAGIC)==g_magic) continue;
      long ty=OrderGetInteger(ORDER_TYPE);
      bool ob=(ty==ORDER_TYPE_BUY || ty==ORDER_TYPE_BUY_STOP || ty==ORDER_TYPE_BUY_LIMIT || ty==ORDER_TYPE_BUY_STOP_LIMIT);
      bool os=(ty==ORDER_TYPE_SELL || ty==ORDER_TYPE_SELL_STOP || ty==ORDER_TYPE_SELL_LIMIT || ty==ORDER_TYPE_SELL_STOP_LIMIT);
      if((ob && buy) || (os && !buy)) v+=OrderGetDouble(ORDER_VOLUME_CURRENT);
     }
   return v;
  }

//--- v2.47 BROKER-NEUTRAL LOT QUANTISATION (min / step / max always come from the live symbol specification, nothing is hard-coded)
//--- FLOOR: real risk <= requested. ROUND_UP (recovery with a debt): one step higher so the TP repays debt + target, bounded by InpRoundUpMaxOverPct when set.
double QuantizeLot(const double raw,const double vmin,const double step,const double risk,const double perSz,const bool debt,string &how)
  {
   double lot=vmin+MathFloor((raw-vmin)/step+1e-7)*step;
   how="FLOOR";
   if(InpRecoveryRoundUp && debt && lot*perSz<risk-1e-9)
     {
      const double up=lot+step;
      if(InpRoundUpMaxOverPct>0.0 && up*perSz>risk*(1.0+InpRoundUpMaxOverPct/100.0)+1e-9) how="FLOOR_STEP_TOO_COARSE";
      else { lot=up; how="ROUND_UP"; }
     }
   return lot;
  }
string g_lcKey="";

//--- Requested Risk -> executable volume, with the explicit policy. Never throws a "fatal": it explains WHY no volume exists.
bool RiskCompute(const double risk,const bool buy,const double entry,const double sl,SRiskResult &r)
  {
   r.valid=false; r.clamped=false; r.code="OK"; r.text=""; r.buy=buy; r.entry=entry; r.sl=sl;
   r.policy=(InpRiskPolicy==YT_RISK_CLAMP_MIN)?"CLAMP_TO_MIN":"STRICT";
   r.requested=risk; r.perLot=0.0; r.rawVol=0.0; r.vol=0.0; r.effective=0.0; r.minRisk=0.0; r.maxRisk=0.0; r.margin=0.0;
   double vmin=SymbolInfoDouble(g_sym,SYMBOL_VOLUME_MIN);
   double vmax=SymbolInfoDouble(g_sym,SYMBOL_VOLUME_MAX);
   double step=SymbolInfoDouble(g_sym,SYMBOL_VOLUME_STEP);
   double lim =SymbolInfoDouble(g_sym,SYMBOL_VOLUME_LIMIT);
   if(step<=0.0) step=(vmin>0.0)?vmin:0.01;
   if(vmin<=0.0) vmin=step;
   r.minVol=vmin; r.maxVol=vmax; r.step=step; r.limit=lim;
   string ccy=AccCcy();
   double perLot=PerLotLossSL(buy,entry,sl);
   if(perLot<=0.0) { r.code="RISK_NO_SPEC"; r.text="Cannot determine the loss per lot from the broker specifications."; return false; }
   r.perLot=perLot; r.minRisk=vmin*perLot; r.maxRisk=vmax*perLot;
   double perSz=SizingPerLot(perLot);                        // v2.34: commission-aware (== perLot when the cost is unknown / Cost-Aware is OFF)
   double raw=risk/perSz;
   r.rawVol=raw;
   if(InpMaxLot>0.0 && InpMaxLot<vmax) { vmax=InpMaxLot; r.maxVol=vmax; r.maxRisk=vmax*perLot; }   // v2.31 hard safety cap
   double lot;
   string how="FLOOR";
   if(raw<vmin-1e-9)
     {
      if(InpRiskPolicy==YT_RISK_CLAMP_MIN) { lot=vmin; r.clamped=true; how="CLAMP_MIN"; }
      else
        {
         r.code="RISK_BELOW_MIN_VOLUME";
         r.text="Requested risk "+D2(risk)+" "+ccy+" is below the minimum executable risk "+D2(r.minRisk)+" "+ccy+" (min lot "+DoubleToString(vmin,g_lotDigits)+"). WAITING_VOLUME: raise the Risk, widen the levels or enable CLAMP_TO_MIN.";
         return false;
        }
     }
   else
     {
      //--- rounded DOWN to the step (real risk <= requested); v2.31 recovery: rounded UP one step when a debt exists so the TP repays loss + target (v2.47: bounded by InpRoundUpMaxOverPct)
      lot=QuantizeLot(raw,vmin,step,risk,perSz,(g_accLoss>1e-9 || g_cycNet>1e-9),how);
     }
   lot=NormalizeDouble(lot,g_lotDigits);
   g_lcHow=how;
   {
    //--- v2.47 LOTCHAIN: ONE line per distinct sizing decision (deduplicated) - the whole chain loss -> ledger -> risk -> lot, with the live broker limits
    const string lck=DoubleToString(risk,4)+"|"+DoubleToString(lot,4)+"|"+how+"|"+D2(g_cycNet);
    if(lck!=g_lcKey)
      {
       g_lcKey=lck;
       YLog("LOTCHAIN risk "+D2(risk)+" | cycle net "+D2(g_cycNet)+" | acc.loss "+D2(g_accLoss)+" | loss/lot "+D2(perLot)+" | raw lot "+DoubleToString(raw,5)+
            " | broker min "+DoubleToString(vmin,g_lotDigits)+" step "+DoubleToString(step,g_lotDigits)+" max "+DoubleToString(vmax,g_lotDigits)+" | final lot "+DoubleToString(lot,g_lotDigits)+" ("+how+") | effective risk "+D2(lot*perLot));
       if(how=="FLOOR_STEP_TOO_COARSE")
          YLog("LOTCHAIN note: the broker lot step ("+DoubleToString(step,g_lotDigits)+") is too coarse for the requested growth; the lot stays and the ledger carries the shortfall until the next step fits within "+DoubleToString(InpRoundUpMaxOverPct,1)+"% over risk.");
      }
   }
   if(lot>vmax+1e-9)
     {
      r.code="RISK_ABOVE_MAX_VOLUME";
      r.text="Required volume "+DoubleToString(lot,g_lotDigits)+" exceeds the allowed maximum "+DoubleToString(vmax,g_lotDigits)+" (broker max / Max Lot cap). WAITING_VOLUME - safety limit: the lot is NOT forced higher.";
      return false;
     }
   if(lim>0.0)
     {
      double ex=DirVolume(buy);
      if(ex+lot>lim+1e-9)
        {
         r.code="RISK_ABOVE_VOLUME_LIMIT";
         r.text="Volume limit: open+pending "+DoubleToString(ex,g_lotDigits)+" + new "+DoubleToString(lot,g_lotDigits)+" > broker limit "+DoubleToString(lim,g_lotDigits)+". WAITING_VOLUME.";
         return false;
        }
     }
   //--- v2.35 FINAL-SIZE CAPS: the safety caps are judged on the risk of the FINAL (rounded) lot, not on the requested risk.
   //--- Recovery round-up (InpRecoveryRoundUp) or CLAMP_TO_MIN can make lot*perLot exceed the requested risk, and RecoveryGuardBlocks()
   //--- only sees the request (g_curRisk). Both caps are 0 = OFF by default, so default behaviour is unchanged.
   if(InpMaxRiskPctBal>0.0)
     {
      double balF=AcM(AccountInfoDouble(ACCOUNT_BALANCE));
      double capF=(balF>0.0)?balF*InpMaxRiskPctBal/100.0:0.0;
      if(lot*perLot>capF+1e-9)
        {
         r.code="RISK_ABOVE_RISKCAP";
         r.text="Final lot "+DoubleToString(lot,g_lotDigits)+" risks "+D2(lot*perLot)+" "+ccy+" at the SL, above "+DoubleToString(InpMaxRiskPctBal,2)+"% of the balance ("+D2(capF)+" "+ccy+"). WAITING_RISKCAP: no order is sent.";
         return false;
        }
     }
   if(InpMaxAccLoss>0.0 && g_accLoss>1e-9 && g_accLoss+lot*perLot>InpMaxAccLoss+1e-9)
     {
      r.code="RISK_ABOVE_ACCCAP";
      r.text="Final lot "+DoubleToString(lot,g_lotDigits)+": accumulated loss "+D2(g_accLoss)+" + loss at SL "+D2(lot*perLot)+" "+ccy+" would exceed the cap "+D2(InpMaxAccLoss)+" "+ccy+". WAITING_ACCLOSSCAP: no order is sent.";
      return false;
     }
   //--- v2.36 FINAL-SIZE CAPS (absolute $ per trade, daily loss): same discipline - judged on the risk of the FINAL lot
   if(InpMaxRiskUSD>0.0 && lot*perLot>InpMaxRiskUSD+1e-9)
     {
      r.code="RISK_ABOVE_RISKCAP";
      r.text="Final lot "+DoubleToString(lot,g_lotDigits)+" risks "+D2(lot*perLot)+" "+ccy+" at the SL, above the per-trade cap "+D2(InpMaxRiskUSD)+" "+ccy+". WAITING_RISKCAP: no order is sent (the lot is NOT forced, the target is NOT widened).";
      return false;
     }
   if(InpMaxDailyLoss>0.0)
     {
      double dn=DayNetToday();
      double dayLoss=(dn<0.0)?-dn:0.0;
      if(dayLoss+lot*perLot>InpMaxDailyLoss+1e-9)
        {
         r.code="RISK_ABOVE_DAYLOSS";
         r.text="Daily loss limit: today's realized loss "+D2(dayLoss)+" + loss at SL of the final lot "+D2(lot*perLot)+" "+ccy+" would exceed "+D2(InpMaxDailyLoss)+" "+ccy+". WAITING_DAYLOSS until the next server day.";
         return false;
        }
     }
   r.vol=lot;
   r.effective=lot*perLot;
   double margin=0.0;
   ENUM_ORDER_TYPE ot=buy?ORDER_TYPE_BUY:ORDER_TYPE_SELL;
   if(OrderCalcMargin(ot,g_sym,lot,entry,margin))
     {
      margin=AcM(margin);
      r.margin=margin;
      if(margin>AcM(AccountInfoDouble(ACCOUNT_MARGIN_FREE)))
        {
         r.code="RISK_NO_MARGIN";
         r.text="Not enough free margin: required "+D2(margin)+" "+ccy+", free "+D2(AcM(AccountInfoDouble(ACCOUNT_MARGIN_FREE)))+" "+ccy+". WAITING_MARGIN.";
         return false;
        }
     }
   r.valid=true;
   if(r.clamped)
      r.text="Minimum lot used: Requested Risk "+D2(risk)+" "+ccy+" -> Effective Risk "+D2(r.effective)+" "+ccy+" (lot "+DoubleToString(lot,g_lotDigits)+")";
   return true;
  }

//--- machine code -> WAITING_* state shown to the user (a volume/margin condition is a WAIT, never a fatal error)
string WaitCodeOf(const string rc)
  {
   if(rc=="RISK_BELOW_MIN_VOLUME" || rc=="RISK_ABOVE_MAX_VOLUME" || rc=="RISK_ABOVE_VOLUME_LIMIT") return "WAITING_VOLUME";
   if(rc=="RISK_NO_MARGIN") return "WAITING_MARGIN";
   if(rc=="RISK_ABOVE_RISKCAP") return "WAITING_RISKCAP";       // v2.35: cap judged on the FINAL lot
   if(rc=="RISK_ABOVE_ACCCAP") return "WAITING_ACCLOSSCAP";     // v2.35
   if(rc=="RISK_ABOVE_DAYLOSS") return "WAITING_DAYLOSS";        // v2.36
   if(rc=="RISK_NO_SPEC") return "WAITING_BROKER";
   return "";
  }

//--- live spread (Ask-Bid), not the possibly stale SYMBOL_SPREAD field
double LiveSpread()
  {
   MqlTick t;
   if(SymbolInfoTick(g_sym,t) && t.ask>0.0 && t.bid>0.0 && t.ask>=t.bid) return t.ask-t.bid;
   return (double)SymbolInfoInteger(g_sym,SYMBOL_SPREAD)*g_point;
  }

bool SpreadTooWide(string &why)
  {
   why="";
   if(InpMaxSpread<=0) return false;
   double sp=LiveSpread()/g_point;
   if(sp>(double)InpMaxSpread) { why="WAITING_SPREAD: spread "+DoubleToString(sp,0)+" pts > Max Spread "+IntegerToString(InpMaxSpread)+" pts (new orders wait; open trades are untouched)"; return true; }
   return false;
  }

//--- v2.24 Recovery Plan Guard: caps the risk-multiplication cycle (report recommendations 3 and 4).
//    It blocks ONLY the placement of NEW orders / a new market reversal. An open trade is never touched or closed.
bool RecoveryGuardBlocks(string &why,string &code)
  {
   why=""; code="";
   if(InpMaxSeqLosses>0 && g_accLoss>1e-9 && g_seq>=InpMaxSeqLosses)
     {
      code="WAITING_SEQCAP";
      why="WAITING_SEQCAP: "+IntegerToString(g_seq)+" consecutive losses reached the cap ("+IntegerToString(InpMaxSeqLosses)+"). Accumulated loss "+D2(g_accLoss)+" "+AccCcy()+" is KEPT (nothing is cleared). New orders are paused - raise or disable the cap (0 = off) to continue the same cycle; a New Cycle would clear the debt.";
      return true;
     }
   if(InpMaxRiskPctBal>0.0)
     {
      double bal=AcM(AccountInfoDouble(ACCOUNT_BALANCE));
      double cap=(bal>0.0)?bal*InpMaxRiskPctBal/100.0:0.0;
      if(g_curRisk>cap+1e-9)
        {
         code="WAITING_RISKCAP";
         why="WAITING_RISKCAP: the next planned risk "+D2(g_curRisk)+" "+AccCcy()+" is above "+DoubleToString(InpMaxRiskPctBal,2)+"% of the balance ("+D2(cap)+" "+AccCcy()+"). New orders are paused - start a New Cycle, raise the cap or add funds.";
         return true;
        }
     }
   //--- v2.36: absolute per-trade cap and daily loss limit on the REQUESTED risk (early, cheap). RiskCompute re-checks them on the FINAL lot.
   if(InpMaxRiskUSD>0.0 && g_curRisk>InpMaxRiskUSD+1e-9)
     {
      code="WAITING_RISKCAP";
      why="WAITING_RISKCAP: the next planned risk "+D2(g_curRisk)+" "+AccCcy()+" is above the per-trade cap "+D2(InpMaxRiskUSD)+" "+AccCcy()+". New orders are paused - start a New Cycle or raise the cap.";
      return true;
     }
   if(InpMaxDailyLoss>0.0)
     {
      double dn=DayNetToday();
      double dl=(dn<0.0)?-dn:0.0;
      if(dl+g_curRisk>InpMaxDailyLoss+1e-9)
        {
         code="WAITING_DAYLOSS";
         why="WAITING_DAYLOSS: today's realized loss "+D2(dl)+" + next risk "+D2(g_curRisk)+" would exceed the daily limit "+D2(InpMaxDailyLoss)+" "+AccCcy()+". New orders resume on the next server day; open trades are untouched.";
         return true;
        }
     }
   //--- v2.34: absolute cap on the accumulated loss of ONE cycle (the loss if the NEXT trade also stops out)
   if(InpMaxAccLoss>0.0 && g_accLoss>1e-9 && g_accLoss+g_curRisk>InpMaxAccLoss+1e-9)
     {
      code="WAITING_ACCLOSSCAP";
      why="WAITING_ACCLOSSCAP: accumulated loss "+D2(g_accLoss)+" + next risk "+D2(g_curRisk)+" would exceed the cap "+D2(InpMaxAccLoss)+" "+AccCcy()+". New orders are paused - start a New Cycle or raise the cap.";
      return true;
     }
   //--- v2.34: minimum Margin Level (only meaningful while margin is in use: MT5 reports 0 with no open position)
   if(InpMinMarginLevel>0.0)
     {
      double ml=AccountInfoDouble(ACCOUNT_MARGIN_LEVEL);
      if(ml>0.0 && ml<InpMinMarginLevel)
        {
         code="WAITING_MARGINLVL";
         why="WAITING_MARGINLVL: Margin Level "+DoubleToString(ml,1)+"% is below the minimum "+DoubleToString(InpMinMarginLevel,1)+"%. New orders are paused.";
         return true;
        }
     }
   //--- v2.34: one cycle per day - after a completed cycle no NEW cycle (no debt, no sequence) starts until the next server day
   if(InpOneCyclePerDay && CycFresh() && g_seq==0)
     {
      long dk=(long)GV("CYCDAY",0.0);
      if(dk>0 && dk==DayKeyNow())
        {
         code="WAITING_NEXTDAY";
         why="WAITING_NEXTDAY: today's cycle is complete (net target reached). The next cycle starts on the next server day (Reset / New Cycle from the Mini App overrides this).";
         return true;
        }
     }
   return false;
  }

//--- exact plan (same recurrence as NextRiskFor: risk = (accLoss + target) / RR; with target = RR = 20 the growth is exactly 5% per loss)
//--- v2.30: the recovery maths is (loss + target) / RR. Risk and Target are in ACCOUNT currency, so on a CENT account (USC/EUC) both must be scaled
//--- together (x100). If the target is too small for the risk, the risk after a loss would be SMALLER than the start risk (it shrinks instead of growing).
void RiskScaleAdvisory()
  {
   if(g_initRisk>0.0 && g_rr>1.0 && NextRiskFor(g_initRisk)<g_initRisk-1e-9)
     {
      string m="RISK_SCALE: Recovery Target "+D2(g_target)+" "+AccCcy()+" is too small for the start risk "+D2(g_initRisk)+" "+AccCcy()+": after a loss the next risk would be "+D2(NextRiskFor(g_initRisk))+" (SMALLER). Risk and Target must keep the ratio Target = "+D2(g_rr)+" x start risk (the standard 1 / 20). On a CENT account that reports a plain currency code set InpMoneyScale=100 instead of scaling by hand.";
      YLog(m);
      RaiseAlert("RISKSCALE",m,false,true);
     }
   else ClearAlert("RISKSCALE");
  }

void WritePlanTable(const string why);      // v2.34 (defined right after PrintRecoveryPlan)

void PrintRecoveryPlan()
  {
   RiskScaleAdvisory();
   if(!InpPlanLog) return;
   double L=0.0;
   string ccy=AccCcy();
   YLog("Recovery plan | start risk "+D2(g_initRisk)+" | target "+D2(g_target)+" | RR "+D2(g_rr)+" | cap seq "+(InpMaxSeqLosses>0?IntegerToString(InpMaxSeqLosses):"off")+" | cap risk% "+(InpMaxRiskPctBal>0.0?DoubleToString(InpMaxRiskPctBal,2):"off")+" | balance "+D2(AcM(AccountInfoDouble(ACCOUNT_BALANCE)))+" "+ccy);
   int last=(InpMaxSeqLosses>0)?InpMaxSeqLosses:20;
   for(int n=1;n<=last;n++)
     {
      double r=(n==1)?g_initRisk:NextRiskFor(L);
      L+=r;
      if(n<=5 || n==10 || n==15 || n==20 || n==last)
         YLog("  loss #"+IntegerToString(n)+": risk "+D2(r)+" | TP profit if it wins "+D2(r*g_rr)+" | cumulative loss "+D2(L));
     }
   YLog("  balance needed to survive "+IntegerToString(last)+" consecutive losses: >= "+D2(L)+" "+ccy+" (before spread/commission/margin).");
   WritePlanTable("start");
  }

//--- v2.34: the per-trade verification table of the report (section 10): trade #, risk, loss before, NET profit needed, lot, loss at SL, NET at TP,
//--- cumulative loss, margin required / available, status. Built from the LIVE broker specification and the saved levels; written to
//--- Yetimmm_<magic>_Plan.csv so it can be compared with an independent calculation. It never places or changes anything.
string PlanFile() { return "Yetimmm_"+IntegerToString(g_magic)+"_Plan.csv"; }

void WritePlanTable(const string why)
  {
   if(!InpPlanLog) return;
   if(g_buyLevel<=0.0 || g_sellLevel<=0.0 || g_buyLevel<=g_sellLevel || g_rr<=1.0) return;   // no valid pair of levels yet: a table is never invented
   double perLot=PerLotLoss(true,g_buyLevel);
   if(perLot<=0.0) return;
   double vmin=SymbolInfoDouble(g_sym,SYMBOL_VOLUME_MIN), vmax=SymbolInfoDouble(g_sym,SYMBOL_VOLUME_MAX), step=SymbolInfoDouble(g_sym,SYMBOL_VOLUME_STEP);
   if(step<=0.0) step=(vmin>0.0)?vmin:0.01;
   if(vmin<=0.0) vmin=step;
   if(InpMaxLot>0.0 && InpMaxLot<vmax) vmax=InpMaxLot;
   double cpl=CommPerLotEff();
   double perSz=SizingPerLot(perLot);
   double bal=AcM(AccountInfoDouble(ACCOUNT_BALANCE));
   double freeM=AcM(AccountInfoDouble(ACCOUNT_MARGIN_FREE));
   int last=(InpMaxSeqLosses>0)?InpMaxSeqLosses:20;
   if(last>80) last=80;
   int h=FileOpen(PlanFile(),FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_SHARE_READ);
   if(h==INVALID_HANDLE) { YLog("Plan table: cannot write "+PlanFile()+" (code "+IntegerToString(GetLastError())+")"); return; }
   FileWriteString(h,"Trade;Risk;LossBefore;NeededNetProfit;Lot;LossAtSL;NetAtTP;CumLossIfSL;MarginRequired;MarginFree;BalanceNeeded;Status\r\n");
   double L=0.0;
   int survive=-1;
   for(int n=1;n<=last;n++)
     {
      double risk=(n==1)?g_initRisk:NextRiskFor(L);
      double need=L+g_target;
      double raw=risk/perSz;
      double lot=0.0;
      string st="OK";
      if(raw<vmin-1e-9)
        {
         if(InpRiskPolicy==YT_RISK_CLAMP_MIN) { lot=vmin; st="CLAMPED_TO_MIN"; }
         else st="BELOW_MIN_VOLUME";
        }
      else
        {
         string how2="";
         lot=QuantizeLot(raw,vmin,step,risk,perSz,(L>1e-9),how2);
        }
      lot=NormalizeDouble(lot,g_lotDigits);
      if(lot>vmax+1e-9) { st="ABOVE_MAX_VOLUME"; }
      double lossSL=(lot>0.0)?lot*(perLot+cpl):risk;
      double netTP =(lot>0.0)?lot*(perLot*g_rr-cpl):0.0;
      double marg=0.0;
      if(lot>0.0 && OrderCalcMargin(ORDER_TYPE_BUY,g_sym,lot,g_buyLevel,marg)) marg=AcM(marg); else marg=0.0;
      if(st=="OK" && lot>0.0 && netTP<need*0.98-1e-9) st="NET_SHORTFALL";
      bool balLow=(bal<L+marg-1e-9);
      if(balLow && survive<0) survive=n-1;
      if(st=="OK" && balLow) st="BALANCE_LOW";
      FileWriteString(h,IntegerToString(n)+";"+D2(risk)+";"+D2(L)+";"+D2(need)+";"+LotS(lot)+";"+D2(lossSL)+";"+D2(netTP)+";"+D2(L+lossSL)+";"+D2(marg)+";"+D2(freeM)+";"+D2(L+marg)+";"+st+"\r\n");
      L+=lossSL;
     }
   FileClose(h);
   YLog("Plan table ("+why+") written to MQL5/Files: "+PlanFile()+" | "+IntegerToString(last)+" rows | commission/lot used "+D2(cpl)+" | loss/lot "+D2(perLot)+" | "+
        (survive<0?"the current balance "+D2(bal)+" covers all "+IntegerToString(last)+" rows":"the current balance "+D2(bal)+" covers only "+IntegerToString(survive)+" consecutive losses (before spread)"));
  }

//--- minimum width of a Buy Stop / Sell Stop PAIR at the live market: both must sit outside their Stops Level
double PairMinWidth()
  {
   double sl=(double)SymbolInfoInteger(g_sym,SYMBOL_TRADE_STOPS_LEVEL)*g_point;
   return 2.0*sl+LiveSpread();
  }

//--- pending order lifetime allowed by the symbol (GTC when permitted)
ENUM_ORDER_TYPE_TIME PendingTimeType(datetime &expir)
  {
   expir=0;
   long m=SymbolInfoInteger(g_sym,SYMBOL_EXPIRATION_MODE);
   if((m&SYMBOL_EXPIRATION_GTC)!=0) return ORDER_TIME_GTC;
   if((m&SYMBOL_EXPIRATION_DAY)!=0) return ORDER_TIME_DAY;
   if((m&SYMBOL_EXPIRATION_SPECIFIED)!=0) { expir=TimeCurrent()+7*86400; return ORDER_TIME_SPECIFIED; }
   if((m&SYMBOL_EXPIRATION_SPECIFIED_DAY)!=0) { expir=TimeCurrent()+7*86400; return ORDER_TIME_SPECIFIED_DAY; }
   return ORDER_TIME_GTC;
  }

//--- server pre-flight of a pending order. Returns true = send it. Only well-understood refusals stop the send (everything else is left to OrderSend).
//--- out: code = WAITING_* , why = text, coolMs = retry delay
bool PendingOrderCheck(const bool buy,const double lot,const double level,const double slp,const double tpp,string &code,string &why,ulong &coolMs)
  {
   code=""; why=""; coolMs=0;
   if(!InpOrderCheck || MQLInfoInteger(MQL_TESTER)) return true;
   MqlTradeRequest rq; MqlTradeCheckResult ck;
   ZeroMemory(rq); ZeroMemory(ck);
   datetime ex; ENUM_ORDER_TYPE_TIME tt=PendingTimeType(ex);
   rq.action=TRADE_ACTION_PENDING; rq.symbol=g_sym; rq.volume=lot;
   rq.type=buy?ORDER_TYPE_BUY_STOP:ORDER_TYPE_SELL_STOP;
   rq.price=level; rq.sl=slp; rq.tp=tpp; rq.type_time=tt; rq.expiration=ex;
   rq.type_filling=ORDER_FILLING_RETURN; rq.magic=(ulong)g_magic; rq.comment="Yetimmm"; rq.deviation=(ulong)g_maxDev;
   ResetLastError();
   bool okc=OrderCheck(rq,ck);
   uint rc=ck.retcode;
   if(okc && (rc==0 || rc==TRADE_RETCODE_DONE || rc==TRADE_RETCODE_PLACED)) return true;
   YLog("OrderCheck "+(buy?"BUY STOP":"SELL STOP")+" "+PX(level)+" lot "+DoubleToString(lot,g_lotDigits)+" -> retcode "+IntegerToString((int)rc)+" ("+ck.comment+")");
   if(rc==TRADE_RETCODE_INVALID_VOLUME) { code="WAITING_VOLUME"; why="The broker refuses this volume right now (min "+DoubleToString(SymbolInfoDouble(g_sym,SYMBOL_VOLUME_MIN),g_lotDigits)+", step "+DoubleToString(SymbolInfoDouble(g_sym,SYMBOL_VOLUME_STEP),g_lotDigits)+")."; coolMs=30000; return false; }
   if(rc==TRADE_RETCODE_NO_MONEY) { code="WAITING_MARGIN"; why="Not enough margin according to the server."; coolMs=15000; return false; }
   if(rc==TRADE_RETCODE_MARKET_CLOSED) { code="WAITING_MARKET"; why="Market is closed."; coolMs=30000; return false; }
   if(rc==TRADE_RETCODE_TRADE_DISABLED) { code="WAITING_BROKER"; why="Trading is currently disabled by the server."; coolMs=30000; return false; }
   if(rc==TRADE_RETCODE_INVALID_STOPS || rc==TRADE_RETCODE_INVALID_PRICE) { code="WAITING_PRICE"; why="The server refuses the price/stops at this moment - waiting for the market."; coolMs=3000; return false; }
   return true;     // unknown / filling-mode / transport code: the real OrderSend decides
  }

//--- Risk Amount -> Lot, using real broker specifications (explicit entry AND explicit SL)
bool CalcLotSL(const double risk,const bool buy,const double entry,const double sl,double &lot,double &estLoss,string &err)
  {
   lot=0.0; estLoss=0.0; err="";
   SRiskResult r;
   bool ok=RiskCompute(risk,buy,entry,sl,r);
   g_rk=r;
   g_riskCode=r.code;
   if(!ok) { err=r.text; return false; }
   lot=r.vol;
   estLoss=r.effective;
   return true;
  }

//--- stop-order sizing: SL = the opposite level
bool CalcLot(const double risk,const bool buy,const double entry,double &lot,double &estLoss,string &err)
  {
   return CalcLotSL(risk,buy,entry,SLPrice(buy,entry),lot,estLoss,err);
  }

//--- PRE-FLIGHT of a MARKET order against the REAL prices (the same discipline PlacementState applies to pending orders):
//--- trading allowed for the direction, SL and TP present, on the correct side of the market, outside the broker Stops Level
bool MarketPreflight(const bool buy,const double sl,const double tp,string &why)
  {
   why="";
   MqlTick t;
   if(!SymbolInfoTick(g_sym,t) || t.ask<=0.0 || t.bid<=0.0) { why="No market prices"; return false; }
   long tm=SymbolInfoInteger(g_sym,SYMBOL_TRADE_MODE);
   if(tm==SYMBOL_TRADE_MODE_DISABLED || tm==SYMBOL_TRADE_MODE_CLOSEONLY) { why="Trading is disabled for this symbol"; return false; }
   if(tm==SYMBOL_TRADE_MODE_LONGONLY && !buy)  { why="Only long trades are allowed on this symbol"; return false; }
   if(tm==SYMBOL_TRADE_MODE_SHORTONLY && buy)  { why="Only short trades are allowed on this symbol"; return false; }
   if((SymbolInfoInteger(g_sym,SYMBOL_ORDER_MODE) & SYMBOL_ORDER_MARKET)==0) { why="Market orders are not allowed on this symbol"; return false; }
   if(!MathIsValidNumber(sl) || !MathIsValidNumber(tp) || sl<=0.0 || tp<=0.0) { why="SL/TP could not be computed"; return false; }
   double stopsLvl=(double)SymbolInfoInteger(g_sym,SYMBOL_TRADE_STOPS_LEVEL)*g_point;
   if(buy)
     {
      if(sl>=t.bid)                          why="SL "+PX(sl)+" is not below the Bid "+PX(t.bid);
      else if(t.bid-sl<stopsLvl-1e-9)        why="SL "+PX(sl)+" is inside the Stops Level ("+PX(stopsLvl)+")";
      else if(tp<=t.bid)                     why="TP "+PX(tp)+" is not above the Bid "+PX(t.bid);
      else if(tp-t.bid<stopsLvl-1e-9)        why="TP "+PX(tp)+" is inside the Stops Level ("+PX(stopsLvl)+")";
     }
   else
     {
      if(sl<=t.ask)                          why="SL "+PX(sl)+" is not above the Ask "+PX(t.ask);
      else if(sl-t.ask<stopsLvl-1e-9)        why="SL "+PX(sl)+" is inside the Stops Level ("+PX(stopsLvl)+")";
      else if(tp>=t.ask)                     why="TP "+PX(tp)+" is not below the Ask "+PX(t.ask);
      else if(t.ask-tp<stopsLvl-1e-9)        why="TP "+PX(tp)+" is inside the Stops Level ("+PX(stopsLvl)+")";
     }
   return (why=="");
  }

string ValidateRisk(const double r)
  {
   if(!MathIsValidNumber(r) || r<=0.0) return "Initial Risk must be greater than zero.";
   return "";
  }

string ValidateLevels(const double buy,const double sell)
  {
   if(!MathIsValidNumber(buy) || !MathIsValidNumber(sell) || buy<=0.0 || sell<=0.0) return "Prices must be positive numbers.";
   if(MathAbs(buy-sell)<(g_tick>0.0?g_tick/2.0:g_point/2.0)) return "Buy Stop and Sell Stop must not be equal.";
   if(buy<sell) return "Buy Stop must be higher than Sell Stop.";
   if(MathAbs(buy-NP(buy))>1e-9 || MathAbs(sell-NP(sell))>1e-9) return "Prices have more decimals than the symbol allows.";
   if(g_tick>0.0)
     {
      double q1=buy/g_tick, q2=sell/g_tick;
      if(MathAbs(q1-MathRound(q1))>1e-3 || MathAbs(q2-MathRound(q2))>1e-3) return "Prices must be multiples of the tick size ("+DoubleToString(g_tick,g_digits)+").";
     }
   if(buy-sell<InpMinLevelGap-1e-9) return "Distance between levels is below the minimum gap ("+D2(InpMinLevelGap)+").";
   long tm=SymbolInfoInteger(g_sym,SYMBOL_TRADE_MODE);
   if(tm==SYMBOL_TRADE_MODE_DISABLED || tm==SYMBOL_TRADE_MODE_CLOSEONLY) return "Trading is disabled for this symbol.";
   double stopsLvl=(double)SymbolInfoInteger(g_sym,SYMBOL_TRADE_STOPS_LEVEL)*g_point;
   if(buy-sell<stopsLvl-1e-9) return "Distance between the levels (= Stop Loss) is below the broker minimum stops level.";
   if(YT_REAL_ORDERS_ONLY || InpEntryMode==ENTRY_PENDING)
     {
      double need=PairMinWidth();
      if(buy-sell<need-1e-9)
         return "PAIR_NOT_EXECUTABLE: a Buy Stop and a Sell Stop can never exist together at this width. Minimum width now = "+DoubleToString(need,g_digits)+" (2 x Stops Level + live spread).";
     }
   return "";
  }

//+------------------------------------------------------------------+
//| Own positions / orders                                           |
//+------------------------------------------------------------------+
int OwnPositions(ulong &tk[])
  {
   ArrayResize(tk,0);
   int n=PositionsTotal();
   for(int i=0;i<n;i++)
     {
      ulong t=PositionGetTicket(i);
      if(t==0) continue;
      if(PositionGetString(POSITION_SYMBOL)!=g_sym) continue;
      if((long)PositionGetInteger(POSITION_MAGIC)!=g_magic) continue;
      int k=ArraySize(tk);
      ArrayResize(tk,k+1);
      tk[k]=t;
     }
   return ArraySize(tk);
  }

int OwnOrders(ulong &tk[])
  {
   ArrayResize(tk,0);
   int n=OrdersTotal();
   for(int i=0;i<n;i++)
     {
      ulong t=OrderGetTicket(i);
      if(t==0) continue;
      if(OrderGetString(ORDER_SYMBOL)!=g_sym) continue;
      if((long)OrderGetInteger(ORDER_MAGIC)!=g_magic) continue;
      int k=ArraySize(tk);
      ArrayResize(tk,k+1);
      tk[k]=t;
     }
   return ArraySize(tk);
  }

//--- find a live position by its identifier and leave it selected
bool FindLive(const ulong pid,ulong &ticket)
  {
   int n=PositionsTotal();
   for(int i=0;i<n;i++)
     {
      ulong t=PositionGetTicket(i);
      if(t==0) continue;
      if((ulong)PositionGetInteger(POSITION_IDENTIFIER)==pid) { ticket=t; return true; }
     }
   return false;
  }

//+------------------------------------------------------------------+
//| Real-ticket tracking: ticket + last snapshot verified on server  |
//+------------------------------------------------------------------+
void TrkStore(const int s)
  {
   string i=IntegerToString(s);
   GS("TKT"+i,(double)g_stopTicket[s]);
   GS("TKP"+i,g_snapPx[s]);
   GS("TKS"+i,g_snapSL[s]);
   GS("TKQ"+i,g_snapTP[s]);
   GS("TKV"+i,g_snapVol[s]);
  }

void TrkLoad()
  {
   for(int s=0;s<2;s++)
     {
      string i=IntegerToString(s);
      g_stopTicket[s]=(ulong)GV("TKT"+i,0.0);
      g_snapPx[s]=GV("TKP"+i,0.0);
      g_snapSL[s]=GV("TKS"+i,0.0);
      g_snapTP[s]=GV("TKQ"+i,0.0);
      g_snapVol[s]=GV("TKV"+i,0.0);
     }
  }

void TrkDrop(const int s)
  {
   g_stopTicket[s]=0;
   g_snapPx[s]=0.0; g_snapSL[s]=0.0; g_snapTP[s]=0.0; g_snapVol[s]=0.0;
   g_missMs[s]=0;
   TrkStore(s);
  }

void TrkDropTicket(const ulong ticket)
  {
   for(int s=0;s<2;s++)
      if(g_stopTicket[s]==ticket) TrkDrop(s);
  }

//--- the baseline = what the server REALLY holds for this ticket right now
bool TrkTake(const bool buy,const ulong ticket)
  {
   if(ticket==0 || !OrderSelect(ticket)) return false;
   int s=buy?0:1;
   g_stopTicket[s]=ticket;
   g_snapPx[s]=OrderGetDouble(ORDER_PRICE_OPEN);
   g_snapSL[s]=OrderGetDouble(ORDER_SL);
   g_snapTP[s]=OrderGetDouble(ORDER_TP);
   g_snapVol[s]=OrderGetDouble(ORDER_VOLUME_CURRENT);
   g_missMs[s]=0;
   TrkStore(s);
   return true;
  }

//--- outside Armed states nothing is tracked or held any more
void TrkPrune()
  {
   for(int s=0;s<2;s++)
     {
      g_hold[s]=false;
      g_missMs[s]=0;
      if(g_stopTicket[s]!=0 && !OrderSelect(g_stopTicket[s])) TrkDrop(s);
     }
  }

//--- v2.40 ARM TIMELINE data (declared early: DeleteOrder / ReconcileSide use it; the watchers are defined with the ledger block)
struct SArmTL
  {
   ulong  ticket;
   double level;
   double lot;
   bool   rev;
   ulong  armMs;        // accepted + verified on the server
   ulong  verMs;        // last time the server still showed exactly this order
   ulong  touchMs;      // first tick that reached the trigger (client side)
   double touchBid;
   double touchAsk;
   bool   presentAtTouch;
  };
SArmTL g_arm[2];
void ArmDrop(const int s)
  {
   g_arm[s].ticket=0; g_arm[s].touchMs=0; g_arm[s].presentAtTouch=false; g_arm[s].rev=false;
  }

void ArmNote(const bool buy,const ulong ticket,const double level,const double lot,const bool rev)
  {
   const int s=buy?0:1;
   g_arm[s].ticket=ticket; g_arm[s].level=level; g_arm[s].lot=lot; g_arm[s].rev=rev;
   g_arm[s].armMs=GetTickCount64(); g_arm[s].verMs=g_arm[s].armMs;
   g_arm[s].touchMs=0; g_arm[s].touchBid=0.0; g_arm[s].touchAsk=0.0; g_arm[s].presentAtTouch=false;
  }

void ArmDropTicket(const ulong ticket)
  {
   for(int s=0;s<2;s++)
      if(g_arm[s].ticket==ticket) ArmDrop(s);
  }

//--- v2.40: has the market already reached the trigger of this pending Stop order?
bool OrderTriggeredNow(const long type,const double price)
  {
   MqlTick t;
   if(!SymbolInfoTick(g_sym,t) || t.ask<=0.0 || t.bid<=0.0) return false;
   if(type==(long)ORDER_TYPE_BUY_STOP)  return (t.ask>=price);
   if(type==(long)ORDER_TYPE_SELL_STOP) return (t.bid<=price);
   return false;
  }

bool g_delFilled=false;   // set by DeleteOrder when the order was NOT deleted because MT5 filled it

bool DeleteOrder(const ulong ticket,const string reason)
  {
   g_delFilled=false;
   double price=0.0,vol=0.0; long type=-1;
   if(OrderSelect(ticket))
     {
      price=OrderGetDouble(ORDER_PRICE_OPEN);
      vol=OrderGetDouble(ORDER_VOLUME_CURRENT);
      type=OrderGetInteger(ORDER_TYPE);
     }
   if(!InstOkTrade("delete order #"+UL(ticket))) return false;
   //--- v2.40: the pre-armed reverse order that the market has JUST triggered is being executed by the server: a delete request would race the execution.
   //--- Skipped for at most 5 s (then the normal path applies); the next synchronisation sees the position.
   if(type>=0 && (ulong)GV("PAO",0.0)==ticket && OrderTriggeredNow(type,price))
     {
      static ulong trgTk=0, trgMs=0;
      ulong nw=GetTickCount64();
      if(trgTk!=ticket) { trgTk=ticket; trgMs=nw; }
      if(nw-trgMs<5000)
        {
         LogOrder("DELETE_SKIPPED_TRIGGERED",type,price,vol,ticket,0,reason+" | the market has triggered this order - not deleted while the server executes it");
         g_dirty=true;
         return false;
        }
     }
   bool r=g_trade.OrderDelete(ticket);
   uint rc=g_trade.ResultRetcode();
   bool ok=(r && (rc==TRADE_RETCODE_DONE || rc==TRADE_RETCODE_PLACED));
   if(ok)
     {
      //--- a successful call is not enough: the order must really be gone from the server
      for(int w=0;w<6 && OrderSelect(ticket);w++) Sleep(60);
      if(OrderSelect(ticket)) ok=false;
     }
   string ev=ok?"DELETED":"DELETE_FAILED";
   string why=reason;
   if(!ok && !OrderSelect(ticket))
     {
      //--- the ticket vanished although our delete did not succeed: a vanished order is NOT automatically a deleted order
      bool inH=false;
      for(int w=0;w<5 && !(inH=HistoryOrderSelect(ticket));w++) Sleep(60);
      long hs=inH?HistoryOrderGetInteger(ticket,ORDER_STATE):-1;
      if(inH && (hs==ORDER_STATE_FILLED || hs==ORDER_STATE_PARTIAL))
        {
         g_delFilled=true;
         TrkDropTicket(ticket);
         LogOrder("FILLED_BEFORE_DELETE",type,price,vol,ticket,rc,reason+" | order was FILLED by MT5, a position exists");
         YLog("Order #"+UL(ticket)+" was FILLED before it could be deleted - NOT reported as deleted ("+reason+")");
         g_dirty=true;
         return false;
        }
      ok=true;
      if(inH && hs==ORDER_STATE_EXPIRED)       { ev="EXPIRED";  why=reason+" | expired on the server"; }
      else if(inH && hs==ORDER_STATE_CANCELED) { ev="DELETED";  why=reason+" | cancelled (confirmed by history)"; }
      else if(!inH)                            { ev="DELETED_UNCONFIRMED"; why=reason+" | gone from the server, history not available yet"; }
     }
   if(ok) { TrkDropTicket(ticket); ArmDropTicket(ticket); }
   LogOrder(ev,type,price,vol,ticket,rc,why);
   YLog((ok?"Order "+ev+" #":"Order Delete FAILED #")+UL(ticket)+" ("+why+")");
   return ok;
  }

//+------------------------------------------------------------------+
//| Desired State / Actual State synchronisation                     |
//| DESIRED = what the bot wants on the server (level, SL, TP, lot)  |
//| ACTUAL  = what the server really holds                           |
//| Reconcile compares both per side and sends the smallest request: |
//| KEEP / MODIFY (same ticket) / CREATE / REMOVE                    |
//+------------------------------------------------------------------+
int SideIdx(const bool buy) { return buy?0:1; }
string SideName(const bool buy) { return buy?"BUY STOP":"SELL STOP"; }

string SyncText(const int st)
  {
   switch(st)
     {
      case YS_SYNCED:   return "SYNCED";
      case YS_PLACED:   return "PLACED";
      case YS_UPDATING: return "MODIFYING...";
      case YS_CREATING: return "PLACING...";
      case YS_REMOVING: return "REMOVING...";
      case YS_REMOVED:  return "REMOVED";
      case YS_FILLED:   return "FILLED";
      case YS_MISSING:  return "MISSING";
      case YS_EXTERNAL: return "EXTERNAL CHANGE";
      case YS_FAILED:   return "FAILED";
      case YS_WAITING:  return "NOT PLACED";
     }
   return "IDLE";
  }

color SyncColor(const int st)
  {
   switch(st)
     {
      case YS_SYNCED:   return clrLime;
      case YS_PLACED:   return clrSpringGreen;
      case YS_UPDATING: return clrDeepSkyBlue;
      case YS_CREATING: return clrDeepSkyBlue;
      case YS_REMOVING: return clrOrange;
      case YS_REMOVED:  return clrOrange;
      case YS_FILLED:   return clrAqua;
      case YS_MISSING:  return clrTomato;
      case YS_EXTERNAL: return clrGold;
      case YS_FAILED:   return clrTomato;
      case YS_WAITING:  return clrGold;
     }
   return clrSilver;
  }

void SetSync(const bool buy,const int st,const string msg="")
  {
   int s=SideIdx(buy);
   g_sync[s]=st;
   g_syncMsg[s]=msg;
  }

void PanelMsg(const string txt,const color c=clrSilver)
  {
   g_uiMsg=txt;
   g_uiMsgCol=c;
  }

//--- is a pending order wanted on this side right now, and at which level?
bool SideDesired(const bool buy,double &level)
  {
   level=buy?g_buyLevel:g_sellLevel;
   if(g_revSide>=0 && (g_state==YT_BUY_ACTIVE || g_state==YT_SELL_ACTIVE) && SideIdx(buy)==g_revSide) return (level>0.0);   // v2.37: the pre-armed reverse order
   if(g_state!=YT_ARMED && g_state!=YT_WAITING_REENTRY) return false;
   if(g_mode==YM_NONE) return false;
   bool need=buy?(g_mode==YM_BOTH || g_mode==YM_BUY):(g_mode==YM_BOTH || g_mode==YM_SELL);
   return (need && level>0.0);
  }

//--- the real pending order of this side on the server (first match)
//--- THE canonical ticket of a side (single source of truth for panel AND reconcile):
//--- 1) the tracked ticket, 2) an order at the desired price, 3) the lowest ticket (deterministic)
ulong CanonicalTicket(const bool buy,const double level)
  {
   int s=SideIdx(buy);
   long want=buy?(long)ORDER_TYPE_BUY_STOP:(long)ORDER_TYPE_SELL_STOP;
   ulong tk=g_stopTicket[s];
   if(tk!=0 && OrderSelect(tk) && OrderGetInteger(ORDER_TYPE)==want &&
      OrderGetString(ORDER_SYMBOL)==g_sym && (long)OrderGetInteger(ORDER_MAGIC)==g_magic) return tk;
   ulong od[];
   int n=OwnOrders(od);
   ulong best=0; bool bestExact=false;
   for(int i=0;i<n;i++)
     {
      if(!OrderSelect(od[i])) continue;
      if(OrderGetInteger(ORDER_TYPE)!=want) continue;
      bool ex=(level>0.0 && PriceEq(OrderGetDouble(ORDER_PRICE_OPEN),level));
      if(best==0 || (ex && !bestExact) || (ex==bestExact && od[i]<best)) { best=od[i]; bestExact=ex; }
     }
   return best;
  }

bool SideActual(const bool buy,ulong &ticket,double &price)
  {
   ticket=0; price=0.0;
   ulong t=CanonicalTicket(buy,buy?g_buyLevel:g_sellLevel);
   if(t==0 || !OrderSelect(t)) return false;
   ticket=t;
   price=OrderGetDouble(ORDER_PRICE_OPEN);
   return true;
  }

//--- status for the panel: SYNCED is only shown when the server really holds the desired order
int SideStatusShown(const bool buy)
  {
   int s=SideIdx(buy);
   double lvl;
   ulong tk; double ap;
   bool have=SideActual(buy,tk,ap);
   if(!SideDesired(buy,lvl))
     {
      if(!have)
        {
         int ls=g_sync[s];
         return (ls==YS_FILLED || ls==YS_REMOVED)?ls:YS_IDLE;
        }
      return (g_sync[s]==YS_FAILED)?YS_FAILED:YS_REMOVING;
     }
   int st=g_sync[s];
   if(st==YS_IDLE) return YS_WAITING;
   if(st==YS_SYNCED || st==YS_PLACED)
     {
      if(!have) return YS_CREATING;
      if(!PriceEq(ap,lvl)) return YS_UPDATING;
     }
   return st;
  }

string SyncSummary()
  {
   string s="";
   for(int k=0;k<2;k++)
     {
      bool b=(k==0);
      double l;
      if(!SideDesired(b,l)) continue;
      if(s!="") s+=" | ";
      int st=SideStatusShown(b);
      ulong stk; double sap;
      s+=(b?"BUY ":"SELL ")+PX(l)+" "+SyncText(st);
      if(SideActual(b,stk,sap)) s+=" #"+UL(stk);
      if((st==YS_FAILED || st==YS_WAITING || st==YS_MISSING || st==YS_EXTERNAL) && StringLen(g_syncMsg[k])>0) s+=" ("+g_syncMsg[k]+")";
     }
   if(s=="") s="no pending order desired";
   return s;
  }

//--- a user action (APPLY / START) always gets a fresh attempt
void ResetSyncBackoff()
  {
   for(int k=0;k<2;k++)
     {
      g_retryMs[k]=0; g_failCnt[k]=0; g_failLvl[k]=0.0; g_unconf[k]=false;
      g_hold[k]=false; g_missMs[k]=0; g_guardMs[k]=0;      // a user action releases every hold
     }
   g_nextDelMs=0;
  }

bool TradingAllowedNow(string &why)
  {
   why="";
   if(!g_connected) why="No connection to the trade server";
   else if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED)) why="AutoTrading is disabled";
   else if(!AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) || !AccountInfoInteger(ACCOUNT_TRADE_EXPERT)) why="Trading not allowed on this account";
   return (why=="");
  }

//--- v2.16: classification of a stop-order price.
//---   0 = can be placed right now
//---   1 = the level itself is fine, but the MARKET is on the wrong side of it / too close (Stops Level): the order WAITS for the price
//---   2 = can never be placed as entered (bad price / tick, symbol rules): rejected
int PlacementState(const bool buy,const double price,string &why)
  {
   why="";
   if(!MathIsValidNumber(price) || price<=0.0) { why="Invalid price"; return 2; }
   double tkSz=(g_tick>0.0)?g_tick:g_point;
   if(MathAbs(price-RoundTick(price))>tkSz*1e-3) { why="Price is not a multiple of the tick size"; return 2; }
   long tm=SymbolInfoInteger(g_sym,SYMBOL_TRADE_MODE);
   if(tm==SYMBOL_TRADE_MODE_DISABLED || tm==SYMBOL_TRADE_MODE_CLOSEONLY) { why="Trading is disabled for this symbol"; return 2; }
   if(tm==SYMBOL_TRADE_MODE_LONGONLY && !buy)  { why="Only long trades are allowed on this symbol"; return 2; }
   if(tm==SYMBOL_TRADE_MODE_SHORTONLY && buy)  { why="Only short trades are allowed on this symbol"; return 2; }
   if((SymbolInfoInteger(g_sym,SYMBOL_ORDER_MODE) & SYMBOL_ORDER_STOP)==0) { why="Stop orders are not allowed on this symbol"; return 2; }
   MqlTick t;
   if(!SymbolInfoTick(g_sym,t) || t.ask<=0.0 || t.bid<=0.0) { why="No market prices"; return 1; }
   double stopsLvl=(double)SymbolInfoInteger(g_sym,SYMBOL_TRADE_STOPS_LEVEL)*g_point;
   if(buy)
     {
      if(price<=t.ask) { why="Buy Stop must be above the Ask ("+PX(t.ask)+")"; return 1; }
      if(price-t.ask<stopsLvl-1e-9) { why="too close to market (Stops Level "+PX(stopsLvl)+")"; return 1; }
     }
   else
     {
      if(price>=t.bid) { why="Sell Stop must be below the Bid ("+PX(t.bid)+")"; return 1; }
      if(t.bid-price<stopsLvl-1e-9) { why="too close to market (Stops Level "+PX(stopsLvl)+")"; return 1; }
     }
   return 0;
  }

void BrWaitActivated(const bool buy,const double level,const ulong ticket,const ulong latMs=0);   // v2.17 (defined with the Mini App command log)
double WaitLevelNow(const bool buy);                       // v2.45.1: defined with the Mini App command log (used by the Telegram order list)
string ExecDeleteOrder(const ulong ticket,const string src);   // v2.45.1: defined below (used by /del)
string ExecDeleteLevel(const bool isBuy,const string src);     // v2.45.1: defined below (used by /del)

//--- v2.17: distance (broker minimum + learned safety buffer) between the market and a waiting level, and the resulting TRIGGER price
double WaitGap(const bool buy)
  {
   double stopsLvl=(double)SymbolInfoInteger(g_sym,SYMBOL_TRADE_STOPS_LEVEL)*g_point;
   return MathMax(stopsLvl,(g_tick>0.0)?g_tick:g_point)+g_waitBuf[SideIdx(buy)];
  }

double WaitTrigger(const bool buy,const double level)
  {
   double gap=WaitGap(buy);
   return buy?NP(level-gap):NP(level+gap);
  }

//--- v2.16: what a waiting level needs from the market (shown on the panel, in Telegram and in the Mini App)
string WaitText(const bool buy,const double level)
  {
   MqlTick t;
   if(!SymbolInfoTick(g_sym,t) || t.ask<=0.0 || t.bid<=0.0) return SideName(buy)+" "+PX(level)+" waits for market prices";
   if(buy)
      return "BUY STOP "+PX(level)+" waits for the price: Ask "+PX(t.ask)+" must fall to "+PX(WaitTrigger(true,level))+" or lower, then it is placed automatically";
   return "SELL STOP "+PX(level)+" waits for the price: Bid "+PX(t.bid)+" must rise to "+PX(WaitTrigger(false,level))+" or higher, then it is placed automatically";
  }

//--- a pending order that is within the Freeze Level of the market can be neither modified nor deleted
bool FrozenNow(const bool buy,const double orderPrice)
  {
   double fz=(double)SymbolInfoInteger(g_sym,SYMBOL_TRADE_FREEZE_LEVEL)*g_point;
   if(fz<=0.0) return false;
   MqlTick t;
   if(!SymbolInfoTick(g_sym,t)) return false;
   return buy?(orderPrice-t.ask<=fz+1e-9):(t.bid-orderPrice<=fz+1e-9);
  }

//--- APPLY pre-check = broker rules BEFORE anything is sent: a request that cannot become a real order is rejected with the reason
string CheckApplicableCore(const double buy,const double sell,const double risk)
  {
   string why;
   if(!TradingAllowedNow(why)) return "Trading is not possible now: "+why;
   double rk=CycFresh()?(risk>0.0?risk:g_initRisk):g_curRisk;
   for(int k=0;k<2;k++)
     {
      bool b=(k==0);
      double nl=b?buy:sell;
      bool seq1=((g_state==YT_ARMED || g_state==YT_WAITING_REENTRY) && (g_mode==YM_BUY || g_mode==YM_SELL));
      if(seq1 && ((b && g_mode==YM_SELL) || (!b && g_mode==YM_BUY))) continue;   // that side has no order in this sequence
      ulong tk; double ap;
      if(SideActual(b,tk,ap))
        {
         if(!PriceEq(ap,nl))
           {
            //--- v2.16: only a level that can NEVER be placed is rejected; a level that waits for the market is accepted
            if(PlacementState(b,nl,why)==2) return SideName(b)+" "+PX(nl)+" cannot be applied now: "+why;
            if(FrozenNow(b,ap)) return SideName(b)+" cannot be modified now: the order is inside the Freeze Level.";
           }
        }
      else if(g_state!=YT_WAITING_REENTRY && PlacementState(b,nl,why)==2) return SideName(b)+" "+PX(nl)+" cannot be placed: "+why;
      double lot,est; string le;
      if(!CalcLot(rk,b,nl,lot,est,le) && WaitCodeOf(g_riskCode)=="") return SideName(b)+": "+le;   // v2.23: a volume/margin condition is accepted and shown as WAITING_*
     }
   return "";
  }

//--- the SL of each order is the OTHER level, so the lot/SL check must use the candidate levels, not the active ones
string CheckApplicable(const double buy,const double sell,const double risk)
  {
   const double ob=g_buyLevel, os=g_sellLevel;
   g_buyLevel=buy; g_sellLevel=sell;
   string r=CheckApplicableCore(buy,sell,risk);
   g_buyLevel=ob; g_sellLevel=os;
   return r;
  }

//--- v2.16: sides whose level is accepted but cannot be placed yet (computed live from the real market, never stale)
string DeferText()
  {
   string out="";
   for(int k=0;k<2;k++)
     {
      bool b=(k==0);
      double lv;
      if(!SideDesired(b,lv)) continue;
      ulong tk; double ap;
      if(SideActual(b,tk,ap)) continue;
      string why;
      if(PlacementState(b,lv,why)!=1) continue;
      if(out!="") out+=" | ";
      out+=WaitText(b,lv);
     }
   return out;
  }

string WaitNote()
  {
   string d=DeferText();
   return (StringLen(d)>0)?d:g_waitReason;
  }

//--- one log line + one Telegram notice per waiting level
void NoteDefer(const bool buy,const double level,const string txt)
  {
   int s=SideIdx(buy);
   if(PriceEq(g_deferLvl[s],level)) return;
   g_deferLvl[s]=level;
   YLog("Level accepted, waiting for the market: "+txt);
   LogOrder("DEFERRED",buy?(long)ORDER_TYPE_BUY_STOP:(long)ORDER_TYPE_SELL_STOP,level,0.0,0,0,txt);
   if(g_state==YT_ARMED) TgQueue("⏳ "+SideName(buy)+" WAITING FOR PRICE\n"+txt);
  }

//--- v2.16: machine-readable list of the waiting levels (the Mini App shows live distance to the trigger)
string WaitsJson()
  {
   MqlTick t;
   if(!SymbolInfoTick(g_sym,t) || t.ask<=0.0 || t.bid<=0.0) return "[]";
   string out="[";
   int c=0;
   for(int k=0;k<2;k++)
     {
      bool b=(k==0);
      double lv;
      if(!SideDesired(b,lv)) continue;
      ulong tk; double ap;
      if(SideActual(b,tk,ap)) continue;
      string why;
      int ps=PlacementState(b,lv,why);
      if(ps==2) continue;   // v4.12.1: only a level that can NEVER be placed is hidden; ps==0 (placeable, order not created yet) stays visible as "placing" - no flicker
      double trig=WaitTrigger(b,lv);
      double now=b?t.ask:t.bid;
      double dist=b?(now-trig):(trig-now);
      if(c>0) out+=",";
      out+="{\"side\":\""+(b?"BUY":"SELL")+"\",\"level\":"+DoubleToString(lv,g_digits)+",\"trig\":"+DoubleToString(trig,g_digits)+
           ",\"now\":"+DoubleToString(now,g_digits)+",\"dist\":"+DoubleToString(MathMax(dist,0.0),g_digits)+(ps==0?",\"placing\":true":"")+"}";
      c++;
     }
   return out+"]";
  }

void ModifyFailed(const bool buy,const ulong ticket,const long otype,const double vol,const double actualPx,const double level,const uint rc,const string descIn)
  {
   int s=SideIdx(buy);
   string desc=descIn;
   if(StringLen(desc)==0) desc="request rejected";
   MqlTick t;
   double cur=0.0;
   if(SymbolInfoTick(g_sym,t)) cur=buy?t.ask:t.bid;
   g_failCnt[s]++;
   g_failLvl[s]=level;
   ulong delay=(ulong)MathMin(30000.0,1500.0*MathPow(2.0,(double)MathMin(g_failCnt[s]-1,5)));
   if(rc==TRADE_RETCODE_MARKET_CLOSED) delay=30000;
   else if(rc==TRADE_RETCODE_TOO_MANY_REQUESTS && delay<10000) delay=10000;
   g_retryMs[s]=GetTickCount64()+delay;
   string rcs=(rc>0)?" [retcode "+IntegerToString((int)rc)+"]":"";
   string msg="MODIFY FAILED: "+desc+rcs;
   SetSync(buy,YS_FAILED,msg);
   PanelMsg(SideName(buy)+" "+msg,clrTomato);
   LogOrder("MODIFY_FAILED",otype,level,vol,ticket,rc,desc+" | Actual "+PX(actualPx)+" | Market "+PX(cur));
   YLog("MODIFY FAILED | "+SideName(buy)+" | Ticket "+UL(ticket)+" | Retcode "+IntegerToString((int)rc)+" ("+desc+") | Requested "+PX(level)+" | Actual "+PX(actualPx)+" | Market "+PX(cur));
   bool first=(g_failCnt[s]==1);
   RaiseAlert("MODFAIL"+IntegerToString(s),"MODIFY FAILED ("+SideName(buy)+"): "+desc+rcs+" | Ticket "+UL(ticket)+" | Requested "+PX(level)+" | Current "+PX(cur)+" | Actual "+PX(actualPx),first,first);
  }

//+------------------------------------------------------------------+
//| MODIFY the existing pending order in place: the Ticket, Magic,   |
//| Comment, Volume and expiration are kept; only price / SL / TP    |
//| are sent. One request per order at a time; the result is read    |
//| from the server before the status becomes SYNCED.                |
//+------------------------------------------------------------------+
bool ModifySide(const bool buy,const ulong ticket,const double level,const double dSL,const double dTP)
  {
   int s=SideIdx(buy);
   if(g_reqBusy[s]) return false;                    // never two requests for the same order at once
   if(!OrderSelect(ticket)) return false;
   long   otype=OrderGetInteger(ORDER_TYPE);
   double aP=OrderGetDouble(ORDER_PRICE_OPEN);
   double aV=OrderGetDouble(ORDER_VOLUME_CURRENT);
   double hs=((g_tick>0.0)?g_tick:g_point)/2.0;
   ulong  nowMs=GetTickCount64();

   if(!PriceEq(g_failLvl[s],level)) { g_failCnt[s]=0; g_retryMs[s]=0; g_unconf[s]=false; }   // a NEW desired level always gets a fresh attempt
   if(nowMs<g_retryMs[s]) return false;              // back-off after a failure / waiting for the server to show the change
   if(g_unconf[s])
     {
      g_unconf[s]=false;
      ModifyFailed(buy,ticket,otype,aV,aP,level,0,"server accepted the request but the order still shows the old values");
      return false;
     }

   //--- pre-flight validation: a request that is known to be invalid is never sent
   string why;
   if(!TradingAllowedNow(why))                           { SetSync(buy,YS_WAITING,why); return false; }
   int pst=PriceEq(aP,level)?0:PlacementState(buy,level,why);
   if(pst==2)            { SetSync(buy,YS_WAITING,"Cannot modify now: "+why); return false; }
   if(FrozenNow(buy,aP)) { SetSync(buy,YS_WAITING,"Order is inside the Freeze Level"); return false; }
   if(pst==1)
     {
      //--- v2.16: the NEW level cannot be placed yet. The old order must never stay alive at the stale price:
      //--- it is removed (verified) and the new level waits; TryPlace creates the order the moment the market allows it
      string wt=WaitText(buy,level);
      SetSync(buy,YS_REMOVING,"New level "+PX(level)+" must wait for the price: old order #"+UL(ticket)+" is removed");
      UpdatePanel();
      if(DeleteOrder(ticket,"Level moved to "+PX(level)+" which cannot be placed yet - old order removed, new level waits for the market"))
        {
         g_unconf[s]=false; g_failCnt[s]=0; g_failLvl[s]=0.0; g_retryMs[s]=0;
         SetSync(buy,YS_WAITING,wt);
         NoteDefer(buy,level,wt);
         g_dirty=true;
        }
      else if(g_delFilled) g_dirty=true;                  // the old order was triggered meanwhile: the position logic takes over
      else
        {
         g_failLvl[s]=level; g_retryMs[s]=GetTickCount64()+2000;
         SetSync(buy,YS_FAILED,"REMOVE FAILED: could not delete the old order");
        }
      return false;
     }

   //--- send ONE modify request
   g_reqBusy[s]=true;
   SetSync(buy,YS_UPDATING,"Modify "+PX(aP)+" -> "+PX(level));
   UpdatePanel();                                    // the panel shows UPDATING while the server works
   g_trade.SetDeviationInPoints(g_maxDev);
   datetime mdExp=0;
   ENUM_ORDER_TYPE_TIME mdTT=PendingTimeType(mdExp);
   if(!InstOkTrade("modify order #"+UL(ticket))) return false;
   bool r=g_trade.OrderModify(ticket,level,dSL,dTP,mdTT,mdExp);
   uint rc=g_trade.ResultRetcode();
   string desc=g_trade.ResultRetcodeDescription();
   g_reqBusy[s]=false;
   bool ok=((r && (rc==TRADE_RETCODE_DONE || rc==TRADE_RETCODE_PLACED)) || rc==TRADE_RETCODE_NO_CHANGES);
   if(!ok)
     {
      ModifyFailed(buy,ticket,otype,aV,aP,level,rc,desc);   // old state is kept, nothing is reported as modified
      return false;
     }

   //--- verify with the server: the order must now carry the requested values
   if(!OrderSelect(ticket))
     {
      SetSync(buy,YS_UPDATING,"Order no longer pending (triggered?)");
      g_dirty=true;
      return false;
     }
   bool conf=(PriceEq(OrderGetDouble(ORDER_PRICE_OPEN),level) &&
              MathAbs(OrderGetDouble(ORDER_SL)-dSL)<=hs && MathAbs(OrderGetDouble(ORDER_TP)-dTP)<=hs);
   if(!conf)
     {
      g_unconf[s]=true;
      g_failLvl[s]=level;
      g_retryMs[s]=GetTickCount64()+2000;
      SetSync(buy,YS_UPDATING,"Awaiting server confirmation");
      g_dirty=true;
      return false;
     }

   g_failCnt[s]=0; g_failLvl[s]=0.0; g_retryMs[s]=0; g_unconf[s]=false;
   TrkTake(buy,ticket);                              // baseline = the values the server confirmed
   SetSync(buy,YS_SYNCED,"");
   ClearAlert("MODFAIL"+IntegerToString(s));
   string note="Ticket "+UL(ticket)+" kept | "+PX(aP)+" -> "+PX(level)+" | SL "+PX(dSL)+" TP "+PX(dTP);
   LogOrder("MODIFIED",otype,level,aV,ticket,rc,note);
   YLog(SideName(buy)+" MODIFIED | "+note);
   PanelMsg(SideName(buy)+" modified "+PX(aP)+" -> "+PX(level),clrLime);
   TgQueue("✏️ "+SideName(buy)+" MODIFIED\nTicket: "+UL(ticket)+" (kept)\nOld: "+PX(aP)+"\nNew: "+PX(level)+"\nSL: "+PX(dSL)+"\nTP: "+PX(dTP));
   return true;
  }

//+------------------------------------------------------------------+
//| Verification of a freshly placed order on the server             |
//+------------------------------------------------------------------+
bool VerifyPlaced(const ulong ticket,const bool buy,const double level,const double lot,const double sl,const double tp,string &why)
  {
   why="";
   if(ticket==0) { why="the server returned no ticket"; return false; }
   double hs=((g_tick>0.0)?g_tick:g_point)/2.0;
   double step=SymbolInfoDouble(g_sym,SYMBOL_VOLUME_STEP);
   if(step<=0.0) step=0.01;
   for(int i=0;i<6;i++)
     {
      if(OrderSelect(ticket))
        {
         long want=buy?(long)ORDER_TYPE_BUY_STOP:(long)ORDER_TYPE_SELL_STOP;
         if(OrderGetInteger(ORDER_TYPE)!=want) { why="wrong order type on the server"; return false; }
         double aP=OrderGetDouble(ORDER_PRICE_OPEN), aV=OrderGetDouble(ORDER_VOLUME_CURRENT);
         double aS=OrderGetDouble(ORDER_SL), aT=OrderGetDouble(ORDER_TP);
         if(PriceEq(aP,level) && MathAbs(aV-lot)<=step/2.0 && MathAbs(aS-sl)<=hs && MathAbs(aT-tp)<=hs) return true;
         why="MT5 holds price "+PX(aP)+" lot "+LotS(aV)+" SL "+PX(aS)+" TP "+PX(aT);
         return false;
        }
      Sleep(50);
     }
   why="order #"+UL(ticket)+" not found on the server";
   return false;
  }

//--- when MT5 is authoritative the panel edit box follows the real order (unless the user is typing something else)
void PanelSetLevelText(const bool buy,const double oldLevel,const double newLevel)
  {
   if(!InpShowPanel || g_page!=0) return;
   string n=UI+(buy?"ED_BUY":"ED_SELL");
   if(ObjectFind(0,n)<0) return;
   double cur=ParseNum(ObjectGetString(0,n,OBJPROP_TEXT));
   if(cur<=0.0 || PriceEq(cur,oldLevel)) ObjectSetString(0,n,OBJPROP_TEXT,PX(newLevel));
  }

//+------------------------------------------------------------------+
//| External changes: the user moved / deleted the order in MT5      |
//| Returns true when this side must NOT be reconciled in this pass  |
//+------------------------------------------------------------------+
bool ExternalCheck(const bool buy,const bool need,const double level)
  {
   int s=SideIdx(buy);
   double hs=((g_tick>0.0)?g_tick:g_point)/2.0;
   long wantType=buy?(long)ORDER_TYPE_BUY_STOP:(long)ORDER_TYPE_SELL_STOP;

   //--- explicit HOLD: nothing changes automatically until the real order matches the panel again or the user presses APPLY / START
   if(g_hold[s])
     {
      ulong hT; double hP;
      if(!need || !SideActual(buy,hT,hP) || !PriceEq(hP,level)) return true;
      g_hold[s]=false;
      TrkTake(buy,hT);
      YLog(SideName(buy)+" is back in line with the panel - hold released");
      return false;
     }

   ulong tk=g_stopTicket[s];
   if(tk==0) return false;                            // not tracked yet (it is adopted by ReconcileSide)
   if(g_reqBusy[s] || g_unconf[s]) return false;      // our own request is still being confirmed

   //--- 1) the ticket exists: did somebody change it outside the EA?
   if(OrderSelect(tk))
     {
      g_missMs[s]=0;
      if(OrderGetInteger(ORDER_TYPE)!=wantType) return false;
      double p=OrderGetDouble(ORDER_PRICE_OPEN), sl=OrderGetDouble(ORDER_SL), tp=OrderGetDouble(ORDER_TP), v=OrderGetDouble(ORDER_VOLUME_CURRENT);
      bool pxChg=!PriceEq(p,g_snapPx[s]);
      bool stChg=(MathAbs(sl-g_snapSL[s])>hs || MathAbs(tp-g_snapTP[s])>hs);
      if(!pxChg && !stChg) return false;

      string what=pxChg?("price "+PX(g_snapPx[s])+" -> "+PX(p)):("SL "+PX(g_snapSL[s])+" -> "+PX(sl)+" / TP "+PX(g_snapTP[s])+" -> "+PX(tp));
      string msg=SideName(buy)+" EXTERNAL CHANGE DETECTED | Ticket #"+UL(tk)+" | "+what;
      LogOrder("EXTERNAL_CHANGE",wantType,p,v,tk,0,what);
      YLog(msg);
      RaiseAlert("EXT"+IntegerToString(s),msg,true,true);
      TrkTake(buy,tk);                                // the new MT5 state is the baseline: it is reported only once
      if(!need) return false;

      bool holdIt=(InpExtPolicy==YT_EXT_HOLD);
      string note="";
      if(!holdIt && pxChg && InpExtPolicy==YT_EXT_ADOPT)
        {
         string e=ValidateLevels(buy?p:g_buyLevel,buy?g_sellLevel:p);
         if(e=="")
           {
            //--- MT5 is authoritative: the panel level becomes the real order price (SL / TP are re-derived by the reconcile)
            if(buy) g_buyLevel=p; else g_sellLevel=p;
            SaveState();
            PanelSetLevelText(buy,level,p);
            SetSync(buy,YS_EXTERNAL,"MT5 price adopted: "+PX(level)+" -> "+PX(p));
            PanelMsg(SideName(buy)+" EXTERNAL CHANGE: panel level now "+PX(p),clrGold);
            TgQueue("⚠️ EXTERNAL CHANGE DETECTED\n"+SideName(buy)+" Ticket #"+UL(tk)+"\nMT5 price: "+PX(p)+" (panel was "+PX(level)+")\nPolicy: MT5 adopted.");
            g_dirty=true;
            return false;
           }
         holdIt=true;                                 // adopting would break the level rules: explicit hold instead
         note=" (cannot adopt: "+e+")";
        }
      if(holdIt)
        {
         g_hold[s]=true;
         SetSync(buy,YS_EXTERNAL,"Panel "+PX(level)+" vs MT5 "+PX(p)+" - press APPLY to enforce the panel"+note);
         PanelMsg(SideName(buy)+" EXTERNAL CHANGE: hold, press APPLY",clrGold);
         TgQueue("⚠️ EXTERNAL CHANGE DETECTED\n"+SideName(buy)+" Ticket #"+UL(tk)+"\nMT5 price: "+PX(p)+"\nPanel: "+PX(level)+"\nNo automatic action. Press APPLY to enforce the panel."+note);
         return true;
        }
      //--- RESTORE (or an SL / TP-only change under ADOPT): the reconcile that follows puts the same ticket back
      SetSync(buy,YS_EXTERNAL,"Restoring panel values on ticket #"+UL(tk));
      PanelMsg(SideName(buy)+" EXTERNAL CHANGE: restoring panel values",clrGold);
      TgQueue("⚠️ EXTERNAL CHANGE DETECTED\n"+SideName(buy)+" Ticket #"+UL(tk)+"\nPolicy: panel values are restored on the same ticket.");
      return false;
     }

   //--- 2) the ticket is gone from the server
   ulong pp[];
   if(OwnPositions(pp)>0) { TrkDrop(s); return true; }                 // triggered meanwhile: the position logic takes over
   bool inHist=HistoryOrderSelect(tk);
   long hst=inHist?HistoryOrderGetInteger(tk,ORDER_STATE):-1;
   if(inHist && (hst==ORDER_STATE_FILLED || hst==ORDER_STATE_PARTIAL))
     {
      //--- triggered and possibly already closed (fast market): book the position immediately, never wait for the 30 s history scan
      ulong fpid=(ulong)HistoryOrderGetInteger(tk,ORDER_POSITION_ID);
      TrkDrop(s);
      if(fpid!=0)
        {
         YLog(SideName(buy)+" #"+UL(tk)+" was FILLED - registering position "+UL(fpid)+" now");
         RegisterPosition(fpid);
         CheckClosures();
        }
      g_restartPass=true;
      g_dirty=true;
      return true;
     }
   if(!inHist)
     {
      if(g_missMs[s]==0) g_missMs[s]=GetTickCount64();
      if(GetTickCount64()-g_missMs[s]<3000) return true;              // history may lag behind the trade server
     }
   g_missMs[s]=0;
   TrkDrop(s);
   if(!need) return false;

   string how=inHist?((hst==ORDER_STATE_EXPIRED)?"expired":"deleted / cancelled"):"no longer on the server";
   string mm=SideName(buy)+" MISSING | Ticket #"+UL(tk)+" "+how+" outside the EA";
   LogOrder("MISSING",wantType,level,0.0,tk,0,how);
   YLog(mm);
   RaiseAlert("MISS"+IntegerToString(s),mm,true,true);
   if(InpMissPolicy==YT_MISS_RECREATE)
     {
      SetSync(buy,YS_MISSING,"Ticket #"+UL(tk)+" missing - placing it again");
      PanelMsg(SideName(buy)+" MISSING: placing again",clrGold);
      TgQueue("⚠️ "+SideName(buy)+" MISSING\nTicket #"+UL(tk)+" "+how+".\nPolicy: placing it again.");
      return false;
     }
   g_hold[s]=true;
   SetSync(buy,YS_MISSING,"Ticket #"+UL(tk)+" "+how+" - press APPLY / START to place it again");
   PanelMsg(SideName(buy)+" MISSING: manual intervention",clrTomato);
   TgQueue("⚠️ "+SideName(buy)+" MISSING\nTicket #"+UL(tk)+" "+how+".\nManual intervention required: press APPLY / START to place it again.");
   return true;
  }

//+------------------------------------------------------------------+
//| One side of Reconcile: KEEP / MODIFY / REPLACE (lot only) / CREATE|
//+------------------------------------------------------------------+
void ReconcileSide(const bool buy,const double level,const double expLot,const bool lotOk,const ulong ticket)
  {
   int s=SideIdx(buy);
   if(ticket==0 || !OrderSelect(ticket))
     {
      if(g_arm[s].ticket!=0 && g_arm[s].touchMs==0)       // v2.40: an armed order vanished BEFORE its level was touched
        {
         LogOrder("ARM_LOST",buy?(long)ORDER_TYPE_BUY_STOP:(long)ORDER_TYPE_SELL_STOP,g_arm[s].level,g_arm[s].lot,g_arm[s].ticket,0,
                  "the armed order is no longer on the server and the level was not touched (expired / deleted outside the EA / rejected after acceptance) - it will be re-created only if the market allows");
         ArmDrop(s);
        }
      //--- no order on the server: CREATE (the only case where a brand-new pending order is sent)
      if(GetTickCount64()<g_guardMs[s])
        {
         //--- the server answered DONE a moment ago but the order is not visible yet: never send a second one
         SetSync(buy,YS_CREATING,"Awaiting server confirmation of #"+UL(g_guardTk[s]));
         return;
        }
      g_unconf[s]=false;
      if(g_sync[s]!=YS_FAILED && g_sync[s]!=YS_WAITING) SetSync(buy,YS_CREATING,"");
      TryPlace(buy,level);                           // sets WAITING / FAILED / SYNCED itself
      return;
     }
   double hs=((g_tick>0.0)?g_tick:g_point)/2.0;
   double step=SymbolInfoDouble(g_sym,SYMBOL_VOLUME_STEP);
   if(step<=0.0) step=0.01;
   if(g_stopTicket[s]!=ticket) TrkTake(buy,ticket);   // adopt the real ticket (restart / first run); the order stays selected
   g_guardMs[s]=0;
   double aP=OrderGetDouble(ORDER_PRICE_OPEN);
   double aSL=OrderGetDouble(ORDER_SL);
   double aTP=OrderGetDouble(ORDER_TP);
   double aV=OrderGetDouble(ORDER_VOLUME_CURRENT);
   long   aT=OrderGetInteger(ORDER_TYPE);
   double dSL=SLPrice(buy,level), dTP=TPPrice(buy,level);
   if(dSL<=0.0 || dTP<=0.0)
     {
      //--- never send an order/modification without a computed SL/TP (no invented distance any more)
      SetSync(buy,YS_WAITING,"Levels invalid: SL/TP cannot be computed");
      return;
     }
   bool volDiff=(lotOk && MathAbs(aV-expLot)>step/2.0);
   bool diff=(!PriceEq(aP,level) || MathAbs(aSL-dSL)>hs || MathAbs(aTP-dTP)>hs);

   if(volDiff)
     {
      //--- MT5 cannot change the volume of a pending order: the ONLY case that needs delete + create
      if(GetTickCount64()<g_nextDelMs) return;
      string why="Lot changed (risk update): volume cannot be modified, order is replaced";
      if(FrozenNow(buy,aP)) { SetSync(buy,YS_WAITING,"Order is inside the Freeze Level"); return; }
      SetSync(buy,YS_UPDATING,why);
      UpdatePanel();
      if(DeleteOrder(ticket,why))
        {
         g_unconf[s]=false;
         SetSync(buy,YS_CREATING,"");
         TryPlace(buy,level);
        }
      else
        {
         g_nextDelMs=GetTickCount64()+2000;
         SetSync(buy,YS_FAILED,"REPLACE FAILED: could not delete the old order");
        }
      return;
     }

   if(!diff)
     {
      //--- KEEP: the server already holds exactly the desired order, nothing is sent
      if(g_unconf[s])
        {
         LogOrder("MODIFIED",aT,aP,aV,ticket,0,"Confirmed by server | "+PX(aP)+" SL "+PX(aSL)+" TP "+PX(aTP));
         YLog(SideName(buy)+" MODIFIED (confirmed) | Ticket "+UL(ticket)+" | "+PX(aP));
         PanelMsg(SideName(buy)+" modified -> "+PX(aP),clrLime);
        }
      g_failCnt[s]=0; g_failLvl[s]=0.0; g_retryMs[s]=0; g_unconf[s]=false;
      if(g_sync[s]==YS_FAILED) ClearAlert("MODFAIL"+IntegerToString(s));
      if(g_arm[s].ticket==ticket) g_arm[s].verMs=GetTickCount64();       // v2.40: the server still shows exactly this order
      else ArmNote(buy,ticket,aP,aV,g_revCtx);                           // adopted (restart / late confirmation)
      TrkTake(buy,ticket);                           // input == EA state == MT5 state: this is the verified baseline
      if(g_sync[s]==YS_PLACED && GetTickCount64()-g_placedMs[s]<5000) return;   // keep PLACED visible briefly
      SetSync(buy,YS_SYNCED,"");
      return;
     }

   //--- MODIFY the existing order (same ticket / magic / comment / volume)
   ModifySide(buy,ticket,level,dSL,dTP);
  }

//+------------------------------------------------------------------+
//| Netting protection                                               |
//| In a Netting account every deal on the symbol merges into ONE    |
//| position, so the bot cannot separate its trade from a foreign    |
//| one. Rule: never place orders while a foreign position exists,   |
//| never close volume that is not ours.                             |
//+------------------------------------------------------------------+
bool IsNettingAccount()
  {
   return ((ENUM_ACCOUNT_MARGIN_MODE)AccountInfoInteger(ACCOUNT_MARGIN_MODE)!=ACCOUNT_MARGIN_MODE_RETAIL_HEDGING);
  }

//--- volume of positions on this symbol that were NOT opened by this bot (other magic / manual)
double ExternalPositionVolume()
  {
   double v=0.0;
   int n=PositionsTotal();
   for(int i=0;i<n;i++)
     {
      ulong t=PositionGetTicket(i);
      if(t==0) continue;
      if(PositionGetString(POSITION_SYMBOL)!=g_sym) continue;
      if((long)PositionGetInteger(POSITION_MAGIC)==g_magic) continue;
      v+=PositionGetDouble(POSITION_VOLUME);
     }
   return v;
  }

//--- true => the bot must stay frozen (Netting + foreign position). Resumes by itself when it is gone.
bool NettingBlocked()
  {
   if(!g_netting) return false;
   double ev=ExternalPositionVolume();
   if(ev<=0.0)
     {
      if(g_extBlock)
        {
         g_extBlock=false;
         g_blockReason="";
         ClearAlert("NETEXT");
         YLog("Netting: external position closed - bot resumed.");
        }
      return false;
     }
   if(!g_extBlock)
     {
      g_extBlock=true;
      YLog("Netting: external "+g_sym+" position detected ("+LotS(ev)+" lots) - bot frozen, its own pending orders are removed.");
     }
   g_blockReason="Netting account: external "+g_sym+" position ("+LotS(ev)+" lots) - bot frozen";
   ulong od[];
   int no=OwnOrders(od);
   for(int i=0;i<no;i++) DeleteOrder(od[i],"Netting: external position present");
   RaiseAlert("NETEXT","Netting account: an external "+g_sym+" position exists. Yetimmm places no orders and does not touch it. It resumes automatically once that position is closed.",true,true);
   return true;
  }

//--- Netting: own position volume must equal the lot the bot registered; otherwise foreign volume merged into it
void NettingDriftCheck(const ulong ticket)
  {
   if(!PositionSelectByTicket(ticket)) return;
   ulong pid=(ulong)PositionGetInteger(POSITION_IDENTIFIER);
   double reg=PGV(pid,"LOT",0.0);
   if(reg<=0.0) return;
   double vol=PositionGetDouble(POSITION_VOLUME);
   double step=SymbolInfoDouble(g_sym,SYMBOL_VOLUME_STEP);
   if(step<=0.0) step=0.01;
   bool bad=(MathAbs(vol-reg)>step/2.0);
   if(bad)
     {
      //--- persisted PER POSITION: survives a restart, and the result of this position never feeds the risk sequence
      if(PGV(pid,"TAINT",0.0)<0.5) { PSet(pid,"TAINT",1.0); GlobalVariablesFlush(); }
      if(!g_netTaint)
        {
         g_netTaint=true;
         YLog("Netting: position volume "+LotS(vol)+" differs from registered lot "+LotS(reg)+" - foreign volume merged. Automatic closing is DISABLED and the risk sequence will NOT be updated from this position.");
         RaiseAlert("NETDRIFT","Netting account: an external trade changed the Yetimmm position volume ("+LotS(vol)+" vs "+LotS(reg)+"). Yetimmm will NOT close it, and the risk sequence will NOT be updated from its result - handle it manually.",true,true);
        }
     }
   else if(g_netTaint)
     {
      g_netTaint=false;                     // closing is allowed again; the position stays flagged (its P/L is not purely ours)
      ClearAlert("NETDRIFT");
      YLog("Netting: position volume matches the registered lot again.");
     }
  }

//--- every AUTOMATIC close goes through this guard: never close volume that is not ours
bool NetTaintRefusesClose(const string what)
  {
   if(!(g_netting && g_netTaint)) return false;
   RaiseAlert("NETCLOSE","Netting account: the Yetimmm position contains external volume, so "+what+" was NOT executed automatically. Handle it manually.",true,true);
   return true;
  }

//+------------------------------------------------------------------+
//| Telegram                                                         |
//+------------------------------------------------------------------+
bool TgActive()
  {
   if(!g_tgEn) return false;
   if(MQLInfoInteger(MQL_TESTER)) return false;
   if(StringLen(g_tgTok)==0) return false;
   return true;
  }

void ParseIds()
  {
   ArrayResize(g_tgIds,0);
   string s=g_tgAuth;
   if(StringLen(g_tgPub)>0) s+=(StringLen(s)>0?",":"")+g_tgPub;
   StringReplace(s,";",",");
   StringReplace(s," ",",");
   string p[];
   int n=StringSplit(s,',',p);
   for(int i=0;i<n;i++)
     {
      if(StringLen(p[i])==0) continue;
      long v=StringToInteger(p[i]);
      if(v==0) continue;
      bool dup=false;
      for(int q=0;q<ArraySize(g_tgIds);q++) if(g_tgIds[q]==v) { dup=true; break; }
      if(dup) continue;
      int k=ArraySize(g_tgIds);
      ArrayResize(g_tgIds,k+1);
      g_tgIds[k]=v;
     }
  }

//--- v2.28: only chat ids registered through the Worker may control the EA (the old "public mode" comment was outdated)
bool TgAuthorized(const long from)
  {
   //--- v2.23: NO public mode. Only chat ids registered through the Worker (Telegram-verified identity) may control the EA.
   if(from==0) return false;
   for(int i=0;i<ArraySize(g_tgIds);i++) if(g_tgIds[i]==from) return true;
   return false;
  }

string UrlEnc(const string s)
  {
   char b[];
   int n=StringToCharArray(s,b,0,WHOLE_ARRAY,CP_UTF8);
   string out="";
   for(int i=0;i<n-1;i++)
     {
      int c=((int)b[i])&0xFF;
      if((c>='0'&&c<='9')||(c>='a'&&c<='z')||(c>='A'&&c<='Z')||c=='-'||c=='_'||c=='.'||c=='~')
         out+=ShortToString((ushort)c);
      else
         out+=StringFormat("%%%02X",c);
     }
   return out;
  }

void TgPush(const long chat,const string text,const string markup)
  {
   int n=ArraySize(g_qText);
   if(n>=60)
     {
      for(int i=1;i<n;i++) { g_qText[i-1]=g_qText[i]; g_qChat[i-1]=g_qChat[i]; g_qMarkup[i-1]=g_qMarkup[i]; g_qTry[i-1]=g_qTry[i]; }
      n--;
     }
   ArrayResize(g_qText,n+1);
   ArrayResize(g_qChat,n+1);
   ArrayResize(g_qMarkup,n+1);
   ArrayResize(g_qTry,n+1);
   g_qText[n]=text; g_qChat[n]=chat; g_qMarkup[n]=markup; g_qTry[n]=0;
  }

void TgPop()
  {
   int n=ArraySize(g_qText);
   if(n<=0) return;
   for(int i=1;i<n;i++) { g_qText[i-1]=g_qText[i]; g_qChat[i-1]=g_qChat[i]; g_qMarkup[i-1]=g_qMarkup[i]; g_qTry[i-1]=g_qTry[i]; }
   ArrayResize(g_qText,n-1);
   ArrayResize(g_qChat,n-1);
   ArrayResize(g_qMarkup,n-1);
   ArrayResize(g_qTry,n-1);
  }

//--- chat==0 -> broadcast to every authorized id (requires Notifications enabled)
string JEsc(const string s);   // defined with the Mini App bridge
void LoadAutoConfig(const bool quiet=false);   // defined below the bridge; BridgeSync() re-reads the settings (quiet = no log lines)

//--- v2.23 EVENT OUTBOX: every notification gets a unique id (login:magic:sequence). The Worker de-duplicates by id and acks it;
//--- unacked events are re-sent with the next sync (same id = never delivered twice). The sequence survives MT5 restarts.
void EvEmit(const string text)
  {
   if(StringLen(text)==0) return;
   if(g_evSeq==0) g_evSeq=(long)GV("EVSEQ",0.0);
   g_evSeq++;
   GS("EVSEQ",(double)g_evSeq);
   string title=text, body="";
   int nl=StringFind(text,"\n");
   if(nl>0) { title=StringSubstr(text,0,nl); body=StringSubstr(text,nl+1); }
   if(StringLen(title)>110) title=StringSubstr(title,0,110);
   if(StringLen(body)>550) body=StringSubstr(body,0,550);
   string kind=(StringFind(text,"ACTIVATED")>=0)?"act":"ev";
   string id=IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN))+":"+IntegerToString((long)g_magic)+":"+IntegerToString(g_evSeq);
   int n=ArraySize(g_evId);
   if(n>=40)
     {
      for(int i=1;i<n;i++) { g_evId[i-1]=g_evId[i]; g_evK[i-1]=g_evK[i]; g_evT[i-1]=g_evT[i]; g_evB[i-1]=g_evB[i]; }
      n--;
     }
   ArrayResize(g_evId,n+1); ArrayResize(g_evK,n+1); ArrayResize(g_evT,n+1); ArrayResize(g_evB,n+1);
   g_evId[n]=id; g_evK[n]=kind; g_evT[n]=title; g_evB[n]=body;
  }

void EvAckFrom(const string resp)
  {
   int p=StringFind(resp,"\"evack\":[");
   if(p<0) return;
   int e=StringFind(resp,"]",p);
   if(e<0) return;
   string sec=StringSubstr(resp,p,e-p);
   for(int i=ArraySize(g_evId)-1;i>=0;i--)
     {
      if(StringFind(sec,"\""+g_evId[i]+"\"")<0) continue;
      int n=ArraySize(g_evId);
      for(int j=i+1;j<n;j++) { g_evId[j-1]=g_evId[j]; g_evK[j-1]=g_evK[j]; g_evT[j-1]=g_evT[j]; g_evB[j-1]=g_evB[j]; }
      ArrayResize(g_evId,n-1); ArrayResize(g_evK,n-1); ArrayResize(g_evT,n-1); ArrayResize(g_evB,n-1);
     }
  }

string EvJson()
  {
   string j="[";
   for(int i=0;i<ArraySize(g_evId);i++)
      j+=(i>0?",":"")+"{\"id\":\""+JEsc(g_evId[i])+"\",\"k\":\""+g_evK[i]+"\",\"t\":\""+JEsc(g_evT[i])+"\",\"b\":\""+JEsc(g_evB[i])+"\"}";
   return j+"]";
  }

void TgQueue(const string text,const long chat=0,const string markup="")
  {
   if(!g_tgEn) return;
   if(chat==0 && InpTgViaWorker)
     {
      //--- v2.23: ONE notification channel: EA -> Worker (unique event id, de-duplicated) -> Telegram. No token in MT5.
      if(g_tgNot && InpBrEnable) EvEmit(text);
      return;
     }
   if(chat==0)
     {
      if(!g_tgNot) return;
      for(int i=0;i<ArraySize(g_tgIds);i++) TgPush(g_tgIds[i],text,markup);
     }
   else TgPush(chat,text,markup);
  }

//--- v2.26: origin (https://host) of a URL + the exact list MT5 needs in Allowed URLs (built from the live input, never hard-coded)
string UrlOrigin(const string u)
  {
   string x=u;
   StringTrimLeft(x); StringTrimRight(x);
   int p=StringFind(x,"://");
   if(p<0) return x;
   int q=StringFind(x,"/",p+3);
   return (q<0)?x:StringSubstr(x,0,q);
  }
string AllowUrlsHint()
  {
   return UrlOrigin(g_brUrl)+"  and  https://api.telegram.org";
  }
bool g_urlAlertShown=false;
void AllowUrlsAlertOnce()
  {
   if(g_urlAlertShown) return;
   g_urlAlertShown=true;
   Alert("Yetimmm: Tools > Options > Expert Advisors > tick 'Allow WebRequest' and add: "+AllowUrlsHint()+"  (or run tools\\allow-urls.bat with MT5 closed)");
  }

//--- low-level Telegram request (token is never logged)
bool TgCall(const string method,const string body,string &resp)
  {
   resp="";
   string url="https://api.telegram.org/bot"+g_tgTok+"/"+method;
   char data[],res[];
   string rh;
   int n=StringToCharArray(body,data,0,WHOLE_ARRAY,CP_UTF8);
   if(n>0) ArrayResize(data,n-1);
   ResetLastError();
   int code=WebRequest("POST",url,"Content-Type: application/x-www-form-urlencoded\r\n",NetTimeout(),data,res,rh);
   if(code==-1)
     {
      int e=GetLastError();
      g_tgOk=false;
      g_tgLastCode=-1;
      if(TimeLocal()-g_tgLastErrLog>=60)
        {
         g_tgLastErrLog=TimeLocal();
         if(e==4014) { YLog("Telegram Connection Error: add https://api.telegram.org to Tools > Options > Expert Advisors > Allowed URLs (error 4014)."); AllowUrlsAlertOnce(); }
         else YLog("Telegram Connection Error: WebRequest failed, error "+IntegerToString(e));
        }
      return false;
     }
   resp=CharArrayToString(res,0,WHOLE_ARRAY,CP_UTF8);
   g_tgLastCode=code;
   if(code!=200 || StringFind(resp,"\"ok\":true")<0)
     {
      g_tgOk=false;
      if(TimeLocal()-g_tgLastErrLog>=60)
        {
         g_tgLastErrLog=TimeLocal();
         {
            string why="";
            if(code==409) why=" | CONFLICT: another getUpdates/webhook is using this same Bot Token (another chart, VPS, PC or program) - keep only ONE instance";
            else if(code==429) why=" | rate limited by Telegram - increase InpTgPollMs";
            else if(code==401 || code==404) why=" | invalid Bot Token";
            else if(code>=1000) why=" | network/proxy/ISP level failure (not a Telegram reply) - check VPN/firewall/internet, increase InpTgPollMs";
            string body2=(StringLen(resp)>0)?" | "+StringSubstr(resp,0,160):"";
            YLog("Telegram Connection Error: HTTP "+IntegerToString(code)+why+body2);
           }
        }
      return false;
     }
   g_tgOk=true;
   return true;
  }

bool TgSend(const long chat,const string text,const string markup)
  {
   string t=text;
   if(StringLen(t)>3900) t=StringSubstr(t,0,3900)+"\n...";
   string body="chat_id="+IntegerToString(chat)+"&text="+UrlEnc(t)+"&disable_web_page_preview=true";
   if(StringLen(markup)>0) body+="&reply_markup="+UrlEnc(markup);
   string resp;
   return TgCall("sendMessage",body,resp);
  }

void TgFlush()
  {
   if(!TgActive()) { if(ArraySize(g_qText)>60) TgPop(); return; }
   if(!g_connected) return;
   int sent=0;
   while(ArraySize(g_qText)>0 && sent<5)
     {
      if(TgSend(g_qChat[0],g_qText[0],g_qMarkup[0]))
        {
         YLog("Telegram Notification Sent");
         TgPop();
         sent++;
        }
      else
        {
         g_qTry[0]++;
         if(g_qTry[0]>=5) TgPop(); // drop a message that keeps failing
         break;
        }
     }
  }

string MenuKeyboard()
  {
   return "{\"inline_keyboard\":[[{\"text\":\"▶️ START\",\"callback_data\":\"CMD:start\"},{\"text\":\"⏹ STOP\",\"callback_data\":\"CMD:stop\"}],"
          "[{\"text\":\"❌ CANCEL\",\"callback_data\":\"CMD:cancel\"},{\"text\":\"📊 STATUS\",\"callback_data\":\"CMD:status\"}],"
          "[{\"text\":\"📜 HISTORY\",\"callback_data\":\"CMD:history\"},{\"text\":\"📈 STATS\",\"callback_data\":\"CMD:stats\"}],"
          "[{\"text\":\"⚙️ SETTINGS\",\"callback_data\":\"CMD:settings\"},{\"text\":\"❓ HELP\",\"callback_data\":\"CMD:help\"}]]}";
  }

// v2.25: the default keyboard is attached only when InpTgMenu=true; /menu still shows it explicitly (MenuKeyboard)
string MenuMarkup()
  {
   return InpTgMenu ? MenuKeyboard() : "";
  }

string ConfirmMarkup(const string nonce,const string yes,const string no)
  {
   return "{\"inline_keyboard\":[[{\"text\":\""+yes+"\",\"callback_data\":\"C1:"+nonce+"\"},{\"text\":\""+no+"\",\"callback_data\":\"C0:"+nonce+"\"}]]}";
  }

//--- minimal JSON helpers
int HexDigit(const ushort c)
  {
   if(c>='0' && c<='9') return c-'0';
   if(c>='a' && c<='f') return c-'a'+10;
   if(c>='A' && c<='F') return c-'A'+10;
   return 0;
  }

string JStr(const string seg,const string marker)
  {
   int a=StringFind(seg,marker);
   if(a<0) return "";
   int i=a+StringLen(marker);
   int L=StringLen(seg);
   string out="";
   while(i<L)
     {
      ushort c=StringGetCharacter(seg,i);
      if(c==92 && i+1<L)
        {
         ushort d=StringGetCharacter(seg,i+1);
         if(d=='n') { out+="\n"; i+=2; continue; }
         if(d=='t') { out+=" "; i+=2; continue; }
         if(d=='r') { i+=2; continue; }
         if(d=='u' && i+5<L)
           {
            int code=0;
            for(int k=0;k<4;k++) code=code*16+HexDigit(StringGetCharacter(seg,i+2+k));
            out+=ShortToString((ushort)code);
            i+=6;
            continue;
           }
         out+=ShortToString(d);
         i+=2;
         continue;
        }
      if(c==34) break;
      out+=ShortToString(c);
      i++;
     }
   return out;
  }

long JNum(const string seg,const string marker,bool &found)
  {
   found=false;
   int a=StringFind(seg,marker);
   if(a<0) return 0;
   int i=a+StringLen(marker);
   int L=StringLen(seg);
   string s="";
   while(i<L)
     {
      ushort c=StringGetCharacter(seg,i);
      if((c>='0' && c<='9') || (c=='-' && s==""))
        { s+=ShortToString(c); i++; }
      else break;
     }
   if(s=="" || s=="-") return 0;
   found=true;
   return StringToInteger(s);
  }

//+------------------------------------------------------------------+
//| Status texts                                                     |
//+------------------------------------------------------------------+
bool OwnPosInfo(ulong &ticket,ulong &pid,bool &buy,double &vol,double &entry,double &sl,double &tp,double &profit)
  {
   ulong tk[];
   if(OwnPositions(tk)<1) return false;
   ticket=tk[ArraySize(tk)-1];
   if(!PositionSelectByTicket(ticket)) return false;
   pid=(ulong)PositionGetInteger(POSITION_IDENTIFIER);
   buy=(PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY);
   vol=PositionGetDouble(POSITION_VOLUME);
   entry=PositionGetDouble(POSITION_PRICE_OPEN);
   sl=PositionGetDouble(POSITION_SL);
   tp=PositionGetDouble(POSITION_TP);
   profit=AcM(PositionGetDouble(POSITION_PROFIT)+PositionGetDouble(POSITION_SWAP));
   return true;
  }

//--- current / planned lot and estimated loss at SL
bool CurrentLotInfo(double &lot,double &est,string &err)
  {
   lot=0; est=0; err="";
   ulong tk,pid; bool buy; double vol,entry,sl,tp,pr;
   if(OwnPosInfo(tk,pid,buy,vol,entry,sl,tp,pr))
     {
      lot=vol;
      double lvl=buy?g_buyLevel:g_sellLevel;
      if(lvl<=0.0) lvl=entry;
      est=vol*PerLotLoss(buy,lvl);
      return true;
     }
   bool useBuy=(g_mode!=YM_SELL);
   double level=useBuy?g_buyLevel:g_sellLevel;
   if(level<=0.0) { err="No valid levels"; return false; }
   return CalcLot(g_curRisk,useBuy,level,lot,est,err);
  }

string OrdersText()
  {
   //--- v2.45.1: the list shows BOTH the live orders on the server AND the levels that are accepted but still WAITING for the price (same facts as the Mini App card:
   //--- current price, trigger, remaining distance). Before this a waiting side was invisible here ("No Pending Orders") although the bot was correctly watching it.
   ulong od[];
   int n=OwnOrders(od);
   MqlTick tk0;
   const bool hasTick=(SymbolInfoTick(g_sym,tk0) && tk0.ask>0.0 && tk0.bid>0.0);
   string live="", wait="";
   for(int i=0;i<n;i++)
     {
      if(!OrderSelect(od[i])) continue;
      long t=OrderGetInteger(ORDER_TYPE);
      const bool b=(t==ORDER_TYPE_BUY_STOP);
      const double lv=OrderGetDouble(ORDER_PRICE_OPEN);
      live+="✅ "+(b?"Buy Stop ":"Sell Stop ")+PX(lv)+" - ON SERVER\n   Lot: "+LotS(OrderGetDouble(ORDER_VOLUME_CURRENT))+"  SL: "+PX(OrderGetDouble(ORDER_SL))+"  TP: "+PX(OrderGetDouble(ORDER_TP))+"  Ticket: #"+UL(od[i])+"\n";
      if(hasTick) live+="   Now: "+(b?"Ask ":"Bid ")+PX(b?tk0.ask:tk0.bid)+"  Remaining: "+PX(b?(lv-tk0.ask):(tk0.bid-lv))+"\n";
     }
   for(int k=0;k<2;k++)
     {
      const bool b=(k==0);
      const double lv=WaitLevelNow(b);
      if(lv<=0.0) continue;
      const double trg=WaitTrigger(b,lv);
      wait+="⏳ "+(b?"Buy Stop ":"Sell Stop ")+PX(lv)+" - WAITING FOR PRICE\n";
      if(hasTick)
         wait+="   Now: "+(b?"Ask ":"Bid ")+PX(b?tk0.ask:tk0.bid)+"  Activates when "+(b?"Ask falls to ":"Bid rises to ")+PX(trg)+(b?" or lower":" or higher")+"  Remaining: "+PX(b?(tk0.ask-trg):(trg-tk0.bid))+"\n";
      else wait+="   Waiting for market prices\n";
     }
   if(live=="" && wait=="") return "No Pending Orders";
   return "Pending Orders\n"+live+wait+"Delete one: /del BUY | /del SELL | /del TICKET\nModify one: /mod BUY PRICE | /mod SELL PRICE";
  }

string OpenText()
  {
   ulong tk,pid; bool buy; double vol,entry,sl,tp,pr;
   if(!OwnPosInfo(tk,pid,buy,vol,entry,sl,tp,pr)) return "No Open Position";
   double cur=buy?SymbolInfoDouble(g_sym,SYMBOL_BID):SymbolInfoDouble(g_sym,SYMBOL_ASK);
   return "Open Position\nTrade #: "+TNo((long)PGV(pid,"N",0))+"\n"+(buy?"BUY":"SELL")+"\nEntry: "+PX(entry)+"\nSL: "+PX(sl)+"\nTP: "+PX(tp)+
          "\nLot: "+LotS(vol)+"\nRisk: $"+D2(PGV(pid,"R",g_curRisk))+"\nCurrent Price: "+PX(cur)+"\nFloating P/L: "+Money(pr);
  }

string TgStateText()
  {
   return g_tgOk?"CONNECTED":(TgActive()?"ERROR":(g_tgEn?"NOT CONFIGURED":"DISABLED"));
  }

string StatusText()
  {
   string s="🤖 Yetimmm Status\nStatus: "+RunStatus()+"\nState: "+StateText()+"\nSymbol: "+g_sym+"\nBuy Stop: "+PX(g_buyLevel)+"\nSell Stop: "+PX(g_sellLevel)+"\n";
   ulong tk,pid; bool buy; double vol,entry,sl,tp,pr;
   if(OwnPosInfo(tk,pid,buy,vol,entry,sl,tp,pr))
      s+="Position: "+(buy?"BUY":"SELL")+"\nTrade #: "+TNo((long)PGV(pid,"N",0))+"\nEntry: "+PX(entry)+"\nSL: "+PX(sl)+"\nTP: "+PX(tp)+"\nLot: "+LotS(vol)+"\n";
   else s+="Position: NONE\n";
   s+="Sync: "+SyncSummary()+"\n";
   if(g_recHold) s+="RECOVERY: REQUIRED_RECOVERY - "+g_recWhy+"\n";
   if(g_fresh && g_pendBuy>0.0 && g_pendSell>0.0) s+="Pending levels (start after TP): Buy "+PX(g_pendBuy)+" / Sell "+PX(g_pendSell)+"\n";
   s+="Initial Risk: $"+D2(g_initRisk)+"\nCurrent Risk: $"+D2(g_curRisk)+"\nAccumulated Loss: $"+D2(g_accLoss)+"\nTrade Sequence: "+IntegerToString(g_seq)+
      "\nConnection: "+(g_connected?"ONLINE":"OFFLINE")+"\nSpread: "+IntegerToString((int)SymbolInfoInteger(g_sym,SYMBOL_SPREAD))+" pts\nTelegram: "+TgStateText();
   { string wn=WaitNote(); if(StringLen(wn)>0) s+="\nNote: "+wn; }
   if(StringLen(g_blockReason)>0) s+="\nBlocked: "+g_blockReason;
   return s;
  }

string StatsText()
  {
   return "📈 Yetimmm Statistics\nTotal Trades: "+IntegerToString(g_st.total)+"\nWinning Trades: "+IntegerToString(g_st.wins)+"\nLosing Trades: "+IntegerToString(g_st.losses)+
          "\nBuy Trades: "+IntegerToString(g_st.buys)+" (W "+IntegerToString(g_st.winBuy)+" / L "+IntegerToString(g_st.loseBuy)+")"+
          "\nSell Trades: "+IntegerToString(g_st.sells)+" (W "+IntegerToString(g_st.winSell)+" / L "+IntegerToString(g_st.loseSell)+")"+
          "\nTotal Profit: "+Money(g_st.totProfit)+"\nTotal Loss: "+Money(-g_st.totLoss)+"\nNet P/L: "+Money(g_st.net)+"\nWin Rate: "+D2(g_st.winRate)+"%"+
          "\nAverage Profit: "+Money(g_st.avgProfit)+"\nAverage Loss: "+Money(-g_st.avgLoss)+
          "\nLargest Loss: "+Money(-g_st.maxLoss)+"\nLargest Profit: "+Money(g_st.maxProfit)+
          "\nCurrent Streak: "+IntegerToString(g_st.streak)+"\nConsecutive SL: "+IntegerToString(g_st.consSL)+"\nConsecutive TP: "+IntegerToString(g_st.consTP)+
          "\nTotal Commission: "+Money(g_st.commission)+"\nTotal Swap: "+Money(g_st.swap)+"\nTotal Volume: "+LotS(g_st.volume)+
          "\nHighest Risk Used: $"+D2(g_st.highRisk)+"\nHighest Lot Used: "+LotS(g_st.highLot)+
          "\nCurrent Risk: $"+D2(g_curRisk)+"\nAccumulated Loss: $"+D2(g_accLoss)+"\nCurrent Trade: #"+TNo(g_tradeNo);
  }

string RiskText()
  {
   double lot,est; string err;
   bool ok=CurrentLotInfo(lot,est,err);
   double nxt=NextRiskForNet(g_cycNet-(ok?est:g_curRisk));
   return "Risk Info\nInitial Risk: $"+D2(g_initRisk)+"\nCurrent Risk: $"+D2(g_curRisk)+"\nNext Risk (if SL): $"+D2(nxt)+"\nAccumulated Loss: $"+D2(g_accLoss)+
          "\nCycle #"+IntegerToString((int)g_cycId)+" ("+CycStateText()+"): net $"+D2(g_cycNet)+" of target $"+D2(g_target)+" | remaining $"+D2(MathMax(g_target-g_cycNet,0.0))+
          "\nTrade Sequence: "+IntegerToString(g_seq)+"\nCurrent Lot: "+(ok?LotS(lot):"n/a ("+err+")")+"\nEstimated Loss at SL: "+(ok?"$"+D2(est):"n/a")+
          "\nTheoretical TP Profit: "+(ok?"$"+D2(est*g_rr):"n/a");
  }

string SettingsText()
  {
   return "Yetimmm Settings\nSymbol: "+g_sym+"\nSL (Upper-Lower): $"+D2(SLDist())+"\nRisk/Reward: 1:"+DoubleToString(g_rr,0)+"\nRecovery Target (sizes next risk): $"+D2(g_target)+
          "\nSpread Alert (alert only): "+IntegerToString(g_warn)+" pts\nMax Slippage Check (post-fill): "+IntegerToString(g_maxDev)+" pts\nMagic Number: "+IntegerToString(g_magic)+
          "\nContract Size: "+DoubleToString(g_contract,2)+"\nAccount Mode: "+(g_netting?"NETTING (external-position guard ON)":"HEDGING")+
          "\nDeviation Action: "+(InpDevAction==YT_DEV_REJECT?"REJECT (close)":"ALERT ONLY")+
          "\nTelegram: "+(g_tgEn?"ENABLED":"DISABLED")+"\nNotifications: "+(g_tgNot?"ON":"OFF")+"\nTelegram Control: "+(g_tgCtl?"ON":"OFF")+
          "\nChats: "+IntegerToString(ArraySize(g_tgIds))+" (public)"+"\nBot Token: HIDDEN";
  }

string HistoryText(int count,int skip)
  {
   string lines[];
   int n=ReadTradeLines(lines);
   if(n==0) return "📊 Yetimmm Trade History\nNo trades recorded yet.";
   if(count<1) count=10;
   if(count>20) count=20;
   if(skip<0) skip=0;
   string s="📊 Yetimmm Trade History\n";
   int end=n-skip;
   int start=MathMax(0,end-count);
   if(end<=0) return s+"No older trades.";
   for(int i=end-1;i>=start;i--)
     {
      string f[];
      if(StringSplit(lines[i],';',f)<30) continue;
      string blk="\n#"+TNo(StringToInteger(f[0]))+" "+f[5]+"\nEntry: "+f[7]+"\nExit: "+f[8]+"\nLot: "+f[11]+"\nRisk: $"+D2(StringToDouble(f[12]))+
                 "\nResult: "+f[23]+"\nP/L: "+Money(StringToDouble(f[18]))+"\n";
      if(StringLen(s)+StringLen(blk)>3700) { s+="\n... (use /history N SKIP for more)"; break; }
      s+=blk;
     }
   return s;
  }

string LastText()
  {
   string lines[];
   int n=ReadTradeLines(lines);
   if(n==0) return "No trades recorded yet.";
   string f[];
   if(StringSplit(lines[n-1],';',f)<30) return "No trades recorded yet.";
   return "Last Trade\nTrade #: "+TNo(StringToInteger(f[0]))+"\nType: "+f[5]+"\nEntry: "+f[7]+"\nExit: "+f[8]+"\nLot: "+f[11]+"\nRisk: $"+D2(StringToDouble(f[12]))+
          "\nResult: "+f[23]+"\nGross Profit: "+Money(StringToDouble(f[15]))+"\nCommission: "+Money(StringToDouble(f[16]))+"\nSwap: "+Money(StringToDouble(f[17]))+
          "\nNet P/L: "+Money(StringToDouble(f[18]));
  }

string HelpText()
  {
   return "Yetimmm Commands\n/start - تشغيل البوت\n/stop - إيقاف البوت\n/set BUY SELL [RISK] - إدخال المستويات والمخاطرة\n/cancel - إلغاء الأوامر / إدارة الإغلاق\n"
          "/status - حالة البوت\n/open - الصفقات المفتوحة\n/orders - الأوامر المعلقة والمنتظرة للسعر\n/del BUY|SELL|TICKET - حذف أمر واحد\n/mod BUY|SELL PRICE - تعديل سعر أمر واحد\n/history [N] [SKIP] - سجل الصفقات\n/last - آخر صفقة\n"
          "/stats - الإحصائيات\n/risk - معلومات المخاطرة\n/settings - الإعدادات\n/menu - لوحة الأزرار\n/help - المساعدة";
  }

//+------------------------------------------------------------------+
//| Max Slippage Check enforcement                                    |
//| MT5 ignores "deviation" for pending orders (the server triggers  |
//| them), so the limit is enforced immediately after the fill: the  |
//| position is closed, the risk sequence is NOT changed, and the    |
//| same orders are re-armed once after a cooldown.                  |
//+------------------------------------------------------------------+
bool CloseRejected(const ulong pid)
  {
   ulong t=0;
   if(!FindLive(pid,t)) return true;
   if(NetTaintRefusesClose("the slippage-reject close")) return false;
   long ot=(PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY)?(long)ORDER_TYPE_BUY:(long)ORDER_TYPE_SELL;
   double px=PositionGetDouble(POSITION_PRICE_OPEN);
   double lt=PositionGetDouble(POSITION_VOLUME);
   ulong exitDev=(ulong)MathMax(500,g_maxDev*10);   // get out even in a fast market
   bool ok=InstOk("close position")&&g_trade.PositionClose(t,exitDev);
   uint rc=g_trade.ResultRetcode();
   LogOrder(ok?"DEV_REJECT_CLOSE":"DEV_REJECT_CLOSE_FAILED",ot,px,lt,t,rc,"Max Slippage Check exceeded");
   YLog(ok?"Deviation reject: position closed #"+UL(t):"Deviation reject: close FAILED #"+UL(t)+" retcode "+IntegerToString((int)rc)+" (retrying)");
   return ok;
  }

void RejectExecution(const ulong pid,const double dev)
  {
   PSet(pid,"CRC",4.0);
   GlobalVariablesFlush();
   YLog("Max Slippage Check exceeded ("+DoubleToString(dev,0)+" > "+IntegerToString(g_maxDev)+" pts): execution REJECTED - closing position "+UL(pid));
   TgQueue("🚫 EXECUTION REJECTED (Maximum Deviation)\nSlippage: "+DoubleToString(dev,0)+" pts > max "+IntegerToString(g_maxDev)+" pts\nThe position is being closed; the risk sequence is unchanged.");
   CloseRejected(pid);
  }

//+------------------------------------------------------------------+
//| CRITICAL protection guard                                        |
//| A Yetimmm position WITHOUT SL/TP is not a normal state: its risk |
//| is unbounded. Detect -> freeze the sequence -> retry every       |
//| second -> critical alert -> emergency close after a timeout.     |
//+------------------------------------------------------------------+
void ProtectionRestored()
  {
   if(!g_unprot) return;
   g_unprot=false; g_unprotPid=0; g_unprotSinceMs=0; g_protTries=0; g_protNextMs=0;
   ClearAlert("PROTFAIL");
   if(StringFind(g_blockReason,"CRITICAL PROTECTION")==0) g_blockReason="";
   YLog("Protection restored: the position carries SL and TP again.");
   TgQueue("🟢 PROTECTION RESTORED\nThe Yetimmm position carries SL and TP again. Sequence resumed.");
   g_dirty=true;
  }

bool EmergencyClose(const ulong pid,const string why)
  {
   ulong t=0;
   if(!FindLive(pid,t)) return true;
   if(NetTaintRefusesClose("the emergency close")) return false;
   long ot=(PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY)?(long)ORDER_TYPE_BUY:(long)ORDER_TYPE_SELL;
   double px=PositionGetDouble(POSITION_PRICE_OPEN);
   double lt=PositionGetDouble(POSITION_VOLUME);
   PSet(pid,"CRC",6.0);
   GlobalVariablesFlush();
   ulong exitDev=(ulong)MathMax(500,g_maxDev*10);   // get out even in a fast market
   bool ok=InstOk("close position")&&g_trade.PositionClose(t,exitDev);
   uint rc=g_trade.ResultRetcode();
   LogOrder(ok?"PROTECTION_CLOSE":"PROTECTION_CLOSE_FAILED",ot,px,lt,t,rc,why);
   YLog((ok?"Emergency close done #":"Emergency close FAILED #")+UL(t)+" retcode "+IntegerToString((int)rc)+" | "+why);
   if(ok) TgQueue("🔴 EMERGENCY CLOSE (no SL/TP protection)\nTicket: #"+UL(t)+"\nReason: "+why+"\nThe risk sequence is unchanged. Enter levels to continue.");
   return ok;
  }

//--- returns true when the position carries SL and TP (restoring them first when needed)
bool ProtectPosition(const ulong pid)
  {
   ulong t=0;
   if(!FindLive(pid,t))
     {
      if(g_unprot && g_unprotPid==pid) { g_unprot=false; g_unprotPid=0; ClearAlert("PROTFAIL"); }
      return true;
     }
   bool buy=(PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY);
   double sl=PositionGetDouble(POSITION_SL), tp=PositionGetDouble(POSITION_TP);
   double ent=PositionGetDouble(POSITION_PRICE_OPEN);
   if(sl>0.0 && tp>0.0)
     {
      if(g_unprot && g_unprotPid==pid) ProtectionRestored();
      return true;
     }
   ulong nowMs=GetTickCount64();
   string miss=(sl<=0.0 && tp<=0.0)?"SL and TP":(sl<=0.0?"SL":"TP");
   if(!g_unprot || g_unprotPid!=pid)
     {
      g_unprot=true; g_unprotPid=pid; g_unprotSinceMs=nowMs; g_protTries=0; g_protNextMs=0;
      g_blockReason="CRITICAL PROTECTION FAILURE: position without "+miss+" - sequence frozen";
      YLog(g_blockReason);
      RaiseAlert("PROTFAIL","🔴 CRITICAL PROTECTION FAILURE: Yetimmm position #"+UL(pid)+" has no "+miss+". Retrying every second; the sequence is frozen"+
                 (InpProtectCloseSec>0?" and the position is closed after "+IntegerToString(InpProtectCloseSec)+" s if protection cannot be set.":"."),true,true);
     }
   if(nowMs<g_protNextMs) return false;
   g_protNextMs=nowMs+1000;
   g_protTries++;

   //--- what the protection must be: the existing value, else the one stored at registration, else derived from the levels
   double eSL=(sl>0.0)?sl:PGV(pid,"SLP",0.0);
   double eTP=(tp>0.0)?tp:PGV(pid,"TPP",0.0);
   double lvl=PGV(pid,"ENT",ent);
   if(lvl<=0.0) lvl=ent;
   if(eSL<=0.0) eSL=SLPrice(buy,lvl);
   if(eTP<=0.0) eTP=TPPrice(buy,lvl);
   if(eSL<=0.0 || eTP<=0.0)
     {
      EmergencyClose(pid,"SL/TP cannot be computed (levels missing)");
      return false;
     }
   //--- a protection that the market has already passed cannot be set: leave the position
   double bid=SymbolInfoDouble(g_sym,SYMBOL_BID), ask=SymbolInfoDouble(g_sym,SYMBOL_ASK);
   if(sl<=0.0 && (buy?(bid<=eSL):(ask>=eSL)))
     {
      EmergencyClose(pid,"SL level "+PX(eSL)+" already crossed while the position had no SL");
      return false;
     }
   if(tp<=0.0 && (buy?(bid>=eTP):(ask<=eTP)))
     {
      EmergencyClose(pid,"TP level "+PX(eTP)+" already reached while the position had no TP");
      return false;
     }
   bool r=InstOk("set SL/TP")&&g_trade.PositionModify(t,eSL,eTP);
   uint rc=g_trade.ResultRetcode();
   bool ok=(r && (rc==TRADE_RETCODE_DONE || rc==TRADE_RETCODE_PLACED));
   if(ok)
     {
      //--- the retcode is not proof: the position must really carry both values now
      ok=false;
      for(int w=0;w<6 && !ok;w++)
        {
         ulong t2=0;
         if(FindLive(pid,t2) && PositionGetDouble(POSITION_SL)>0.0 && PositionGetDouble(POSITION_TP)>0.0) ok=true;
         else Sleep(60);
        }
     }
   if(ok)
     {
      PSet(pid,"SLP",eSL); PSet(pid,"TPP",eTP);
      long ot=buy?(long)ORDER_TYPE_BUY:(long)ORDER_TYPE_SELL;
      LogOrder("PROTECTION_RESTORED",ot,ent,0.0,t,rc,"SL "+PX(eSL)+" TP "+PX(eTP)+" after "+IntegerToString(g_protTries)+" attempt(s)");
      YLog("SL/TP restored on position "+UL(pid)+" | SL "+PX(eSL)+" TP "+PX(eTP));
      ProtectionRestored();
      return true;
     }
   long ot2=buy?(long)ORDER_TYPE_BUY:(long)ORDER_TYPE_SELL;
   LogOrder("PROTECTION_FAILED",ot2,ent,0.0,t,rc,"attempt "+IntegerToString(g_protTries)+": "+g_trade.ResultComment());
   YLog("Protection attempt "+IntegerToString(g_protTries)+" FAILED on #"+UL(pid)+" retcode "+IntegerToString((int)rc)+" "+g_trade.ResultComment());
   if(InpProtectCloseSec>0 && (nowMs-g_unprotSinceMs)>=(ulong)InpProtectCloseSec*1000)
      EmergencyClose(pid,"protection could not be set for "+IntegerToString(InpProtectCloseSec)+" s");
   return false;
  }

//+------------------------------------------------------------------+
//| Trade registration (Trade Number assignment)                     |
//+------------------------------------------------------------------+
long RegisterPosition(const ulong pid)
  {
   if(PHas(pid,"N")) return (long)PGV(pid,"N",0);
   if(IsLoggedPos(pid)) return 0;
   double entry=0.0,vol=0.0,orderPrice=0.0,sl=0.0,tp=0.0;
   long ptype=-1,otype=-1;
   datetime topen=0;
   ulong order=0,dealIn=0;
   if(HistorySelectByPosition(pid))
     {
      int n=HistoryDealsTotal();
      for(int i=0;i<n;i++)
        {
         ulong d=HistoryDealGetTicket(i);
         if(d==0) continue;
         if(HistoryDealGetInteger(d,DEAL_ENTRY)!=DEAL_ENTRY_IN) continue;
         long dt=HistoryDealGetInteger(d,DEAL_TYPE);
         if(dt!=DEAL_TYPE_BUY && dt!=DEAL_TYPE_SELL) continue;
         //--- Netting merges foreign deals into the same position id: the registered lot counts ONLY this bot's deals,
         //--- so a foreign volume that arrived before registration is still detected by NettingDriftCheck
         if(g_netting && (long)HistoryDealGetInteger(d,DEAL_MAGIC)!=g_magic) continue;
         vol+=HistoryDealGetDouble(d,DEAL_VOLUME);
         if(order==0)
           {
            entry=HistoryDealGetDouble(d,DEAL_PRICE);
            topen=(datetime)HistoryDealGetInteger(d,DEAL_TIME);
            order=(ulong)HistoryDealGetInteger(d,DEAL_ORDER);
            ptype=(dt==DEAL_TYPE_BUY)?(long)POSITION_TYPE_BUY:(long)POSITION_TYPE_SELL;
            dealIn=d;
           }
        }
     }
   if(ptype<0) return 0; // history not ready yet, retried on the next sync
   if(order!=0 && HistoryOrderSelect(order))
     {
      orderPrice=HistoryOrderGetDouble(order,ORDER_PRICE_OPEN);
      sl=HistoryOrderGetDouble(order,ORDER_SL);
      tp=HistoryOrderGetDouble(order,ORDER_TP);
      otype=HistoryOrderGetInteger(order,ORDER_TYPE);
     }
   bool buy=(ptype==(long)POSITION_TYPE_BUY);
   ulong live=0;
   if(FindLive(pid,live))
     {
      sl=PositionGetDouble(POSITION_SL);
      tp=PositionGetDouble(POSITION_TP);
     }
   double level=buy?g_buyLevel:g_sellLevel;
   if(orderPrice<=0.0) orderPrice=(level>0.0)?level:entry;
   double dev=MathAbs(entry-orderPrice)/g_point;
   bool marketFill=(otype==(long)ORDER_TYPE_BUY || otype==(long)ORDER_TYPE_SELL);
   double devLim=(double)g_maxDev;               // v2.30: a FAST CATCH fill is judged against the (wider) window it was sent with
   if(marketFill)
     {
      //--- v2.11: REAL post-fill slippage of a market reversal = |actual fill - the price the lot and TP were sized from|
      double expPx=GV("RVEXP",0.0);
      dev=(expPx>0.0)?MathAbs(entry-expPx)/g_point:0.0;
      GS("RVEXP",0.0);                          // consumed
      double rvDev=GV("RVDEV",0.0);
      if(rvDev>devLim) devLim=rvDev;
      GS("RVDEV",0.0);                          // consumed
      //--- the SL/TP the reversal REQUESTED (computed from the real execution price) is the expected protection of this position
      if(sl<=0.0) sl=GV("RVSL",0.0);
      if(tp<=0.0) tp=GV("RVTP",0.0);
      GS("RVSL",0.0); GS("RVTP",0.0);          // consumed (stored below as this position's expected protection)
     }
   double spread=(double)SymbolInfoInteger(g_sym,SYMBOL_SPREAD);

   int priorMode=g_mode;                 // mode before this fill (needed to re-arm after a deviation reject)
   //--- v2.37: a fill of the PRE-ARMED reverse order was planned with the risk / ledger of the step AFTER the stop-out. The stop-out itself may not be booked yet
   //--- (its closing deal arrives in the same instant), so the planned values stored with the order are the truth for this position.
   double useRisk=g_curRisk, useAL=g_accLoss;
   bool   revFill=false;
   if(order!=0 && (ulong)GV("PAO",0.0)==order && GV("PAR",0.0)>0.0)
     {
      revFill=true;
      useRisk=GV("PAR",g_curRisk);
      useAL=GV("PAA",g_accLoss);
      GS("PAO",0.0);
      YLog("Pre-armed reverse order #"+UL(order)+" triggered by the market: planned risk "+D2(useRisk)+" | planned accumulated loss "+D2(useAL)+" | FILLED lot "+LotS(vol));
      LogOrder("REVERSE_FILLED",otype,orderPrice,vol,order,0,"filled lot "+LotS(vol)+" | planned risk "+D2(useRisk)+" | planned acc.loss "+D2(useAL)+" | ledger NOW (previous trade may not be booked yet): cycle net "+D2(g_cycNet));
     }
   g_tradeNo++;
   SaveState();
   PSet(pid,"N",(double)g_tradeNo);
   PSet(pid,"CY",(double)g_cycId);                 // v2.38: the cycle this position belongs to (a result of an older cycle is never booked into a newer one)
   CycTouch();
   PSet(pid,"R",useRisk);
   PSet(pid,"AL",useAL);
   if(revFill) PSet(pid,"PAF",1.0);
   PSet(pid,"BB",AcM(AccountInfoDouble(ACCOUNT_BALANCE)));
   PSet(pid,"SP",spread);
   PSet(pid,"DV",dev);
   PSet(pid,"SLP",sl);
   PSet(pid,"TPP",tp);
   PSet(pid,"LOT",vol);
   PSet(pid,"LB",g_buyLevel);
   PSet(pid,"LS",g_sellLevel);
   PSet(pid,"TY",(double)ptype);
   PSet(pid,"ET",(double)otype);
   PSet(pid,"ENT",orderPrice);
   PSet(pid,"ORD",(double)order);
   PSet(pid,"PM",(double)priorMode);
   //--- v2.48 TRADE PASSPORT: which cycle, which target, which role, what the cycle looked like when this trade was born
   CycOpenIfNeeded("first trade of this cycle");
   PSet(pid,"CT",g_target); PSet(pid,"RL",revFill?1.0:0.0); PSet(pid,"CO",g_cycNet);
   CycLife(g_cycId,"TRADE_OPEN",g_tradeNo,pid,buy?"BUY":"SELL",vol,revFill?"REVERSE_PREARM":(g_state==YT_WAITING_REENTRY?"RE_ENTRY":"ENTRY"),"MINE",g_cycNet,g_cycNet,
           "planned risk "+D2(useRisk)+" | planned acc.loss "+D2(useAL)+" | cycle net at open "+D2(g_cycNet)+" of target "+D2(g_target)+" | SL step so far "+IntegerToString(g_seq)+" | entry "+PX(entry));
   GlobalVariablesFlush();

   //--- make sure the position is protected by SL/TP (a position without them is a CRITICAL failure: see ProtectPosition)
   if(live!=0)
     {
      ProtectPosition(pid);
      if(FindLive(pid,live)) { sl=PositionGetDouble(POSITION_SL); tp=PositionGetDouble(POSITION_TP); }
     }

   if(g_state!=YT_STOPPED)
     {
      g_state=buy?YT_BUY_ACTIVE:YT_SELL_ACTIVE;
      g_mode=YM_NONE;
     }
   g_activeNoPosSince=0;
   SaveState();
   g_dirty=true;

   YLog((buy?"Buy Activated":"Sell Activated")+" | Trade Number Assigned #"+TNo(g_tradeNo)+" | Entry "+PX(entry));
   LogOrder("TRIGGERED",otype,orderPrice,vol,order,0,"Trade #"+TNo(g_tradeNo)+" fill "+PX(entry));
   TgQueue((buy?"🟢 BUY ACTIVATED":"🔴 SELL ACTIVATED")+"\nTrade #: "+TNo(g_tradeNo)+"\nEntry: "+PX(entry)+"\nSL: "+PX(sl)+"\nTP: "+PX(tp)+"\nLot: "+LotS(vol)+
           "\nRisk: $"+D2(useRisk)+(revFill?"\n🔄 Opened by the pre-armed reverse order (stop-and-reverse)":"")+"\nBuy Level: "+PX(g_buyLevel)+"\nSell Level: "+PX(g_sellLevel)+"\nTime: "+TimeToString(topen,TIME_DATE|TIME_SECONDS));
   if(dev>devLim)
     {
      RaiseAlert("DEV","Deviation exceeded: fill slippage "+DoubleToString(dev,0)+" pts > max "+DoubleToString(devLim,0)+" pts (Trade #"+TNo(g_tradeNo)+").",true,true);
      if(InpDevAction==YT_DEV_REJECT && live!=0 && g_state!=YT_STOPPED) RejectExecution(pid,dev);
     }
   return g_tradeNo;
  }

void RegisterLivePositions()
  {
   ulong tk[];
   int n=OwnPositions(tk);
   for(int i=0;i<n;i++)
     {
      if(!PositionSelectByTicket(tk[i])) continue;
      ulong pid=(ulong)PositionGetInteger(POSITION_IDENTIFIER);
      if(!PHas(pid,"N") && !IsLoggedPos(pid)) RegisterPosition(pid);
     }
  }

//+------------------------------------------------------------------+
//| Closed position processing (SL / TP / other)                     |
//+------------------------------------------------------------------+
//--- v2.38 CYCLE LEDGER: ONE booking rule for EVERY closed result that belongs to the current cycle (SL, TP, manual / mobile / web close, stop-out, protection close,
//--- rejected fill, extra position, old / overlapping TP). The NET money result (profit + commission + swap + fees) moves CycleNet. The debt g_accLoss is derived
//--- (max(0,-CycleNet)), so the account's other losses can never enter. Booking NEVER ends a cycle by itself: see CycleComplete / CycleMet. Returns a log text.
string CycleBook(const double net,const string why)
  {
   double before=g_cycNet;
   g_cycNet=NormalizeDouble(before+net,8);
   g_cycTrades++;
   if(net<0.0) g_cycLosses+=-net;
   g_accLoss=(g_cycNet<0.0)?-g_cycNet:0.0;
   g_curRisk=NextRiskForNet(g_cycNet);
   string st=CycleMet(g_cycNet)?"TARGET MET":"remaining "+D2(g_target-g_cycNet);
   string t=why+" net "+D2(net)+" booked in cycle #"+IntegerToString((int)g_cycId)+": CYCLE NET "+D2(before)+" -> "+D2(g_cycNet)+" vs target "+D2(g_target)+" ("+st+") | Acc.Loss "+D2(g_accLoss)+" | next risk "+D2(g_curRisk);
   CycTouch();
   CycOpenIfNeeded("first booking of this cycle");
   YLog("LEDGER: "+t);
   CycLife(g_cycId,"BOOK",g_bookTno,g_bookPid,g_bookSide,g_bookLot,g_bookRole,"MINE",before,g_cycNet,why+" net "+D2(net)+" | "+st+" | Acc.Loss "+D2(g_accLoss)+" | next risk "+D2(g_curRisk));
   g_bookTno=0; g_bookPid=0; g_bookSide=""; g_bookRole=""; g_bookLot=0.0;
   return t;
  }

long g_lastCycIdShown() { return (long)GV("LCID",0.0); }
string CycleFile() { return "Yetimmm_"+IntegerToString(g_magic)+"_Cycles.csv"; }
const string CYCLE_HEADER="CycleId;Trades;SLSteps;CycleLosses;CycleNet;Target;Result;CloseTime;Magic;Symbol";

//--- the ledger part of the completion: record, zero, wait for the user. Idempotent (a restart in COMPLETING runs it again only if the ledger was not zeroed yet).
void CycleFinishLedger(const bool record)
  {
   long id=g_cycId; double cnet=g_cycNet; int trades=g_cycTrades; int steps=g_seq; double losses=g_cycLosses;
   if(record && (long)GV("LCID",0.0)!=id)                       // never records the same cycle twice (restart in COMPLETING)
     {
      string line=IntegerToString((int)id)+";"+IntegerToString(trades)+";"+IntegerToString(steps)+";"+D2(losses)+";"+D2(cnet)+";"+D2(g_target)+";TARGET_MET;"+
                  TimeToString(TimeCurrent(),TIME_DATE|TIME_SECONDS)+";"+IntegerToString(g_magic)+";"+g_sym;
      AppendLine(CycleFile(),CYCLE_HEADER,line);
      GS("LCID",(double)id); GS("LCNET",cnet); GS("LCTR",(double)trades); GS("LCTM",(double)TimeCurrent());
      string t="CYCLE #"+IntegerToString((int)id)+" COMPLETE | trades "+IntegerToString(trades)+" | SL steps "+IntegerToString(steps)+" | cycle losses "+D2(losses)+
               " | CYCLE NET "+D2(cnet)+" vs target "+D2(g_target)+" | TARGET MET | ledger zeroed, pending orders cancelled, waiting for the user";
      YLog(t);
      LogOrder("CYCLE_COMPLETE",-1,0.0,0.0,0,0,t);
      CycCloseLife(id,"TARGET_MET",cnet,trades,steps,losses);
      TgQueue("🏁 CYCLE #"+IntegerToString((int)id)+" COMPLETE\nTrades: "+IntegerToString(trades)+" | SL steps: "+IntegerToString(steps)+"\nCycle losses: $"+D2(losses)+"\nCYCLE NET: $"+D2(cnet)+" (target $"+D2(g_target)+") ✅\nLedger zeroed. The bot WAITS for your START.");
      ClearAlert("CYCSHORT");
     }
   ResetRisk();                                               // new CycleId, empty ledger: nothing is inherited
   GS("CYCDAY",(double)DayKeyNow());                          // InpOneCyclePerDay
   g_lastSLSide=0;
   g_mode=YM_NONE;
   g_state=YT_TP_RESET;                                       // = WAITING_USER: no automatic re-arming
   g_cycState=YC_COMPLETING;
   if(g_fresh) PromotePending();                              // levels the user queued become the saved levels - but NOTHING is armed
  }

//--- v2.38: THE ONE place where a cycle can end. Called after every booking. Only when CycleNet >= target and no position of the EA is open:
//--- COMPLETING (saved) -> record -> zero the ledger -> cancel the cycle's pending orders -> WAITING_USER.
bool CycleTryComplete(const ulong dealOut)
  {
   if(g_cycState==YC_COMPLETING) return false;
   if(!CycleMet(g_cycNet)) return false;
   ulong rp[];
   if(OwnPositions(rp)>0) return false;                       // a position of the cycle is still open: its result must be booked first
   g_cycState=YC_COMPLETING;
   if(dealOut!=0) g_lastDeal=dealOut;
   SaveState();                                               // crash here: restart sees COMPLETING + CycleNet>=target and finishes (CycleCompletionTick)
   CycleFinishLedger(true);
   CleanupOrders("Cycle complete: pending orders of the finished cycle cancelled");
   ulong od[];
   if(OwnOrders(od)==0) g_cycState=YC_WAITING_USER;           // else it stays COMPLETING and CycleCompletionTick retries
   SaveState();
   g_dirty=true;
   return true;
  }

//--- v2.38: restart / retry safety for the completion above.
void CycleCompletionTick()
  {
   if(g_cycState!=YC_COMPLETING) return;
   if(g_cycTrades>0 && CycleMet(g_cycNet))                     // crashed before the ledger was zeroed (the record is written only if this CycleId has none yet)
     {
      CycleFinishLedger(true);
      SaveState();
     }
   ulong od[];
   if(OwnOrders(od)>0)
     {
      if(GetTickCount64()>=g_nextDelMs)
        {
         if(!CleanupOrders("Cycle complete: pending orders of the finished cycle cancelled")) g_nextDelMs=GetTickCount64()+2000;
        }
      return;
     }
   g_cycState=YC_WAITING_USER;
   SaveState();
   YLog("Cycle completion confirmed: no pending order left - WAITING_USER (START or new levels required).");
  }

bool ProcessClosedPosition(const ulong pid)
  {
   if(IsLoggedPos(pid)) { ClearPosGV(pid); return true; }
   if(!HistorySelectByPosition(pid)) return false;
   int n=HistoryDealsTotal();
   double inVol=0,outVol=0,gross=0,comm=0,swap=0,exitPrice=0,entryPrice=0;
   datetime tOpen=0,tClose=0;
   long tCloseMsc=0;
   string outComment="";
   ulong dealIn=0,dealOut=0,orderIn=0,orderOut=0;
   long ptype=-1,reason=-1;
   bool foreignIn=false;                                   // Netting: a foreign ENTRY deal merged into this position id
   double extInVol=0.0;                                    // v4.30: Netting: ENTRY volume that did NOT come from this EA (to attribute the bot's share of a mixed position)
   for(int i=0;i<n;i++)
     {
      ulong d=HistoryDealGetTicket(i);
      if(d==0) continue;
      long dtype=HistoryDealGetInteger(d,DEAL_TYPE);
      if(dtype!=DEAL_TYPE_BUY && dtype!=DEAL_TYPE_SELL) continue;
      long entry=HistoryDealGetInteger(d,DEAL_ENTRY);
      double vol=HistoryDealGetDouble(d,DEAL_VOLUME);
      if(g_netting && entry==DEAL_ENTRY_IN && (long)HistoryDealGetInteger(d,DEAL_MAGIC)!=g_magic) { foreignIn=true; extInVol+=vol; }
      double pr=HistoryDealGetDouble(d,DEAL_PRICE);
      datetime tm=(datetime)HistoryDealGetInteger(d,DEAL_TIME);
      comm+=AcM(HistoryDealGetDouble(d,DEAL_COMMISSION)+HistoryDealGetDouble(d,DEAL_FEE));
      swap+=AcM(HistoryDealGetDouble(d,DEAL_SWAP));
      if(entry==DEAL_ENTRY_IN)
        {
         inVol+=vol;
         if(dealIn==0)
           {
            dealIn=d; tOpen=tm; entryPrice=pr;
            orderIn=(ulong)HistoryDealGetInteger(d,DEAL_ORDER);
            ptype=(dtype==DEAL_TYPE_BUY)?(long)POSITION_TYPE_BUY:(long)POSITION_TYPE_SELL;
           }
        }
      else if(entry==DEAL_ENTRY_OUT || entry==DEAL_ENTRY_OUT_BY || entry==DEAL_ENTRY_INOUT)
        {
         outVol+=vol;
         gross+=AcM(HistoryDealGetDouble(d,DEAL_PROFIT));
         dealOut=d; tClose=tm; exitPrice=pr;
         reason=HistoryDealGetInteger(d,DEAL_REASON);
         tCloseMsc=(long)HistoryDealGetInteger(d,DEAL_TIME_MSC);
         outComment=HistoryDealGetString(d,DEAL_COMMENT);
         orderOut=(ulong)HistoryDealGetInteger(d,DEAL_ORDER);
        }
     }
   if(inVol<=0.0 || dealOut==0) return false;             // history not ready yet
   if(outVol<inVol-1e-8) return false;                     // not fully closed yet
   if(IsLoggedDeal(dealOut)) { ClearPosGV(pid); return true; }

   double net=gross+comm+swap;
   //--- v2.34: learn the REAL round-trip commission per lot (in + out deals) so the next lot is cost-aware
   if(comm<-1e-9 && inVol>0.0) { g_commLot=-comm/inVol; GS("CPL",g_commLot); }
   bool buy=(ptype==(long)POSITION_TYPE_BUY);
   long tno=(long)PGV(pid,"N",0);
   g_bookTno=tno; g_bookPid=pid; g_bookSide=buy?"BUY":"SELL"; g_bookLot=inVol;                    // v2.48: the journal line of this booking names the trade
   g_bookRole=(PGV(pid,"RL",0.0)>0.5)?"REVERSE_PREARM":"ENTRY";
   double reqRisk=PGV(pid,"R",g_curRisk);
   double accBefore=PGV(pid,"AL",g_accLoss);
   double balBefore=PGV(pid,"BB",0);
   double spread=PGV(pid,"SP",0);
   double dev=PGV(pid,"DV",0);
   double slp=PGV(pid,"SLP",0), tpp=PGV(pid,"TPP",0);
   double lbuy=PGV(pid,"LB",g_buyLevel), lsell=PGV(pid,"LS",g_sellLevel);
   long otype=(long)PGV(pid,"ET",-1);
   long cmd=(long)PGV(pid,"CRC",0);

   //--- v2.29: the broker's own SL/TP flag is read from THREE places (deal reason, closing-order reason, deal comment "[sl ...]"/"[tp ...]"),
   //--- so a stop that filled with slippage is still an SL. Unknown reasons are never guessed unless the price proves it (see below).
   long oreason=-1;
   if(orderOut!=0 && HistoryOrderSelect(orderOut)) oreason=HistoryOrderGetInteger(orderOut,ORDER_REASON);
   string lcm=outComment;
   StringToLower(lcm);
   bool brokerSL=(reason==DEAL_REASON_SL || oreason==ORDER_REASON_SL);
   bool brokerTP=(reason==DEAL_REASON_TP || oreason==ORDER_REASON_TP);
   string cnote="";
   if(!brokerSL && !brokerTP && cmd==0)
     {
      if(StringFind(lcm,"[sl")>=0) { brokerSL=true; cnote="classified SL from the deal comment"; }
      else if(StringFind(lcm,"[tp")>=0) { brokerTP=true; cnote="classified TP from the deal comment"; }
     }
   string rs;
   if(brokerSL && !(reason==DEAL_REASON_TP)) rs="SL";
   else if(brokerTP) rs="TP";
   else if(cmd==1) rs="Manual Stop";
   else if(cmd==2) rs="Telegram Stop";
   else if(cmd==3) rs="Telegram Cancel";
   else if(cmd==4) rs="Deviation Reject";
   else if(cmd==5) rs="Extra Position Closed";
   else if(cmd==6) rs="Protection Close";
   else
     {
      double tol=MathMax(g_point*5.0,g_tick*3.0);
      //--- v2.11: the price fallback applies ONLY when the reason is unknown; a manual / mobile / web / stop-out / EA close is never re-labelled SL or TP
      bool reasonUnknown=(reason!=DEAL_REASON_CLIENT && reason!=DEAL_REASON_MOBILE && reason!=DEAL_REASON_WEB &&
                          reason!=DEAL_REASON_SO && reason!=DEAL_REASON_EXPERT);
      //--- v2.29: "at or BEYOND the stop" counts as SL (slippage on a gap), "at or beyond the target" as TP. Only when no explicit reason exists.
      bool slHit=(slp>0.0) && (buy?(exitPrice<=slp+tol):(exitPrice>=slp-tol));
      bool tpHit=(tpp>0.0) && (buy?(exitPrice>=tpp-tol):(exitPrice<=tpp+tol));
      if(InpPriceFallback && reasonUnknown && slHit) { rs="SL"; cnote="reason unknown: exit price at/beyond SL ("+PX(exitPrice)+" vs "+PX(slp)+") -> SL by price"; }
      else if(InpPriceFallback && reasonUnknown && tpHit) { rs="TP"; cnote="reason unknown: exit price at/beyond TP -> TP by price"; }
      else if(reason==DEAL_REASON_SO) rs="Stop Out";
      else if(reason==DEAL_REASON_CLIENT || reason==DEAL_REASON_MOBILE || reason==DEAL_REASON_WEB) rs="Manual (External)";
      else rs="Other";
     }

   double entryLevel=buy?lbuy:lsell;
   if(entryLevel<=0.0) entryLevel=entryPrice;
   //--- theoretical loss at SL from the levels this position was opened with (not from today's levels)
   double theoSL=buy?lsell:lbuy;
   double theoLoss=inVol*PerLotLossSL(buy,entryLevel,(theoSL>0.0 && theoSL!=entryLevel)?theoSL:SLPrice(buy,entryLevel));
   double theoProfit=theoLoss*g_rr;

   //--- Netting: a position that absorbed foreign volume has a P/L that is NOT purely this bot's.
   //--- It is logged, but it never feeds the risk sequence (no accumulated loss, no risk step, no TP reset).
   bool tainted=(g_netting && (foreignIn || PGV(pid,"TAINT",0.0)>0.5));
   //--- v2.36: today's realized NET (for the daily loss limit). Once per closing deal (DLDL marker); never for a netting-tainted position.
   if(!tainted && (ulong)GV("DLDL",0.0)!=dealOut) { DayNetAdd(net); GS("DLDL",(double)dealOut); }
   if(g_netting && foreignIn && PGV(pid,"TAINT",0.0)<=0.5)
      YLog("Netting: position "+UL(pid)+" absorbed foreign volume (found in its history) - logged, but NOT counted in the risk sequence / statistics.");

   //--- apply the risk logic exactly once for this position
   ulong rest[];
   int others=OwnPositions(rest);
   bool bookkeeping=(g_state==YT_STOPPED || g_stopCleanup);
   //--- v2.29: a position marked as the EXTRA one (CRC=5) is an extra even if the broker's SL/TP hit it before our market close:
   //--- it is a real loss of the running sequence, never a new SL step / TP reset.
   bool markedExtra=(cmd==5);
   bool isSL=(rs=="SL" && !tainted && !markedExtra), isTP=(rs=="TP" && !tainted && !markedExtra), isDev=(rs=="Deviation Reject" && !tainted);
   bool isExtra=((rs=="Extra Position Closed" || markedExtra) && !tainted);
   //--- v2.29: OLD EVENT guard. A closing deal older than the last one already applied 
   //--- may update the loss / sequence numbers, but it must NEVER rewrite the state, mode or levels that a newer event already set.
   long ldtm=(long)GV("LDTM",0.0);
   bool staleEv=(ldtm>0 && tCloseMsc>0 && tCloseMsc<ldtm);
   bool keepState=staleEv;   // an overlapping position (others>0) is handled by Reconcile exactly as before; only a genuinely OLDER deal is kept away from the state
   //--- v2.29: crash-safety replay: the previous run applied this deal and saved the state but died before the log line was written
   bool replay=(dealOut!=0 && g_lastDeal==dealOut);
   if(replay)
     {
      bookkeeping=true;
      cnote="replayed after a restart: the risk effect of this deal was already applied and saved";
      YLog("Closing deal "+UL(dealOut)+" was already applied before a restart - only its log line is written (loss NOT counted twice).");
     }
   //--- v2.38 OWNERSHIP BY CYCLE: Magic + Symbol decide which positions are tracked at all; the saved CycleId decides WHICH CYCLE a tracked position belongs to.
   //--- A position of a cycle that was already completed / reset is logged but NEVER booked into the current cycle (no inherited result, no double count).
   long posCyc=(long)PGV(pid,"CY",0.0);
   bool orphanCyc=(posCyc>0 && posCyc!=g_cycId);
   if(orphanCyc && !bookkeeping)
     {
      bookkeeping=true;
      cnote="belongs to cycle #"+IntegerToString((int)posCyc)+" (current cycle #"+IntegerToString((int)g_cycId)+"): logged only, NOT booked in the current cycle";
      YLog("Closing deal "+UL(dealOut)+" belongs to an older cycle (#"+IntegerToString((int)posCyc)+") - its result is NOT booked in cycle #"+IntegerToString((int)g_cycId)+".");
      CycLife(posCyc,"CLOSE_NOT_BOOKED",tno,pid,buy?"BUY":"SELL",inVol,"","MINE_OLD_CYCLE",g_cycNet,g_cycNet,"net "+D2(net)+" belongs to cycle #"+IntegerToString((int)posCyc)+", current cycle #"+IntegerToString((int)g_cycId)+": logged only");
      g_bookTno=0; g_bookPid=0;
      RaiseAlert("OLDCYC"+IntegerToString((int)tno),"Trade #"+TNo(tno)+" (net "+D2(net)+") closed after its cycle #"+IntegerToString((int)posCyc)+" had ended. It was NOT added to the current cycle.",false,true);
     }
   //--- v4.30 (final polish, problem 1): a result that closes while the EA is STOPPED (manual Stop / Telegram Stop / Cancel sweep, or a broker SL that fires during the stop)
   //--- is REAL money of the cycle. It is booked in the ledger (net only: no state / mode / level change, no re-arm) so the debt cannot be lost by pressing STOP.
   //--- Replays and positions of an older cycle stay bookkeeping-only exactly as before.
   const bool stopLedger=(bookkeeping && !replay && !orphanCyc && (g_state==YT_STOPPED || g_stopCleanup));
   bool ledgerBooked=false;                                     // v4.30: a booking happened on a path that is not the normal one (stopped / Netting share)
   //--- v4.30 (problem 4) CONSERVATIVE NETTING POLICY: a Netting position that absorbed foreign volume cannot be split into "bot money" and "foreign money".
   //--- No estimate is treated as a financial split. The rule never loses a loss and never credits an unconfirmed profit:
   //---   net < 0  -> the WHOLE loss is booked in the ledger (the debt may be larger than the bot's own share - the safe side)
   //---   net >= 0 -> NOTHING is credited (a mixed profit cannot repay the debt)
   //--- The foreign entry volume (when known) is only written to the log for the user's information. InpCountManualResults=false restores the old behaviour.
   double taintNet=0.0; bool taintDo=false; string taintNote="";
   if(tainted && InpCountManualResults)
     {
      if(net<0.0)
        {
         taintNet=net; taintDo=true;
         taintNote="LEDGER_BOOKED full loss "+D2(net)+" (mixed Netting position: the loss is never dropped; foreign entry volume "+(extInVol>1e-9?LotS(extInVol)+" of "+LotS(inVol):"not found in history")+")";
        }
      else
         taintNote="mixed Netting position: profit "+D2(net)+" NOT credited to the ledger (cannot be separated from foreign volume)";
     }
   string nextInfo="";
   string ledNote="";                                           // v2.38: cycle-ledger effect of a result
   string cycTxt="";                                            // v2.34: cycle summary (TP that ends a cycle)
   double nextLot=0,nextEst=0; string lerr="";
   if(!bookkeeping)
     {
      //--- v2.28: the loss of an EXTRA position (closed at market by the one-position rule) is a REAL loss of the running sequence:
      //--- it joins the accumulated loss so the next risk recovers it too. It is NOT an SL step (Seq unchanged).
      if(isExtra && net<0.0)
        {
         ledNote=CycleBook(net,"Extra position loss");
        }
      else if(isExtra && net>0.0 && InpCountManualResults) ledNote=CycleBook(net,"Extra position");
      //--- v2.36 POLICY (report section 7): a result is judged by its NET money, never by the close reason alone. Manual / mobile / web closes,
      //--- stop-outs, protection closes and rejected fills enter the ledger. InpCountManualResults=false restores the old behaviour.
      if(InpCountManualResults && !tainted && !isSL && !isTP && !isExtra) ledNote=CycleBook(net,rs);
      if(tainted)
        {
         if(taintDo) { ledNote=CycleBook(taintNet,"Netting-mixed "+rs+" (whole loss)"); ledgerBooked=true; YLog("Netting: "+taintNote); }
         if(others==0) { g_mode=YM_NONE; g_state=YT_IDLE; g_lastSLSide=0; }
         g_failCount=0;
        }
      else if(isSL)
        {
         ledNote=CycleBook(net,"SL");
         g_seq++;
         g_lastLossLot=inVol; g_lastLossNet=net; g_lastLossBuy=buy;     // v2.48: remembered for RecoveryTrace
         if(keepState)
           {
            //--- v2.29: an OLD / overlapping SL: the loss and the Seq step count, but the CURRENT state, mode and levels are left exactly as they are
            YLog("Old/overlapping SL event (Trade #"+TNo(tno)+"): loss and Seq applied, current state "+StateText()+" and levels NOT touched.");
           }
         else
           {
            //--- v2.00: a VERIFIED Stop Loss closed the position -> BOTH stop orders are prepared again (Upper = Buy Stop, Lower = Sell Stop)
            g_mode=YM_BOTH;
            g_state=YT_WAITING_REENTRY;
            g_lastSLSide=buy?1:2;
            g_nextPlaceMs=0;
            g_failCount=0;
            //--- the ORIGINAL levels of the position that just stopped out are restored (its SL was the opposite level)
            if(lbuy>0.0 && lsell>0.0 && (!PriceEq(g_buyLevel,lbuy) || !PriceEq(g_sellLevel,lsell)))
              {
               YLog("Original levels restored for re-arm: Buy "+PX(g_buyLevel)+" -> "+PX(lbuy)+" | Sell "+PX(g_sellLevel)+" -> "+PX(lsell));
               g_buyLevel=lbuy; g_sellLevel=lsell;
              }
            double lvl=buy?g_sellLevel:g_buyLevel;   // the opposite direction is the next one (same SL distance on both sides)
            if(!CalcLot(g_curRisk,!buy,lvl,nextLot,nextEst,lerr)) nextLot=0;
           }
        }
      else if(isTP && keepState)
        {
         //--- v2.36: an OLD TP that arrives after a newer event: its NET result is still real money. It repays the live debt (never below zero);
         //--- the state, mode and levels stay exactly as the newer event set them (nothing else is touched).
         ledNote=CycleBook(net,"Old/overlapping TP (Trade #"+TNo(tno)+")");
         RaiseAlert("STALETP"+IntegerToString((int)tno),"An older TP (Trade #"+TNo(tno)+", net "+D2(net)+") was processed after a newer event. Its net result was applied to the ledger: Acc.Loss "+D2(g_accLoss)+", Seq "+IntegerToString(g_seq)+". State and levels untouched.",true,true);
        }
      else if(isTP)
        {
         //--- v2.38: a TP is just a closed trade. Its NET goes into the cycle ledger; the cycle ends ONLY when the whole cycle's net reaches the target.
         ledNote=CycleBook(net,"TP");
         g_lastSLSide=0;
         if(others==0) CleanupOrders("TP hit: the pair is finished - leftover pending order deleted");   // v2.45.1: also here (restart / missed event); cycle end or re-arm is decided below
         if(CycleMet(g_cycNet) && others==0)
           {
            cycTxt="CYCLE #"+IntegerToString((int)g_cycId)+" NET "+D2(g_cycNet)+" >= target "+D2(g_target)+" -> COMPLETE";
            // the completion itself (record / zero / cancel / WAITING_USER) runs below, after the closing deal id is saved
           }
         else if(others==0)
           {
            //--- not complete: the cycle CONTINUES (ACTIVE) with the remaining target; both stop orders are re-armed at the ORIGINAL levels. No reset.
            cycTxt="CYCLE #"+IntegerToString((int)g_cycId)+" NOT complete: NET "+D2(g_cycNet)+" vs target "+D2(g_target)+" - remaining "+D2(g_target-g_cycNet)+" | the cycle continues, next risk "+D2(g_curRisk);
            YLog(cycTxt);
            LogOrder("CYCLE_CONTINUES",-1,0.0,inVol,0,0,cycTxt);
            RaiseAlert("TPPART"+IntegerToString((int)g_tradeNo),"TP closed with net "+D2(net)+" "+AccCcy()+" but the cycle net is "+D2(g_cycNet)+" of "+D2(g_target)+": NOT complete (remaining "+D2(g_target-g_cycNet)+"). The cycle continues; nothing is reset.",false,true);
            if(lbuy>0.0 && lsell>0.0 && (!PriceEq(g_buyLevel,lbuy) || !PriceEq(g_sellLevel,lsell))) { g_buyLevel=lbuy; g_sellLevel=lsell; }
            g_mode=YM_BOTH;
            g_state=YT_ARMED;
            g_nextPlaceMs=0;
            g_failCount=0;
           }
        }
      else if(isDev && keepState)
        {
         YLog("Old/overlapping Deviation-Reject close (Trade #"+TNo(tno)+"): state and levels NOT touched.");
        }
      else if(isDev)
        {
         int pm=(int)PGV(pid,"PM",(double)YM_BOTH);
         if(pm!=YM_BOTH && pm!=YM_BUY && pm!=YM_SELL) pm=YM_BOTH;
         g_failCount=0;
         g_nextPlaceMs=GetTickCount64()+30000;   // cooldown: no immediate re-fill / no repeated orders
         if((otype==(long)ORDER_TYPE_BUY || otype==(long)ORDER_TYPE_SELL) && (g_lastSLSide==1 || g_lastSLSide==2))
           {
            //--- v2.11: a rejected MARKET reversal keeps its direction: back to WAITING_REENTRY (the reversal / pending pair is retried after the cooldown)
            g_mode=YM_BOTH;
            g_state=YT_WAITING_REENTRY;
            g_nextRevMs=GetTickCount64()+30000;
           }
         else
           {
            g_mode=pm;
            g_state=YT_ARMED;
           }
        }
      else if(others==0 && !staleEv && g_state!=YT_ARMED && g_state!=YT_WAITING_REENTRY && !isExtra)
        {
         //--- v2.28: never overwrite a state that ALREADY moved on (e.g. the kept position hit its SL and the pair was re-armed
         //--- before this older closing deal was processed): going IDLE there would drop the pending pair and stop the sequence.
         if(g_fresh) PromotePending();
         g_mode=YM_NONE;
         g_state=YT_IDLE;
        }
     }
   bool stopBooked=false;
   if(stopLedger)
     {
      if(tainted)
        {
         if(taintDo) { ledNote=CycleBook(taintNet,"Netting-mixed "+rs+" (whole loss, while stopped)"); stopBooked=true; YLog("Netting: "+taintNote); }
        }
      else if(isSL)
        {
         ledNote=CycleBook(net,"SL (closed while stopped)");
         g_seq++;                                       // an SL is a sequence step (the sequence audit counts SL rows); NO re-arm while stopped
         stopBooked=true;
        }
      else if(isTP || InpCountManualResults)
        {
         ledNote=CycleBook(net,rs+" (closed while stopped)");
         stopBooked=true;
        }
      if(stopBooked)
        {
         ledgerBooked=true;
         cnote="STOPPED: net "+D2(net)+" booked in the cycle ledger (no state change)";
         YLog("LEDGER (stopped): "+ledNote);
         if(CycleMet(g_cycNet))
            RaiseAlert("STOPTARGET","The result closed while STOPPED brought the cycle net to "+D2(g_cycNet)+" (target "+D2(g_target)+"). The cycle is recorded and closed when you press START; the next cycle then starts empty.",false,true);
        }
     }
   double accAfter=g_accLoss;
   double nextRisk=g_curRisk;
   double cycNetAfter=g_cycNet;            // v2.38: logged BEFORE a completion zeroes the ledger
   if(!bookkeeping && !isSL && !isTP) nextRisk=g_curRisk;

   //--- v2.29: the new risk numbers and the id of this closing deal are SAVED TOGETHER before the log line is written, so a crash in between
   //--- can neither lose this loss nor count it twice (see "replay" above).
   if(!bookkeeping || replay || stopBooked)
     {
      g_lastDeal=dealOut;
      if(tCloseMsc>ldtm) GS("LDTM",(double)tCloseMsc);
      SaveState();
      //--- v2.42 FAST REVERSE (report Fix_1, problem 3): the loss is booked and saved together with its closing deal (crash-safe replay exists), the cause of the
      //--- close was verified as a broker Stop Loss and no other position is open: the opposite Stop order starts NOW - before the trade log, statistics and
      //--- notifications below are written. One reversal per closed position (g_revPid); the journal / request ledger still block a second copy.
      if(isSL && !bookkeeping && !keepState && !tainted && others==0 && g_state==YT_WAITING_REENTRY)
        {
         g_bookedPid=pid;
         g_revPid=pid;
         g_tlBookMs=GetTickCount64();
         FastReverseNow();
        }
     }
   //--- persistent trade log (once per position)
   string line=IntegerToString(tno)+";"+UL(orderIn)+";"+UL(dealIn)+";"+UL(dealOut)+";"+UL(pid)+";"+(buy?"BUY":"SELL")+";"+OTypeStr(otype)+";"+
               PX(entryPrice)+";"+PX(exitPrice)+";"+PX(slp)+";"+PX(tpp)+";"+LotS(inVol)+";"+D2(reqRisk)+";"+D2(theoLoss)+";"+D2(theoProfit)+";"+
               D2(gross)+";"+D2(comm)+";"+D2(swap)+";"+D2(net)+";"+DoubleToString(spread,0)+";"+DoubleToString(dev,0)+";"+
               TimeToString(tOpen,TIME_DATE|TIME_SECONDS)+";"+TimeToString(tClose,TIME_DATE|TIME_SECONDS)+";"+rs+";"+
               D2(balBefore)+";"+D2(AcM(AccountInfoDouble(ACCOUNT_BALANCE)))+";"+D2(accBefore)+";"+D2(accAfter)+";"+D2(reqRisk)+";"+D2(nextRisk)+";"+
               PX(lbuy)+";"+PX(lsell)+";"+IntegerToString(g_magic)+";"+g_sym+";"+(tainted?"CLOSED_NET_TAINTED":"CLOSED")+";"+
               Clean(tainted?(ledgerBooked?"Netting: external volume merged - "+taintNote:"Netting: external volume merged - risk sequence NOT updated"):(bookkeeping?((replay || stopBooked)?cnote:"bookkeeping only"):cnote));
   AppendLine(TradeFile(),TRADE_HEADER,line);
   MarkLogged(pid,dealOut);
   g_bookedPid=0;
   if(!tainted) StatsAdd(net,comm,swap,buy?"BUY":"SELL",inVol,reqRisk,rs);
   g_lastDeal=dealOut;
   GS("LDT",(double)tClose);                 // time of the last processed closing deal (history-recovery fallback anchor)
   SaveState();
   ClearPosGV(pid);
   g_dirty=true;
   YLog("Trade History Updated: #"+TNo(tno)+" "+rs+" net "+D2(net));
   YLog("Statistics Updated");

   //--- v2.38: the ONE completion rule, for EVERY booking path above (SL / TP / manual / extra / old TP): ends the cycle only when CycleNet >= target
   //--- and no position is open. It cancels the cycle's pending orders, records the result, zeroes the ledger and waits for the user.
   bool cycDone=false;
   if(!stopBooked && ((!bookkeeping && !tainted) || (ledgerBooked && !bookkeeping))) cycDone=CycleTryComplete(dealOut);   // v4.30: a Netting share may end the cycle; a result booked while STOPPED never changes the state (START closes the cycle)
   if(cycDone) cycTxt="CYCLE #"+IntegerToString((int)g_lastCycIdShown())+" COMPLETE | CYCLE NET "+D2(GV("LCNET",0.0))+" vs target "+D2(g_target)+" | ledger zeroed - WAITING FOR YOUR START";

   //--- notifications
   if(!isSL) { g_tlTrMs=0; g_tlBookMs=0; }                  // v2.42: the timeline belongs to a stop-loss reversal only
   if(isSL)
     {
      YLog("Stop Loss | New Risk Calculated "+D2(g_curRisk)+" | New Lot Calculated "+(nextLot>0?LotS(nextLot):"n/a"));
      TgQueue("🔴 STOP LOSS\nTrade #: "+TNo(tno)+"\nType: "+(buy?"BUY":"SELL")+"\nEntry: "+PX(entryPrice)+"\nExit: "+PX(exitPrice)+"\nLot: "+LotS(inVol)+
              "\nLoss: "+Money(net)+"\nAccumulated Loss: $"+D2(g_accLoss)+"\nNext Risk: $"+D2(g_curRisk)+"\nNext Lot: "+(nextLot>0?LotS(nextLot):"n/a ("+lerr+")")+
              (others>0?"\n🔄 The reverse trade is already open (pre-armed order) - no re-entry gap.":(stopBooked?"\n⏸ Bot is STOPPED: the loss is booked in the ledger, nothing was re-armed. START continues the same cycle.":"\nRe-armed (both sides):\nBuy Stop: "+PX(g_buyLevel)+"\nSell Stop: "+PX(g_sellLevel))));
     }
   else if(isTP)
     {
      YLog("Take Profit | "+(cycDone?"cycle completed":"cycle NOT complete (net "+D2(cycNetAfter)+" of "+D2(g_target)+")"));
      TgQueue("🟢 TAKE PROFIT\nTrade #: "+TNo(tno)+"\nType: "+(buy?"BUY":"SELL")+"\nEntry: "+PX(entryPrice)+"\nExit: "+PX(exitPrice)+"\nProfit: "+Money(net)+
              (cycDone?"\nCycle target reached ✅ (ledger zeroed)":"\nCycle NOT complete: net $"+D2(cycNetAfter)+" of $"+D2(g_target)+" - remaining $"+D2(g_target-cycNetAfter)+"\nNext Risk: $"+D2(g_curRisk))+
              (cycTxt!=""?"\n"+cycTxt:"")+"\nStatus:\n"+(cycDone?"WAITING FOR YOUR START":(g_state==YT_ARMED?"ARMED (cycle continues)":"WAITING")));
     }
   else if(isDev)
     {
      YLog("Execution rejected (Max Deviation) Trade #"+TNo(tno)+" net "+D2(net)+" | "+(ledNote!=""?"net result applied to the ledger, ":"risk sequence unchanged, ")+"orders re-armed at the original levels");
      TgQueue("🚫 EXECUTION REJECTED (Max Deviation)\nTrade #: "+TNo(tno)+"\nType: "+(buy?"BUY":"SELL")+"\nEntry: "+PX(entryPrice)+"\nExit: "+PX(exitPrice)+"\nNet P/L: "+Money(net)+
              (bookkeeping?"":"\nRisk sequence unchanged. Orders re-armed at the original levels after a short cooldown."));
     }
   else
     {
      YLog("Position closed ("+rs+") Trade #"+TNo(tno)+" net "+D2(net)+(tainted?(ledgerBooked?" | NETTING-TAINTED: whole loss booked in the ledger, not in statistics":" | NETTING-TAINTED: not counted in the risk sequence / statistics"):"")+(stopBooked?" | booked in the ledger while STOPPED":""));
      TgQueue("⚪ POSITION CLOSED ("+rs+")\nTrade #: "+TNo(tno)+"\nType: "+(buy?"BUY":"SELL")+"\nEntry: "+PX(entryPrice)+"\nExit: "+PX(exitPrice)+"\nNet P/L: "+Money(net)+
              (tainted?(ledgerBooked?"\n⚠️ Netting: external volume was merged into this position. The whole loss was booked in the ledger ("+taintNote+"); statistics exclude it.":"\n⚠️ Netting: external volume was merged into this position. Its result is NOT counted in the risk sequence or statistics."):"")+
              ((bookkeeping && !stopBooked)?"":(isExtra?"\nExtra position (one-position rule). Ledger: Acc.Loss $"+D2(g_accLoss)+" | Next Risk: $"+D2(g_curRisk)
                                      +(g_state==YT_IDLE?"\nWaiting for levels (/set BUY SELL) or START.":""):
                                 (ledNote!=""?"\nLedger: Acc.Loss $"+D2(g_accLoss)+" | Next Risk: $"+D2(g_curRisk)+(g_state==YT_IDLE?"\nWaiting for levels (/set BUY SELL) or START.":""):
                                 (g_state==YT_IDLE?"\nRisk sequence unchanged. Waiting for levels (/set BUY SELL).":"\nRisk sequence unchanged.")))));
      if(!bookkeeping && others==0 && g_state==YT_IDLE)
        {
         if(tainted) RaiseAlert("NETTAINT","Netting-contaminated position closed ("+rs+"). "+(ledgerBooked?"The whole loss was booked in the ledger ("+taintNote+").":"Its result was NOT added to the risk sequence"+(StringLen(taintNote)>0?" ("+taintNote+")":"")+".")+" Check the account, then enter new levels to continue.",true,true);
         else        RaiseAlert("EXTCLOSE","Position closed outside SL/TP ("+rs+"). Its net result was applied to the ledger (Seq "+IntegerToString(g_seq)+", Acc.Loss "+D2(g_accLoss)+"). Press START to re-arm the saved levels, or enter new levels.",true,true);
        }
     }
   return true;
  }

void CheckClosures()
  {
   string prefix=GN("P");
   int pl=StringLen(prefix);
   int total=GlobalVariablesTotal();
   if(total!=g_gvTotal)
     {
   g_gvTotal=total;
   ArrayResize(g_pids,0);
   for(int i=0;i<total;i++)
     {
      string nm=GlobalVariableName(i);
      if(StringFind(nm,prefix)!=0) continue;
      int L=StringLen(nm);
      if(L<pl+3) continue;
      if(StringSubstr(nm,L-2)!="_N") continue;
      string mid=StringSubstr(nm,pl,L-pl-2);
      bool digits=true;
      for(int k=0;k<StringLen(mid);k++)
        { ushort c=StringGetCharacter(mid,k); if(c<'0' || c>'9') { digits=false; break; } }
      if(!digits || StringLen(mid)==0) continue;
      ulong pid=(ulong)StringToInteger(mid);
      int c2=ArraySize(g_pids);
      ArrayResize(g_pids,c2+1);
      g_pids[c2]=pid;
     }
     }
   ulong ids[];
   ArrayCopy(ids,g_pids);
   //--- v2.29: closed positions are applied in the order they were OPENED (trade number). The order of the saved variables is arbitrary,
   //--- and TP-then-SL is not the same sequence as SL-then-TP. Insertion sort (the list is tiny).
   for(int a=1;a<ArraySize(ids);a++)
     {
      ulong key=ids[a];
      double kn=PGV(key,"N",0.0);
      int b=a-1;
      while(b>=0 && PGV(ids[b],"N",0.0)>kn) { ids[b+1]=ids[b]; b--; }
      ids[b+1]=key;
     }
   for(int i=0;i<ArraySize(ids);i++)
     {
      ulong tk;
      if(FindLive(ids[i],tk)) continue;
      ProcessClosedPosition(ids[i]);
     }
  }

//--- find trades opened (and maybe closed) while the EA/terminal was offline
//--- v2.11: anchored on the last time the history was FULLY processed (LSCAN, fallback: last processed closing deal time LDT),
//--- with a 6 h safety overlap. The marker advances only when every position found in the range has been registered, and positions are
//--- registered AND processed one by one in chronological order (so several offline trades rebuild the risk sequence in the right order).
void RecoverHistory()
  {
   datetime now=TimeCurrent();
   datetime anchor=(datetime)GV("LSCAN",0);
   if(anchor==0) anchor=(datetime)GV("LDT",0);
   if(anchor==0) { GS("LSCAN",(double)now); return; }
   datetime from=0;
   if(anchor>(datetime)YT_SCAN_BUFFER_SEC) from=anchor-(datetime)YT_SCAN_BUFFER_SEC;
   if(!HistorySelect(from,now+60)) return;
   int n=HistoryDealsTotal();
   ulong cand[];
   for(int i=0;i<n;i++)
     {
      ulong d=HistoryDealGetTicket(i);
      if(d==0) continue;
      if(HistoryDealGetString(d,DEAL_SYMBOL)!=g_sym) continue;
      if((long)HistoryDealGetInteger(d,DEAL_MAGIC)!=g_magic) continue;
      if(HistoryDealGetInteger(d,DEAL_ENTRY)!=DEAL_ENTRY_IN) continue;
      ulong pid=(ulong)HistoryDealGetInteger(d,DEAL_POSITION_ID);
      if(PHas(pid,"N") || IsLoggedPos(pid)) continue;
      bool dup=false;
      for(int k=0;k<ArraySize(cand);k++) if(cand[k]==pid) { dup=true; break; }
      if(dup) continue;
      int c=ArraySize(cand);
      ArrayResize(cand,c+1);
      cand[c]=pid;
     }
   bool complete=true;
   for(int i=0;i<ArraySize(cand);i++)
     {
      //--- history order == chronological order of the entry deals
      if(RegisterPosition(cand[i])==0 && !PHas(cand[i],"N") && !IsLoggedPos(cand[i]))
        {
         complete=false;                       // history of this position is not ready yet: the marker must not pass it
         continue;
        }
      ulong lt=0;
      if(!FindLive(cand[i],lt)) ProcessClosedPosition(cand[i]);   // already closed (offline): apply it NOW, before the next one is registered
     }
   CheckClosures();
   if(complete)
     {
      GS("LSCAN",(double)now);
      GS("LSCANFAIL",0.0);
     }
   else
     {
      datetime f0=(datetime)GV("LSCANFAIL",0);
      if(f0==0)
        {
         GS("LSCANFAIL",(double)now);
         YLog("History recovery: a position could not be registered yet - the scan marker is NOT advanced (retried every 30 s).");
        }
      else if((long)(now-f0)>YT_SCAN_BUFFER_SEC)
        {
         GS("LSCAN",(double)now);
         GS("LSCANFAIL",0.0);
         RaiseAlert("RECOVERFAIL","History recovery could not register some position(s) for 6 hours - the scan marker was advanced. Check the Trades / Orders logs.",true,true);
        }
     }
  }

//+------------------------------------------------------------------+
//| Order placement                                                  |
//+------------------------------------------------------------------+
void HandleLotError(const string err)
  {
   //--- v2.23: a volume / margin condition is a WAIT (WAITING_VOLUME / WAITING_MARGIN ...), never a fatal error and never a stop
   string wc=WaitCodeOf(g_riskCode);
   if(wc=="") wc="WAITING_BROKER";
   g_wcode=wc;
   g_waitReason=err;
   g_nextPlaceMs=GetTickCount64()+30000;
   YLog(wc+": "+err);
   g_riskAlertKey="RISK"+g_riskCode;
   RaiseAlert(g_riskAlertKey,err,false,true);        // one alert per re-arm window (throttled), no pop-up
  }

//--- true when every pending order wanted by the current mode really exists on the server
bool AllNeededPlaced()
  {
   bool nb=(g_mode==YM_BOTH || g_mode==YM_BUY), ns=(g_mode==YM_BOTH || g_mode==YM_SELL);
   bool hb=false, hs=false;
   ulong t[];
   int n=OwnOrders(t);
   for(int i=0;i<n;i++)
     {
      if(!OrderSelect(t[i])) continue;
      long ty=OrderGetInteger(ORDER_TYPE);
      if(ty==ORDER_TYPE_BUY_STOP)  hb=true;
      if(ty==ORDER_TYPE_SELL_STOP) hs=true;
     }
   return ((!nb || hb) && (!ns || hs));
  }

//--- v2.28: is there ALREADY a pending order of this side on the server (own symbol + magic)?
bool SideOrderExists(const bool buy)
  {
   ulong t[];
   int n=OwnOrders(t);
   long want=buy?(long)ORDER_TYPE_BUY_STOP:(long)ORDER_TYPE_SELL_STOP;
   for(int i=0;i<n;i++)
     {
      if(!OrderSelect(t[i])) continue;
      if(OrderGetInteger(ORDER_TYPE)==want) return true;
     }
   return false;
  }

//--- v2.29: a position that was registered by this bot but is no longer open and whose closing deal is NOT booked yet is a recent state change
//--- that was not processed: no new order is sent until it is (bounded to 20 s, so a deal that never appears can never block trading forever).
bool ClosurePendingBlocks()
  {
   bool pend=false;
   ulong pp=0;
   for(int i=0;i<ArraySize(g_pids);i++)
     {
      ulong tk=0;
      if(FindLive(g_pids[i],tk)) continue;
      if(IsLoggedPos(g_pids[i])) continue;
      if(g_bookedPid!=0 && g_pids[i]==g_bookedPid) continue;   // v2.42: booked + saved (only the log lines are pending) - no reason to hold the reversal
      pend=true;
      pp=g_pids[i];
      break;
     }
   if(!pend) { g_pendClSince=0; g_pendClPid=0; return false; }
   ulong now=GetTickCount64();
   if(g_pendClSince==0 || pp!=g_pendClPid) { g_pendClSince=now; g_pendClPid=pp; g_clRelLogged=0; }   // a NEW pending closure restarts the bound
   //--- v2.48: the loss of a closed trade MUST be in the ledger before the next lot is sized. The old 20 s release sized the next order from a STALE ledger (the loss
   //--- was not yet booked, so the lot did not grow). Now: block up to 90 s (the periodic sync keeps trying to book it); only then is the gate released, LOUDLY.
   const ulong waited=now-g_pendClSince;
   if(waited<90000)
     {
      if(waited>=20000 && AlertThrottle("CLWAIT",15))
         YLog("LEDGER WAIT: closed position #"+UL(pp)+" is still NOT booked after "+UL(waited/1000)+" s - no new order is sized from a stale ledger (cycle net "+D2(g_cycNet)+", next risk "+D2(g_curRisk)+"). Retrying the booking.");
      return true;
     }
   if(g_clRelLogged!=pp)
     {
      g_clRelLogged=pp;
      string t="LEDGER NOT UPDATED: closed position #"+UL(pp)+" could not be booked within 90 s (history not available?). The gate is released so trading is never blocked forever, but the NEXT LOT MAY BE SIZED FROM A STALE LEDGER (cycle net "+D2(g_cycNet)+", risk "+D2(g_curRisk)+"). Check the Experts log and the account history.";
      YLog(t);
      LogOrder("LEDGER_STALE_RELEASE",-1,0.0,0.0,pp,0,t);
      RaiseAlert("CLSTALE",t,true,true);
     }
   return false;
  }

//--- v2.34: every reason why a RE-ENTRY order is NOT re-placed is written to the Orders log (throttled), so a missing re-arm can be explained
void RearmBlocked(const bool buy,const double level,const string why)
  {
   if(g_state!=YT_WAITING_REENTRY) return;
   if(!AlertThrottle("RBLK"+IntegerToString(SideIdx(buy))+why,30)) return;
   YLog("Re-entry "+SideName(buy)+" "+PX(level)+" NOT placed: "+why);
   LogOrder("REARM_BLOCKED",buy?(long)ORDER_TYPE_BUY_STOP:(long)ORDER_TYPE_SELL_STOP,level,0.0,0,0,"RE-ENTRY blocked: "+why);
  }

//--- v2.34 PLAN CHECK: BEFORE the order is sent, verify (and log) that the lot really gives, at TP, a NET profit = accumulated loss + target.
//--- It never blocks (rounding / caps can legitimately leave a gap; the existing net-only reset then keeps the remaining debt): it makes the gap visible.
void PlanCheck(const bool buy,const double level,const double lot)
  {
   double perLot=g_rk.perLot;
   if(perLot<=0.0 || lot<=0.0) return;
   double cpl=CommPerLotEff();
   double expLoss=lot*(perLot+cpl);                 // price loss at SL + round-trip commission
   double expTP  =lot*(perLot*g_rr-cpl);            // expected NET at TP
   double need   =g_target-g_cycNet;                // v2.38: net the cycle still needs from this trade (target - cycle net)
   double gap    =need-expTP;
   bool   short_ =(gap>need*0.02+1e-9);
   static string lastSig="";
   string sig=(buy?"B":"S")+PX(level)+"|"+LotS(lot)+"|"+D2(g_accLoss)+"|"+D2(cpl);
   if(sig==lastSig) return;                         // one line per distinct plan, not one per retry
   lastSig=sig;
   string t="PLAN_CHECK lot "+LotS(lot)+" | loss at SL "+D2(expLoss)+" | NET at TP "+D2(expTP)+" | needed (target "+D2(g_target)+" - cycle #"+IntegerToString((int)g_cycId)+" net "+D2(g_cycNet)+") "+D2(need)+
            " | commission/lot "+D2(cpl)+" | "+(short_?"SHORTFALL "+D2(gap)+" (lot rounding / caps / commission)":"OK");
   LogOrder("PLAN_CHECK",buy?(long)ORDER_TYPE_BUY_STOP:(long)ORDER_TYPE_SELL_STOP,level,lot,0,0,t);
   YLog(t);
   if(short_) RaiseAlert("PLANGAP",t,false,true); else ClearAlert("PLANGAP");
  }

//--- v2.39: ORDER-ERROR CLASSES (report section 5.4). The retcode of a failed pending-order request is sorted into ONE class that decides what happens next.
//--- A failed send is never a trade and never a step: only a CLOSED position moves the cycle ledger / sequence.
#define YR_RETRY   1   // price / market moved or the broker is busy: refresh the market data and try again later (bounded back-off, never ERROR)
#define YR_ADJUST  2   // volume / expiration / filling / limits: the request itself must change; repeated failure ends in ERROR (a visible state)
#define YR_BROKER  3   // margin, market closed, trading disabled / restricted: wait (the reason is shown), never ERROR
#define YR_PERM    4   // invalid request / unknown: repeated failure ends in ERROR
#define YR_UNCERT  5   // timeout / no answer / transport error: the order MAY exist on the server -> verify the server before ANY new request
int ClassifyRetcode(const uint rc,const bool callOk)
  {
   if(rc==0) return callOk?YR_PERM:YR_UNCERT;                 // no result structure at all: the outcome is unknown
   switch((int)rc)
     {
      case TRADE_RETCODE_ERROR:
      case TRADE_RETCODE_TIMEOUT:
      case TRADE_RETCODE_CONNECTION:
         return YR_UNCERT;
      case TRADE_RETCODE_REQUOTE:
      case TRADE_RETCODE_PRICE_CHANGED:
      case TRADE_RETCODE_PRICE_OFF:
      case TRADE_RETCODE_INVALID_PRICE:
      case TRADE_RETCODE_INVALID_STOPS:
      case TRADE_RETCODE_REJECT:
      case TRADE_RETCODE_TOO_MANY_REQUESTS:
      case TRADE_RETCODE_LOCKED:
      case TRADE_RETCODE_FROZEN:
      case TRADE_RETCODE_ORDER_CHANGED:
         return YR_RETRY;
      case TRADE_RETCODE_INVALID_VOLUME:
      case TRADE_RETCODE_INVALID_EXPIRATION:
      case TRADE_RETCODE_INVALID_FILL:
      case TRADE_RETCODE_LIMIT_ORDERS:
      case TRADE_RETCODE_LIMIT_VOLUME:
      case TRADE_RETCODE_LIMIT_POSITIONS:
      case TRADE_RETCODE_INVALID_ORDER:
         return YR_ADJUST;
      case TRADE_RETCODE_NO_MONEY:
      case TRADE_RETCODE_MARKET_CLOSED:
      case TRADE_RETCODE_TRADE_DISABLED:
      case TRADE_RETCODE_CLIENT_DISABLES_AT:
      case TRADE_RETCODE_SERVER_DISABLES_AT:
      case TRADE_RETCODE_LONG_ONLY:
      case TRADE_RETCODE_SHORT_ONLY:
      case TRADE_RETCODE_CLOSE_ONLY:
      case TRADE_RETCODE_ONLY_REAL:
         return YR_BROKER;
     }
   return YR_PERM;
  }
string RetClassName(const int c)
  {
   switch(c)
     {
      case YR_RETRY:  return "RETRY";
      case YR_ADJUST: return "ADJUST";
      case YR_BROKER: return "BROKER";
      case YR_UNCERT: return "UNCERTAIN";
     }
   return "PERMANENT";
  }


//+------------------------------------------------------------------+
//| v2.42 REQUEST JOURNAL (report Fix_1, problem 2)                  |
//| Every pending-order request is written to the saved state BEFORE |
//| it leaves the terminal:                                          |
//|   PREPARED -> SENT -> CONFIRMED | REJECTED | UNKNOWN              |
//| After a crash / restart a record that stayed PREPARED never      |
//| reached the server (discarded); SENT / UNKNOWN is an unresolved  |
//| request: it is handed to the request ledger below and verified   |
//| against the server (orders, positions, history) before anything  |
//| new is sent for that side. A timeout alone never re-sends.       |
//+------------------------------------------------------------------+
#define YJ_NONE       0
#define YJ_PREPARED   1
#define YJ_SENT       2
#define YJ_CONFIRMED  3
#define YJ_REJECTED   4
#define YJ_UNKNOWN    5

string JKey(const int s,const string k) { return "RJ"+IntegerToString(s)+"_"+k; }

string JStateName(const int st)
  {
   switch(st)
     {
      case YJ_PREPARED:  return "PREPARED";
      case YJ_SENT:      return "SENT";
      case YJ_CONFIRMED: return "CONFIRMED";
      case YJ_REJECTED:  return "REJECTED";
      case YJ_UNKNOWN:   return "UNKNOWN";
     }
   return "NONE";
  }

//--- difference of two tick counts for the timing lines ("n/a" when one of them was not measured)
string MsDiff(const ulong a,const ulong b)
  {
   if(a==0 || b==0 || b<a) return "n/a";
   return UL(b-a)+" ms";
  }

//--- PREPARED: the data of the request is saved (one record per side). Returns the journal number.
long ReqPrepare(const bool buy,const double level,const double lot)
  {
   const int s=SideIdx(buy);
   const long id=(long)GV("RJSEQ",0.0)+1;
   GS("RJSEQ",(double)id);
   GS(JKey(s,"I"),(double)id);
   GS(JKey(s,"P"),level);
   GS(JKey(s,"L"),lot);
   GS(JKey(s,"T"),(double)TimeCurrent());
   GS(JKey(s,"C"),(double)g_cycId);
   GS(JKey(s,"Q"),(double)(g_seq+1));
   GS(JKey(s,"D"),(double)g_revPid);
   GS(JKey(s,"S"),(double)YJ_PREPARED);
   return id;
  }

//--- moves the record of this side to a new phase. SENT and UNKNOWN are flushed to disk (they must survive a crash during / after the send).
void ReqMark(const int s,const int st)
  {
   if(!GHas(JKey(s,"S"))) return;
   GS(JKey(s,"S"),(double)st);
   if(st==YJ_SENT || st==YJ_UNKNOWN) GlobalVariablesFlush();
  }

//+------------------------------------------------------------------+
//| v2.40 PENDING-REQUEST LEDGER (report section 2: UNCERTAIN)       |
//| A request whose result is unknown (timeout / no answer / accepted|
//| but not visible) is NOT a failure and NOT a success. One record  |
//| per side is kept (and saved, so it survives a restart) until the |
//| server shows what happened: live order / position / history.     |
//| While a record is open NO new request for that side is sent.     |
//+------------------------------------------------------------------+
#define YT_UNC_SETTLE_SEC  30   // verified-connection time without ANY trace on the server before the request is treated as not delivered
#define YT_UNC_MARGIN_SEC   5   // clock tolerance between the send time and the server order time
#define YU_UNKNOWN  0           // no trace yet
#define YU_ORDER    1           // the order is live on the server
#define YU_FILLED   2           // the request was executed (position / filled order)
#define YU_GONE     3           // the server processed it and it is no longer pending (rejected / cancelled / expired)
#define YU_NOHIST   4           // the history could not be read: nothing can be concluded

struct SUncReq
  {
   bool     active;
   bool     buy;
   double   level;
   double   lot;
   ulong    ticket;       // order ticket when the server returned one (0 = none)
   uint     rc;
   long     id;           // request number (persisted counter)
   long     cyc;          // cycle id at the send
   int      seq;          // the step this request belongs to (a failed / unknown request is never a step)
   datetime reqTime;      // server time of the send
   ulong    startMs;      // start of the current settle window (restarts after a connection loss)
   ulong    nextMs;       // next verification
   int      checks;
   int      histOk;       // v2.42: consecutive checks where the history WAS readable and showed no trace (evidence, not just elapsed time)
   bool     paused;       // connection lost: the window is frozen
  };
SUncReq g_unc[2];
long    g_uncSeq=0;

string UncKey(const int s,const string k) { return "UN"+IntegerToString(s)+"_"+k; }

void UncSave(const int s)
  {
   GS(UncKey(s,"ON"),g_unc[s].active?1.0:0.0);
   if(g_unc[s].active)
     {
      GS(UncKey(s,"T"),(double)g_unc[s].reqTime);
      GS(UncKey(s,"P"),g_unc[s].level);
      GS(UncKey(s,"L"),g_unc[s].lot);
      GS(UncKey(s,"K"),(double)g_unc[s].ticket);
      GS(UncKey(s,"R"),(double)g_unc[s].rc);
      GS(UncKey(s,"I"),(double)g_unc[s].id);
      GS(UncKey(s,"C"),(double)g_unc[s].cyc);
      GS(UncKey(s,"Q"),(double)g_unc[s].seq);
     }
   GlobalVariablesFlush();
  }

//--- restart: an open request is restored and verified BEFORE anything is sent for that side
void UncLoad()
  {
   g_uncSeq=(long)GV("UNSEQ",0.0);
   for(int s=0;s<2;s++)
     {
      g_unc[s].active=false;
      g_unc[s].buy=(s==0);
      g_unc[s].level=0.0; g_unc[s].lot=0.0; g_unc[s].ticket=0; g_unc[s].rc=0;
      g_unc[s].id=0; g_unc[s].cyc=0; g_unc[s].seq=0; g_unc[s].reqTime=0;
      g_unc[s].startMs=0; g_unc[s].nextMs=0; g_unc[s].checks=0; g_unc[s].histOk=0; g_unc[s].paused=false;
      if(GV(UncKey(s,"ON"),0.0)<0.5) continue;
      g_unc[s].active=true;
      g_unc[s].reqTime=(datetime)GV(UncKey(s,"T"),0.0);
      g_unc[s].level=GV(UncKey(s,"P"),0.0);
      g_unc[s].lot=GV(UncKey(s,"L"),0.0);
      g_unc[s].ticket=(ulong)GV(UncKey(s,"K"),0.0);
      g_unc[s].rc=(uint)GV(UncKey(s,"R"),0.0);
      g_unc[s].id=(long)GV(UncKey(s,"I"),0.0);
      g_unc[s].cyc=(long)GV(UncKey(s,"C"),0.0);
      g_unc[s].seq=(int)GV(UncKey(s,"Q"),0.0);
      g_unc[s].startMs=GetTickCount64();      // the settle window starts again after a restart (conservative)
      g_unc[s].nextMs=0;
      const bool b=(s==0);
      LogOrder("UNCERTAIN_RESTORED",b?(long)ORDER_TYPE_BUY_STOP:(long)ORDER_TYPE_SELL_STOP,g_unc[s].level,g_unc[s].lot,g_unc[s].ticket,g_unc[s].rc,
               "req#"+IntegerToString((int)g_unc[s].id)+" restored after a restart | no new request for this side until the server is checked");
      YLog("Unresolved order request #"+IntegerToString((int)g_unc[s].id)+" ("+SideName(b)+" "+PX(g_unc[s].level)+") restored after a restart - verified before anything is sent.");
     }
  }

int UncHistState(const long st,const ulong tk,string &how)
  {
   how="history order #"+UL(tk)+" state "+IntegerToString((int)st);
   if(st==ORDER_STATE_FILLED || st==ORDER_STATE_PARTIAL) return YU_FILLED;
   return YU_GONE;
  }

//--- what does the server show for this request? (live orders, positions, order history)
int UncProbe(const int s,string &how)
  {
   how="";
   const bool buy=g_unc[s].buy;
   const long want=buy?(long)ORDER_TYPE_BUY_STOP:(long)ORDER_TYPE_SELL_STOP;
   //--- 1) live pending order: by ticket when known, otherwise any own order of this side
   if(g_unc[s].ticket!=0 && OrderSelect(g_unc[s].ticket))
     {
      how="live order #"+UL(g_unc[s].ticket);
      return YU_ORDER;
     }
   ulong t[];
   int n=OwnOrders(t);
   for(int i=0;i<n;i++)
     {
      if(!OrderSelect(t[i])) continue;
      if(OrderGetInteger(ORDER_TYPE)!=want) continue;
      how="live order #"+UL(t[i])+" @ "+PX(OrderGetDouble(ORDER_PRICE_OPEN))+" vol "+LotS(OrderGetDouble(ORDER_VOLUME_CURRENT));
      return YU_ORDER;
     }
   //--- 2) an own position of this direction opened after the request
   ulong p[];
   int np=OwnPositions(p);
   for(int j=0;j<np;j++)
     {
      if(!PositionSelectByTicket(p[j])) continue;
      if((PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY)!=buy) continue;
      if((datetime)PositionGetInteger(POSITION_TIME)+YT_UNC_MARGIN_SEC<g_unc[s].reqTime) continue;
      how="open position #"+UL(p[j])+" opened after the request";
      return YU_FILLED;
     }
   //--- 3) order history since the request
   datetime from=g_unc[s].reqTime-YT_UNC_MARGIN_SEC;
   if(from<0) from=0;
   if(!HistorySelect(from,TimeCurrent()+60))
     {
      how="order history could not be read";
      return YU_NOHIST;
     }
   if(g_unc[s].ticket!=0 && HistoryOrderSelect(g_unc[s].ticket))
      return UncHistState(HistoryOrderGetInteger(g_unc[s].ticket,ORDER_STATE),g_unc[s].ticket,how);
   double step=SymbolInfoDouble(g_sym,SYMBOL_VOLUME_STEP);
   if(step<=0.0) step=0.01;
   const int hn=HistoryOrdersTotal();
   for(int h=hn-1;h>=0;h--)
     {
      ulong ho=HistoryOrderGetTicket(h);
      if(ho==0) continue;
      if(HistoryOrderGetString(ho,ORDER_SYMBOL)!=g_sym) continue;
      if((long)HistoryOrderGetInteger(ho,ORDER_MAGIC)!=g_magic) continue;
      if(HistoryOrderGetInteger(ho,ORDER_TYPE)!=want) continue;
      if((datetime)HistoryOrderGetInteger(ho,ORDER_TIME_SETUP)+YT_UNC_MARGIN_SEC<g_unc[s].reqTime) continue;
      if(!PriceEq(HistoryOrderGetDouble(ho,ORDER_PRICE_OPEN),g_unc[s].level)) continue;
      if(MathAbs(HistoryOrderGetDouble(ho,ORDER_VOLUME_INITIAL)-g_unc[s].lot)>step/2.0) continue;
      return UncHistState(HistoryOrderGetInteger(ho,ORDER_STATE),ho,how);
     }
   how="no live order, no position and no history entry";
   return YU_UNKNOWN;
  }

void UncClose(const int s,const int pr,const string how)
  {
   const bool buy=g_unc[s].buy;
   const long otype=buy?(long)ORDER_TYPE_BUY_STOP:(long)ORDER_TYPE_SELL_STOP;
   const long secs=(long)((GetTickCount64()-g_unc[s].startMs)/1000);
   string ev="UNCERTAIN_RESOLVED", txt="";
   if(pr==YU_ORDER)       txt="the order IS on the server ("+how+") - adopted, NO new request";
   else if(pr==YU_FILLED) txt="the request was EXECUTED ("+how+") - NO new request";
   else if(pr==YU_GONE)   txt="the server processed the request and it is no longer pending ("+how+") - the normal path continues";
   else
     {
      ev="UNCERTAIN_ABSENT";
      txt="no order / position / history trace after "+IntegerToString((int)YT_UNC_SETTLE_SEC)+" s of verified connection - treated as NOT delivered; a new request is allowed now";
      RaiseAlert("UNCABS"+IntegerToString(s),SideName(buy)+" "+PX(g_unc[s].level)+": the unconfirmed request left no trace on the server and is treated as not delivered.",false,true);
     }
   LogOrder(ev,otype,g_unc[s].level,g_unc[s].lot,g_unc[s].ticket,g_unc[s].rc,"req#"+IntegerToString((int)g_unc[s].id)+" | cycle #"+IntegerToString((int)g_unc[s].cyc)+" step "+IntegerToString(g_unc[s].seq)+" | "+txt+" | checks "+IntegerToString(g_unc[s].checks)+" | window "+IntegerToString((int)secs)+" s");
   YLog("Request #"+IntegerToString((int)g_unc[s].id)+" "+SideName(buy)+" "+PX(g_unc[s].level)+": "+txt);
   ClearAlert("UNC"+IntegerToString(s));
   g_unc[s].active=false;
   UncSave(s);
   ReqMark(s,(pr==YU_ORDER || pr==YU_FILLED)?YJ_CONFIRMED:YJ_REJECTED);     // v2.42: the journal record of this request is settled by the server state
   g_dirty=true;
   if(pr==YU_UNKNOWN || pr==YU_GONE) g_nextPlaceMs=GetTickCount64()+500;
  }

//--- true => still undecided (every new request of this side stays blocked). Throttled: 0.4 s at first, then every 3 s.
bool UncVerify(const int s)
  {
   if(!g_unc[s].active) return false;
   const ulong now=GetTickCount64();
   if(now<g_unc[s].nextMs) return true;
   g_unc[s].checks++;
   g_unc[s].nextMs=now+((g_unc[s].checks<4)?400:3000);
   if(!TerminalInfoInteger(TERMINAL_CONNECTED))
     {
      if(!g_unc[s].paused)
        {
         g_unc[s].paused=true;
         LogOrder("UNCERTAIN_PAUSED",g_unc[s].buy?(long)ORDER_TYPE_BUY_STOP:(long)ORDER_TYPE_SELL_STOP,g_unc[s].level,g_unc[s].lot,g_unc[s].ticket,g_unc[s].rc,
                  "req#"+IntegerToString((int)g_unc[s].id)+" | connection lost - verification paused, NO new request");
        }
      g_unc[s].startMs=now;              // an absence observed while offline proves nothing: the window restarts after the reconnection
      return true;
     }
   g_unc[s].paused=false;
   string how="";
   const int pr=UncProbe(s,how);
   if(pr==YU_NOHIST) g_unc[s].histOk=0;                       // v2.42: an unreadable history proves nothing
   else if(pr==YU_UNKNOWN) g_unc[s].histOk++;
   if(pr==YU_ORDER || pr==YU_FILLED || pr==YU_GONE)
     {
      UncClose(s,pr,how);
      return false;
     }
   //--- v2.42: the window alone never releases the side: it needs the verified connection for the whole window AND at least 5 checks of which the last 3 read the
   //--- history successfully and found NO trace (live order / position / order history). Anything less keeps the side blocked (no second copy of the request).
   if(pr==YU_UNKNOWN && g_unc[s].checks>=5 && g_unc[s].histOk>=3 && (now-g_unc[s].startMs)>=(ulong)YT_UNC_SETTLE_SEC*1000)
     {
      UncClose(s,YU_UNKNOWN,how);
      return false;
     }
   return true;
  }

//--- called by TryPlace before ANY request
bool UncBlocks(const bool buy)
  {
   const int s=SideIdx(buy);
   if(!g_unc[s].active) return false;
   if(!UncVerify(s)) return false;
   SetSync(buy,YS_WAITING,"Request result UNCERTAIN (req#"+IntegerToString((int)g_unc[s].id)+") - verifying the server, no new request");
   return true;
  }

//--- called by every synchronisation pass: records are resolved even while TryPlace is not running
void UncTick()
  {
   for(int s=0;s<2;s++)
      if(g_unc[s].active) UncVerify(s);
  }

//--- opens a record (one per side). ticket = 0 when the server returned none.
void UncOpen(const bool buy,const double level,const double lot,const ulong ticket,const uint rc,const string why)
  {
   const int s=SideIdx(buy);
   if(g_unc[s].active) return;
   g_uncSeq++;
   GS("UNSEQ",(double)g_uncSeq);
   g_unc[s].active=true;
   g_unc[s].buy=buy;
   g_unc[s].level=level;
   g_unc[s].lot=lot;
   g_unc[s].ticket=ticket;
   g_unc[s].rc=rc;
   g_unc[s].id=g_uncSeq;
   g_unc[s].cyc=g_cycId;
   g_unc[s].seq=g_seq+1;
   g_unc[s].reqTime=TimeCurrent();
   g_unc[s].startMs=GetTickCount64();
   g_unc[s].nextMs=g_unc[s].startMs+300;
   g_unc[s].checks=0;
   g_unc[s].histOk=0;
   g_unc[s].paused=false;
   UncSave(s);
   LogOrder("UNCERTAIN_OPEN",buy?(long)ORDER_TYPE_BUY_STOP:(long)ORDER_TYPE_SELL_STOP,level,lot,ticket,rc,
            "req#"+IntegerToString((int)g_uncSeq)+" | "+why+" | cycle #"+IntegerToString((int)g_cycId)+" step "+IntegerToString(g_seq+1)+" (an unknown request is NOT a step) | no repeated request until the server shows the outcome");
  }

//--- is this exact request (same side / level / lot / cycle) still in flight or unresolved? Stale in-flight marks (> 120 s, no request ledger) are cleared, never allowed to block forever.
bool ReqIsDuplicate(const bool buy,const double level,const double lot)
  {
   const int s=SideIdx(buy);
   const int st=(int)GV(JKey(s,"S"),0.0);
   if(st!=YJ_PREPARED && st!=YJ_SENT && st!=YJ_UNKNOWN) return false;
   if(!PriceEq(GV(JKey(s,"P"),0.0),level) || MathAbs(GV(JKey(s,"L"),0.0)-lot)>1e-9) return false;
   if((long)GV(JKey(s,"C"),0.0)!=g_cycId) return false;
   if(g_unc[s].active) return true;
   if((long)(TimeCurrent()-(datetime)GV(JKey(s,"T"),0.0))>120) { GS(JKey(s,"S"),(double)YJ_NONE); return false; }
   return true;
  }

//--- v2.42: restart / crash: what the journal says about the last request of each side
void ReqJournalRecover()
  {
   for(int s=0;s<2;s++)
     {
      const int st=(int)GV(JKey(s,"S"),0.0);
      if(st==YJ_NONE || st==YJ_CONFIRMED || st==YJ_REJECTED) continue;
      const bool buy=(s==0);
      const long otype=buy?(long)ORDER_TYPE_BUY_STOP:(long)ORDER_TYPE_SELL_STOP;
      const double lv=GV(JKey(s,"P"),0.0), lt=GV(JKey(s,"L"),0.0);
      const long id=(long)GV(JKey(s,"I"),0.0);
      if(st==YJ_PREPARED)
        {
         LogOrder("REQ_NOT_SENT",otype,lv,lt,0,0,"journal #"+IntegerToString((int)id)+" was PREPARED but never SENT (the terminal stopped before the send) - nothing reached the server, record discarded");
         GS(JKey(s,"S"),(double)YJ_NONE);
         continue;
        }
      //--- SENT / UNKNOWN: the outcome was never recorded
      if(g_unc[s].active) { GS(JKey(s,"S"),(double)YJ_UNKNOWN); continue; }     // the request ledger already holds it
      UncOpen(buy,lv,lt,0,0,"journal #"+IntegerToString((int)id)+" was "+JStateName(st)+" and no result was recorded (restart / crash during or right after the send)");
      if(g_unc[s].active)
        {
         g_unc[s].reqTime=(datetime)GV(JKey(s,"T"),(double)TimeCurrent());
         g_unc[s].cyc=(long)GV(JKey(s,"C"),(double)g_cycId);
         g_unc[s].seq=(int)GV(JKey(s,"Q"),(double)(g_seq+1));
         UncSave(s);
        }
      GS(JKey(s,"S"),(double)YJ_UNKNOWN);
      GlobalVariablesFlush();
     }
  }

//+------------------------------------------------------------------+
//| v2.40 ARM TIMELINE (report section 4)                            |
//| For every armed order: when it was accepted / last verified on   |
//| the server, when the price touched its level, when it executed,  |
//| requested vs actual price. Measurement only - it sends nothing.  |
//+------------------------------------------------------------------+
string g_revCov="";            // v2.40: state of the reverse order while the position was open (written to the log at the close)
ulong  g_closeDetMs=0;         // v2.40: tick count when the vanished position was first noticed
ulong  g_trDeal[16];           // v2.40: ring of the latest transaction deals (a repeated event is not processed twice)
int    g_trDealPos=0;

//--- OnTick: one comparison per armed side
void ArmTouchWatch(const MqlTick &t,const ulong now)
  {
   for(int s=0;s<2;s++)
     {
      if(g_arm[s].ticket==0 || g_arm[s].touchMs!=0) continue;
      const bool buy=(s==0);
      const bool touched=buy?(t.ask>=g_arm[s].level):(t.bid<=g_arm[s].level);
      if(!touched) continue;
      g_arm[s].touchMs=now;
      g_arm[s].touchBid=t.bid;
      g_arm[s].touchAsk=t.ask;
      g_arm[s].presentAtTouch=OrderSelect(g_arm[s].ticket);
      LogOrder("ARM_TOUCH",buy?(long)ORDER_TYPE_BUY_STOP:(long)ORDER_TYPE_SELL_STOP,g_arm[s].level,g_arm[s].lot,g_arm[s].ticket,0,
               (g_arm[s].rev?"REVERSE | ":"")+"price reached the trigger | bid "+PX(t.bid)+" ask "+PX(t.ask)+" | order visible on this terminal: "+(g_arm[s].presentAtTouch?"YES":"NO")+
               " | accepted "+UL(now-g_arm[s].armMs)+" ms ago | last server check "+UL(now-g_arm[s].verMs)+" ms ago");
     }
  }

//--- OnTradeTransaction (entry deal): requested vs actual price and the measured times
void ArmFill(const ulong deal)
  {
   const long dt=HistoryDealGetInteger(deal,DEAL_TYPE);
   if(dt!=DEAL_TYPE_BUY && dt!=DEAL_TYPE_SELL) return;
   const bool buy=(dt==DEAL_TYPE_BUY);
   const int s=SideIdx(buy);
   if(g_arm[s].ticket==0) return;
   if((ulong)HistoryDealGetInteger(deal,DEAL_ORDER)!=g_arm[s].ticket) return;
   const ulong now=GetTickCount64();
   const double px=HistoryDealGetDouble(deal,DEAL_PRICE);
   const double lvl=g_arm[s].level;
   const double slip=(buy?(px-lvl):(lvl-px))/g_point;
   string tl="";
   if(g_arm[s].touchMs>0)
      tl="touch -> execution seen by the EA "+UL(now-g_arm[s].touchMs)+" ms | order visible at the touch: "+(g_arm[s].presentAtTouch?"YES":"NO")+" | last server check "+UL(g_arm[s].touchMs-g_arm[s].verMs)+" ms before the touch";
   else
      tl="executed WITHOUT a touch tick seen by the EA (the price jumped between ticks)";
   LogOrder("ARM_TIMELINE",buy?(long)ORDER_TYPE_BUY_STOP:(long)ORDER_TYPE_SELL_STOP,lvl,g_arm[s].lot,g_arm[s].ticket,0,
            (g_arm[s].rev?"REVERSE | ":"")+"requested "+PX(lvl)+" | executed "+PX(px)+" | adverse slippage "+DoubleToString(slip,0)+" pts | armed "+UL(now-g_arm[s].armMs)+" ms before this event | "+tl+" | acct "+(g_netting?"Netting":"Hedging"));
   ArmDrop(s);
  }

//--- the same transaction is never processed twice
bool TransDealSeen(const ulong deal)
  {
   for(int i=0;i<16;i++)
      if(g_trDeal[i]==deal) return true;
   g_trDeal[g_trDealPos]=deal;
   g_trDealPos=(g_trDealPos+1)%16;
   return false;
  }

//--- v2.48 RECOVERY TRACE (report: diagnostic log). ONE line per distinct sizing decision: which loss came before, the ledger it was sized from, the risk asked,
//--- the raw / final lot, how it was quantised and which cap (if any) acted. A lot that did NOT grow after a loss is flagged with its reason - the user never has to guess.
void RecoveryTrace(const string stage,const bool buy,const double risk,const double lot,const double prevLot)
  {
   const string key=stage+"|"+(buy?"B":"S")+"|"+D2(risk)+"|"+DoubleToString(lot,g_lotDigits)+"|"+D2(g_cycNet)+"|"+IntegerToString(g_seq);
   if(key==g_rtKey) return;
   g_rtKey=key;
   string prev=(g_lastLossLot>0.0)?(string)(g_lastLossBuy?"BUY":"SELL")+" lot "+LotS(g_lastLossLot)+" net "+D2(g_lastLossNet):"none this session";
   string t="RECOVERY_TRACE ["+stage+"] next "+(buy?"BUY":"SELL")+" | last SL booked: "+prev+" | ledger: cycle net "+D2(g_cycNet)+", acc.loss "+D2(g_accLoss)+", seq "+IntegerToString(g_seq)+
            " | required risk "+D2(risk)+" | raw lot "+DoubleToString(g_rk.rawVol,5)+" -> final lot "+DoubleToString(lot,g_lotDigits)+" ("+g_lcHow+", code "+g_riskCode+")"+
            " | broker min "+DoubleToString(g_rk.minVol,g_lotDigits)+" step "+DoubleToString(g_rk.step,g_lotDigits)+" max "+DoubleToString(g_rk.maxVol,g_lotDigits)+(InpMaxLot>0.0?" (Max Lot cap "+DoubleToString(InpMaxLot,g_lotDigits)+")":"");
   YLog(t);
   LogOrder("RECOVERY_TRACE",buy?(long)ORDER_TYPE_BUY_STOP:(long)ORDER_TYPE_SELL_STOP,0.0,lot,0,0,t);
   const bool inDebt=(g_cycNet<-1e-9 || g_accLoss>1e-9);
   if(inDebt && prevLot>0.0 && lot<=prevLot+g_rk.step/2.0)
     {
      string why;
      if(g_lcHow=="FLOOR_STEP_TOO_COARSE") why="the broker lot step is too coarse for this growth and Round-Up Max Over % ("+DoubleToString(InpRoundUpMaxOverPct,1)+") refused the next step - the shortfall is carried in the ledger";
      else if(g_lcHow=="CLAMP_MIN") why="the requested risk is below the broker minimum lot and CLAMP_TO_MIN raised it";
      else if(InpMaxLot>0.0 && lot>=InpMaxLot-g_rk.step/2.0) why="the Max Lot cap ("+DoubleToString(InpMaxLot,g_lotDigits)+") is reached";
      else if(!InpRecoveryRoundUp) why="Recovery Round-Up is OFF, so the lot is rounded DOWN to the step";
      else why="the loss per lot at this SL distance and the lot step give the same volume for the required risk";
      string w="RECOVERY_LOT_NOT_GROWN: previous lot "+LotS(prevLot)+" -> new lot "+LotS(lot)+" although the cycle is in debt (net "+D2(g_cycNet)+"). Reason: "+why+". The ledger is NOT cleared.";
      YLog(w);
      LogOrder("RECOVERY_LOT_NOT_GROWN",buy?(long)ORDER_TYPE_BUY_STOP:(long)ORDER_TYPE_SELL_STOP,0.0,lot,0,0,w);
     }
  }

bool TryPlace(const bool buy,const double level)
  {
   int s=SideIdx(buy);
   if(!InstOkTrade("place a pending order")) return false;     // v2.29: lock ownership re-verified before every send
   if(UncBlocks(buy)) return false;                            // v2.40: an earlier request of this side has no confirmed outcome yet - NOTHING new is sent
   if(g_recHold) return false;                                 // v2.42: REQUIRED_RECOVERY - nothing new is sent until the saved state and the broker are reconciled
   if(GV("CANCELEND",0.0)>0.5) return false;                   // fix15: the user ENDED this cycle - no recovery order of the old debt is ever sent while its last trade is closing
   if(!g_revCtx && g_state!=YT_ARMED && g_state!=YT_WAITING_REENTRY) return false;   // v2.42: the cycle state must allow a new order (no order from an idle / finished / stopped cycle)
   ulong nowMs=GetTickCount64();
   //--- v2.28 HARD GUARD: a second order of the same side, or ANY new pending order while a position is open, is never sent.
   //--- (two Buy Stops at one level = two positions at the same moment = one of them is closed as "extra" at market)
   {
    ulong gp[];
    int gpn=OwnPositions(gp);
    if(gpn>0 && !(g_revCtx && gpn==1))
      {
       RearmBlocked(buy,level,"a position is still open");
       return false;
      }
    if(g_revCtx && gpn==1)           // v2.37: the reverse order is only ever the OPPOSITE direction of the single open position
      {
       if(!PositionSelectByTicket(gp[0])) return false;
       if((PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY)==buy) return false;
      }
    if(SideOrderExists(buy)) return false;
    if(ClosurePendingBlocks())
      {
       RearmBlocked(buy,level,"the closing deal of the previous trade is not booked yet");
       SetSync(buy,YS_WAITING,"A closed position is still being booked - no new order until it is processed");
       g_nextPlaceMs=GetTickCount64()+500;
       return false;
      }
   }
   if(nowMs<g_nextPlaceMs)
     {
      if(g_sync[s]==YS_CREATING) SetSync(buy,YS_WAITING,"Retry cooldown");
      return false;
     }
   MqlTick tk;
   if(!SymbolInfoTick(g_sym,tk) || tk.ask<=0.0 || tk.bid<=0.0)
     {
      SetSync(buy,YS_WAITING,"No market prices");
      return false;
     }
   //--- broker / market rules: a request that the server would reject is never sent; the reason is shown (NOT PLACED)
   string pwhy="";
   int pst=PlacementState(buy,level,pwhy);
   if(pst!=0)
     {
      //--- v2.16: the level is accepted and kept; the order is created automatically when the broker rules allow it
      string wtxt=(pst==1)?WaitText(buy,level):pwhy;
      g_waitReason=(g_state==YT_WAITING_REENTRY?"Re-entry: ":"")+wtxt;
      SetSync(buy,YS_WAITING,g_waitReason);
      g_raceCnt[s]=0;
      g_trigMs[s]=0;
      g_trig[s]=(pst==1)?WaitTrigger(buy,level):0.0;      // v2.17: cached; OnTick wakes the synchroniser the tick the price crosses it
      if(pst==1) NoteDefer(buy,level,wtxt);
      return false;
     }
   //--- v2.17: after a "market moved" race the side keeps a wider safety distance until the price is really clear of the level
   if(g_waitBuf[s]>0.0)
     {
      double trg=WaitTrigger(buy,level);
      if(buy?(tk.ask>trg+1e-9):(tk.bid<trg-1e-9))
        {
         g_trig[s]=trg;
         g_waitReason=(g_state==YT_WAITING_REENTRY?"Re-entry: ":"")+WaitText(buy,level);
         SetSync(buy,YS_WAITING,g_waitReason);
         return false;
        }
     }
   g_waitReason="";
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED) ||
      !AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) || !AccountInfoInteger(ACCOUNT_TRADE_EXPERT))
     {
      g_nextPlaceMs=nowMs+15000;
      g_blockReason="AutoTrading / account trading disabled";
      SetSync(buy,YS_WAITING,g_blockReason);
      RaiseAlert("AUTOTR","Trading is not allowed (AutoTrading disabled or account restriction).",true,true);
      return false;
     }
   double lot=0,est=0; string err="";
   string spw="";
   if(SpreadTooWide(spw)) { g_wcode="WAITING_SPREAD"; g_waitReason=spw; g_nextPlaceMs=nowMs+2000; SetSync(buy,YS_WAITING,spw); return false; }
   string rgw="",rgc="";
   if(RecoveryGuardBlocks(rgw,rgc))
     {
      g_wcode=rgc; g_waitReason=rgw; g_nextPlaceMs=nowMs+5000;
      SetSync(buy,YS_WAITING,rgw);
      RaiseAlert("RPGUARD"+rgc,rgw,false,true);
      return false;
     }
   ClearAlert("RPGUARDWAITING_SEQCAP"); ClearAlert("RPGUARDWAITING_RISKCAP");
   ClearAlert("RPGUARDWAITING_ACCLOSSCAP"); ClearAlert("RPGUARDWAITING_MARGINLVL"); ClearAlert("RPGUARDWAITING_NEXTDAY"); ClearAlert("RPGUARDWAITING_DAYLOSS");
   if(!CalcLot(g_curRisk,buy,level,lot,est,err)) { HandleLotError(err); SetSync(buy,YS_WAITING,err); return false; }
   g_blockReason="";
   g_wcode="";
   if(StringLen(g_riskAlertKey)>0) { ClearAlert(g_riskAlertKey); g_riskAlertKey=""; }
   ClearAlert("AUTOTR");
   if(g_rk.clamped) YLog("CLAMP_TO_MIN: "+g_rk.text);
   RecoveryTrace(g_revCtx?"REVERSE_PLACE":(g_state==YT_WAITING_REENTRY?"RE-ENTRY":"PLACE"),buy,g_curRisk,lot,g_lastLossLot);

   double slp=SLPrice(buy,level), tpp=TPPrice(buy,level);
   PlanCheck(buy,level,lot);                         // v2.34: financial verification before the order is sent
   SetSync(buy,YS_CREATING,"Placing "+PX(level));
   UpdatePanel();                                    // the panel shows PLACING while the server works
   g_trade.SetDeviationInPoints(g_maxDev);
   {
    string ocCode="", ocWhy=""; ulong ocCool=0;
    if(!PendingOrderCheck(buy,lot,level,slp,tpp,ocCode,ocWhy,ocCool))
      {
       g_wcode=ocCode; g_waitReason=ocWhy; g_nextPlaceMs=GetTickCount64()+ocCool;
       SetSync(buy,YS_WAITING,ocWhy);
       return false;
      }
   }
   datetime pxExp=0;
   ENUM_ORDER_TYPE_TIME pxTT=PendingTimeType(pxExp);
   //--- v2.42 REQUEST JOURNAL: the request is saved (PREPARED) and marked SENT (flushed) BEFORE it leaves the terminal. The same request is never sent twice.
   if(ReqIsDuplicate(buy,level,lot))
     {
      LogOrder("REQ_DUPLICATE_BLOCKED",buy?(long)ORDER_TYPE_BUY_STOP:(long)ORDER_TYPE_SELL_STOP,level,lot,0,0,"an identical request (same side / level / lot / cycle) is still in flight or unresolved - not sent twice");
      SetSync(buy,YS_WAITING,"The same request is already in flight / unresolved - not sent twice");
      g_nextPlaceMs=GetTickCount64()+1000;
      return false;
     }
   const long jId=ReqPrepare(buy,level,lot);
   ReqMark(s,YJ_SENT);
   const ulong sendMs=GetTickCount64();
   ulong rttT0=GetMicrosecondCount();                // v2.39: real time of the server round trip (request -> answer), logged with the result
   bool r=buy?g_trade.BuyStop(lot,level,g_sym,slp,tpp,pxTT,pxExp,"Yetimmm")
             :g_trade.SellStop(lot,level,g_sym,slp,tpp,pxTT,pxExp,"Yetimmm");
   ulong rttMs=(GetMicrosecondCount()-rttT0)/1000;
   uint rc=g_trade.ResultRetcode();
   bool ok=(r && (rc==TRADE_RETCODE_DONE || rc==TRADE_RETCODE_PLACED || rc==TRADE_RETCODE_DONE_PARTIAL));
   long otype=buy?(long)ORDER_TYPE_BUY_STOP:(long)ORDER_TYPE_SELL_STOP;
   bool reentryTag=(g_state==YT_WAITING_REENTRY);   // v2.34: the Orders log says whether this send was a RE-ENTRY after an SL
   if(ok)
     {
      ulong ticket=g_trade.ResultOrder();
      if(g_revCtx)                                      // v2.37: remember WHICH risk / ledger this reverse order was planned with (read back when it fills)
        {
         GS("PAO",(double)ticket);
         GS("PAR",g_curRisk);
         GS("PAA",g_accLoss);
        }
      g_failCount=0;
      g_raceCnt[s]=0;
      //--- the retcode alone is not proof: the order must exist on the server with the requested values
      string vwhy="";
      bool verified=VerifyPlaced(ticket,buy,level,lot,slp,tpp,vwhy);
      ReqMark(s,verified?YJ_CONFIRMED:YJ_UNKNOWN);           // v2.42: journal - confirmed by the server state, or unknown (handed to the request ledger)
      if(!verified)
        {
         g_guardTk[s]=ticket;
         g_guardMs[s]=GetTickCount64()+4000;
         LogOrder("PLACED_UNVERIFIED",otype,level,lot,ticket,rc,vwhy);
         UncOpen(buy,level,lot,ticket,rc,"accepted by the server but not verified: "+vwhy);   // v2.40: no second request until the order is seen (or its fate is in the history)
         YLog(SideName(buy)+" accepted by the server but NOT verified: "+vwhy);
         SetSync(buy,YS_CREATING,"Awaiting server confirmation: "+vwhy);
         g_dirty=true;
         return false;
        }
      TrkTake(buy,ticket);
      ArmNote(buy,ticket,level,lot,g_revCtx);                    // v2.40: timeline of this armed order starts (measurement only)
      g_placedMs[s]=GetTickCount64();
      if(g_deferLvl[s]>0.0) YLog(SideName(buy)+" was waiting for the market - the price allows it now, order placed");
      g_deferLvl[s]=0.0;
      g_trig[s]=0.0;
      g_waitBuf[s]=(g_waitBuf[s]>(g_tick>0.0?g_tick:g_point)*1.5)?g_waitBuf[s]*0.5:0.0;   // the learned buffer decays after a success
      ulong latMs=(g_trigMs[s]>0)?(GetTickCount64()-g_trigMs[s]):0;
      g_trigMs[s]=0;
      BrWaitActivated(buy,level,ticket,latMs);           // v2.17: the waiting command in the app log becomes "activated"
      LogOrder("PLACED",otype,level,lot,ticket,rc,(g_revCtx?"REVERSE PRE-ARMED (fires on the SL touch) | ":"")+(reentryTag?"RE-ENTRY | ":"")+"Risk $"+D2(g_curRisk)+" SL "+PX(slp)+" TP "+PX(tpp)+" | acct "+(g_netting?"Netting":"Hedging")+" | cycle #"+IntegerToString((int)g_cycId)+" step "+IntegerToString(g_seq+1)+" | send RTT "+UL(rttMs)+" ms"+
               ((reentryTag && g_closeDetMs>0)?" | placed "+UL(GetTickCount64()-g_closeDetMs)+" ms after the closed position was noticed":""));
      if(reentryTag)                                      // v2.42: the measured reversal timeline (report Fix_1, problem 3)
        {
         const ulong tNow=GetTickCount64();
         const ulong t0=(g_tlTrMs>0)?g_tlTrMs:g_closeDetMs;
         string pv="";
         if(g_pvOk && g_revPid!=0 && g_pvPid==g_revPid)
            pv=" | prepared plan (age "+MsDiff(g_pvMs,sendMs)+" at the send): lot "+LotS(g_pvLot)+" risk "+D2(g_pvRisk)+" vs final lot "+LotS(lot)+" risk "+D2(g_curRisk)+((MathAbs(g_pvLot-lot)<1e-9)?" (same, re-validated)":" (different - final values were recomputed after the close)");
         LogOrder("REVERSE_TIMELINE",otype,level,lot,ticket,rc,"reversal of closed position #"+UL(g_revPid)+" | journal #"+IntegerToString((int)jId)+" | close seen -> loss booked "+MsDiff(t0,g_tlBookMs)+" | booked -> request sent "+MsDiff(g_tlBookMs,sendMs)+
                  " | broker answer (RTT) "+UL(rttMs)+" ms | TOTAL close seen -> broker confirmation "+MsDiff(t0,tNow)+" | close detected by "+(g_tlTrMs>0?"OnTradeTransaction":"position poll")+" | acct "+(g_netting?"Netting":"Hedging")+pv);
         g_tlTrMs=0; g_tlBookMs=0; g_pvOk=false;
        }
      SetSync(buy,YS_PLACED,"Ticket #"+UL(ticket));
      PanelMsg(SideName(buy)+" PLACED #"+UL(ticket)+" @ "+PX(level),clrLime);
      bool reentry=(g_state==YT_WAITING_REENTRY);
      YLog(g_revCtx?"Reverse order ARMED (real "+(buy?"Buy":"Sell")+" Stop "+PX(level)+" #"+UL(ticket)+", lot "+LotS(lot)+", planned risk "+D2(g_curRisk)+") - the broker fires it on the SL touch":
           (reentry?(buy?"Re-entry Order Placed: Buy Stop ":"Re-entry Order Placed: Sell Stop ")+PX(level)+" #"+UL(ticket):(buy?"Buy Stop Placed ":"Sell Stop Placed ")+PX(level)+" #"+UL(ticket)));
      if(reentry && AllNeededPlaced()) { g_state=YT_ARMED; g_closeDetMs=0; SaveState(); }   // WAITING_REENTRY lasts until BOTH orders are on the server
      TgQueue((g_revCtx?"🔄 REVERSE ORDER ARMED (fires on the SL touch)":(reentry?"🔁 RE-ENTRY ORDER PLACED":(buy?"📌 BUY STOP PLACED":"📌 SELL STOP PLACED")))+"\nTicket: #"+UL(ticket)+"\n"+(buy?"Buy Stop: ":"Sell Stop: ")+PX(level)+
              "\nLot: "+LotS(lot)+"\nRisk: $"+D2(g_curRisk)+"\nEstimated Loss at SL: $"+D2(est)+"\nSL: "+PX(slp)+"\nTP: "+PX(tpp)+(latMs>0?"\nExecution: "+UL(latMs)+" ms after the price reached the trigger":""));
      return true;
     }

   //--- rejected
   string cm=g_trade.ResultComment();
   //--- v2.16: the market moved between the check and the request (price crossed the level / requote): this is NOT a failure.
   //--- The level simply keeps waiting and the order is retried on the very next tick (bounded, then the normal error path applies)
   //--- v2.17: it is never shown as a failure; the safety buffer of this side widens (bounded) and the retries back off
   if((rc==TRADE_RETCODE_INVALID_STOPS || rc==TRADE_RETCODE_INVALID_PRICE || rc==TRADE_RETCODE_REQUOTE || rc==TRADE_RETCODE_PRICE_CHANGED) && g_raceCnt[s]<120)
     {
      ReqMark(s,YJ_REJECTED);                                // v2.42: journal - the server answered (price moved), nothing is pending
      g_raceCnt[s]++;
      double stp=MathMax((double)SymbolInfoInteger(g_sym,SYMBOL_SPREAD)*g_point,(g_tick>0.0)?g_tick:g_point);
      g_waitBuf[s]=MathMin(g_waitBuf[s]+stp,stp*8.0);
      g_trig[s]=WaitTrigger(buy,level);
      g_nextPlaceMs=nowMs+((g_raceCnt[s]<4)?250:(ulong)MathMin(3000.0,250.0*(g_raceCnt[s]-2)));
      SetSync(buy,YS_WAITING,"Market moved while sending - waiting for a safer price");
      if(g_raceCnt[s]==1 || g_raceCnt[s]%10==0)
         YLog(SideName(buy)+" "+PX(level)+": market moved while sending (retcode "+IntegerToString((int)rc)+") - safety buffer "+PX(g_waitBuf[s])+", waiting (attempt "+IntegerToString(g_raceCnt[s])+")");
      return false;
     }
   const int cls=ClassifyRetcode(rc,r);
   const string ctx=" | class "+RetClassName(cls)+" | acct "+(g_netting?"Netting":"Hedging")+" | cycle #"+IntegerToString((int)g_cycId)+" step "+IntegerToString(g_seq+1)+" (a failed send is NOT a step) | Acc.Loss $"+D2(g_accLoss)+
                    " | risk $"+D2(g_curRisk)+" | bid "+PX(tk.bid)+" ask "+PX(tk.ask)+" (at the pre-send check) | send RTT "+UL(rttMs)+" ms";
   //--- v2.39 UNCERTAIN: the request may have reached the server. NO failure, NO new request until the server has been looked at (SideOrderExists is
   //--- the first guard of TryPlace; the short cool-down gives the server time to publish the order). The next synchronisation adopts it if it exists.
   if(cls==YR_UNCERT)
     {
      const bool onServer=SideOrderExists(buy);
      ReqMark(s,YJ_UNKNOWN);                                 // v2.42: journal - unknown, verified against the server before anything is re-sent
      UncOpen(buy,level,lot,g_trade.ResultOrder(),rc,(reentryTag?"RE-ENTRY | ":"")+"result unknown ("+cm+") | order on the server right now: "+(onServer?"YES (it will be adopted)":"NO (verification continues)")+ctx);
      YLog(SideName(buy)+" "+PX(level)+": request result UNCERTAIN (retcode "+IntegerToString((int)rc)+" "+cm+") - recorded in the request ledger; nothing new is sent until the server shows the outcome; order present now: "+(onServer?"yes":"no"));
      SetSync(buy,YS_WAITING,"Result UNCERTAIN (retcode "+IntegerToString((int)rc)+") - verifying the server before any new request");
      RaiseAlert("UNC"+IntegerToString(s),SideName(buy)+" "+PX(level)+": the server did not confirm the request (retcode "+IntegerToString((int)rc)+"). Verifying before any new request.",false,true);
      g_nextPlaceMs=nowMs+3000;
      g_dirty=true;
      return false;
     }
   ReqMark(s,YJ_REJECTED);                                   // v2.42: journal - a definite answer: rejected
   LogOrder("REJECTED",otype,level,lot,0,rc,(reentryTag?"RE-ENTRY | ":"")+cm+ctx);
   SetSync(buy,YS_FAILED,"NOT PLACED: "+cm+" [retcode "+IntegerToString((int)rc)+"]");
   PanelMsg(SideName(buy)+" NOT PLACED: "+cm,clrTomato);
   YLog("Execution Rejected: retcode "+IntegerToString((int)rc)+" "+cm+" ["+RetClassName(cls)+"]");
   ulong delay=2000;
   bool transient=false;
   switch(cls)
     {
      case YR_BROKER:
         if(rc==TRADE_RETCODE_NO_MONEY)           { g_blockReason="Insufficient margin for required risk."; delay=30000; }
         else if(rc==TRADE_RETCODE_MARKET_CLOSED) { g_blockReason="Market closed"; delay=30000; }
         else                                     { g_blockReason="Trading disabled / restricted by the broker"; delay=15000; }
         transient=true;
         break;
      case YR_RETRY:
         g_failCount++;                                     // only the back-off grows; a RETRY class never moves the bot to ERROR
         delay=(ulong)MathMin(10000.0,1500.0*MathPow(2.0,MathMin(g_failCount-1,3)));
         if(rc==TRADE_RETCODE_TOO_MANY_REQUESTS && delay<10000) delay=10000;
         transient=true;
         break;
      default:                                              // ADJUST / PERMANENT
         g_failCount++;
         delay=(ulong)MathMin(60000.0,2000.0*MathPow(2.0,MathMin(g_failCount,5)));
         break;
     }
   g_nextPlaceMs=nowMs+delay;
   RaiseAlert("REJ"+IntegerToString((int)rc),"Order rejected (NOT PLACED) ("+(buy?"Buy Stop":"Sell Stop")+" "+PX(level)+"): "+cm+" [retcode "+IntegerToString((int)rc)+"]",true,true);
   if(!transient && g_failCount>=8 && !g_revCtx)
     {
      g_state=YT_ERROR;
      GS("REVERR",0.0);                          // a placement error is not a reversal error: /start re-arms normally
      SaveState();
      RaiseAlert("ERRSTATE","Bot moved to ERROR state after repeated order failures. Fix the issue, then use /start or enter levels.",true,true);
     }
   return false;
  }

//+------------------------------------------------------------------+
//| v2.00: ONE position at most. If more than one exists (e.g. both  |
//| stop orders were triggered inside one price gap) the oldest is   |
//| kept and the others are closed.                                  |
//+------------------------------------------------------------------+
void EnforceSinglePosition(const ulong &pos[],const int np)
  {
   ulong nowMs=GetTickCount64();
   if(nowMs<g_nextExtraMs) return;
   g_nextExtraMs=nowMs+250;          // v2.28: was 2000 ms - the extra position is closed as soon as it is seen (smaller loss)
   ulong keep=0; long kt=0;
   //--- v2.37: when exactly ONE of two positions is already past its own SL (the broker is closing it), the OTHER one is the one to keep
   if(np==2 && InpPreArmReverse && !g_netting)
     {
      bool c0=PosSLCrossed(pos[0]), c1=PosSLCrossed(pos[1]);
      if(c0 && !c1) keep=pos[1];
      else if(c1 && !c0) keep=pos[0];
     }
   if(keep==0)
      for(int i=0;i<np;i++)
        {
         if(!PositionSelectByTicket(pos[i])) continue;
         long tm=PositionGetInteger(POSITION_TIME_MSC);
         if(keep==0 || tm<kt || (tm==kt && pos[i]<keep)) { keep=pos[i]; kt=tm; }   // oldest kept; equal time -> lowest ticket (deterministic)
        }
   for(int i=0;i<np;i++)
     {
      if(pos[i]==keep) continue;
      if(!PositionSelectByTicket(pos[i])) continue;
      ulong pid=(ulong)PositionGetInteger(POSITION_IDENTIFIER);
      long ot=(PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY)?(long)ORDER_TYPE_BUY:(long)ORDER_TYPE_SELL;
      double px=PositionGetDouble(POSITION_PRICE_OPEN), lt=PositionGetDouble(POSITION_VOLUME);
      PSet(pid,"CRC",5.0);
      GlobalVariablesFlush();
      ulong exitDev=(ulong)MathMax(500,g_maxDev*10);
      bool ok=InstOk("close extra position")&&g_trade.PositionClose(pos[i],exitDev);
      uint rc=g_trade.ResultRetcode();
      LogOrder(ok?"EXTRA_POS_CLOSE":"EXTRA_POS_CLOSE_FAILED",ot,px,lt,pos[i],rc,"only one position is allowed");
      YLog(ok?"Extra position closed #"+UL(pos[i])+" (only one position is allowed)":"Extra position close FAILED #"+UL(pos[i])+" retcode "+IntegerToString((int)rc)+" (retrying)");
     }
  }

//+------------------------------------------------------------------+
//| v2.00 (BREACH_MARKET): the Stop-Loss itself already crossed the  |
//| opposite level, so a stop order cannot exist there. The opposite |
//| direction is opened at market (SL/TP from the same two levels).  |
//| returns true while this pass is consumed by the reversal.        |
//+------------------------------------------------------------------+
//--- v2.11: failure classes of a market reversal
//--- transient: can clear by itself (market closed, connection, requote ...) - never counted towards the ERROR threshold
bool RevRetcodeTransient(const uint rc)
  {
   switch((int)rc)
     {
      case TRADE_RETCODE_MARKET_CLOSED:
      case TRADE_RETCODE_CONNECTION:
      case TRADE_RETCODE_TOO_MANY_REQUESTS:
      case TRADE_RETCODE_REQUOTE:
      case TRADE_RETCODE_PRICE_CHANGED:
      case TRADE_RETCODE_PRICE_OFF:
      case TRADE_RETCODE_TIMEOUT:
         return true;
     }
   return false;
  }

//--- permanent: retrying cannot help, the cause must be fixed by the user
bool RevRetcodePermanent(const uint rc)
  {
   switch((int)rc)
     {
      case TRADE_RETCODE_INVALID_VOLUME:
      case TRADE_RETCODE_LONG_ONLY:
      case TRADE_RETCODE_SHORT_ONLY:
      case TRADE_RETCODE_CLOSE_ONLY:
      case TRADE_RETCODE_LIMIT_VOLUME:
         return true;
     }
   return false;
  }

//--- the reversal cannot be executed: stop retrying, ERROR / MANUAL ACTION (resumed by /start or by new levels)
void RevEnterError(const string why)
  {
   //--- v2.23: a reversal that cannot be executed is a WAIT, not a fatal state: no ERROR, no MANUAL ACTION. Retry slowly.
   g_revFails=0; g_revHard=0;
   g_nextRevMs=GetTickCount64()+60000;
   g_wcode="WAITING_REENTRY";
   g_waitReason="Market reversal paused ("+why+") - retrying every 60 s";
   YLog("WAITING_REENTRY: "+g_waitReason);
   RaiseAlert("REVWAIT","Market reversal is waiting: "+why+". The bot keeps retrying by itself (no action required).",false,true);
   g_dirty=true;
  }

bool TryMarketReverse(const int force=0,const bool catchMode=false)   // v2.33: disabled - the EA never sends a market entry by itself. force: 0 = reversal after an SL, 1 = virtual-entry BUY, 2 = virtual-entry SELL; catchMode (v2.30) = FAST CATCH of a crossed level
  {
   if(YT_REAL_ORDERS_ONLY) return false;                               // v2.33: real pending orders only
   if(force==0 && g_lastSLSide!=1 && g_lastSLSide!=2) return false;
   if(!InstOkTrade("open a market reversal")) return false;                  // v2.29: lock re-verified before every send
   {
    ulong rp[];
    if(OwnPositions(rp)>0) return false;                                // v2.29: never open a second trade while one is open
   }
   bool revBuy=(force!=0)?(force==1):(g_lastSLSide==2);                 // a Sell was stopped -> Buy next; a Buy was stopped -> Sell next
   double lvl=revBuy?g_buyLevel:g_sellLevel;      // the level that would have been the stop-order entry
   double slLvl=revBuy?g_sellLevel:g_buyLevel;    // SL of the new trade = the opposite level
   if(lvl<=0.0 || slLvl<=0.0 || g_buyLevel<=g_sellLevel) return false;
   MqlTick tk;
   if(!SymbolInfoTick(g_sym,tk) || tk.ask<=0.0 || tk.bid<=0.0) return false;
   bool breached=(force!=0)?true:(revBuy?(tk.ask>=lvl):(tk.bid<=lvl));
   if(!breached) { g_revHard=0; return false; }   // level still ahead of the price: a normal pending order is used
   ulong nowMs=GetTickCount64();
   if(nowMs<g_nextRevMs) return true;
   string why;
   if(!TradingAllowedNow(why)) { g_waitReason="Market reversal waiting: "+why; g_nextRevMs=nowMs+3000; return true; }

   //--- 1) REAL execution price, SL = the opposite level, TP from the REAL entry and the REAL SL distance
   //---    (so profit at TP = risk x R/R exactly as the recovery maths assumes, even after a gap)
   //--- v2.31 FIXED DISTANCES: SL = zone width (Upper-Lower) and TP = zone width x R/R, both measured from the REAL fill price.
   //---    Before, SL was the opposite LEVEL, so a gap beyond the level made the SL farther -> SMALLER lot and a FARTHER TP (the wrong way round).
   double entry=revBuy?tk.ask:tk.bid;
   double fixedDist=SLDist();
   if(fixedDist<=0.0) return false;
   double slp=RoundTick(revBuy?entry-fixedDist:entry+fixedDist);
   double tpp=RoundTick(revBuy?entry+fixedDist*g_rr:entry-fixedDist*g_rr);
   //--- v2.23 MAX REVERSAL DISTANCE: a market entry far beyond the level is a different trade (different SL distance / lot): do not take it
   double gapLim=catchMode?InpCatchMaxGap:((force==0)?InpMaxRevGap:0.0);
   if(gapLim>0.0 && MathAbs(entry-lvl)>gapLim)
     {
      g_wcode="WAITING_REENTRY";
      g_waitReason=(catchMode?"Fast catch skipped: price is ":"Market reversal skipped: price is ")+PX(MathAbs(entry-lvl))+" beyond the level (Max Gap "+PX(gapLim)+") - waiting for the pending pair";
      g_nextRevMs=nowMs+2000;
      return false;
     }

   //--- 2) PRE-FLIGHT against the real market: SL/TP on the correct side and outside the Stops Level
   if(!MarketPreflight(revBuy,slp,tpp,why))
     {
      g_revFails++;
      g_revHard++;
      g_waitReason="Market reversal blocked: "+why;
      g_nextRevMs=nowMs+(ulong)MathMin(15000.0,2000.0*g_revFails);
      LogOrder("MARKET_REVERSAL_BLOCKED",revBuy?(long)ORDER_TYPE_BUY:(long)ORDER_TYPE_SELL,entry,0.0,0,0,why);
      YLog("Market reversal blocked by pre-flight: "+why+" (attempt "+IntegerToString(g_revFails)+")");
      RaiseAlert("REVBLOCK","Market reversal NOT sent (pre-flight): "+why+". Retrying; the opposite trade is not open yet.",true,true);
      if(g_revHard>=YT_REV_MAX_HARD) RevEnterError("pre-flight keeps failing: "+why);
      return true;
     }

   //--- 3) lot from the REAL entry to the SL (a gap makes the SL farther -> a smaller lot; the risk stays = requested risk)
   double lot=0,est=0; string err="";
   string rgw="",rgc="";
   if(RecoveryGuardBlocks(rgw,rgc))
     {
      g_wcode=rgc; g_waitReason=rgw; g_nextRevMs=nowMs+5000;
      RaiseAlert("RPGUARD"+rgc,rgw,false,true);
      return true;
     }
   if(!CalcLotSL(g_curRisk,revBuy,entry,slp,lot,est,err))
     {
      //--- v2.23: no legal volume at THIS price is a WAIT (the price may move to a better entry), never a hard failure
      HandleLotError(err);
      g_nextRevMs=nowMs+5000;
      return true;
     }

   //--- 4) one-position rule: no pending order may survive next to the market order
   ulong od[];
   int no=OwnOrders(od);
   for(int i=0;i<no;i++)
      if(!DeleteOrder(od[i],"Market reversal: pending orders removed")) { g_nextRevMs=nowMs+2000; return true; }

   //--- 5) send; the expected protection AND the expected price are remembered:
   //---    SL/TP -> repaired by the protection guard if missing; price -> REAL slippage is measured after the fill (RegisterPosition)
   GS("RVSL",slp); GS("RVTP",tpp); GS("RVEXP",entry);
   int sendDev=catchMode?MathMax(g_maxDev,InpCatchDeviation):g_maxDev;     // v2.30: a fast market needs a wide window, otherwise requote / reject = a missed entry
   GS("RVDEV",catchMode?(double)sendDev:0.0);                               // the same window is tolerated after the fill (RegisterPosition)
   g_trade.SetDeviationInPoints(sendDev);
   //--- the expected price is sent with the request, so Max Slippage Check also works as a PRICE GUARD (a requote / reject instead of a bad fill)
   bool r=revBuy?g_trade.Buy(lot,g_sym,entry,slp,tpp,"Yetimmm"):g_trade.Sell(lot,g_sym,entry,slp,tpp,"Yetimmm");
   uint rc=g_trade.ResultRetcode();
   bool ok=(r && (rc==TRADE_RETCODE_DONE || rc==TRADE_RETCODE_PLACED || rc==TRADE_RETCODE_DONE_PARTIAL));
   long ot=revBuy?(long)ORDER_TYPE_BUY:(long)ORDER_TYPE_SELL;
   if(ok)
     {
      g_revFails=0;
      g_revHard=0;
      g_waitReason="";
      double gapPts=MathAbs(entry-lvl)/g_point;
      LogOrder("MARKET_REVERSAL",ot,entry,lot,g_trade.ResultOrder(),rc,"level "+PX(lvl)+" already crossed (gap "+DoubleToString(gapPts,0)+" pts) | SL "+PX(slp)+" TP "+PX(tpp)+" | est. loss at SL $"+D2(est));
      YLog(string(revBuy?"Buy":"Sell")+" opened at market @ "+PX(entry)+" (level "+PX(lvl)+" already crossed after the Stop Loss) | lot "+LotS(lot)+" | est. loss at SL $"+D2(est));
      TgQueue("🔁 MARKET REVERSAL\n"+(revBuy?"BUY":"SELL")+" opened at market\nLevel crossed: "+PX(lvl)+" | Expected entry: "+PX(entry)+"\nLot: "+LotS(lot)+" (risk $"+D2(g_curRisk)+", est. loss at SL $"+D2(est)+")\nSL: "+PX(slp)+"\nTP: "+PX(tpp));
      g_dirty=true;
      return true;
     }
   GS("RVSL",0.0); GS("RVTP",0.0); GS("RVEXP",0.0); GS("RVDEV",0.0);
   string cm=g_trade.ResultComment();
   g_revFails++;
   if(!RevRetcodeTransient(rc)) g_revHard++;
   LogOrder("MARKET_REVERSAL_FAILED",ot,entry,lot,0,rc,cm);
   YLog((catchMode?"Fast catch rejected: retcode ":"Market reversal rejected: retcode ")+IntegerToString((int)rc)+" "+cm+" (attempt "+IntegerToString(g_revFails)+")");
   //--- v2.30: a requote / price change in a fast market is retried within 80 ms, not after seconds (the price is moving, every second is a worse entry)
   if((rc==TRADE_RETCODE_REQUOTE || rc==TRADE_RETCODE_PRICE_CHANGED || rc==TRADE_RETCODE_PRICE_OFF || rc==TRADE_RETCODE_REJECT || rc==TRADE_RETCODE_TIMEOUT) && g_revFails<12)
      g_nextRevMs=nowMs+80;
   else
      g_nextRevMs=nowMs+(ulong)MathMin(15000.0,2000.0*g_revFails);
   if(g_revFails>=5) RaiseAlert("REVFAIL","Market reversal keeps failing ("+cm+" [retcode "+IntegerToString((int)rc)+"]). The opposite trade is NOT open - check the account / market.",true,true);
   if(RevRetcodePermanent(rc) || g_revHard>=YT_REV_MAX_HARD)
      RevEnterError(cm+" [retcode "+IntegerToString((int)rc)+"]");
   return true;
  }

//+------------------------------------------------------------------+
//| v2.22 VIRTUAL ENTRY: the zone is stored in the EA; no pending     |
//| order exists. Edge trigger like a real Stop order: the price must |
//| first be INSIDE the zone, then crossing the upper level = BUY and |
//| crossing the lower level = SELL, executed at market with the SL   |
//| at the opposite level. Both levels are always honoured, so there  |
//| is no zone gate, no Stops-Level window and no lone order.         |
//+------------------------------------------------------------------+
bool VirtualWake()
  {
   if(YT_REAL_ORDERS_ONLY || InpEntryMode!=ENTRY_VIRTUAL) return false;
   if(g_state!=YT_ARMED && g_state!=YT_WAITING_REENTRY) return false;
   if(g_mode!=YM_BOTH || g_buyLevel<=0.0 || g_sellLevel<=0.0 || g_buyLevel<=g_sellLevel) return false;
   MqlTick tk;
   if(!SymbolInfoTick(g_sym,tk) || tk.ask<=0.0 || tk.bid<=0.0) return false;
   if(!g_vArmed) return (tk.bid>g_sellLevel && tk.ask<g_buyLevel);
   return (tk.ask>=g_buyLevel || tk.bid<=g_sellLevel);
  }

void VirtualEntryPass()
  {
   if(YT_REAL_ORDERS_ONLY) { g_vArmed=false; return; }
   g_zoneGate=false; g_trig[0]=0.0; g_trig[1]=0.0;
   //--- no pending order is wanted in this mode (leftovers of PENDING mode are removed)
   ulong od[];
   int no=OwnOrders(od);
   if(no>0 && GetTickCount64()>=g_nextDelMs)
      for(int i=0;i<no;i++)
         if(!DeleteOrder(od[i],"Virtual entry mode: no pending order is wanted")) g_nextDelMs=GetTickCount64()+2000;
   string vt=g_vArmed?"Virtual trigger armed: BUY when Ask >= "+PX(g_buyLevel)+" | SELL when Bid <= "+PX(g_sellLevel)
                     :"Waiting for the price to enter the zone ("+PX(g_sellLevel)+" - "+PX(g_buyLevel)+")";
   g_waitReason=vt;
   SetSync(true, YS_WAITING,vt);
   SetSync(false,YS_WAITING,vt);
   MqlTick tk;
   if(!SymbolInfoTick(g_sym,tk) || tk.ask<=0.0 || tk.bid<=0.0) return;
   if(!g_vArmed)
     {
      if(tk.bid>g_sellLevel && tk.ask<g_buyLevel)
        {
         g_vArmed=true;
         if(g_state==YT_WAITING_REENTRY) { g_state=YT_ARMED; SaveState(); }
         YLog("Virtual entry armed: the price is inside the zone ("+PX(g_sellLevel)+" - "+PX(g_buyLevel)+")");
        }
      return;
     }
   if(tk.ask>=g_buyLevel)       TryMarketReverse(1);
   else if(tk.bid<=g_sellLevel) TryMarketReverse(2);
  }

//+------------------------------------------------------------------+
//| v2.30 FAST CATCH. The pending Stop orders are the strategy, and   |
//| the server fills them itself. But when a level is crossed while   |
//| NO order of that side is on the server (re-arming after a Stop    |
//| Loss, zone gate, "market moved" wait, ...) the old code simply    |
//| waited and the move was lost. Now the crossing is entered AT      |
//| MARKET on that very tick: SL = opposite level, TP from the real   |
//| entry, lot from the real entry-to-SL distance (risk unchanged).   |
//| Safe-guards: the zone must have been seen first (no instant entry |
//| on START with the price far outside), one position only, the      |
//| previous closure must be booked first, optional max gap.          |
//+------------------------------------------------------------------+
void SyncAll();   // defined below

bool CatchTick(const MqlTick &tk,const ulong now)
  {
   if(YT_REAL_ORDERS_ONLY || !InpFastCatch || InpEntryMode!=ENTRY_PENDING) { g_catchArmed=false; return false; }
   if(g_state!=YT_ARMED && g_state!=YT_WAITING_REENTRY) { g_catchArmed=false; return false; }
   if(g_buyLevel<=0.0 || g_sellLevel<=0.0 || g_buyLevel<=g_sellLevel) return false;
   if(g_mode!=YM_BOTH && g_mode!=YM_BUY && g_mode!=YM_SELL) return false;
   if(MathAbs(g_catchLb-g_buyLevel)>1e-9 || MathAbs(g_catchLs-g_sellLevel)>1e-9) { g_catchArmed=false; g_catchLb=g_buyLevel; g_catchLs=g_sellLevel; }   // new levels: the zone must be seen again
   bool inside=(tk.bid>g_sellLevel && tk.ask<g_buyLevel);
   if(inside) g_catchArmed=true;
   else if(g_state==YT_WAITING_REENTRY && InpCatchAfterSL) g_catchArmed=true;
   if(!g_catchArmed) return false;
   int force=0;
   if((g_mode==YM_BOTH || g_mode==YM_BUY)  && tk.ask>=g_buyLevel  && tk.bid>g_sellLevel) force=1;
   else if((g_mode==YM_BOTH || g_mode==YM_SELL) && tk.bid<=g_sellLevel && tk.ask<g_buyLevel) force=2;
   if(force==0 || now<g_nextCatchMs || g_busy) return false;
   g_nextCatchMs=now+50;
   //--- the server fills its own order: only a MISSING order needs the catch
   if(SideOrderExists(force==1)) return false;
   //--- one position at most, and the closure of the previous one is booked first (the risk of the new trade depends on it)
   {
    ulong pp[];
    if(OwnPositions(pp)>0) return false;
   }
   if(ClosurePendingBlocks())
     {
      SyncAll();                                       // books the closing deal in milliseconds in the normal case
      if(g_state!=YT_ARMED && g_state!=YT_WAITING_REENTRY) return false;
      if(ClosurePendingBlocks()) return false;         // not booked yet: retried on the next tick (bounded to 20 s inside)
     }
   g_busy=true;
   bool r=TryMarketReverse(force,true);
   g_busy=false;
   if(r)
     {
      //--- TryMarketReverse also returns true for "consumed, retry later" (requote, waiting volume ...): disarm only when a position really exists
      ulong p2[];
      if(OwnPositions(p2)>0) g_catchArmed=false;
     }
   return r;
  }

void CatchTimer()
  {
   if(YT_REAL_ORDERS_ONLY || !InpFastCatch) return;
   MqlTick tk;
   if(SymbolInfoTick(g_sym,tk) && tk.ask>0.0 && tk.bid>0.0) CatchTick(tk,GetTickCount64());
  }

//+------------------------------------------------------------------+
//| v2.30 NETWORK SILENCE. MT5 runs an EA on ONE thread: while a      |
//| WebRequest waits (up to its timeout) NO tick is processed - that  |
//| was the "the bot froze and did not execute" in a fast move.       |
//| The network is therefore silent while the market is hot.          |
//+------------------------------------------------------------------+
void HotTrack(const MqlTick &tk,const ulong now)
  {
   double mid=(tk.bid+tk.ask)*0.5;
   if(g_hkMs==0 || now-g_hkMs>=1000) { g_hkMs=now; g_hkLo=mid; g_hkHi=mid; return; }
   if(mid<g_hkLo) g_hkLo=mid;
   if(mid>g_hkHi) g_hkHi=mid;
   if(InpFastMovePts>0 && (g_hkHi-g_hkLo)>=(double)InpFastMovePts*g_point)
      g_fastUntil=now+(ulong)MathMax(1,InpHotHoldSec)*1000;
  }

bool NetHot(const bool prio=false)
  {
   ulong now=GetTickCount64();
   if(now<g_fastUntil) return true;
   if(g_dirty && !prio) return true;                          // a trade event is waiting to be processed (a priority ack call may go out: it is one short request, the event is handled within 1 s)
   if(g_state==YT_BUY_ACTIVE || g_state==YT_SELL_ACTIVE)
     {
      ulong od[];
      return OwnOrders(od)>0;                                 // the opposite pending order must disappear first
     }
   if(g_state!=YT_ARMED && g_state!=YT_WAITING_REENTRY) return false;
   if(g_sync[0]==YS_CREATING || g_sync[1]==YS_CREATING) return true;
   if(g_trig[0]>0.0 || g_trig[1]>0.0)
     {
      //--- v2.45: a WAITING side keeps the network silent only while the price is NEAR its trigger (3 x the hot zone). Before this, ANY waiting side silenced the network
      //--- for up to 20 s even when the price was far away: the Mini App command was executed but its confirmation (and the heartbeat) left 20 s later.
      if(InpHotZone<=0.0) return true;
      MqlTick tw;
      if(!SymbolInfoTick(g_sym,tw) || tw.ask<=0.0 || tw.bid<=0.0) return true;
      const double nearW=3.0*InpHotZone;
      if(g_trig[0]>0.0 && tw.ask<=g_trig[0]+nearW) return true;   // Buy waits for Ask <= trigger
      if(g_trig[1]>0.0 && tw.bid>=g_trig[1]-nearW) return true;   // Sell waits for Bid >= trigger
     }
   if(InpHotZone>0.0 && g_buyLevel>g_sellLevel && g_sellLevel>0.0)
     {
      MqlTick t;
      if(SymbolInfoTick(g_sym,t) && t.ask>0.0 && t.bid>0.0)
        {
         if(t.ask>=g_buyLevel-InpHotZone || t.bid<=g_sellLevel+InpHotZone) return true;   // near / beyond a level (covers outside-the-zone too)
        }
     }
   return false;
  }

//--- true = a WebRequest may run now. A hot market silences it, but never longer than InpNetMaxDeferSec
bool NetAllowed()
  {
   if(!InpNetSilence) return true;                       // v2.46: silence is OFF by default (EA 2.30 behaviour) - the network is always allowed
   if(!NetHot()) { g_netDeferSince=0; return true; }
   ulong now=GetTickCount64();
   //--- v2.45 PRIORITY ACK: a command was executed and its result must reach the Worker now. Allowed unless the market itself is hot (fast move / price at a level / position + opposite order)
   if(g_netAckWait && now-g_netPrioMs>=500 && !NetHot(true)) { g_netPrioMs=now; return true; }
   if(g_netDeferSince==0) g_netDeferSince=now;
   if(now-g_netDeferSince>=(ulong)MathMax(1,InpNetMaxDeferSec)*1000) { g_netDeferSince=now; return true; }
   return false;
  }

//--- v2.45.1 HEARTBEAT ALLOWANCE (root cause of the "EA offline for 35-80 s" drops).
//--- Before: TgPoll() and BridgeSync() shared ONE allowance (NetAllowed). In a hot market it opens once per InpNetMaxDeferSec (5 s) at a random 200 ms timer event,
//--- TgPoll() (first in OnTimer) used it up, and BridgeSync() runs only in the 1-per-second slow path -> it got the allowance only when both happened to coincide
//--- (about 1 time in 5). Measured by simulation: median gap between syncs 20 s, 30 % of gaps > 30 s (the Worker's offline limit), worst case 150 s.
//--- Now the bridge has its OWN allowance, measured from the last bridge request that really left, so the heartbeat can never be starved by anything else.
//--- It never makes the network noisier than before (<= 1 bridge call per InpNetMaxDeferSec in a hot market) and a quiet market is untouched.
bool BrNetAllowed()
  {
   if(!InpNetSilence) return true;                       // v2.46: the heartbeat is sent every slow-path second, exactly as in EA 2.30
   if(!NetHot()) return true;
   ulong now=GetTickCount64();
   if(g_netAckWait && now-g_netPrioMs>=500 && !NetHot(true)) { g_netPrioMs=now; return true; }   // priority ack (unchanged rule)
   if(g_brNetMs==0 || now<g_brNetMs) return true;                                                  // never sent yet / tick counter wrapped
   return (now-g_brNetMs>=(ulong)MathMax(1,InpNetMaxDeferSec)*1000);
  }

int NetTimeout()
  {
   return MathMax(500,MathMin(5000,InpNetTimeoutMs));
  }

//+------------------------------------------------------------------+
//| v2.37 STOP-AND-REVERSE (pre-armed opposite Stop order)           |
//| While a position is open the opposite Stop order stays on the    |
//| server at the SL level. It is a REAL pending order: the broker   |
//| triggers it on the same tick that triggers the position's SL.    |
//| Its lot is the NEXT recovery step, predicted from the open       |
//| trade's loss at its SL (same ledger rule as ProcessClosedPosition)|
//+------------------------------------------------------------------+
//--- is the position already past its own SL (the server is closing it)?
bool PosSLCrossed(const ulong ticket)
  {
   if(!PositionSelectByTicket(ticket)) return false;
   double sl=PositionGetDouble(POSITION_SL);
   if(sl<=0.0) return false;
   MqlTick t;
   if(!SymbolInfoTick(g_sym,t) || t.bid<=0.0 || t.ask<=0.0) return false;
   double tol=((g_tick>0.0)?g_tick:g_point)*0.5;
   if(PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY) return (t.bid<=sl+tol);
   return (t.ask>=sl-tol);
  }

//--- two positions at one instant because the pre-armed reverse order fired together with the SL of the first: NOT an "extra position"
bool ReverseSwitchInProgress(const ulong &pos[],const int np)
  {
   if(np!=2 || !InpPreArmReverse || g_netting) return false;
   ulong young=0;
   long ym0=0, ym1=0;
   if(!PositionSelectByTicket(pos[0])) return false;
   ym0=PositionGetInteger(POSITION_TIME_MSC);
   long t0=PositionGetInteger(POSITION_TYPE);
   ulong pid0=(ulong)PositionGetInteger(POSITION_IDENTIFIER);
   if(!PositionSelectByTicket(pos[1])) return false;
   ym1=PositionGetInteger(POSITION_TIME_MSC);
   long t1=PositionGetInteger(POSITION_TYPE);
   ulong pid1=(ulong)PositionGetInteger(POSITION_IDENTIFIER);
   if(t0==t1) return false;                                   // the reverse trade is the OPPOSITE direction
   young=(ym1>=ym0)?pos[1]:pos[0];
   ulong yp=(ym1>=ym0)?pid1:pid0;
   if(PGV(yp,"PAF",0.0)<0.5) return false;                    // only a trade opened by the pre-armed order qualifies
   if(!PositionSelectByTicket(young)) return false;
   long ageMs=(long)TimeCurrent()*1000-PositionGetInteger(POSITION_TIME_MSC);
   return (MathAbs(ageMs)<5000);                              // 5 s grace for the server to book the stop-out of the first trade
  }

//--- 0 = no reverse order (legacy: the opposite order is deleted) | 1 = keep and maintain it | 2 = wait one more pass (position not registered yet)
int ReverseArmDecision(const ulong ptk,const bool posBuy)
  {
   if(!InpPreArmReverse || g_netting) return 0;
   if(g_state==YT_STOPPED || g_stopCleanup || g_halt || g_netTaint || g_unprot) return 0;
   if(g_state!=YT_BUY_ACTIVE && g_state!=YT_SELL_ACTIVE) return 0;
   if(!PositionSelectByTicket(ptk)) return 0;
   ulong pid=(ulong)PositionGetInteger(POSITION_IDENTIFIER);
   if(g_revOffPid==pid) return 0;
   if(!PHas(pid,"N"))
     {
      //--- just filled: the registration (levels / risk of this trade) is a few ms behind - never delete the opposite order in that window
      long ageMs=(long)TimeCurrent()*1000-PositionGetInteger(POSITION_TIME_MSC);
      return (MathAbs(ageMs)<3000)?2:0;
     }
   if(PositionGetDouble(POSITION_SL)<=0.0) return 0;           // unprotected: ProtectPosition has priority
   if(!(g_sellLevel>0.0 && g_buyLevel>g_sellLevel)) return 0;
   if(!PriceEq(PGV(pid,"LB",0.0),g_buyLevel) || !PriceEq(PGV(pid,"LS",0.0),g_sellLevel)) return 0;   // the levels this trade was opened with are still the active ones
   return 1;
  }

//--- maintain the reverse order: ONE opposite Stop at the SL level, sized for the next recovery step
void ReverseArmPass(const ulong ptk,const bool posBuy)
  {
   const bool revBuy=!posBuy;
   const int  rs=SideIdx(revBuy);
   g_revSide=rs;
   if(ClosurePendingBlocks()) return;          // an older closing deal is not booked yet: its loss must enter the ledger BEFORE the next lot is planned
   const double level=revBuy?g_buyLevel:g_sellLevel;
   //--- 1) only ONE order may exist next to the position: the reverse one
   ulong keepT=CanonicalTicket(revBuy,level);
   if(GetTickCount64()>=g_nextDelMs)
     {
      ulong od[];
      int no=OwnOrders(od);
      for(int i=0;i<no;i++)
        {
         if(od[i]==keepT) continue;
         if(!DeleteOrder(od[i],"Reverse pre-arm: only ONE opposite Stop order is kept")) g_nextDelMs=GetTickCount64()+2000;
        }
     }
   //--- 2) predicted next step: the loss of the OPEN trade at its SL (broker specification + learned commission) joins the ledger exactly as ProcessClosedPosition will book it
   if(!PositionSelectByTicket(ptk)) return;
   double vol=PositionGetDouble(POSITION_VOLUME), pe=PositionGetDouble(POSITION_PRICE_OPEN), psl=PositionGetDouble(POSITION_SL);
   double perLot=PerLotLossSL(posBuy,pe,psl);
   if(perLot<=0.0 || vol<=0.0) return;
   double predLoss=vol*(perLot+CommPerLotEff());
   double sA=g_accLoss, sC=g_curRisk;
   int    sS=g_seq, sF=g_failCount;
   ulong  sN=g_nextPlaceMs;
   g_revSwap=true;                              // from here until the restore below NOTHING may return early
   //--- v2.48: the PREDICTED debt is derived exactly like CycleBook does (max(0, -net)); the old 'sA+predLoss' over-stated it when the cycle was in partial profit
   //--- (net > 0), which fed the wrong debt to the accumulated-loss cap, the round-up rule and the value stored with the order (PAA)
   const double predNet=g_cycNet-predLoss;
   g_accLoss=(predNet<0.0)?-predNet:0.0;
   g_seq=sS+1;
   g_curRisk=NextRiskForNet(predNet);
   double lot=0.0, est=0.0;
   string err="", gw="", gc="";
   bool guard=RecoveryGuardBlocks(gw,gc);
   bool lotOk=(!guard) && CalcLot(g_curRisk,revBuy,level,lot,est,err);
   double planRisk=g_curRisk;
   if(lotOk)
     {
      RecoveryTrace("REVERSE_PREARM",revBuy,g_curRisk,lot,vol);
      g_nextPlaceMs=g_revNextMs;                 // the reverse order has its own retry cooldown
      g_revCtx=true;
      ReconcileSide(revBuy,level,lot,true,keepT);
      g_revCtx=false;
      g_revNextMs=g_nextPlaceMs;
     }
   g_nextPlaceMs=sN; g_failCount=sF;             // a failed reverse never delays the normal re-entry and never counts towards the ERROR state
   g_revSwap=false;
   g_accLoss=sA; g_curRisk=sC; g_seq=sS;
   //--- 3) the next step cannot be planned (cap / volume / margin rule): no reverse order with a WRONG lot may stay - the legacy re-entry path takes over
   if(!lotOk)
     {
      string why=guard?gw:err;
      SetSync(revBuy,YS_WAITING,"Reverse order not armed: "+why);
      if(keepT!=0 && OrderSelect(keepT) && GetTickCount64()>=g_nextDelMs)
        {
         if(!DeleteOrder(keepT,"Reverse pre-arm impossible: "+why)) g_nextDelMs=GetTickCount64()+2000;
        }
      if(AlertThrottle("REVNO"+IntegerToString(rs),300))
        {
         YLog("Reverse pre-arm NOT possible (planned next risk "+D2(planRisk)+"): "+why+" - after the SL the normal re-entry path applies.");
         RaiseAlert("REVNO"+IntegerToString(rs),"Reverse order NOT armed: "+why,false,true);
        }
     }
  }

//--- v2.42 PREPARED PLAN (Netting): while the position is open, everything that does not depend on the final close result is prepared and kept:
//--- the opposite direction, its level, the predicted next risk / lot and whether the broker rules allow that volume. NOTHING is sent from here and nothing
//--- is frozen: after the close the lot, the price and the broker rules are computed AGAIN from the real ledger before the request is sent.
void NetPrepare(const ulong ptk,const bool posBuy)
  {
   const ulong now=GetTickCount64();
   if(g_pvOk && now-g_pvMs<2000) return;
   if(!PositionSelectByTicket(ptk)) return;
   const ulong pid=(ulong)PositionGetInteger(POSITION_IDENTIFIER);
   const double vol=PositionGetDouble(POSITION_VOLUME), pe=PositionGetDouble(POSITION_PRICE_OPEN), psl=PositionGetDouble(POSITION_SL);
   const bool revBuy=!posBuy;
   const double level=revBuy?g_buyLevel:g_sellLevel;
   g_pvOk=false;
   if(vol<=0.0 || level<=0.0 || psl<=0.0) return;
   const double perLot=PerLotLossSL(posBuy,pe,psl);
   if(perLot<=0.0) return;
   const double predLoss=vol*(perLot+CommPerLotEff());
   const double risk=NextRiskForNet(g_cycNet-predLoss);
   double lot=0.0, est=0.0;
   string err="";
   if(!CalcLot(risk,revBuy,level,lot,est,err)) return;
   g_pvOk=true; g_pvPid=pid; g_pvCyc=g_cycId; g_pvLevel=level; g_pvRisk=risk; g_pvLot=lot; g_pvMs=now;
  }

//--- v2.42: called from ProcessClosedPosition the moment the closing Stop Loss is booked + saved: the placement pass runs immediately
void FastReverseNow()
  {
   if(g_recHold || g_halt) return;
   g_nextPlaceMs=0;
   Reconcile();
  }

//+------------------------------------------------------------------+
//| Reconcile: keep real account state == bot state (idempotent)     |
//+------------------------------------------------------------------+
void Reconcile()
  {
   if(!g_connected) return;
   ulong pos[];
   int np=OwnPositions(pos);
   if(np>0)
     {
      g_vArmed=false;
      g_activeNoPosSince=0;
      if(g_state!=YT_STOPPED)
        {
         ulong newest=pos[np-1];
         if(PositionSelectByTicket(newest))
           {
            ENUM_YT_STATE want=(PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY)?YT_BUY_ACTIVE:YT_SELL_ACTIVE;
            if(g_state!=want) { g_state=want; g_mode=YM_NONE; SaveState(); }
           }
        }
      //--- the pending order that MT5 triggered is now a REAL position (FILLED); the opposite pending order must really disappear
      bool fillBuy=true, haveFill=false;
      if(PositionSelectByTicket(pos[np-1])) { fillBuy=(PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY); haveFill=true; }
      int fIdx=SideIdx(fillBuy), oIdx=SideIdx(!fillBuy);
      bool hadFill=(g_stopTicket[fIdx]!=0), hadOpp=(g_stopTicket[oIdx]!=0);
      if(hadFill)
        {
         TrkDrop(fIdx);
         if(haveFill) SetSync(fillBuy,YS_FILLED,"Pending order triggered by MT5 - real position");
        }
      //--- v2.37 STOP-AND-REVERSE: with ONE open position the opposite Stop order is KEPT (re-sized for the next recovery step) instead of deleted
      g_revSide=-1;
      int revDec=(np==1 && haveFill)?ReverseArmDecision(pos[0],fillBuy):0;     // 0 = legacy (delete) | 1 = keep + maintain | 2 = hold one more pass
      if(revDec==1) ReverseArmPass(pos[0],fillBuy);
      else if(revDec==0)
        {
         ulong od[];
         int no=OwnOrders(od);
         for(int i=0;i<no;i++)
           {
            if(DeleteOrder(od[i],"Opposite Order Deleted"))
               TgQueue("🗑 OPPOSITE ORDER DELETED\nTicket: "+UL(od[i]));
           }
         if(haveFill && (hadOpp || no>0))
           {
            ulong rest[];
            if(OwnOrders(rest)==0) SetSync(!fillBuy,YS_REMOVED,"Opposite pending order deleted (verified on the server)");
            else SetSync(!fillBuy,YS_FAILED,"Opposite pending order is still on the server");
           }
        }
      if(np==1 && haveFill)                  // v2.40: what covered the SL level while this position was open (written to the log when it closes)
        {
         if(revDec==1)      g_revCov=(SideOrderExists(!fillBuy)?"reverse order ARMED on the server":"reverse order NOT on the server yet - "+SyncText(g_sync[SideIdx(!fillBuy)]));
         else if(revDec==2) g_revCov="position just filled - registration pending, reverse order not decided yet";
         else               g_revCov=(g_netting?"NOT armed - Netting account (pre-arm disabled by design: the opposite order would merge into the open position); re-arm starts after the close is processed":"NOT armed - pre-arm off or guarded (input / protection / unplannable next step)");
        }
      if(np>1 && !ReverseSwitchInProgress(pos,np))
        {
         if(np!=g_lastPosCount)
           {
            YLog("Unexpected Multiple Positions: "+IntegerToString(np));
            RaiseAlert("MULTIPOS","Unexpected Multiple Positions ("+IntegerToString(np)+") on "+g_sym+" with this Magic Number. Only ONE position is allowed: the oldest is kept, the others are closed.",true,true);
           }
         EnforceSinglePosition(pos,np);
        }
      if(g_netting) NettingDriftCheck(pos[np-1]);
      if(g_netting && np==1 && haveFill) NetPrepare(pos[0],fillBuy);      // v2.42: the opposite order is planned while the trade is open
      //--- CRITICAL: every own position must carry SL and TP (retry / alert / emergency close inside ProtectPosition)
      for(int pq=0;pq<np;pq++)
        {
         if(!PositionSelectByTicket(pos[pq])) continue;
         ProtectPosition((ulong)PositionGetInteger(POSITION_IDENTIFIER));
        }
      //--- a fill that exceeded Max Slippage Check is closed; keep retrying until it is really closed
      for(int q=0;q<np;q++)
        {
         if(!PositionSelectByTicket(pos[q])) continue;
         ulong qpid=(ulong)PositionGetInteger(POSITION_IDENTIFIER);
         if((long)PGV(qpid,"CRC",0)==4 && GetTickCount64()>=g_nextDevCloseMs)
           {
            g_nextDevCloseMs=GetTickCount64()+2000;
            CloseRejected(qpid);
           }
        }
      g_lastPosCount=np;
      return;
     }
   g_lastPosCount=0;
   g_revSide=-1;
   if(g_unprot) { g_unprot=false; g_unprotPid=0; ClearAlert("PROTFAIL"); if(StringFind(g_blockReason,"CRITICAL PROTECTION")==0) g_blockReason=""; }
   if(g_netTaint) { g_netTaint=false; ClearAlert("NETDRIFT"); }          // no own position left: nothing is contaminated any more
   if(NettingBlocked()) return;
   if(g_recHold) { RecoveryHoldTick(); return; }     // v2.42 REQUIRED_RECOVERY: nothing is placed, nothing is deleted, until the conflict is reconciled or the user acts

   if(g_state==YT_BUY_ACTIVE || g_state==YT_SELL_ACTIVE)
     {
      //--- the closing deal has not been processed yet; never create orders before it is
      if(g_activeNoPosSince==0)
        {
         g_activeNoPosSince=TimeCurrent(); g_vanishNextMs=0;
         g_closeDetMs=GetTickCount64();
         LogOrder("COVERAGE_AT_CLOSE",-1,0.0,0.0,0,0,"the open position is gone | reverse cover at that moment: "+(StringLen(g_revCov)>0?g_revCov:"no record (restart or first pass)")+" | acct "+(g_netting?"Netting":"Hedging")+" | cycle #"+IntegerToString((int)g_cycId)+" seq "+IntegerToString(g_seq));
         g_revCov="";
        }
      else
        {
         long waited=(long)(TimeCurrent()-g_activeNoPosSince);
         //--- v2.29: SAFE STATE - while the closing deal is not in the history yet, nothing is placed and nothing is decided.
         //--- The history is re-read every 5 s (it may simply lag behind the position list).
         if(waited>=3 && GetTickCount64()>=g_vanishNextMs)
           {
            g_vanishNextMs=GetTickCount64()+5000;
            CheckClosures();
            RecoverHistory();
            if(g_state!=YT_BUY_ACTIVE && g_state!=YT_SELL_ACTIVE) { g_activeNoPosSince=0; g_dirty=true; ClearAlert("VANISHWAIT"); return; }
           }
         if(waited<=YT_VANISH_WAIT_SEC)
           {
            if(waited>=20) RaiseAlert("VANISHWAIT","Position of Trade #"+TNo(g_tradeNo)+" is no longer open but its closing deal is not in the history yet. Safe state: NO new orders, sequence kept (Seq "+IntegerToString(g_seq)+", Acc.Loss "+D2(g_accLoss)+"). Retrying the history every 5 s.",false,true);
            return;
           }
         ClearAlert("VANISHWAIT");
         g_activeNoPosSince=0;
         //--- an unfinished risk sequence is never dropped silently: with valid saved levels the same pending pair is re-armed (sequence kept)
         if(!CycFresh() && g_buyLevel>0.0 && g_sellLevel>0.0 && g_buyLevel>g_sellLevel)
           {
            g_mode=YM_BOTH; g_state=YT_WAITING_REENTRY; g_nextPlaceMs=0;
            SaveState();
            RaiseAlert("INCONS","Position vanished without a processed closing deal. The risk sequence (Seq "+IntegerToString(g_seq)+", Acc.Loss "+D2(g_accLoss)+") is kept and the same Buy/Sell pending pair is re-armed. Check the Trades log.",true,true);
           }
         else
           {
            g_state=YT_IDLE; g_mode=YM_NONE;
            SaveState();
            RaiseAlert("INCONS","Position vanished without a processed closing deal. Bot is waiting for levels.",true,true);
           }
        }
      return;
     }
   if(g_state!=YT_ARMED && g_state!=YT_WAITING_REENTRY)
     {
      //--- no pending order is wanted in IDLE / TP_RESET / STOPPED: a leftover (e.g. the opposite order of a fast fill+TP) is removed
      if(g_state==YT_IDLE || g_state==YT_TP_RESET || g_state==YT_STOPPED)
        {
         ulong lo[];
         int ln=OwnOrders(lo);
         if(ln>0 && GetTickCount64()>=g_nextDelMs)
            for(int q=0;q<ln;q++)
               if(!DeleteOrder(lo[q],"No pending order is wanted in this state")) g_nextDelMs=GetTickCount64()+2000;
        }
      CycleCompletionTick();                      // v2.38: finishes / verifies a cycle completion (orders gone -> WAITING_USER)
      TrkPrune(); SetSync(true,YS_IDLE); SetSync(false,YS_IDLE); return;
     }
   if(g_mode==YM_NONE) { TrkPrune(); SetSync(true,YS_IDLE); SetSync(false,YS_IDLE); return; }

   bool needBuy=(g_mode==YM_BOTH || g_mode==YM_BUY);
   bool needSell=(g_mode==YM_BOTH || g_mode==YM_SELL);
   if(!needBuy)  SetSync(true,YS_IDLE);
   if(!needSell) SetSync(false,YS_IDLE);
   if((needBuy && g_buyLevel<=0.0) || (needSell && g_sellLevel<=0.0)) return;

   //--- v2.00: optional market reversal when the stop-out already crossed the opposite level
   if(!YT_REAL_ORDERS_ONLY && g_state==YT_WAITING_REENTRY && (InpBreachPolicy==BREACH_MARKET || InpEntryMode==ENTRY_VIRTUAL) && TryMarketReverse()) return;
   if(!YT_REAL_ORDERS_ONLY && InpEntryMode==ENTRY_VIRTUAL && needBuy && needSell && g_buyLevel>g_sellLevel) { VirtualEntryPass(); return; }

   //--- 0) manual changes in MT5 are DETECTED first (moved / deleted / SL-TP edited), then handled by the explicit policy
   bool held[2]={false,false};
   held[0]=ExternalCheck(true, needBuy, g_buyLevel);
   held[1]=ExternalCheck(false,needSell,g_sellLevel);
   if(g_restartPass) { g_restartPass=false; g_dirty=true; return; }   // state changed by a fill: re-evaluate from scratch

   double expBuy=0,expSell=0,e1,e2; string er;
   bool okB=needBuy && CalcLot(g_curRisk,true,g_buyLevel,expBuy,e1,er);
   bool okS=needSell && CalcLot(g_curRisk,false,g_sellLevel,expSell,e2,er);

   //--- 1) identity = Symbol + Magic + Order Type: pick ONE order per side to keep
   //---    (CanonicalTicket: tracked ticket, then exact desired price, then lowest ticket); everything else is a duplicate / not wanted
   ulong od[];
   int no=OwnOrders(od);
   ulong keepT[2]={0,0};
   if(needBuy)  keepT[0]=CanonicalTicket(true, g_buyLevel);     // same function the panel uses
   if(needSell) keepT[1]=CanonicalTicket(false,g_sellLevel);

   //--- 2) REMOVE: duplicates and orders that are no longer desired
   if(GetTickCount64()>=g_nextDelMs)
     {
      for(int i=0;i<no;i++)
        {
         if(od[i]==keepT[0] || od[i]==keepT[1]) continue;
         if(!OrderSelect(od[i])) continue;
         long type=OrderGetInteger(ORDER_TYPE);
         bool isB=(type==ORDER_TYPE_BUY_STOP), isS=(type==ORDER_TYPE_SELL_STOP);
         bool dup=((isB && needBuy) || (isS && needSell));
         bool notWanted=(!dup && (isB || isS));
         string why=dup?"Duplicate Order Prevented":"Unexpected pending order / not required";
         if(notWanted) SetSync(isB,YS_REMOVING,why);
         if(dup)
           {
            YLog("Duplicate Order Prevented");
            const ulong kp=isB?keepT[0]:keepT[1];            // v2.42: the proof is written down - ONE order per side is wanted, this one is the extra (the kept one is never touched)
            LogOrder("DUPLICATE_PROVEN",type,OrderGetDouble(ORDER_PRICE_OPEN),OrderGetDouble(ORDER_VOLUME_CURRENT),od[i],0,"second "+string(isB?"Buy":"Sell")+" Stop (same symbol / magic / type): kept #"+UL(kp)+" (tracked ticket, then exact level, then oldest) | removed only #"+UL(od[i])+" | the position state is re-read on the next pass");
           }
         if(DeleteOrder(od[i],why))
           {
            if(notWanted) SetSync(isB,YS_IDLE);
            if(dup) g_dirty=true;
           }
         else
           {
            g_nextDelMs=GetTickCount64()+2000;
            if(notWanted) SetSync(isB,YS_FAILED,"REMOVE FAILED: "+why);
           }
        }
     }

   //--- 3) per side: KEEP / MODIFY / REPLACE (lot change only) / CREATE
   //--- v2.11: COMBINED margin. Both stop orders are required; the orders that are still MISSING are sent only when the margin of ALL of them
   //--- is available, so the bot never ends with "one side placed, the other rejected for NO MONEY". Existing orders are still verified / modified.
   bool cmHold=false;
   if(InpCombinedMargin && needBuy && needSell && okB && okS && (keepT[0]==0 || keepT[1]==0))
     {
      double mB=0.0,mS=0.0,mNeed=0.0;
      if(keepT[0]==0 && OrderCalcMargin(ORDER_TYPE_BUY, g_sym,expBuy, g_buyLevel, mB)) mNeed+=AcM(mB);
      if(keepT[1]==0 && OrderCalcMargin(ORDER_TYPE_SELL,g_sym,expSell,g_sellLevel,mS)) mNeed+=AcM(mS);
      double mFree=AcM(AccountInfoDouble(ACCOUNT_MARGIN_FREE));
      if(mNeed>mFree+1e-9)
        {
         cmHold=true;
         string cmMsg="Insufficient COMBINED margin: the missing pending order(s) need $"+D2(mNeed)+", free margin is $"+D2(mFree);
         g_waitReason=cmMsg;
         if(keepT[0]==0) SetSync(true, YS_WAITING,cmMsg);
         if(keepT[1]==0) SetSync(false,YS_WAITING,cmMsg);
         if(!g_cmWarned)
           {
            g_cmWarned=true;
            YLog(cmMsg+" - the missing order(s) are NOT sent until the margin allows both.");
            RaiseAlert("COMBMARGIN","⚠️ "+cmMsg+". Both stop orders are required; the missing one(s) will be sent as soon as the margin allows.",true,true);
           }
        }
     }
   if(!cmHold && g_cmWarned)
     {
      g_cmWarned=false;
      ClearAlert("COMBMARGIN");
      if(StringFind(g_waitReason,"COMBINED margin")>=0) g_waitReason="";
     }
   //--- v2.18 ZONE GATE: both orders are missing and the market is outside the zone -> neither is sent. The bot remembers both levels,
   //--- caches both trigger prices and OnTick wakes the placement the tick the price is inside the zone: both orders are then placed together.
   bool zoneHold=false;
   if(InpZoneGate && !cmHold && needBuy && needSell && keepT[0]==0 && keepT[1]==0 && !held[0] && !held[1])
     {
      string zw1,zw2;
      int zB=PlacementState(true, g_buyLevel, zw1);
      int zS=PlacementState(false,g_sellLevel,zw2);
      if(zB!=2 && zS!=2 && (zB==1 || zS==1))
        {
         zoneHold=true;
         g_trig[0]=WaitTrigger(true, g_buyLevel);
         g_trig[1]=WaitTrigger(false,g_sellLevel);
         string zt="Zone gate: waiting for the price to enter the zone (Sell "+PX(g_sellLevel)+" - Buy "+PX(g_buyLevel)+"); both orders are placed together";
         //--- v2.22: the zone must be wider than both broker gaps + the spread, otherwise both orders can NEVER exist together
         double zNeed=WaitGap(true)+WaitGap(false)+LiveSpread();
         if(g_buyLevel-g_sellLevel<zNeed)
           {
            zt="⚠️ ZONE TOO NARROW: width "+PX(g_buyLevel-g_sellLevel)+" < minimum "+PX(zNeed)+" (Stops Level x2 + spread). Both orders can never be placed together - widen the zone.";
            RaiseAlert("ZONENARROW",zt,true,true);
           }
         else ClearAlert("ZONENARROW");
         g_waitReason=zt;
         SetSync(true, YS_WAITING,(zB==1)?WaitText(true, g_buyLevel):zt);
         SetSync(false,YS_WAITING,(zS==1)?WaitText(false,g_sellLevel):zt);
         if(zB==1) NoteDefer(true, g_buyLevel, WaitText(true, g_buyLevel));
         if(zS==1) NoteDefer(false,g_sellLevel,WaitText(false,g_sellLevel));
        }
     }
   if(g_zoneGate && !zoneHold) YLog("Zone gate released: the price is inside the zone, placing both orders");
   g_zoneGate=zoneHold;
   if(!zoneHold)
     {
      if(needBuy  && !held[0] && !(cmHold && keepT[0]==0)) ReconcileSide(true, g_buyLevel, expBuy, okB,keepT[0]);
      if(needSell && !held[1] && !(cmHold && keepT[1]==0)) ReconcileSide(false,g_sellLevel,expSell,okS,keepT[1]);
      //--- v2.22 ATOMIC PAIR: the two stop orders are one unit. If this pass started with BOTH missing and ended with only ONE on the server because the
      //--- other side is still only WAITING for the market (price moved while sending), the lone order is withdrawn and the zone gate holds both again.
      //--- (before: a lone Sell Stop / Buy Stop stayed alone while the other side waited for a price that had already left the zone)
      if(InpZoneGate && !cmHold && needBuy && needSell && keepT[0]==0 && keepT[1]==0 && !held[0] && !held[1] && GetTickCount64()>=g_nextDelMs)
        {
         ulong ro[];
         if(OwnOrders(ro)==1 && OrderSelect(ro[0]))
           {
            bool haveBuy=(OrderGetInteger(ORDER_TYPE)==ORDER_TYPE_BUY_STOP);
            if(g_sync[SideIdx(!haveBuy)]==YS_WAITING)
              {
               string rbWhy=string(haveBuy?"Sell":"Buy")+" Stop could not be placed together with it";
               if(DeleteOrder(ro[0],"Pair rollback: "+rbWhy))
                 {
                  SetSync(haveBuy,YS_WAITING,"Pair rollback: both orders are placed together when the price is inside the zone");
                  g_nextPlaceMs=GetTickCount64()+400;
                  g_dirty=true;
                  YLog("Atomic pair: lone "+SideName(haveBuy)+" withdrawn ("+rbWhy+"); both orders wait for the zone again");
                 }
               else g_nextDelMs=GetTickCount64()+2000;
              }
           }
        }
     }
  }

void SyncAll()
  {
   if(g_busy) return;
   g_busy=true;
   UncTick();                         // v2.40: unresolved order requests are verified first
   RegisterLivePositions();
   CheckClosures();
   Reconcile();
   CycleCensus("sync",false);          // v2.48: what is mine / foreign (throttled 30 s, read-only)
   g_busy=false;
   g_lastSyncMs=GetTickCount64();
  }

//+------------------------------------------------------------------+
//| Levels / Start / Stop / Cancel                                   |
//+------------------------------------------------------------------+
//--- true while a risk sequence is running: its ORIGINAL levels are frozen
bool SequenceLocked()
  {
   ulong tk[];
   if(OwnPositions(tk)>0) return true;                                  // a real position is open: there is no pending order to move
   if(g_state==YT_BUY_ACTIVE || g_state==YT_SELL_ACTIVE) return true;
   if(InpSeqPolicy==YT_SEQ_APPLY_NOW) return false;                     // pending orders of a running sequence follow APPLY immediately
   if(g_state==YT_WAITING_REENTRY) return true;
   if((g_state==YT_ARMED || g_state==YT_ERROR) && (g_mode==YM_BUY || g_mode==YM_SELL)) return true;
   return false;
  }

//--- levels entered during a sequence become active only after the sequence ends
void PromotePending()
  {
   if(g_pendBuy>0.0 && g_pendSell>0.0)
     {
      g_buyLevel=g_pendBuy;
      g_sellLevel=g_pendSell;
      YLog("Pending levels now active: Buy "+PX(g_buyLevel)+" Sell "+PX(g_sellLevel));
     }
   g_pendBuy=0.0;
   g_pendSell=0.0;
   g_fresh=false;
  }

bool CancelEndTry(const string src);   // fix13 forward declaration (defined after the Stop/Cancel helpers)

bool ApplyLevels(const double buy,const double sell,const double risk,const string src,string &err)
  {
   if(g_cycState==YC_COMPLETING) { err="the finished cycle is still being closed (its pending orders are being cancelled) - try again in a moment"; return false; }   // v2.38
   err=ValidateLevels(buy,sell);
   if(err=="" && risk>0.0) err=ValidateRisk(risk);
   if(err!="")
     {
      YLog("Invalid Configuration ("+src+"): "+err);
      if(src!="Telegram") RaiseAlert("INVALID","Invalid Price Configuration: "+err,true,true);
      return false;
     }
   g_applyNote="";
   if(GV("CANCELEND",0.0)>0.5 && !CancelEndTry("Telegram CANCEL (completed)"))
     { err="The cancelled cycle is still closing its last trade - try again in a few seconds."; return false; }
   RecoveryRelease("user applied new levels");            // v2.42: new levels from the user are an explicit decision
   const bool locked=SequenceLocked();
   bool riskSame=(risk<=0.0 || MathAbs(risk-g_initRisk)<1e-9);

   //--- a live order that has to be MODIFIED must accept its new price right now (stops level / freeze level)
   if(!locked)
     {
      string pre=CheckApplicable(buy,sell,risk);
      if(pre!="")
        {
         err=pre;
         YLog("Invalid Configuration ("+src+"): "+err);
         if(src!="Telegram") RaiseAlert("INVALID","Cannot apply levels: "+err,true,true);
         return false;
        }
     }

   //--- APPLY with an identical desired state: nothing to send, the real orders are just verified
   bool same=locked?(g_fresh && PriceEq(g_pendBuy,buy) && PriceEq(g_pendSell,sell) && riskSame)
                   :((g_state==YT_ARMED || g_state==YT_WAITING_REENTRY) && g_mode!=YM_NONE && PriceEq(g_buyLevel,buy) && PriceEq(g_sellLevel,sell) && riskSame);
   ResetSyncBackoff();
   if(same)
     {
      YLog("APPLY ("+src+"): desired levels are already active - nothing to change");
      g_dirty=true;
      SyncAll();
      bool allOk=true;
      if(!locked)
         for(int k=0;k<2;k++)
           {
            bool sb=(k==0);
            double dl;
            if(SideDesired(sb,dl) && SideStatusShown(sb)!=YS_SYNCED && SideStatusShown(sb)!=YS_PLACED) allOk=false;
           }
      g_applyNote=allOk?"NOTHING TO DO":"";
      return true;
     }

   if(risk>0.0) g_initRisk=risk;
   g_failCount=0; g_nextPlaceMs=0; g_blockReason="";

   //--- a sequence is running: it keeps its ORIGINAL levels, the new ones wait for the next TP
   if(locked)
     {
      g_pendBuy=buy;
      g_pendSell=sell;
      g_fresh=true;
      YLog("New levels ("+src+") stored as PENDING: Buy "+PX(buy)+" Sell "+PX(sell)+" | running sequence keeps ORIGINAL levels Buy "+PX(g_buyLevel)+" Sell "+PX(g_sellLevel));
      if(g_state==YT_ERROR && (g_mode==YM_BUY || g_mode==YM_SELL)) g_state=YT_WAITING_REENTRY;
      if(CycFresh()) g_curRisk=g_initRisk;
      SaveState();
      g_dirty=true;
      SyncAll();
      g_applyNote="QUEUED";
      return true;
     }

   g_pendBuy=0.0; g_pendSell=0.0; g_fresh=false;
   g_buyLevel=buy;
   g_sellLevel=sell;
   YLog("New Buy/Sell Levels ("+src+"): Buy "+PX(buy)+" Sell "+PX(sell)+" Risk "+D2(g_initRisk));
   switch(g_state)
     {
      case YT_STOPPED:
         ImplicitResetGuarded("levels applied after STOP");
         g_state=YT_ARMED; g_mode=YM_BOTH; g_stopCleanup=false;
         break;
      case YT_ERROR:
         if(GV("REVERR",0.0)>0.5 && (g_lastSLSide==1 || g_lastSLSide==2))
           {
            //--- v2.11: a failed market reversal resumes as a REVERSAL at the new levels (direction kept)
            g_state=YT_WAITING_REENTRY; g_mode=YM_BOTH;
            g_revFails=0; g_revHard=0; g_nextRevMs=0;
           }
         else
           {
            g_state=YT_ARMED; if(g_mode==YM_NONE) g_mode=YM_BOTH;
           }
         GS("REVERR",0.0);
         break;
      case YT_WAITING_REENTRY:
         if(g_mode==YM_NONE) g_mode=YM_BOTH;           // a running sequence keeps its state / side; only the levels move
         break;
      default:
         g_state=YT_ARMED;
         if(g_mode!=YM_BUY && g_mode!=YM_SELL) g_mode=YM_BOTH;   // ARMED single-side (sequence) keeps its side
         break;
     }
   if(CycFresh()) g_curRisk=g_initRisk;
   CycTouch();                                                    // v2.38: levels applied by the user start / continue the cycle
   SaveState();
   g_dirty=true;
   WritePlanTable("levels applied");                              // v2.34
   SyncAll();
   return true;
  }

string LevelsAcceptedText()
  {
   string t;
   if(g_fresh && g_pendBuy>0.0 && g_pendSell>0.0)
      t="✅ LEVELS ACCEPTED (PENDING)\nA sequence is running and keeps its ORIGINAL levels:\nBuy Stop: "+PX(g_buyLevel)+"\nSell Stop: "+PX(g_sellLevel)+
        "\nNew levels start after the next TP:\nBuy Stop: "+PX(g_pendBuy)+"\nSell Stop: "+PX(g_pendSell)+"\nInitial Risk: $"+D2(g_initRisk)+"\nStatus: "+StateText();
   else
     {
      string dn=DeferText();
      t=(dn!=""?"✅ LEVELS ACCEPTED (waiting for price)":"✅ LEVELS ACCEPTED")+"\nBuy Stop: "+PX(g_buyLevel)+"\nSell Stop: "+PX(g_sellLevel)+"\nInitial Risk: $"+D2(g_initRisk)+"\nStatus: "+StateText();
      if(dn!="") t+="\n⏳ "+dn;
     }
   return t;
  }

string DoStart(const string src)
  {
   if(GV("CANCELEND",0.0)>0.5 && !CancelEndTry("Telegram CANCEL (completed)")) return "⏳ The cancelled cycle is still closing its last trade. Try again in a few seconds.";
   if(StringFind(g_sym,"XAUUSD")<0) return "❌ START FAILED\nReason: Symbol is not XAUUSD.";
   if(g_recHold) return "❌ START FAILED\nReason: REQUIRED_RECOVERY - "+g_recWhy+"\nSend /cancel (removes the pending orders) or /stop first, then /set BUY SELL and START.";
   if(!g_connected) return "❌ START FAILED\nReason: No connection to the trade server.";
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED)) return "❌ START FAILED\nReason: AutoTrading is disabled.";
   if(!AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) || !AccountInfoInteger(ACCOUNT_TRADE_EXPERT)) return "❌ START FAILED\nReason: Trading not allowed on this account.";
   if(g_netting && ExternalPositionVolume()>0.0)
      return "❌ START FAILED\nReason: Netting account and an external "+g_sym+" position exists. Yetimmm will not run until it is closed.";
   if(g_state==YT_BUY_ACTIVE || g_state==YT_SELL_ACTIVE || g_state==YT_ARMED || g_state==YT_WAITING_REENTRY)
     {
      SyncAll();
      return "✅ Yetimmm is already RUNNING\nState: "+StateText()+"\nBuy Stop: "+PX(g_buyLevel)+"\nSell Stop: "+PX(g_sellLevel);
     }
   if(g_state==YT_TP_RESET)
     {
      //--- v2.38: the finished cycle waits for the USER. This START is the order that begins the NEW cycle (empty ledger) with the saved levels.
      if(g_cycState==YC_COMPLETING) return "⏳ The finished cycle is still being closed (its pending orders are being cancelled). Try START again in a few seconds.";
      if(g_fresh) PromotePending();
      if(ValidateLevels(g_buyLevel,g_sellLevel)!="")
         return "ℹ️ Yetimmm is WAITING FOR YOU\nStatus: WAITING FOR LEVELS\nSend /set BUY SELL [RISK] to continue.";
     }
   if(g_fresh) PromotePending();
   string err=ValidateLevels(g_buyLevel,g_sellLevel);
   if(err!="") return "❌ START FAILED\nReason:\nInvalid Buy/Sell levels. "+err;
   //--- v4.30: a result booked while STOPPED may have brought the cycle net to the target. The cycle is then recorded and closed here (the same one-time
   //--- completion as always), and THIS start begins the next cycle with an empty ledger. Nothing is closed while a position is still open.
   if(g_state==YT_STOPPED && g_cycTrades>0 && CycleMet(g_cycNet))
     {
      ulong cp[];
      if(OwnPositions(cp)==0)
        {
         YLog("START after STOP: the cycle net "+D2(g_cycNet)+" already reached the target "+D2(g_target)+" while stopped - the cycle is recorded and closed now; this START begins the NEW cycle.");
         CycleFinishLedger(true);
         g_cycState=YC_IDLE;
         ClearAlert("STOPTARGET");
        }
     }
   if(g_state==YT_STOPPED) ImplicitResetGuarded("START after STOP");
   //--- v2.11: after a market-reversal ERROR the REVERSAL is resumed (WAITING_REENTRY keeps the direction); every other start re-arms normally
   bool resumeRev=(g_state==YT_ERROR && GV("REVERR",0.0)>0.5 && (g_lastSLSide==1 || g_lastSLSide==2));
   GS("REVERR",0.0);
   g_revFails=0; g_revHard=0; g_nextRevMs=0;
   if(resumeRev) { g_state=YT_WAITING_REENTRY; g_mode=YM_BOTH; }
   else { g_state=YT_ARMED; if(g_mode==YM_NONE) g_mode=YM_BOTH; }
   g_stopCleanup=false; g_failCount=0; g_nextPlaceMs=0; g_blockReason=""; g_revOffPid=0;
   g_deferLvl[0]=0.0; g_deferLvl[1]=0.0;
   ResetSyncBackoff();
   CycTouch();                                                    // v2.38: WAITING_USER -> ACTIVE (a new cycle begins on the user's START)
   SaveState();
   YLog("EA Started ("+src+")");
   SyncAll();
   if(g_state==YT_ERROR) return "❌ START FAILED\nReason: Bot entered ERROR state. See Journal.";
   ulong od[]; int no=OwnOrders(od);
   string t="✅ START EXECUTED\nYetimmm is now RUNNING.\nBuy Stop: "+PX(g_buyLevel)+"\nSell Stop: "+PX(g_sellLevel)+"\nRisk: $"+D2(g_curRisk)+"\nPending orders: "+IntegerToString(no)+"\nSync: "+SyncSummary();
   if(StringLen(g_blockReason)>0) t+="\n⚠️ "+g_blockReason;
   string wn=WaitNote();
   if(StringLen(wn)>0) t+="\n⏳ "+wn;
   return t;
  }

bool CleanupPositions(const int code)
  {
   if(g_netting && g_netTaint)
     {
      YLog("Netting: close refused - the position contains external volume.");
      RaiseAlert("NETCLOSE","Netting account: the Yetimmm position contains external volume, so it was NOT closed automatically. Close it manually.",true,true);
      return false;
     }
   ulong tk[];
   int n=OwnPositions(tk);
   for(int i=0;i<n;i++)
     {
      if(!PositionSelectByTicket(tk[i])) continue;
      ulong pid=(ulong)PositionGetInteger(POSITION_IDENTIFIER);
      PSet(pid,"CRC",(double)code);
      if(!InstOkTrade("close position") || !g_trade.PositionClose(tk[i]))
         YLog("Close position failed #"+UL(tk[i])+" retcode "+IntegerToString((int)g_trade.ResultRetcode()));
     }
   return OwnPositions(tk)==0;
  }

bool CleanupOrders(const string reason)
  {
   ulong od[];
   int n=OwnOrders(od);
   for(int i=0;i<n;i++) DeleteOrder(od[i],reason);
   return OwnOrders(od)==0;
  }

//--- race-free cleanup: pending orders are deleted FIRST (nothing can trigger afterwards), then positions are closed
//--- (including one that filled during the deletion), and BOTH are re-verified before success is reported
bool StopSweep(const int code,const string reason)
  {
   for(int pass=0;pass<4;pass++)
     {
      CleanupOrders(reason);
      CleanupPositions(code);
      ulong a[],b[];
      if(OwnOrders(a)==0 && OwnPositions(b)==0) return true;
      if(g_netting && g_netTaint) break;
      Sleep(150);
     }
   return false;
  }

//--- STOP: no new orders, delete own orders first, then close own trades (verified)
bool ExecStop(const int code,const long chat)
  {
   RecoveryRelease("user stop");                          // v2.42
   if(g_fresh) PromotePending();
   g_state=YT_STOPPED;
   g_frzBid=SymbolInfoDouble(g_sym,SYMBOL_BID); g_frzAsk=SymbolInfoDouble(g_sym,SYMBOL_ASK); g_frzTs=(long)TimeCurrent();
   g_mode=YM_NONE;
   g_fresh=false;
   g_deferLvl[0]=0.0; g_deferLvl[1]=0.0;
   SaveState();
   YLog(code==2?"Telegram Stop":"Manual Stop");
   bool done=StopSweep(code,code==2?"Telegram Stop":"Manual Stop");
   if(done)
     {
      g_stopCleanup=false;
      CheckClosures();
      return true;
     }
   g_stopCleanup=true; g_stopTries=0; g_stopCode=code; g_stopChat=chat; g_stopLastTry=TimeLocal();
   return false;
  }

void StopCleanupTick()
  {
   if(!g_stopCleanup) return;
   if(TimeLocal()-g_stopLastTry<2) return;
   g_stopLastTry=TimeLocal();
   g_stopTries++;
   bool done=StopSweep(g_stopCode,"Stop cleanup");
   if(done)
     {
      g_stopCleanup=false;
      CheckClosures();
      YLog("Stop completed after retries");
      TgQueue("✅ STOP EXECUTED\nYetimmm is now STOPPED. All Yetimmm trades closed and orders deleted.",g_stopChat);
     }
   else if(g_stopTries>=30)
     {
      g_stopCleanup=false;
      RaiseAlert("STOPFAIL","STOP FAILED: could not close/delete all Yetimmm trades and orders. Manual action required.",true,true);
     }
  }

string StopResultText(const bool done)
  {
   if(done) return "✅ STOP EXECUTED\nYetimmm is now STOPPED.\nYetimmm trades closed and pending orders deleted. Other trades untouched.";
   return "⏳ STOP IN PROGRESS\nBot is STOPPED; closing remaining Yetimmm trades/orders. A confirmation follows when verified.";
  }

//--- fix13 (user request): a FULL CANCEL from the Telegram bot is one of the TWO ways a cycle ends (the other is CycleNet >= target).
//--- The cycle is over: ledger zeroed (new CycleId), levels and queued levels removed, no pending order, state IDLE, nothing inherited by the next /set.
//--- STOP is only a pause (same cycle). The accumulated loss shown in the app is ONLY this cycle's own number - it is 0 again after this.
int PendingClosedRecords()
  {
   //--- closed positions of this EA whose result has not been booked into the ledger yet (history not ready): they must be booked BEFORE the ledger is zeroed
   string prefix=GN("P");
   int pl=StringLen(prefix), total=GlobalVariablesTotal(), cnt=0;
   for(int i=0;i<total;i++)
     {
      string nm=GlobalVariableName(i);
      if(StringFind(nm,prefix)!=0) continue;
      int L=StringLen(nm);
      if(L<pl+3 || StringSubstr(nm,L-2)!="_N") continue;
      string mid=StringSubstr(nm,pl,L-pl-2);
      bool digits=(StringLen(mid)>0);
      for(int k=0;k<StringLen(mid) && digits;k++)
        { ushort c=StringGetCharacter(mid,k); if(c<'0' || c>'9') digits=false; }
      if(!digits) continue;
      ulong tk;
      if(!FindLive((ulong)StringToInteger(mid),tk)) cnt++;
     }
   return cnt;
  }

void CycleEndByUser(const string src)
  {
   long id=g_cycId; double cnet=g_cycNet; int trades=g_cycTrades; int steps=g_seq; double losses=g_cycLosses;
   if(trades>0 && (long)GV("LCID",0.0)!=id)
     {
      string line=IntegerToString((int)id)+";"+IntegerToString(trades)+";"+IntegerToString(steps)+";"+D2(losses)+";"+D2(cnet)+";"+D2(g_target)+";CANCELLED_BY_USER;"+
                  TimeToString(TimeCurrent(),TIME_DATE|TIME_SECONDS)+";"+IntegerToString(g_magic)+";"+g_sym;
      AppendLine(CycleFile(),CYCLE_HEADER,line);
      GS("LCID",(double)id); GS("LCNET",cnet); GS("LCTR",(double)trades); GS("LCTM",(double)TimeCurrent());
     }
   CycCloseLife(id,"CANCELLED_BY_USER",cnet,trades,steps,losses);
   ResetRiskLogged(src);                                   // new CycleId, empty ledger, Seq 0, risk = initial risk
   GS("CYCDAY",0.0);                                       // no one-cycle-per-day lock after a user cancel
   GS("REVERR",0.0);
   g_lastSLSide=0;
   g_mode=YM_NONE;
   g_buyLevel=0.0; g_sellLevel=0.0; g_pendBuy=0.0; g_pendSell=0.0; g_fresh=false;
   g_deferLvl[0]=0.0; g_deferLvl[1]=0.0;
   g_revFails=0; g_revHard=0; g_nextRevMs=0; g_failCount=0; g_nextPlaceMs=0; g_blockReason="";
   g_state=YT_IDLE;
   g_cycState=YC_IDLE;
   GS("CANCELEND",0.0);
   SaveState();
   g_dirty=true;
   TgQueue("🛑 CYCLE #"+IntegerToString((int)id)+" ENDED (cancelled by you)\nCycle net: $"+D2(cnet)+" | trades "+IntegerToString(trades)+"\nEverything was deleted. The next cycle starts from ZERO when you send /set BUY SELL [RISK].");
  }

//--- tries to finish a user cancel: only when no order and no position of this EA is left and every closed result is booked (nothing can leak into the next cycle)
bool CancelEndTry(const string src)
  {
   ulong a[],b[];
   if(OwnOrders(a)>0 || OwnPositions(b)>0) return false;
   CheckClosures();
   if(PendingClosedRecords()>0) return false;
   CycleEndByUser(src);
   return true;
  }

void CancelEndTick()
  {
   if(GV("CANCELEND",0.0)<0.5) return;
   if(GetTickCount64()<g_nextDelMs) return;
   {
    ulong kp[];
    if(OwnPositions(kp)>0)                                                          // fix15: a kept position - the cycle ends after ITS result is booked
      {
       if(TimeLocal()-(datetime)GV("CANCELEND",0.0)>30) GS("CANCELEND",(double)TimeLocal());   // the 180 s history safety counts from the moment it closes
       return;
      }
   }
   ulong od[];
   if(OwnOrders(od)>0) { if(!CleanupOrders("Cancelled by user")) g_nextDelMs=GetTickCount64()+2000; return; }
   if(CancelEndTry("Telegram CANCEL (completed)")) return;
   ulong pk[];
   if(OwnPositions(pk)==0 && TimeLocal()-(datetime)GV("CANCELEND",0.0)>180)      // safety: a closed trade whose history never arrives must not keep the cycle open forever
      CycleEndByUser("Telegram CANCEL (completed, history timeout)");
  }

string ExecCancel(const bool closePos)
  {
   RecoveryRelease("user cancel");                        // v2.42: an explicit user decision resolves a REQUIRED_RECOVERY conflict
   {
    ulong rp[];
    if(OwnPositions(rp)>0 && PositionSelectByTicket(rp[0])) g_revOffPid=(ulong)PositionGetInteger(POSITION_IDENTIFIER);   // v2.37: the user wants NO pending order next to this trade
   }
   g_mode=YM_NONE;
   if(g_state==YT_ARMED || g_state==YT_WAITING_REENTRY) g_state=YT_IDLE;
   ulong ctk[];
   if(g_state==YT_IDLE && g_fresh && OwnPositions(ctk)==0) PromotePending();
   SaveState();
   bool o=CleanupOrders("Cancelled by user");
   string t="";
   if(o) t="✅ Pending orders cancelled.";
   else t="❌ Could not delete all pending orders.";
   ulong tk[];
   if(OwnPositions(tk)>0)
     {
      if(closePos)
        {
         bool p=StopSweep(3,"Cancelled by user");
         t+=p?"\n✅ Open position closed.":"\n❌ Could not close the open position.";
         CheckClosures();
        }
      else
        {
         //--- fix15: the cycle is ENDED by the user even though the position is kept. The position runs to its own SL / TP, its result is booked in the ending cycle, then the ledger is zeroed
         //--- and NO recovery order is armed (TryPlace is blocked by CANCELEND). The next /set starts from ZERO.
         GS("CANCELEND",(double)TimeLocal());
         t+="\n⚠️ Open position kept until its own SL/TP. The cycle is ENDED: no recovery order will be placed, and the next /set starts from ZERO.";
        }
     }
   YLog("Telegram Cancel / Cancel executed");
   if(o)
     {
      ulong pk[];
      if(OwnPositions(pk)==0)
        {
         GS("CANCELEND",(double)TimeLocal());                                // persistent: finished by CancelEndTick even if the history of a just-closed trade is late
         if(CancelEndTry("Telegram CANCEL")) t+="\n🛑 CYCLE ENDED: ledger zeroed, accumulated loss 0, everything deleted. Send /set BUY SELL [RISK] to start a new cycle from zero.";
         else t+="\n⏳ Cycle ends as soon as the last closed trade is booked.";
        }
     }
   g_dirty=true;
   return t;
  }

//+------------------------------------------------------------------+
//| Telegram command handling                                        |
//+------------------------------------------------------------------+
double ParseNum(string s)
  {
   StringReplace(s,",",".");
   return StringToDouble(s);
  }

string NewNonce() { return IntegerToString((long)(GetTickCount64()%1000000))+IntegerToString(MathRand()%1000); }

//--- v2.45.1: modify ONE level from Telegram (same rules as the Mini App "modify": ApplyLevels validates, the sequence lock is honest). The answer states the REAL outcome
//--- after the synchronisation (placed on the server / still waiting for the price), never just "sent".
string ExecModifySide(const bool isBuy,const double px,const string src)
  {
   if(px<=0.0) return "❌ Invalid price.";
   if(g_state!=YT_ARMED) return "❌ Orders can be changed only while the bot is ARMED (state: "+StateText()+").";
   const bool has=(g_mode==YM_BOTH || (isBuy && g_mode==YM_BUY) || (!isBuy && g_mode==YM_SELL));
   if(!has) return "❌ That order does not exist (use /set to enter the levels).";
   const double nb=isBuy?px:g_buyLevel, ns=isBuy?g_sellLevel:px;
   string er="";
   if(!ApplyLevels(nb,ns,0.0,src,er)) return "❌ Invalid Price Configuration: "+er;
   if(g_fresh && g_pendBuy>0.0 && g_pendSell>0.0) return LevelsAcceptedText();   // sequence locked: the change is only PENDING, say so honestly
   GS("LVSRC",1.0);
   g_nextPlaceMs=0; ResetSyncBackoff(); SyncAll(); g_dirty=true;
   string out="✅ ORDER MODIFIED\n"+(isBuy?"Buy Stop @ ":"Sell Stop @ ")+PX(px);
   ulong tk=0; double ap=0.0;
   if(SideActual(isBuy,tk,ap))
      out+=PriceEq(ap,px)?"\nOn the server: #"+UL(tk)+" @ "+PX(ap):"\n⚠️ The server order #"+UL(tk)+" is still at "+PX(ap)+" - the update is in progress, check /orders";
   else if(WaitLevelNow(isBuy)>0.0) out+="\n⏳ "+WaitText(isBuy,px);
   else out+="\nℹ️ Not confirmed on the server yet - check /orders in a few seconds.";
   return out;
  }

void TgCommand(const string text,const long chat,const long from)
  {
   string t=text;
   StringTrimLeft(t); StringTrimRight(t);
   if(StringLen(t)==0 || StringGetCharacter(t,0)!='/') return;
   string raw[];
   int rn=StringSplit(t,' ',raw);
   string a[];
   for(int i=0;i<rn;i++)
      if(StringLen(raw[i])>0) { int k=ArraySize(a); ArrayResize(a,k+1); a[k]=raw[i]; }
   int argc=ArraySize(a);
   if(argc==0) return;
   string cmd=a[0];
   StringToLower(cmd);
   int at=StringFind(cmd,"@");
   if(at>0) cmd=StringSubstr(cmd,0,at);

   YLog("Telegram Command Received: "+cmd);
   if(!g_tgCtl)
     {
      YLog("Telegram Command Rejected: control disabled");
      TgQueue("⛔ Telegram control is disabled in the EA settings.",chat);
      return;
     }

   //--- duplicate protection for state-changing commands
   bool mutating=(cmd=="/start" || cmd=="/stop" || cmd=="/set" || cmd=="/cancel" || cmd=="/del" || cmd=="/mod");
   if(mutating)
     {
      string key=IntegerToString(from)+"|"+t;
      if(key==g_lastCmdKey && TimeLocal()-g_lastCmdTime<=6)
        {
         YLog("Telegram Command Rejected: duplicate");
         TgQueue("⚠️ Command already processed.",chat);
         return;
        }
      g_lastCmdKey=key;
      g_lastCmdTime=TimeLocal();
     }

   if(cmd=="/start")
     {
      TgQueue(DoStart("Telegram"),chat,MenuMarkup());
     }
   else if(cmd=="/stop")
     {
      ulong tk[];
      if(OwnPositions(tk)>0)
        {
         ulong tkt,pid; bool buy; double vol,entry,sl,tp,pr;
         string info="";
         if(OwnPosInfo(tkt,pid,buy,vol,entry,sl,tp,pr)) info="\nTrade #"+TNo((long)PGV(pid,"N",0))+"\n"+(buy?"BUY":"SELL")+"\nP/L: "+Money(pr);
         g_confAction="STOP"; g_confNonce=NewNonce(); g_confExpire=TimeLocal()+60;
         TgQueue("⚠️ يوجد Position مفتوح."+info+"\nهل تريد الإغلاق وإيقاف البوت؟",chat,ConfirmMarkup(g_confNonce,"✅ CONFIRM","✖ CANCEL"));
        }
      else
        {
         bool done=ExecStop(2,chat);
         TgQueue(StopResultText(done),chat);
        }
     }
   else if(cmd=="/cancel")
     {
      ulong tk[];
      bool hasPos=(OwnPositions(tk)>0);
      string res=ExecCancel(false);
      TgQueue("⚠️ سيتم إلغاء أوامر Yetimmm المعلقة.\n"+res,chat);
      if(hasPos)
        {
         g_confAction="CANCELCLOSE"; g_confNonce=NewNonce(); g_confExpire=TimeLocal()+60;
         TgQueue("⚠️ توجد صفقة مفتوحة. هل تريد إغلاقها أيضاً؟",chat,ConfirmMarkup(g_confNonce,"✅ CLOSE POSITION","✖ KEEP"));
        }
     }
   else if(cmd=="/set")
     {
      if(argc<3 || argc>4) { TgQueue("Usage: /set BUY SELL [RISK]\nExample: /set 4138 4137 1",chat); return; }
      double b=ParseNum(a[1]), s=ParseNum(a[2]);
      double r=(argc==4)?ParseNum(a[3]):0.0;
      if(argc==4 && r<=0.0) { TgQueue("❌ Invalid Price Configuration\nRisk must be a positive number.",chat); return; }
      string err;
      if(ApplyLevels(b,s,r,"Telegram",err)) TgQueue(LevelsAcceptedText(),chat);
      else TgQueue("❌ Invalid Price Configuration\n"+err,chat);
     }
   else if(cmd=="/del")
     {
      if(argc!=2) { TgQueue("Usage: /del BUY | /del SELL | /del TICKET\nExample: /del SELL",chat); return; }
      string w=a[1]; StringToUpper(w);
      if(w=="BUY" || w=="SELL") TgQueue(ExecDeleteLevel(w=="BUY","Telegram"),chat);
      else
        {
         const ulong tkd=(ulong)StringToInteger(a[1]);
         if(tkd==0) { TgQueue("Usage: /del BUY | /del SELL | /del TICKET",chat); return; }
         TgQueue(ExecDeleteOrder(tkd,"Telegram"),chat);
        }
     }
   else if(cmd=="/mod")
     {
      if(argc!=3) { TgQueue("Usage: /mod BUY PRICE | /mod SELL PRICE\nExample: /mod SELL 4120",chat); return; }
      string w=a[1]; StringToUpper(w);
      if(w!="BUY" && w!="SELL") { TgQueue("Usage: /mod BUY PRICE | /mod SELL PRICE",chat); return; }
      const double pxm=ParseNum(a[2]);
      if(pxm<=0.0) { TgQueue("❌ Invalid price.",chat); return; }
      TgQueue(ExecModifySide(w=="BUY",pxm,"Telegram"),chat);
     }
   else if(cmd=="/status") TgQueue(StatusText(),chat,MenuMarkup());
   else if(cmd=="/open")   TgQueue(OpenText(),chat);
   else if(cmd=="/orders") TgQueue(OrdersText(),chat);
   else if(cmd=="/history")
     {
      int c=(argc>=2)?(int)StringToInteger(a[1]):10;
      int sk=(argc>=3)?(int)StringToInteger(a[2]):0;
      TgQueue(HistoryText(c,sk),chat);
     }
   else if(cmd=="/last")     TgQueue(LastText(),chat);
   else if(cmd=="/stats")    TgQueue(StatsText(),chat);
   else if(cmd=="/risk")     TgQueue(RiskText(),chat);
   else if(cmd=="/settings") TgQueue(SettingsText(),chat);
   else if(cmd=="/menu")     TgQueue("🤖 Yetimmm\nStatus: "+RunStatus(),chat,MenuKeyboard());
   else if(cmd=="/help")     TgQueue(HelpText(),chat,MenuMarkup());
   else TgQueue("Unknown command. Send /help",chat);
  }

void TgCallbackBody(const string data,const long chat,const long from)
  {
   if(StringFind(data,"CMD:")==0)
     {
      TgCommand("/"+StringSubstr(data,4),chat,from);
      return;
     }
   bool yes=(StringFind(data,"C1:")==0);
   bool no=(StringFind(data,"C0:")==0);
   if(!yes && !no) return;
   string nonce=StringSubstr(data,3);
   if(g_confNonce=="" || nonce!=g_confNonce || TimeLocal()>g_confExpire)
     {
      TgQueue("⚠️ Command already processed (or confirmation expired).",chat);
      return;
     }
   string action=g_confAction;
   g_confNonce=""; g_confAction="";
   if(no) { TgQueue("Cancelled. No action taken.",chat); return; }
   if(action=="STOP")
     {
      bool done=ExecStop(2,chat);
      TgQueue(StopResultText(done),chat);
     }
   else if(action=="CANCELCLOSE")
     {
      bool p=CleanupPositions(3);
      CheckClosures();
      string ex="";
      if(p)
        {
         GS("CANCELEND",(double)TimeLocal());
         ex=CancelEndTry("Telegram CANCEL + CLOSE")?"\n🛑 CYCLE ENDED: ledger zeroed, everything deleted. Send /set BUY SELL [RISK] to start a new cycle from zero.":"\n⏳ Cycle ends as soon as the closed trade is booked.";
        }
      TgQueue((p?"✅ Open position closed.":"❌ Could not close the open position.")+ex,chat);
     }
  }

//--- v2.13: the button action is EXECUTED first; the (slow) answerCallbackQuery round-trip comes after it
void TgCallback(const string cbId,const string data,const long chat,const long from)
  {
   TgCallbackBody(data,chat,from);
   string resp;
   TgCall("answerCallbackQuery","callback_query_id="+UrlEnc(cbId),resp);
  }

string SecFile() { return "Yetimmm_"+IntegerToString(g_magic)+"_Security.csv"; }

void SecurityLog(const long from,const long chat,const string what)
  {
   string w=Clean(what);
   if(StringLen(w)>60) w=StringSubstr(w,0,60);
   AppendLine(SecFile(),"Time;FromID;ChatID;Event;Content",
              TimeToString(TimeCurrent(),TIME_DATE|TIME_SECONDS)+";"+IntegerToString(from)+";"+IntegerToString(chat)+";UNAUTHORIZED_REJECTED;"+w);
  }

//--- one poller per bot token inside this terminal (several charts with the same EA no longer collide)
string TgLeadKey()
  {
   long h=0;
   for(int i=0;i<StringLen(g_tgTok);i++) h=(h*31+(long)StringGetCharacter(g_tgTok,i))%2147483647;
   return "YTLEAD_"+IntegerToString((int)h);
  }

bool TgIsLeader()
  {
   if(!InpTgAutoHeal) return true;
   string k=TgLeadKey();
   string kid=k+"_ID", kt=k+"_T";
   double me=(double)ChartID();
   datetime now=TimeLocal();
   if(GlobalVariableCheck(kid) && GlobalVariableCheck(kt))
     {
      double owner=GlobalVariableGet(kid);
      datetime t=(datetime)(long)GlobalVariableGet(kt);
      if(owner!=me && now-t<=10) return false;   // another chart polls this token
     }
   GlobalVariableSet(kid,me);
   GlobalVariableSet(kt,(double)(long)now);
   return true;
  }

void TgPoll()
  {
   if(!TgActive() || !g_connected) return;
   if(BrShared()) return;              // v3 shared bot: notifications only, no getUpdates
   if(g_tgPausedUntil>0 && TimeLocal()<g_tgPausedUntil) return;   // another instance owns the token
   if(!TgIsLeader()) return;
   ulong nowMs=GetTickCount64();
   if(nowMs<g_tgBackoffUntil) return;   // back off after a failed poll instead of hammering Telegram
   if(nowMs-g_tgLastPollMs<(ulong)MathMax(100,MathMin(2000,InpTgPollMs))) return;
   g_tgLastPollMs=nowMs;
   bool any=false;                      // v2.13: something new arrived in this poll
   bool baseline=!GHas("TGINIT");
   string body;
   if(baseline) body="offset=-1&timeout=0";
   else body="offset="+IntegerToString(g_tgLast+1)+"&timeout=0&allowed_updates="+UrlEnc("[\"message\",\"callback_query\"]");
   string resp;
   if(!TgCall("getUpdates",body,resp))
     {
      g_tgBackoffUntil=GetTickCount64()+(g_tgLastCode==409?15000:5000);
      if(InpTgAutoHeal && g_tgLastCode==409)
        {
         g_tg409++;
         string r2;
         if(TimeLocal()-g_tgWhTry>=600)    // 1) a leftover webhook is the most common cause: clear it once
           {
            g_tgWhTry=TimeLocal();
            if(TgCall("deleteWebhook","drop_pending_updates=false",r2)) YLog("Telegram Self-Heal: webhook cleared, retrying.");
           }
         if(g_tg409>=3)                    // 2) still conflicting: another PC/VPS/program polls this token
           {
            g_tgPausedUntil=TimeLocal()+600;
            g_tg409=0;
            YLog("Telegram Self-Heal: another instance is polling this Bot Token (VPS/PC/other chart). Polling paused 10 min - notifications keep working, commands are handled by the other instance.");
           }
        }
      return;
     }
   g_tg409=0;
   string marker="\"update_id\":";
   int mlen=StringLen(marker);
   int p=0;
   while(true)
     {
      int a=StringFind(resp,marker,p);
      if(a<0) break;
      int b=StringFind(resp,marker,a+mlen);
      string seg=(b<0)?StringSubstr(resp,a):StringSubstr(resp,a,b-a);
      bool f;
      long uid=JNum(seg,marker,f);
      if(f && uid>g_tgLast)
        {
         any=true;
         g_tgLast=uid;                       // persist before executing (at-most-once)
         GS("TGLAST",(double)g_tgLast);
         if(!baseline)
           {
            bool isCb=(StringFind(seg,"\"callback_query\":")>=0);
            bool f1,f2;
            long from=JNum(seg,"\"from\":{\"id\":",f1);
            long chat=JNum(seg,"\"chat\":{\"id\":",f2);
            if(!f2) chat=from;
            if(!f1 || !TgAuthorized(from))
              {
               string uText=isCb?JStr(seg,"\"data\":\""):JStr(seg,"\"text\":\"");
               YLog("Telegram User Unauthorized (id "+IntegerToString(from)+") - command rejected, no action taken");
               SecurityLog(from,chat,uText);
               if(AlertThrottle("UNAUTH"+IntegerToString(from),300))
                  TgQueue("🚫 UNAUTHORIZED TELEGRAM ACCESS ATTEMPT\nID: "+IntegerToString(from)+"\nThe command was rejected; no trading action was taken.");
              }
            else if(isCb)
              {
               string cid=JStr(seg,"\"callback_query\":{\"id\":\"");
               string data=JStr(seg,"\"data\":\"");
               TgCallback(cid,data,chat,from);
              }
            else
              {
               string text=JStr(seg,"\"text\":\"");
               TgCommand(text,chat,from);
              }
           }
        }
      if(b<0) break;
      p=b;
     }
   if(baseline) GS("TGINIT",1.0);
   if(any || baseline) GlobalVariablesFlush();   // v2.13: no disk flush on an empty poll
   if(any) TgFlush();                             // v2.13: the reply leaves right after the command was executed
  }

//+------------------------------------------------------------------+
//| Monitors                                                         |
//+------------------------------------------------------------------+
void MonitorConnection()
  {
   bool c=(bool)TerminalInfoInteger(TERMINAL_CONNECTED);
   if(c && !g_connected)
     {
      g_connected=true;
      YLog("Connection Restored");
      RecoverHistory();
      g_dirty=true;
      SyncAll();
      if(AlertThrottle("CONNOK",300)) TgQueue("🔌 CONNECTION RESTORED\nAccount state checked: positions, orders and last deal verified.\nStatus: "+RunStatus());
     }
   else if(!c && g_connected)
     {
      g_connected=false;
      YLog("Connection Lost");
      RaiseAlert("CONN","Connection Lost: no new orders will be sent until it is restored.",true,true);
     }
  }

void MonitorSpread()
  {
   double sp=(double)SymbolInfoInteger(g_sym,SYMBOL_SPREAD);
   if(sp>(double)g_warn)
     {
      if(!g_spreadWarned)
        {
         g_spreadWarned=true;
         YLog("Spread Warning: "+DoubleToString(sp,0)+" pts");
         RaiseAlert("SPREAD","Spread Warning: "+DoubleToString(sp,0)+" pts > "+IntegerToString(g_warn)+" pts (trading NOT blocked).",true,true);
        }
     }
   else if(sp<=(double)g_warn*0.8) g_spreadWarned=false;
  }

//+------------------------------------------------------------------+
//| Panel                                                            |
//+------------------------------------------------------------------+
void UI_Rect(const string n,const int x,const int y,const int w,const int h,const color bg,const color bd)
  {
   if(ObjectFind(0,n)<0) ObjectCreate(0,n,OBJ_RECTANGLE_LABEL,0,0,0);
   ObjectSetInteger(0,n,OBJPROP_CORNER,CORNER_LEFT_UPPER);
   ObjectSetInteger(0,n,OBJPROP_XDISTANCE,x);
   ObjectSetInteger(0,n,OBJPROP_YDISTANCE,y);
   ObjectSetInteger(0,n,OBJPROP_XSIZE,w);
   ObjectSetInteger(0,n,OBJPROP_YSIZE,h);
   ObjectSetInteger(0,n,OBJPROP_BGCOLOR,bg);
   ObjectSetInteger(0,n,OBJPROP_BORDER_TYPE,BORDER_FLAT);
   ObjectSetInteger(0,n,OBJPROP_COLOR,bd);
   ObjectSetInteger(0,n,OBJPROP_SELECTABLE,false);
   ObjectSetInteger(0,n,OBJPROP_HIDDEN,true);
  }

void UI_Label(const string n,const int x,const int y,const string txt,const color c,const int fs)
  {
   if(ObjectFind(0,n)<0) ObjectCreate(0,n,OBJ_LABEL,0,0,0);
   ObjectSetInteger(0,n,OBJPROP_CORNER,CORNER_LEFT_UPPER);
   ObjectSetInteger(0,n,OBJPROP_ANCHOR,ANCHOR_LEFT_UPPER);
   ObjectSetInteger(0,n,OBJPROP_XDISTANCE,x);
   ObjectSetInteger(0,n,OBJPROP_YDISTANCE,y);
   ObjectSetInteger(0,n,OBJPROP_COLOR,c);
   ObjectSetInteger(0,n,OBJPROP_FONTSIZE,fs);
   ObjectSetString(0,n,OBJPROP_FONT,"Arial");
   ObjectSetString(0,n,OBJPROP_TEXT,txt);
   ObjectSetInteger(0,n,OBJPROP_SELECTABLE,false);
   ObjectSetInteger(0,n,OBJPROP_HIDDEN,true);
  }

void UI_Edit(const string n,const int x,const int y,const int w,const int h,const string txt)
  {
   if(ObjectFind(0,n)<0) ObjectCreate(0,n,OBJ_EDIT,0,0,0);
   ObjectSetInteger(0,n,OBJPROP_CORNER,CORNER_LEFT_UPPER);
   ObjectSetInteger(0,n,OBJPROP_XDISTANCE,x);
   ObjectSetInteger(0,n,OBJPROP_YDISTANCE,y);
   ObjectSetInteger(0,n,OBJPROP_XSIZE,w);
   ObjectSetInteger(0,n,OBJPROP_YSIZE,h);
   ObjectSetInteger(0,n,OBJPROP_BGCOLOR,C'40,46,58');
   ObjectSetInteger(0,n,OBJPROP_COLOR,clrWhite);
   ObjectSetInteger(0,n,OBJPROP_BORDER_COLOR,C'90,100,120');
   ObjectSetInteger(0,n,OBJPROP_ALIGN,ALIGN_CENTER);
   ObjectSetInteger(0,n,OBJPROP_FONTSIZE,9);
   ObjectSetString(0,n,OBJPROP_TEXT,txt);
   ObjectSetInteger(0,n,OBJPROP_SELECTABLE,false);
   ObjectSetInteger(0,n,OBJPROP_HIDDEN,true);
  }

void UI_Button(const string n,const int x,const int y,const int w,const int h,const string txt,const color bg)
  {
   if(ObjectFind(0,n)<0) ObjectCreate(0,n,OBJ_BUTTON,0,0,0);
   ObjectSetInteger(0,n,OBJPROP_CORNER,CORNER_LEFT_UPPER);
   ObjectSetInteger(0,n,OBJPROP_XDISTANCE,x);
   ObjectSetInteger(0,n,OBJPROP_YDISTANCE,y);
   ObjectSetInteger(0,n,OBJPROP_XSIZE,w);
   ObjectSetInteger(0,n,OBJPROP_YSIZE,h);
   ObjectSetInteger(0,n,OBJPROP_BGCOLOR,bg);
   ObjectSetInteger(0,n,OBJPROP_COLOR,clrWhite);
   ObjectSetInteger(0,n,OBJPROP_FONTSIZE,8);
   ObjectSetString(0,n,OBJPROP_TEXT,txt);
   ObjectSetInteger(0,n,OBJPROP_STATE,false);
   ObjectSetInteger(0,n,OBJPROP_SELECTABLE,false);
   ObjectSetInteger(0,n,OBJPROP_HIDDEN,true);
  }

void UI_ToggleSet(const string n,const bool on)
  {
   color bg=C'150,50,50';
   if(on) bg=C'30,130,60';
   ObjectSetString(0,n,OBJPROP_TEXT,on?"ON":"OFF");
   ObjectSetInteger(0,n,OBJPROP_BGCOLOR,bg);
   ObjectSetInteger(0,n,OBJPROP_STATE,false);
  }

void SettingRow(const string key,const int x,const int ry,const string label,const string val)
  {
   UI_Label(UI+"SL_"+key,x+12,ry+4,label,clrSilver,9);
   UI_Edit(UI+"S_"+key,x+190,ry,140,20,val);
  }

void ToggleRow(const string key,const int x,const int ry,const string label,const bool on)
  {
   UI_Label(UI+"SL_"+key,x+12,ry+4,label,clrSilver,9);
   UI_Button(UI+"BTN_"+key,x+190,ry,140,20,"",C'150,50,50');
   UI_ToggleSet(UI+"BTN_"+key,on);
  }

//--- page 1: every configurable value (the trading levels / risk are on page 0)
void CreateSettingsPage()
  {
   int x=10,y=25,w=350,rowH=26;
   int h=48+9*rowH+70;
   UI_Rect(UI+"BG",x,y,w,h,C'22,26,34',C'212,175,55');
   UI_Label(UI+"TITLE",x+12,y+6,"Yetimmm",clrGold,15);
   UI_Label(UI+"SUB",x+110,y+13,"Settings",C'150,160,175',8);
   int ry=y+40;
   SettingRow("TARGET",x,ry,"Recovery Target ($, next risk)",D2(g_target)); ry+=rowH;
   SettingRow("RR",x,ry,"Risk/Reward (1:x)",DoubleToString(g_rr,2)); ry+=rowH;
   SettingRow("SLD",x,ry,"SL = Upper-Lower ($, auto)",DoubleToString(SLDist(),g_digits));
   ObjectSetInteger(0,UI+"S_SLD",OBJPROP_READONLY,true);
   ObjectSetInteger(0,UI+"S_SLD",OBJPROP_BGCOLOR,C'30,34,44');
   ry+=rowH;
   SettingRow("MAXDEV",x,ry,"Max Slippage Check (pts, post-fill)",IntegerToString(g_maxDev)); ry+=rowH;
   SettingRow("WARN",x,ry,"Spread Alert (pts, alert only)",IntegerToString(g_warn)); ry+=rowH;
   SettingRow("MAGIC",x,ry,"Magic Number (locked)",IntegerToString(g_magic));
   ObjectSetInteger(0,UI+"S_MAGIC",OBJPROP_READONLY,true);
   ObjectSetInteger(0,UI+"S_MAGIC",OBJPROP_BGCOLOR,C'30,34,44');
   ry+=rowH;
   ToggleRow("TGEN",x,ry,"Telegram Enable",g_uiTgEn); ry+=rowH;
   ToggleRow("TGNOT",x,ry,"Notifications",g_uiTgNot); ry+=rowH;
   ToggleRow("TGCTL",x,ry,"Telegram Control",g_uiTgCtl); ry+=rowH+6;
   UI_Button(UI+"BTN_SAVE",x+10,ry,160,24,"SAVE SETTINGS",C'30,130,60');
   UI_Button(UI+"BTN_BACK",x+180,ry,160,24,"< BACK",C'60,70,95');
   ry+=30;
   UI_Label(UI+"INFO",x+12,ry,"Contract Size: "+DoubleToString(g_contract,2)+"  |  "+(g_netting?"NETTING":"HEDGING"),C'150,160,175',8);
  }

void CreatePanel()
  {
   if(!InpShowPanel || MQLInfoInteger(MQL_OPTIMIZATION)) return;
   ObjectsDeleteAll(0,UI);
   if(g_page==1)
     {
      CreateSettingsPage();
      ChartRedraw(0);
      return;
     }
   int x=10,y=25,w=400;
   int rows=ArraySize(g_rowKeys);
   ArrayResize(g_uiTxt,rows);                        // value cache: UpdatePanel writes only the rows that changed
   ArrayResize(g_uiCol,rows);
   for(int c=0;c<rows;c++) { g_uiTxt[c]="~~~"; g_uiCol[c]=clrNONE; }
   int h=48+34+rows*15+12;
   UI_Rect(UI+"BG",x,y,w,h,C'22,26,34',C'212,175,55');
   UI_Label(UI+"TITLE",x+12,y+6,"Yetimmm",clrGold,15);
   UI_Label(UI+"SUB",x+110,y+13,"XAUUSD | Monitor - orders come from the Mini App",C'150,160,175',8);
   int ry=y+40;
   UI_Button(UI+"BTN_SET",x+10,ry,380,22,"SETTINGS  >",C'60,70,95');
   ry+=34;
   for(int i=0;i<rows;i++)
     {
      UI_Label(UI+"K"+IntegerToString(i),x+12,ry+i*15,g_rowKeys[i],C'150,160,175',8);
      UI_Label(UI+"V"+IntegerToString(i),x+170,ry+i*15,"-",clrWhite,8);
     }
  }

void UI_Val(const int i,const string txt,const color c=clrWhite)
  {
   if(i<0 || i>=ArraySize(g_uiTxt)) return;
   if(g_uiTxt[i]==txt && g_uiCol[i]==c) return;      // unchanged: no object call at all
   string n=UI+"V"+IntegerToString(i);
   if(ObjectFind(0,n)<0) return;
   ObjectSetString(0,n,OBJPROP_TEXT,txt);
   ObjectSetInteger(0,n,OBJPROP_COLOR,c);
   g_uiTxt[i]=txt;
   g_uiCol[i]=c;
   g_uiChanged=true;
  }

//--- incremental refresh: only rows whose text/colour changed are written, and the chart is redrawn only then
void UpdatePanel()
  {
   if(!InpShowPanel || MQLInfoInteger(MQL_OPTIMIZATION)) return;
   if(ObjectFind(0,UI+"BG")<0) CreatePanel();
   if(g_page!=0) return;            // settings page has no live values
   g_uiChanged=false;
   color sc=clrLime;
   if(g_state==YT_STOPPED || g_state==YT_ERROR) sc=clrTomato;
   else if(g_state==YT_IDLE || g_state==YT_TP_RESET) sc=clrGold;
   UI_Val(0,RunStatus()+" ["+StateText()+"]",sc);
   UI_Val(1,g_sym);

   //--- BUY STOP / SELL STOP: Desired (what the bot wants) vs Actual (what the server holds) vs Status
   for(int k=0;k<2;k++)
     {
      bool b=(k==0);
      int base=b?2:5;
      double dl;
      bool want=SideDesired(b,dl);
      double pend=b?g_pendBuy:g_pendSell;
      string nxt=(g_fresh && pend>0.0)?"  (next: "+PX(pend)+")":"";
      UI_Val(base,(want?PX(dl):"-")+nxt);
      ulong oTk; double ap;
      bool have=SideActual(b,oTk,ap);
      string det="-";
      if(have && OrderSelect(oTk))
         det="SL "+PX(OrderGetDouble(ORDER_SL))+"  TP "+PX(OrderGetDouble(ORDER_TP))+"  Lot "+LotS(OrderGetDouble(ORDER_VOLUME_CURRENT));
      UI_Val(b?29:30,det);
      UI_Val(base+1,have?PX(ap)+"  #"+UL(oTk):"-",(have && want && PriceEq(ap,dl))?clrLime:clrWhite);
      int st=SideStatusShown(b);
      UI_Val(base+2,SyncText(st),SyncColor(st));
     }

   ulong tk,pid; bool buy; double vol,entry,sl,tp,pr;
   if(OwnPosInfo(tk,pid,buy,vol,entry,sl,tp,pr))
     {
      UI_Val(8,(buy?"BUY ":"SELL ")+LotS(vol)+" @ "+PX(entry)+"  P/L "+Money(pr),buy?clrLime:clrTomato);
      UI_Val(31,"SL "+PX(sl)+"  TP "+PX(tp)+"  #"+UL(tk));
     }
   else { UI_Val(8,"None",clrSilver); UI_Val(31,"-"); }
   ulong od[]; int no=OwnOrders(od);
   string os="";
   for(int i=0;i<no;i++)
      if(OrderSelect(od[i])) os+=(OrderGetInteger(ORDER_TYPE)==ORDER_TYPE_BUY_STOP?"BuyStop ":"SellStop ")+PX(OrderGetDouble(ORDER_PRICE_OPEN))+"  ";
   if(os=="") { string wn=WaitNote(); os=(StringLen(wn)>0)?wn:((StringLen(g_blockReason)>0)?g_blockReason:"None"); if(StringLen(os)>70) os=StringSubstr(os,0,70)+"..."; }
   UI_Val(9,os);
   string lm=g_uiMsg;
   if(StringLen(lm)>56) lm=StringSubstr(lm,0,56)+"..";
   UI_Val(10,(lm=="")?"-":lm,g_uiMsgCol);
   UI_Val(11,IntegerToString(g_seq));
   UI_Val(12,"$"+D2(g_curRisk));
   double lot,est; string err;
   bool ok=CurrentLotInfo(lot,est,err);
   string lotTxt=ok?LotS(lot)+"  (est. loss $"+D2(est)+")":"n/a: "+err;
   color lotCol=ok?clrWhite:clrTomato;
   if(ok)
     {
      //--- the panel lot must equal the volume of the REAL pending order
      ulong lotTk; double lotPx;
      if(SideActual(g_mode!=YM_SELL,lotTk,lotPx) && OrderSelect(lotTk))
        {
         double mv=OrderGetDouble(ORDER_VOLUME_CURRENT);
         double vst=SymbolInfoDouble(g_sym,SYMBOL_VOLUME_STEP);
         if(vst<=0.0) vst=0.01;
         lotTxt+="  MT5 "+LotS(mv);
         if(MathAbs(mv-lot)>vst/2.0) lotCol=clrTomato;
        }
     }
   UI_Val(13,lotTxt,lotCol);
   UI_Val(14,"$"+D2(g_accLoss));
   UI_Val(15,"$"+D2(NextRiskForNet(g_cycNet-(ok?est:g_curRisk))));
   UI_Val(16,ok?"$"+D2(est*g_rr):"n/a");
   UI_Val(17,"1:"+DoubleToString(g_rr,0));
   UI_Val(18,g_connected?"ONLINE":"OFFLINE",g_connected?clrLime:clrTomato);
   double sp=(double)SymbolInfoInteger(g_sym,SYMBOL_SPREAD);
   UI_Val(19,DoubleToString(sp,0)+" pts",sp>(double)g_warn?clrTomato:clrWhite);
   UI_Val(20,g_tradeNo>0?"#"+TNo(g_tradeNo):"-");
   UI_Val(21,IntegerToString(g_st.total));
   UI_Val(22,IntegerToString(g_st.wins));
   UI_Val(23,IntegerToString(g_st.losses));
   UI_Val(24,Money(g_st.totProfit));
   UI_Val(25,Money(-g_st.totLoss));
   UI_Val(26,Money(g_st.net),g_st.net>=0?clrLime:clrTomato);
   UI_Val(27,D2(g_st.winRate)+"%");
   UI_Val(28,TgStateText(),g_tgOk?clrLime:clrSilver);
   if(g_uiChanged) ChartRedraw(0);
  }

//--- every id must be a non-zero integer (negative ids = groups/channels)
//--- validate EVERYTHING first; apply all-or-nothing
void PanelSaveSettings()
  {
   double nt =ParseNum(ObjectGetString(0,UI+"S_TARGET",OBJPROP_TEXT));
   double rr =ParseNum(ObjectGetString(0,UI+"S_RR",OBJPROP_TEXT));
   double mdv=ParseNum(ObjectGetString(0,UI+"S_MAXDEV",OBJPROP_TEXT));
   double wnv=ParseNum(ObjectGetString(0,UI+"S_WARN",OBJPROP_TEXT));

   string err="";
   double stopsLvl=(double)SymbolInfoInteger(g_sym,SYMBOL_TRADE_STOPS_LEVEL)*g_point;
   if(!MathIsValidNumber(nt) || nt<0.0)                          err="Recovery Target must be zero or positive.";
   else if(!MathIsValidNumber(rr) || rr<=0.0)                    err="Risk/Reward must be greater than zero.";
   else if(!MathIsValidNumber(mdv) || mdv<0.0 || mdv>100000.0)   err="Max Slippage Check must be between 0 and 100000 points.";
   else if(!MathIsValidNumber(wnv) || wnv<0.0 || wnv>100000.0)   err="Spread Alert must be between 0 and 100000 points.";

   bool tradeChanged=(MathAbs(nt-g_target)>1e-9 || MathAbs(rr-g_rr)>1e-9);
   if(err=="" && tradeChanged)
     {
      ulong tk[];
      if(OwnPositions(tk)>0) err="Recovery Target / Risk-Reward cannot change while a Yetimmm position is open.";
     }
   if(err!="")
     {
      YLog("Settings NOT saved: "+err);
      Alert("Yetimmm: settings NOT saved - ",err);
      return;
     }

   string oldTok=g_tgTok;
   bool wasActive=TgActive();

   g_target=nt; g_rr=rr;
   g_maxDev=(int)MathRound(mdv);
   g_warn=(int)MathRound(wnv);
   g_tgEn=g_uiTgEn; g_tgNot=g_uiTgNot; g_tgCtl=g_uiTgCtl;
   g_trade.SetDeviationInPoints(g_maxDev);

   if(tradeChanged)
     {
      g_curRisk=NextRiskForNet(g_cycNet);
      g_nextPlaceMs=0;
      ResetSyncBackoff();
     }
   //--- never execute commands that piled up while Telegram was off or the bot changed
   if((!wasActive && TgActive()) || oldTok!=g_tgTok)
     {
      GlobalVariableDel(GN("TGINIT"));
      g_tgOk=false;
     }
   CfgPutAll();
   CfgSaveFile();
   SaveState();
   g_dirty=true;
   YLog("Settings saved from panel | Target "+D2(g_target)+" | R:R 1:"+DoubleToString(g_rr,2)+" | SL (Upper-Lower) "+D2(SLDist())+" | MaxSlippage "+IntegerToString(g_maxDev)+" | SpreadAlert "+IntegerToString(g_warn)+
        " | Telegram "+(g_tgEn?"ON":"OFF")+" | Notify "+(g_tgNot?"ON":"OFF")+" | Control "+(g_tgCtl?"ON":"OFF"));
   if(tradeChanged)
     {
      SyncAll();                        // SL / RR / target change the REAL orders now, not on the next tick
      UpdatePanel();
      PanelMsg("SETTINGS: "+SyncSummary(),clrWhite);
     }
   Alert("Yetimmm: settings saved."+(tradeChanged?" "+SyncSummary():""));
   TgQueue("⚙️ SETTINGS UPDATED (panel)\n"+SettingsText());
  }

void OnChartEvent(const int id,const long &lparam,const double &dparam,const string &sparam)
  {
   if(id!=CHARTEVENT_OBJECT_CLICK) return;
   if(StringFind(sparam,UI)!=0) return;
   if(sparam==UI+"BTN_SET")
     {
      ObjectSetInteger(0,sparam,OBJPROP_STATE,false);
      g_uiTgEn=g_tgEn; g_uiTgNot=g_tgNot; g_uiTgCtl=g_tgCtl;
      g_page=1;
      CreatePanel();
     }
   else if(sparam==UI+"BTN_BACK")
     {
      g_page=0;
      CreatePanel();
     }
   else if(sparam==UI+"BTN_SAVE")
     {
      ObjectSetInteger(0,sparam,OBJPROP_STATE,false);
      PanelSaveSettings();
     }
   else if(sparam==UI+"BTN_TGEN")   { g_uiTgEn=!g_uiTgEn;   UI_ToggleSet(sparam,g_uiTgEn); }
   else if(sparam==UI+"BTN_TGNOT")  { g_uiTgNot=!g_uiTgNot; UI_ToggleSet(sparam,g_uiTgNot); }
   else if(sparam==UI+"BTN_TGCTL")  { g_uiTgCtl=!g_uiTgCtl; UI_ToggleSet(sparam,g_uiTgCtl); }
   g_dirty=true;
   UpdatePanel();
   ChartRedraw(0);
  }

//+------------------------------------------------------------------+
//| Expert events                                                    |
//+------------------------------------------------------------------+
//--- log the symbol specification that drives the lot calculation (Contract Size included)
void LogSpecs()
  {
   YLog("Specs | Contract Size "+DoubleToString(g_contract,2)+" | Tick Size "+DoubleToString(g_tick,g_digits)+" | Tick Value "+DoubleToString(SymbolInfoDouble(g_sym,SYMBOL_TRADE_TICK_VALUE),4)+
        " | Volume Min "+DoubleToString(SymbolInfoDouble(g_sym,SYMBOL_VOLUME_MIN),g_lotDigits)+" Max "+DoubleToString(SymbolInfoDouble(g_sym,SYMBOL_VOLUME_MAX),g_lotDigits)+
        " Step "+DoubleToString(SymbolInfoDouble(g_sym,SYMBOL_VOLUME_STEP),g_lotDigits)+" | Digits "+IntegerToString(g_digits));
   if(g_contract<=0.0)
      RaiseAlert("CSIZE0","Broker reports Contract Size = 0 for "+g_sym+": loss per lot relies on OrderCalcProfit / Tick Value only.",true,false);
   double px=SymbolInfoDouble(g_sym,SYMBOL_BID);
   if(px>0.0) PerLotLossSL(true,px,px-1.0);   // triggers the Contract Size cross-check once at start-up (1.00 test distance)
  }

//+------------------------------------------------------------------+
//| Magic Number guard                                               |
//| Positions/orders are identified by Symbol + Magic. If the Magic  |
//| was changed while Yetimmm orders/positions of the OLD Magic still|
//| exist, the new instance would never manage them: they would stay |
//| alive on the server. Detect -> strong warning -> do not start.   |
//+------------------------------------------------------------------+
string MagicKey() { return "YTX_"+g_sym+"_LASTMAGIC"; }

bool IsYetimmmComment(const string c) { return (StringFind(c,"Yetimmm")>=0); }

//--- counts Yetimmm-tagged pending orders / positions on this symbol that belong to ANOTHER magic
int CountOrphans(string &detail)
  {
   int cnt=0;
   detail="";
   int no=OrdersTotal();
   for(int i=0;i<no;i++)
     {
      ulong t=OrderGetTicket(i);
      if(t==0) continue;
      if(OrderGetString(ORDER_SYMBOL)!=g_sym) continue;
      long mg=(long)OrderGetInteger(ORDER_MAGIC);
      if(mg==g_magic) continue;
      if(!IsYetimmmComment(OrderGetString(ORDER_COMMENT))) continue;
      cnt++;
      if(StringLen(detail)<180) detail+=" order#"+UL(t)+"(magic "+IntegerToString((int)mg)+")";
     }
   int np=PositionsTotal();
   for(int i=0;i<np;i++)
     {
      ulong t=PositionGetTicket(i);
      if(t==0) continue;
      if(PositionGetString(POSITION_SYMBOL)!=g_sym) continue;
      long mg=(long)PositionGetInteger(POSITION_MAGIC);
      if(mg==g_magic) continue;
      if(!IsYetimmmComment(PositionGetString(POSITION_COMMENT))) continue;
      cnt++;
      if(StringLen(detail)<180) detail+=" position#"+UL(t)+"(magic "+IntegerToString((int)mg)+")";
     }
   return cnt;
  }

//--- returns false when the start must be refused
bool MagicGuardOk()
  {
   string key=MagicKey();
   bool changed=(GlobalVariableCheck(key) && (long)GlobalVariableGet(key)!=g_magic);
   string det="";
   int orph=CountOrphans(det);
   if(orph>0 && changed && !InpIgnoreOrphans)
     {
      string m="MAGIC NUMBER CHANGED ("+IntegerToString((int)(long)GlobalVariableGet(key))+" -> "+IntegerToString((int)g_magic)+") while "+IntegerToString(orph)+
               " Yetimmm order(s)/position(s) of another Magic still exist on "+g_sym+":"+det+
               ". They are NOT managed by this instance. Close/delete them or restore the old Magic, then re-attach (or set InpIgnoreOrphans=true).";
      YLog("INIT REFUSED: "+m);
      Alert("Yetimmm refused to start: ",m);
      return false;
     }
   if(orph>0 && !changed)
      YLog("WARNING: "+IntegerToString(orph)+" Yetimmm-tagged order(s)/position(s) of another Magic on "+g_sym+":"+det+" (not managed by this instance).");
   if(orph>0 && InpIgnoreOrphans)
      YLog("Magic guard bypassed by InpIgnoreOrphans.");
   GlobalVariableSet(key,(double)g_magic);
   return true;
  }

//+------------------------------------------------------------------+
//| Mini App bridge (Cloudflare Worker)                              |
//| One WebRequest per cycle: push state + ack done commands +       |
//| receive pending commands. Commands reuse the SAME functions as   |
//| the Telegram commands (DoStart / ExecStop / ApplyLevels ...).    |
//+------------------------------------------------------------------+
string g_brSec="";
bool   g_brFresh=true;             // first sync after (re)start (an EA restart no longer signs anybody out; only reset / a changed MT5 server does)
bool   g_brShared=false, g_brSharedLoaded=false;
// v3: private secret generated once by the EA itself (invisible to the user) - proves "this is the same EA" to the Worker
bool   g_brPairLoaded=false, g_brPairNeed=true;   // v2.21: true until the Worker confirmed the pairing (then the minted secret alone authenticates)
string YtSha256Hex(const string src)
  {
   uchar inb[],outb[],keyb[];
   int n=StringToCharArray(src,inb,0,WHOLE_ARRAY,CP_UTF8);
   if(n>1) ArrayResize(inb,n-1);
   ArrayResize(keyb,0);
   if(CryptEncode(CRYPT_HASH_SHA256,inb,keyb,outb)<=0) return "";
   string h="";
   for(int i=0;i<ArraySize(outb);i++) h+=StringFormat("%02x",outb[i]);
   return h;
  }
// The secret is now a BOOTSTRAP value only: the Worker mints the real one (CSPRNG) when the pairing code is accepted and the EA stores it ("es" in the sync reply).
// The local value mixes several entropy sources through SHA-256 (MathRand alone is not a cryptographic generator).
string BrKeyEff()
  {
   if(StringLen(g_brSec)>=16) return g_brSec;
   string s=CfgGet("brsec","");
   if(StringLen(s)<16)
     {
      ulong mix=GetMicrosecondCount() ^ (ulong)GetTickCount64() ^ ((ulong)TimeLocal()<<20) ^ (ulong)AccountInfoInteger(ACCOUNT_LOGIN);
      MathSrand((int)(mix%2147483647));
      string seed=IntegerToString((long)mix)+"|"+IntegerToString((long)TerminalInfoInteger(TERMINAL_MEMORY_USED))+"|"+IntegerToString((long)TerminalInfoInteger(TERMINAL_PING_LAST))+"|"+
                  DoubleToString(SymbolInfoDouble(_Symbol,SYMBOL_BID),8)+"|"+TerminalInfoString(TERMINAL_PATH)+"|"+TerminalInfoString(TERMINAL_DATA_PATH);
      for(int k=0;k<16;k++) seed+="|"+IntegerToString(MathRand());
      s=YtSha256Hex(seed);
      if(StringLen(s)<32)               // SHA-256 unavailable: legacy generator (the Worker mints the real secret anyway)
        {
         s="";
         for(int i=0;i<32;i++) s+=StringSubstr("0123456789abcdef",MathRand()%16,1);
        }
      CfgSet("brsec",s);
      CfgSaveFile();
     }
   g_brSec=s;
   return s;
  }
// v3: one shared bot -> the EA only SENDS notifications; commands come from the app (several EAs polling one token would conflict)
bool BrShared()
  {
   if(!g_brSharedLoaded) { g_brShared=(CfgGet("brshared","0")=="1"); g_brSharedLoaded=true; }
   return g_brShared;
  }
int      g_brCv=0;                 // v2.19b: version of the Telegram config received from the Worker
bool     g_brCvLoaded=false;
datetime g_brLast=0;
datetime g_brErrLog=0;
bool     g_brOk=false;
bool     g_brFirst=true;          // first successful sync: queued commands are discarded, never executed
string   g_brAck[];
string   g_brDone[];
int      g_brHistTotal=-1;
string   g_brHistJson="[]";
string   g_brLastId="";
string   g_brLastText="";
bool     g_brLastOk=true;

//+------------------------------------------------------------------+
//| v4.31.1 bridge connection state machine + diagnostics            |
//| CONFIG_LOADING -> CONFIG_READY | CONFIG_INVALID                  |
//| CONNECTING -> CONNECTED -> RETRYING -> OFFLINE -> CONNECTED      |
//| CONNECTED is declared ONLY after a real "ok":true answer from    |
//| the Worker. A state change is logged once (no log spam).         |
//+------------------------------------------------------------------+
enum YT_BR_STATE { BR_CONFIG_LOADING=0, BR_CONFIG_INVALID, BR_CONFIG_READY, BR_CONNECTING, BR_CONNECTED, BR_RETRYING, BR_OFFLINE };
YT_BR_STATE g_brState=BR_CONFIG_LOADING;
datetime g_brLastOkAt=0;        // last successful sync
datetime g_brLastFailAt=0;      // last failed sync attempt
datetime g_brDownSince=0;       // first failure of the current outage (0 = none)
int      g_brFails=0;           // consecutive failed attempts
string   g_brLastErr="";        // short code of the last failure: wr<MT5 error> | http<code> | <Worker error>
int      g_brLastHttp=0;        // last HTTP status (0 = no HTTP answer)
int      g_brLastOutSec=0;      // duration of the last recovered outage (reported to the Worker)
int      g_brLastOutFails=0;
const int YT_BR_OFFLINE_SEC=30; // equals the Worker EA_STALE_SEC: beyond this the app shows the bot as offline

string BrStateName(const YT_BR_STATE s)
  {
   switch(s)
     {
      case BR_CONFIG_LOADING: return "CONFIG_LOADING";
      case BR_CONFIG_INVALID: return "CONFIG_INVALID";
      case BR_CONFIG_READY:   return "CONFIG_READY";
      case BR_CONNECTING:     return "CONNECTING";
      case BR_CONNECTED:      return "CONNECTED";
      case BR_RETRYING:       return "RETRYING";
      case BR_OFFLINE:        return "OFFLINE";
     }
   return "?";
  }
// A transition is logged ONCE; the same state is never logged twice in a row.
void BrSetState(const YT_BR_STATE s,const string why="")
  {
   if(s==g_brState) return;
   g_brState=s;
   YLog("Mini App bridge: "+BrStateName(s)+(why!=""?" - "+why:""));
  }
// "" = the settings are usable. Otherwise the exact missing / wrong setting (never a vague "INACTIVE").
string BrConfigProblem()
  {
   if(StringLen(g_brUrl)<12) return "Worker URL missing (InpBrUrl is empty and Common\\Files\\Yetimmm.cfg has no url=) - run `npm run setup` or fill InpBrUrl.";
   if(StringFind(g_brUrl,"https://")!=0) return "Worker URL must start with https:// (got '"+g_brUrl+"').";
   if(StringLen(BrKeyEff())<8) return "no EA key could be created (is the Common Files folder writable?).";
   return "";
  }
// Seconds before the next attempt. Normal: InpBrPollSec. After failures: x2 per failure, capped at 10 s (recovery stays fast, the Worker is never flooded).
int BrRetryDelaySec()
  {
   int base=MathMax(1,InpBrPollSec);
   if(g_brFails<=0) return base;
   int d=base<<MathMin(g_brFails,3);
   return MathMin(MathMax(d,base),10);
  }
// One failed attempt: recorded -> RETRYING (OFFLINE after YT_BR_OFFLINE_SEC without any success). The first failure is always logged.
void BrFail(const string code,const int httpCode,const string human)
  {
   datetime now=TimeLocal();
   if(g_brFails==0) g_brDownSince=now;
   g_brFails++;
   g_brLastFailAt=now;
   g_brLastErr=code;
   g_brLastHttp=httpCode;
   g_brOk=false;
   datetime ref=(g_brLastOkAt>0)?g_brLastOkAt:g_brDownSince;
   if(now-ref>=YT_BR_OFFLINE_SEC) BrSetState(BR_OFFLINE,human);
   else if(g_brState!=BR_OFFLINE) BrSetState(BR_RETRYING,human);
   if(g_brFails==1 || g_brErrLog==0 || now-g_brErrLog>=60)
     {
      g_brErrLog=now;
      YLog("Mini App bridge: "+human+" | attempt #"+IntegerToString(g_brFails)+" | next try in "+IntegerToString(BrRetryDelaySec())+" s | last success "+(g_brLastOkAt>0?IntegerToString((int)(now-g_brLastOkAt))+" s ago":"never"));
     }
  }
// A real, verified success: the outage (if any) is closed and measured.
void BrSuccess()
  {
   datetime now=TimeLocal();
   if(g_brFails==0 && g_brLastOkAt>0 && now-g_brLastOkAt>=15)   // v2.45.1: a silent heartbeat gap is never hidden: it is written down with its length
      YLog("Mini App bridge: heartbeat gap of "+IntegerToString((int)(now-g_brLastOkAt))+" s (no failed request: the EA was busy or the market was hot). Worker offline limit is "+IntegerToString(YT_BR_OFFLINE_SEC)+" s.");
   if(g_brFails>0)
     {
      int down=(g_brDownSince>0)?(int)(now-g_brDownSince):0;
      g_brLastOutSec=down; g_brLastOutFails=g_brFails;
      g_brState=BR_CONNECTED;
      YLog("Mini App bridge: CONNECTED - recovered automatically after "+IntegerToString(down)+" s and "+IntegerToString(g_brFails)+" failed attempt(s) (last error "+g_brLastErr+"). No restart / re-login needed.");
     }
   else BrSetState(BR_CONNECTED,"Worker answered ok");
   g_brFails=0; g_brDownSince=0; g_brErrLog=0;
   g_brLastOkAt=now; g_brLastHttp=200; g_brLastErr="";
   g_brOk=true;
  }
// Outage report for the Worker: lets it tell "EA / network was down" from "Worker was down" (error code, failed attempts, last outage length).
string BrNetJson()
  {
   return "{\"fails\":"+IntegerToString(g_brFails)+",\"err\":\""+JEsc(g_brLastErr)+"\",\"outSec\":"+IntegerToString(g_brLastOutSec)+",\"outFails\":"+IntegerToString(g_brLastOutFails)+",\"st\":\""+BrStateName(g_brState)+"\"}";
  }

string JEsc(const string s)
  {
   string r=s;
   StringReplace(r,"\\","\\\\");
   StringReplace(r,"\"","\\\"");
   StringReplace(r,"\r"," ");
   StringReplace(r,"\n"," | ");
   StringReplace(r,"\t"," ");
   return r;
  }

//+------------------------------------------------------------------+
//| v2.20: MT5 built-in economic calendar -> Worker                   |
//| The logged-in MT5 account is the news source: it carries the REAL |
//| Actual values and the broker's own server time. The EA sends only |
//| a tiny content hash every sync; the full table travels only when  |
//| the content changed (or the Worker asks for it). Times are UTC.   |
//+------------------------------------------------------------------+
string   g_calJson="";           // rows array (JSON) of this week
string   g_calHash="";           // content hash of g_calJson
string   g_calSent="";           // last hash the Worker received
bool     g_calNeed=false;        // the Worker asked for the table
bool     g_calHot=false;         // an event is due / just released and still has no Actual -> refresh fast
datetime g_calBuilt=0;

// broker server time minus GMT, rounded to 15 min (DST of the broker is followed automatically)
int BrTzOffset()
  {
   long d=(long)(TimeTradeServer()-TimeGMT());
   long r=(long)MathRound((double)d/900.0)*900;
   if(r>50400 || r<-50400) r=0;
   return (int)r;
  }

string CalHash(const string s)
  {
   ulong h=5381;
   int n=StringLen(s);
   for(int i=0;i<n;i++) h=((h<<5)+h)+(ulong)StringGetCharacter(s,i);
   return StringFormat("%I64x",h);
  }

string CalFmt(const double v,const MqlCalendarEvent &ev)
  {
   if(!MathIsValidNumber(v)) return "";
   string suf="";
   switch(ev.multiplier)
     {
      case CALENDAR_MULTIPLIER_THOUSANDS: suf="K"; break;
      case CALENDAR_MULTIPLIER_MILLIONS:  suf="M"; break;
      case CALENDAR_MULTIPLIER_BILLIONS:  suf="B"; break;
      case CALENDAR_MULTIPLIER_TRILLIONS: suf="T"; break;
      default: break;
     }
   if(ev.unit==CALENDAR_UNIT_PERCENT) suf+="%";
   int dg=(int)ev.digits;
   if(dg>6) dg=6;
   return DoubleToString(v,dg)+suf;
  }

bool CalBuild()
  {
   string cur[]={"USD","EUR","GBP","JPY","AUD","CAD","CHF","NZD","CNY"};
   datetime st=TimeTradeServer();
   MqlDateTime dt;
   TimeToStruct(st,dt);
   datetime day0=st-(datetime)(dt.hour*3600+dt.min*60+dt.sec);
   datetime mon=day0-(datetime)(((dt.day_of_week+6)%7)*86400);      // Monday 00:00 (server time) of this week
   datetime from=mon, to=mon+7*86400;
   if(dt.day_of_week==0 || dt.day_of_week==6) to=mon+14*86400;     // weekend: also show next week so "next event" is never empty
   int off=BrTzOffset();
   string rows="";
   int cnt=0;
   bool hot=false;
   for(int c=0;c<ArraySize(cur) && cnt<450;c++)
     {
      MqlCalendarValue vals[];
      ResetLastError();
      int n=CalendarValueHistory(vals,from,to,NULL,cur[c]);
      if(n<=0) continue;
      for(int i=0;i<n && cnt<450;i++)
        {
         MqlCalendarEvent ev;
         if(!CalendarEventById(vals[i].event_id,ev)) continue;
         MqlCalendarCountry co;
         if(!CalendarCountryById(ev.country_id,co)) continue;
         string imp="";
         if(ev.type==CALENDAR_TYPE_HOLIDAY) imp="holiday";
         else if(ev.importance==CALENDAR_IMPORTANCE_HIGH) imp="high";
         else if(ev.importance==CALENDAR_IMPORTANCE_MODERATE) imp="medium";
         else if(ev.importance==CALENDAR_IMPORTANCE_LOW) imp="low";
         else continue;
         if(ev.type!=CALENDAR_TYPE_HOLIDAY && (ev.time_mode==CALENDAR_TIMEMODE_NOTIME || ev.time_mode==CALENDAR_TIMEMODE_TENTATIVE)) continue;   // no exact time: an alert would be a guess
         bool euCountry=(cur[c]=="EUR" && co.code!="EU");
         if(euCountry && (imp=="low" || imp=="holiday")) continue;   // keep the euro list readable: member-state noise only when it matters
         string a="",f="",p="";
         if(vals[i].HasActualValue())   a=CalFmt(vals[i].GetActualValue(),ev);
         if(vals[i].HasForecastValue()) f=CalFmt(vals[i].GetForecastValue(),ev);
         if(vals[i].HasRevisedValue())       p=CalFmt(vals[i].GetRevisedValue(),ev);
         else if(vals[i].HasPreviousValue()) p=CalFmt(vals[i].GetPreviousValue(),ev);
         if(imp!="holiday" && a=="" && vals[i].time>=st-1800 && vals[i].time<=st+180) hot=true;
         string nm=ev.name;
         if(euCountry) nm=co.code+" "+nm;
         if(StringLen(nm)>90) nm=StringSubstr(nm,0,90);
         long utc=(long)vals[i].time-(long)off;
         rows+=(cnt>0?",":"")+"{\"t\":\""+JEsc(nm)+"\",\"c\":\""+cur[c]+"\",\"s\":"+IntegerToString(utc)+",\"m\":\""+imp+"\",\"p\":\""+JEsc(p)+"\",\"f\":\""+JEsc(f)+"\",\"a\":\""+JEsc(a)+"\"}";
         cnt++;
        }
     }
   g_calHot=hot;
   if(cnt==0) return false;                      // calendar not synchronised yet / no data: keep what we had
   g_calJson="["+rows+"]";
   g_calHash=CalHash(g_calJson);
   return true;
  }

void CalTick()
  {
   if(MQLInfoInteger(MQL_TESTER)) return;
   int every=g_calHot?4:60;                      // fast only around a release, so Actual reaches the app within seconds
   if(g_calBuilt!=0 && TimeLocal()-g_calBuilt<every) return;
   g_calBuilt=TimeLocal();
   if(!CalBuild() && StringLen(g_calHash)==0) g_calBuilt=TimeLocal()-50;   // first data not ready: retry in ~10 s
  }

bool JDbl(const string seg,const string key,double &v)
  {
   v=0.0;
   string mk="\""+key+"\":";
   int a=StringFind(seg,mk);
   if(a<0) return false;
   int i=a+StringLen(mk);
   int L=StringLen(seg);
   string s="";
   while(i<L)
     {
      ushort c=StringGetCharacter(seg,i);
      if((c>='0' && c<='9') || c=='.' || c=='-' || c=='+' || c=='e' || c=='E') { s+=ShortToString(c); i++; }
      else break;
     }
   if(s=="") return false;
   v=StringToDouble(s);
   return true;
  }

bool BrSeen(const string id)
  {
   for(int i=0;i<ArraySize(g_brDone);i++) if(g_brDone[i]==id) return true;
   return false;
  }

void BrRemember(const string id)
  {
   int n=ArraySize(g_brDone);
   if(n>=40)
     {
      for(int i=1;i<n;i++) g_brDone[i-1]=g_brDone[i];
      n--;
     }
   ArrayResize(g_brDone,n+1);
   g_brDone[n]=id;
  }

void BrAckAdd(const string id)
  {
   int n=ArraySize(g_brAck);
   ArrayResize(g_brAck,n+1);
   g_brAck[n]=id;
   g_netAckWait=true;                   // v2.45: tells NetAllowed() that a result is waiting to leave
  }

//--- v2.14: Mini App command log (kept in memory + Yetimmm_<magic>_Commands.csv, sent to the app inside the state)
#define BR_CMD_MAX 25
#define CMD_HEADER "Time;Source;Id;Command;Details;Result;OK;Ts;State;WB;WS;Act"
string g_cmId[],g_cmCmd[],g_cmDet[],g_cmTxt[],g_cmSt[];
bool   g_cmOk[],g_cmAct[];
long   g_cmTs[];
double g_cmWB[],g_cmWS[];               // v2.17: levels of this command that still wait for the market (0 = none / resolved)
string g_cmJson="[]";
bool   g_cmDirty=true;

string CmdFile() { return "Yetimmm_"+IntegerToString(g_magic)+"_Commands.csv"; }

int BrCmdFind(const string id)
  {
   for(int i=ArraySize(g_cmId)-1;i>=0;i--) if(g_cmId[i]==id) return i;
   return -1;
  }

void BrCmdPush(const string id,const string cmd,const string det,const string txt,const bool ok,const long ts,
               const string st="",const double wb=0.0,const double ws=0.0,const bool act=false)
  {
   int n=ArraySize(g_cmId);
   if(n>=BR_CMD_MAX)
     {
      for(int i=1;i<n;i++)
        {
         g_cmId[i-1]=g_cmId[i]; g_cmCmd[i-1]=g_cmCmd[i]; g_cmDet[i-1]=g_cmDet[i]; g_cmTxt[i-1]=g_cmTxt[i]; g_cmOk[i-1]=g_cmOk[i]; g_cmTs[i-1]=g_cmTs[i];
         g_cmSt[i-1]=g_cmSt[i]; g_cmWB[i-1]=g_cmWB[i]; g_cmWS[i-1]=g_cmWS[i]; g_cmAct[i-1]=g_cmAct[i];
        }
      n--;
     }
   ArrayResize(g_cmId,n+1); ArrayResize(g_cmCmd,n+1); ArrayResize(g_cmDet,n+1);
   ArrayResize(g_cmTxt,n+1); ArrayResize(g_cmOk,n+1); ArrayResize(g_cmTs,n+1);
   ArrayResize(g_cmSt,n+1); ArrayResize(g_cmWB,n+1); ArrayResize(g_cmWS,n+1); ArrayResize(g_cmAct,n+1);
   g_cmId[n]=id; g_cmCmd[n]=cmd; g_cmDet[n]=det; g_cmTxt[n]=txt; g_cmOk[n]=ok; g_cmTs[n]=ts;
   g_cmSt[n]=(StringLen(st)>0)?st:(ok?"ok":"fail");
   g_cmWB[n]=wb; g_cmWS[n]=ws; g_cmAct[n]=act;
   g_cmDirty=true;
  }

//--- one line of the commands CSV (append-only): a later line with the same Id UPDATES the earlier one when the file is loaded
void BrCmdSave(const int i)
  {
   AppendLine(CmdFile(),CMD_HEADER,
              TimeToString((datetime)g_cmTs[i],TIME_DATE|TIME_SECONDS)+";MiniApp;"+Clean(g_cmId[i])+";"+Clean(g_cmCmd[i])+";"+Clean(g_cmDet[i])+";"+Clean(g_cmTxt[i])+";"+
              (g_cmOk[i]?"1":"0")+";"+IntegerToString(g_cmTs[i])+";"+g_cmSt[i]+";"+DoubleToString(g_cmWB[i],g_digits)+";"+DoubleToString(g_cmWS[i],g_digits)+";"+(g_cmAct[i]?"1":"0"));
  }

//--- v2.17: the level of this side if it is ACCEPTED but still waits for the market right now, else 0
double WaitLevelNow(const bool buy)
  {
   double lv;
   if(!SideDesired(buy,lv)) return 0.0;
   ulong tk; double ap;
   if(SideActual(buy,tk,ap)) return 0.0;
   string why;
   return (PlacementState(buy,lv,why)==1)?lv:0.0;
  }

void BrCmdAdd(const string id,const string cmd,const string det,const string result,const bool ok)
  {
   string one=result;
   StringReplace(one,"\n"," | ");
   StringReplace(one,"✅ ",""); StringReplace(one,"❌ ",""); StringReplace(one,"⚠️ ","");
   StringReplace(one,"ℹ️ ",""); StringReplace(one,"⏳ ",""); StringReplace(one,"✅",""); StringReplace(one,"❌","");
   if(StringLen(one)>140) one=StringSubstr(one,0,140);
   datetime now=TimeCurrent();
   //--- v2.17: an accepted command whose level waits for the market stays "wait" until it is activated / superseded / cancelled
   double wb=0.0,ws=0.0;
   if(ok && (cmd=="apply" || cmd=="settings" || cmd=="place" || cmd=="modify"))
     {
      wb=WaitLevelNow(true);
      ws=WaitLevelNow(false);
     }
   string st=!ok?"fail":((wb>0.0 || ws>0.0)?"wait":"ok");
   BrCmdPush(id,cmd,det,one,ok,(long)now,st,wb,ws,false);
   BrCmdSave(ArraySize(g_cmId)-1);
  }

//--- v2.17: one waiting side of a command is resolved. kind: 1 = activated, 2 = superseded by a newer level, 3 = cancelled
void BrWaitSide(const int i,const bool buy,const int kind,const string note)
  {
   if(buy) g_cmWB[i]=0.0; else g_cmWS[i]=0.0;
   if(kind==1) g_cmAct[i]=true;
   bool first=(StringFind(g_cmTxt[i],"Activated:")<0 && StringFind(g_cmTxt[i],"Superseded:")<0 && StringFind(g_cmTxt[i],"Cancelled:")<0);
   g_cmTxt[i]=first?note:g_cmTxt[i]+" | "+note;
   if(g_cmWB[i]<=0.0 && g_cmWS[i]<=0.0)
      g_cmSt[i]=g_cmAct[i]?"done":((kind==3)?"cancel":"sup");
   g_cmDirty=true;
   BrCmdSave(i);
  }

void BrWaitActivated(const bool buy,const double level,const ulong ticket,const ulong latMs)
  {
   for(int i=ArraySize(g_cmId)-1;i>=0;i--)
     {
      if(g_cmSt[i]!="wait") continue;
      double lv=buy?g_cmWB[i]:g_cmWS[i];
      if(lv>0.0 && PriceEq(lv,level))
         BrWaitSide(i,buy,1,"Activated: "+(buy?"Buy":"Sell")+" Stop #"+UL(ticket)+" @ "+PX(level)+" at "+TimeToString(TimeCurrent(),TIME_SECONDS)+
                         (latMs>0?" ("+UL(latMs)+" ms after the price reached the trigger)":""));
     }
  }

//--- v2.17: once per second: a waiting command whose level is no longer wanted is closed with the real reason
void BrWaitTrack()
  {
   int n=ArraySize(g_cmId);
   for(int i=0;i<n;i++)
     {
      if(g_cmSt[i]!="wait") continue;
      for(int k=0;k<2;k++)
        {
         bool b=(k==0);
         double lv0=b?g_cmWB[i]:g_cmWS[i];
         if(lv0<=0.0) continue;
         ulong tk; double ap;
         if(SideActual(b,tk,ap) && PriceEq(ap,lv0))
           { BrWaitSide(i,b,1,"Activated: "+(b?"Buy":"Sell")+" Stop #"+UL(tk)+" @ "+PX(lv0)+" at "+TimeToString(TimeCurrent(),TIME_SECONDS)); continue; }
         double lv;
         if(SideDesired(b,lv) && PriceEq(lv,lv0)) continue;             // still waiting
         bool stopped=(g_state==YT_STOPPED || g_state==YT_IDLE || g_state==YT_TP_RESET || g_mode==YM_NONE);
         BrWaitSide(i,b,stopped?3:2,stopped?"Cancelled: "+(b?"Buy":"Sell")+" Stop "+PX(lv0)+" (bot stopped / orders cancelled)"
                                           :"Superseded: "+(b?"Buy":"Sell")+" Stop "+PX(lv0)+" replaced by a newer level");
        }
     }
  }

void BrCmdLoad()
  {
   int h=FileOpen(CmdFile(),FILE_READ|FILE_TXT|FILE_ANSI|FILE_SHARE_READ|FILE_SHARE_WRITE);
   if(h==INVALID_HANDLE) return;
   bool first=true;
   while(!FileIsEnding(h))
     {
      string line=FileReadString(h);
      if(StringLen(line)==0) continue;
      if(first) { first=false; continue; }
      string f[];
      if(StringSplit(line,';',f)<8) continue;
      bool ok=(f[6]=="1");
      string st=(ArraySize(f)>=9 && StringLen(f[8])>0)?f[8]:(ok?"ok":"fail");
      double wb=(ArraySize(f)>=11)?StringToDouble(f[9]):0.0;
      double ws=(ArraySize(f)>=11)?StringToDouble(f[10]):0.0;
      bool act=(ArraySize(f)>=12 && f[11]=="1");
      int ix=BrCmdFind(f[2]);
      if(ix>=0)                                    // an UPDATE line of an earlier command
        {
         g_cmTxt[ix]=f[5]; g_cmSt[ix]=st; g_cmWB[ix]=wb; g_cmWS[ix]=ws; g_cmAct[ix]=act; g_cmOk[ix]=ok;
         g_cmDirty=true;
        }
      else BrCmdPush(f[2],f[3],f[4],f[5],ok,StringToInteger(f[7]),st,wb,ws,act);
     }
   FileClose(h);
  }

string BrCmdsJson()
  {
   if(!g_cmDirty) return g_cmJson;
   string out="[";
   int n=ArraySize(g_cmId);
   for(int i=n-1;i>=0;i--)                       // newest first
     {
      if(i<n-1) out+=",";
      out+="{\"id\":\""+JEsc(g_cmId[i])+"\",\"cmd\":\""+JEsc(g_cmCmd[i])+"\",\"det\":\""+JEsc(g_cmDet[i])+"\",\"text\":\""+JEsc(g_cmTxt[i])+
           "\",\"ok\":"+(g_cmOk[i]?"true":"false")+",\"st\":\""+g_cmSt[i]+"\",\"wb\":"+DoubleToString(g_cmWB[i],g_digits)+",\"ws\":"+DoubleToString(g_cmWS[i],g_digits)+
           ",\"ts\":"+IntegerToString(g_cmTs[i])+",\"t\":\""+TimeToString((datetime)g_cmTs[i],TIME_SECONDS)+"\"}";
     }
   out+="]";
   g_cmJson=out;
   g_cmDirty=false;
   return out;
  }

//--- short human description of a command's parameters, taken BEFORE it runs
string BrCmdDetail(const string cmd,const string seg)
  {
   double a,b,c,e,r;
   string d="";
   if(cmd=="apply" || cmd=="settings")
     {
      if(JDbl(seg,"buy",a))    d+="Buy "+PX(a);
      if(JDbl(seg,"sell",b))   d+=(d!=""?" / ":"")+"Sell "+PX(b);
      if(JDbl(seg,"risk",c))   d+=(d!=""?" / ":"")+"Risk $"+D2(c);
      if(JDbl(seg,"target",e)) d+=(d!=""?" / ":"")+"Target $"+D2(e);
      if(JDbl(seg,"rr",r))     d+=(d!=""?" / ":"")+"RR 1:"+DoubleToString(r,2);
      return d;
     }
   if(cmd=="modify" || cmd=="place")
     {
      if(JDbl(seg,"ticket",a)) d="#"+UL((ulong)a);
      string sd2=JStr(seg,"\"side\":\"");
      if(StringLen(sd2)>0) d=sd2+" Stop";
      if(JDbl(seg,"price",b)) d+=(d!=""?" @ ":"@ ")+PX(b);
      return d;
     }
   if(cmd=="delete")
     {
      string side=JStr(seg,"\"side\":\"");
      if(StringLen(side)>0) d=side+" Stop";
      if(JDbl(seg,"ticket",a)) d+=(d!=""?" ":"")+"#"+UL((ulong)a);
      return d;
     }
   return d;
  }

//--- the pending Stop orders that really exist on the server (the app shows them with a delete button)
string BrOrdersJson()
  {
   ulong od[];
   int n=OwnOrders(od);
   string out="[";
   int c=0;
   for(int i=0;i<n;i++)
     {
      if(!OrderSelect(od[i])) continue;
      long ty=OrderGetInteger(ORDER_TYPE);
      if(ty!=ORDER_TYPE_BUY_STOP && ty!=ORDER_TYPE_SELL_STOP) continue;
      if(c>0) out+=",";
      out+="{\"ticket\":"+UL(od[i])+",\"side\":\""+(ty==ORDER_TYPE_BUY_STOP?"BUY":"SELL")+"\",\"price\":"+DoubleToString(OrderGetDouble(ORDER_PRICE_OPEN),g_digits)+
           ",\"lot\":"+DoubleToString(OrderGetDouble(ORDER_VOLUME_CURRENT),2)+",\"sl\":"+DoubleToString(OrderGetDouble(ORDER_SL),g_digits)+
           ",\"tp\":"+DoubleToString(OrderGetDouble(ORDER_TP),g_digits)+"}";
      c++;
     }
   out+="]";
   return out;
  }

//--- v2.14: delete ONE pending Stop order of this bot from MT5. The wanted state is changed FIRST, so the
//--- synchroniser never re-creates it: BOTH -> the other side only; the last remaining order -> IDLE (like /cancel).
string ExecDeleteOrder(const ulong ticket,const string src)
  {
   ulong od[];
   int n=OwnOrders(od);
   bool mine=false;
   for(int i=0;i<n;i++) if(od[i]==ticket) { mine=true; break; }
   if(!mine || !OrderSelect(ticket)) return "❌ Order #"+UL(ticket)+" not found (already filled or deleted).";
   long ty=OrderGetInteger(ORDER_TYPE);
   bool isBuy=(ty==ORDER_TYPE_BUY_STOP), isSell=(ty==ORDER_TYPE_SELL_STOP);
   if(!isBuy && !isSell) return "❌ Only Buy Stop / Sell Stop orders can be deleted.";
   if(g_state!=YT_ARMED || g_mode==YM_NONE) return "❌ Order cannot be deleted in the current state ("+StateText()+").";
   double px=OrderGetDouble(ORDER_PRICE_OPEN);
   int oldMode=g_mode;
   int newMode=g_mode;
   if(g_mode==YM_BOTH) newMode=isBuy?YM_SELL:YM_BUY;
   else if((g_mode==YM_BUY && isBuy) || (g_mode==YM_SELL && isSell)) newMode=YM_NONE;
   g_mode=newMode;
   if(newMode==YM_NONE)
     {
      g_state=YT_IDLE;
      ulong ct[];
      if(g_fresh && OwnPositions(ct)==0) PromotePending();
     }
   SaveState();
   bool ok=DeleteOrder(ticket,src+" Delete");
   if(!ok)
     {
      g_mode=oldMode;
      g_state=YT_ARMED;
      SaveState();
      g_dirty=true;
      if(g_delFilled) return "❌ Order #"+UL(ticket)+" was already FILLED by MT5 - a position exists, nothing was deleted.";
      return "❌ Could not delete order #"+UL(ticket)+". See Journal.";
     }
   YLog("Order #"+UL(ticket)+" deleted by "+src);
   g_dirty=true;
   SyncAll();
   string modeTxt=(newMode==YM_NONE)?"IDLE (no pending orders left)":(newMode==YM_BUY?"BUY STOP only":"SELL STOP only");
   return "✅ ORDER DELETED\n"+(isBuy?"Buy Stop":"Sell Stop")+" #"+UL(ticket)+" @ "+PX(px)+"\nBot mode: "+modeTxt;
  }

//--- v2.19: delete a level that is still WAITING for the price (no ticket exists yet); a live order is deleted through ExecDeleteOrder
string ExecDeleteLevel(const bool isBuy,const string src)
  {
   if(g_state!=YT_ARMED || g_mode==YM_NONE) return "❌ Level cannot be deleted in the current state ("+StateText()+").";
   bool has=(g_mode==YM_BOTH || (isBuy && g_mode==YM_BUY) || (!isBuy && g_mode==YM_SELL));
   if(!has) return "❌ That level does not exist.";
   ulong tk=0; double ap=0.0;
   if(SideActual(isBuy,tk,ap)) return ExecDeleteOrder(tk,src);
   double px=isBuy?g_buyLevel:g_sellLevel;
   if(g_mode==YM_BOTH) g_mode=isBuy?YM_SELL:YM_BUY;
   else g_mode=YM_NONE;
   if(g_mode==YM_NONE) g_state=YT_IDLE;
   int s=SideIdx(isBuy);
   g_trig[s]=0.0; g_deferLvl[s]=0.0;
   SetSync(isBuy,YS_IDLE,"");
   SaveState();
   YLog("Waiting level deleted by "+src+": "+(isBuy?"Buy":"Sell")+" "+PX(px));
   g_dirty=true;
   SyncAll();
   return "✅ LEVEL DELETED\n"+(isBuy?"Buy Stop @ ":"Sell Stop @ ")+PX(px)+" (was waiting for the price)";
  }

//--- last closed trades (newest first), rebuilt only when the trade count changes
string BrHistJson()
  {
   if(g_st.total==g_brHistTotal) return g_brHistJson;
   string lines[];
   int n=ReadTradeLines(lines);
   string out="[";
   int cnt=0;
   for(int i=n-1;i>=0 && cnt<40;i--)
     {
      string f[];
      if(StringSplit(lines[i],';',f)<30) continue;
      string tm=f[22];
      int sp=StringFind(tm," ");
      if(sp>=0) tm=StringSubstr(tm,sp+1);
      if(cnt>0) out+=",";
      out+="{\"no\":"+IntegerToString(StringToInteger(f[0]))+",\"side\":\""+JEsc(f[5])+"\",\"entry\":"+DoubleToString(StringToDouble(f[7]),g_digits)+
           ",\"exit\":"+DoubleToString(StringToDouble(f[8]),g_digits)+",\"lot\":"+DoubleToString(StringToDouble(f[11]),2)+
           ",\"pnl\":"+DoubleToString(StringToDouble(f[18]),2)+",\"reason\":\""+JEsc(f[23])+"\",\"t\":\""+JEsc(tm)+"\",\"ts\":"+IntegerToString((long)StringToTime(f[22]))+"}";
      cnt++;
     }
   out+="]";
   g_brHistJson=out;
   g_brHistTotal=g_st.total;
   return out;
  }

//--- account-wide open volume (all open positions of the account) for the app's account card
double BrOpenVolume(int &cnt)
  {
   double v=0.0; cnt=0;
   for(int i=PositionsTotal()-1;i>=0;i--)
     {
      ulong tk=PositionGetTicket(i);
      if(tk==0) continue;
      v+=PositionGetDouble(POSITION_VOLUME); cnt++;
     }
   return v;
  }

//--- v2.23 live BrokerSpec -> Mini App (the EA is the authority; the Mini App never assumes contract / step / min / max / digits)
string JNum8(const double v) { return DoubleToString(v,8); }

string BsJson()
  {
   MqlTick t;
   double bid=0.0, ask=0.0;
   if(SymbolInfoTick(g_sym,t)) { bid=t.bid; ask=t.ask; }
   double tvl=AcM(SymbolInfoDouble(g_sym,SYMBOL_TRADE_TICK_VALUE_LOSS)), tvp=AcM(SymbolInfoDouble(g_sym,SYMBOL_TRADE_TICK_VALUE_PROFIT));   // v2.30: main units
   double vmin=SymbolInfoDouble(g_sym,SYMBOL_VOLUME_MIN), vmax=SymbolInfoDouble(g_sym,SYMBOL_VOLUME_MAX), vst=SymbolInfoDouble(g_sym,SYMBOL_VOLUME_STEP), vlm=SymbolInfoDouble(g_sym,SYMBOL_VOLUME_LIMIT);
   long stops=SymbolInfoInteger(g_sym,SYMBOL_TRADE_STOPS_LEVEL), frz=SymbolInfoInteger(g_sym,SYMBOL_TRADE_FREEZE_LEVEL);
   long exe=SymbolInfoInteger(g_sym,SYMBOL_TRADE_EXEMODE), fil=SymbolInfoInteger(g_sym,SYMBOL_FILLING_MODE), exm=SymbolInfoInteger(g_sym,SYMBOL_EXPIRATION_MODE), tm=SymbolInfoInteger(g_sym,SYMBOL_TRADE_MODE);
   double contract=SymbolInfoDouble(g_sym,SYMBOL_TRADE_CONTRACT_SIZE);
   //--- change detection: brokers may change these (news, session switch) - log it once, the next calculation already uses the new values
   string sig=JNum8(vmin)+"|"+JNum8(vmax)+"|"+JNum8(vst)+"|"+JNum8(vlm)+"|"+IntegerToString((int)stops)+"|"+IntegerToString((int)frz)+"|"+JNum8(tvl)+"|"+JNum8(contract)+"|"+IntegerToString((int)exe)+"|"+IntegerToString((int)exm)+"|"+IntegerToString((int)tm);
   if(sig!=g_bsSig)
     {
      if(StringLen(g_bsSig)>0) YLog("BrokerSpec changed: now "+sig+" | was "+g_bsSig);
      g_bsSig=sig;
     }
   string j="{\"vmin\":"+JNum8(vmin)+",\"vmax\":"+JNum8(vmax)+",\"vstep\":"+JNum8(vst)+",\"vlimit\":"+JNum8(vlm)+",\"vdig\":"+IntegerToString(g_lotDigits);
   j+=",\"contract\":"+JNum8(contract)+",\"tick\":"+JNum8(g_tick)+",\"tvl\":"+JNum8(tvl)+",\"tvp\":"+JNum8(tvp)+",\"point\":"+JNum8(g_point)+",\"digits\":"+IntegerToString(g_digits);
   j+=",\"stops\":"+IntegerToString((int)stops)+",\"freeze\":"+IntegerToString((int)frz)+",\"exe\":"+IntegerToString((int)exe)+",\"fill\":"+IntegerToString((int)fil)+",\"expm\":"+IntegerToString((int)exm)+",\"tmode\":"+IntegerToString((int)tm);
   j+=",\"ccy\":\""+JEsc(AccCcy())+"\",\"pccy\":\""+JEsc(SymbolInfoString(g_sym,SYMBOL_CURRENCY_PROFIT))+"\",\"hedge\":"+(AccountInfoInteger(ACCOUNT_MARGIN_MODE)==ACCOUNT_MARGIN_MODE_RETAIL_HEDGING?"true":"false");
   j+=",\"bid\":"+DoubleToString(bid,g_digits)+",\"ask\":"+DoubleToString(ask,g_digits)+",\"spr\":"+DoubleToString((ask>=bid&&bid>0.0)?ask-bid:0.0,g_digits)+",\"maxSpr\":"+IntegerToString(InpMaxSpread)+"}";
   return j;
  }

//--- the risk decision for the level the bot would trade next (Requested vs Effective risk, min risk, policy, status)
string RkJson()
  {
   if(g_buyLevel<=0.0 || g_sellLevel<=0.0 || g_buyLevel<=g_sellLevel) return "null";
   bool b=(g_mode!=YM_SELL);
   double lvl=b?g_buyLevel:g_sellLevel;
   SRiskResult r;
   RiskCompute(g_curRisk,b,lvl,SLPrice(b,lvl),r);
   string st="OK";
   if(!r.valid)
     {
      if(r.code=="RISK_BELOW_MIN_VOLUME") st="BELOW_MIN";
      else if(r.code=="RISK_ABOVE_MAX_VOLUME") st="ABOVE_MAX";
      else if(r.code=="RISK_ABOVE_VOLUME_LIMIT") st="ABOVE_LIMIT";
      else if(r.code=="RISK_NO_MARGIN") st="NO_MARGIN";
      else if(r.code=="RISK_ABOVE_RISKCAP" || r.code=="RISK_ABOVE_ACCCAP" || r.code=="RISK_ABOVE_DAYLOSS") st="ABOVE_CAP";   // v2.35
      else st="NO_SPEC";
     }
   else if(r.clamped) st="CLAMPED";
   string j="{\"side\":\""+(b?"BUY":"SELL")+"\",\"req\":"+D2(r.requested)+",\"raw\":"+JNum8(r.rawVol)+",\"vol\":"+JNum8(r.vol)+",\"vmin\":"+JNum8(r.minVol)+",\"eff\":"+D2(r.effective)+",\"minRisk\":"+D2(r.minRisk)+",\"perLot\":"+D2(r.perLot);
   j+=",\"margin\":"+D2(r.margin)+",\"policy\":\""+r.policy+"\",\"status\":\""+st+"\",\"clamped\":"+(r.clamped?"true":"false")+",\"ccy\":\""+JEsc(AccCcy())+"\"}";
   return j;
  }

string BrStateJson()
  {
   string s="{";
   bool frz=(g_state==YT_STOPPED);
   if(!frz) { g_frzBid=0.0; g_frzAsk=0.0; g_frzTs=0; }
   else if(g_frzBid<=0.0) { g_frzBid=SymbolInfoDouble(g_sym,SYMBOL_BID); g_frzAsk=SymbolInfoDouble(g_sym,SYMBOL_ASK); g_frzTs=(long)TimeCurrent(); }
   s+="\"price\":"+DoubleToString(frz?g_frzBid:SymbolInfoDouble(g_sym,SYMBOL_BID),g_digits);
   s+=",\"ask\":"+DoubleToString(frz?g_frzAsk:SymbolInfoDouble(g_sym,SYMBOL_ASK),g_digits)+",\"minDist\":"+DoubleToString(SymbolInfoInteger(g_sym,SYMBOL_TRADE_STOPS_LEVEL)*SymbolInfoDouble(g_sym,SYMBOL_POINT),g_digits);
   s+=",\"run\":"+(g_state==YT_STOPPED?"false":"true");
   s+=",\"frz\":"+(frz?"true":"false")+",\"frzT\":"+IntegerToString(g_frzTs);
   s+=",\"state\":\""+StateText()+"\"";
   string msg=g_blockReason;
   if(StringLen(msg)==0) msg=WaitNote();
   s+=",\"msg\":\""+JEsc(msg)+"\"";
   s+=",\"ver\":\""+YT_VER+"\",\"proto\":2,\"evp\":1,\"sym\":\""+JEsc(g_sym)+"\",\"waits\":"+WaitsJson();
   s+=",\"tick\":"+DoubleToString(g_tick,g_digits)+",\"pt\":"+DoubleToString(g_point,g_digits);   // symbol precision: the Worker matches order alerts with 3 ticks / Max Deviation, never a % of price
   s+=",\"mt\":{\"conn\":"+(TerminalInfoInteger(TERMINAL_CONNECTED)?"true":"false")+",\"auto\":"+(TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)?"true":"false")+
      ",\"exp\":"+(MQLInfoInteger(MQL_TRADE_ALLOWED)?"true":"false")+",\"acc\":"+(AccountInfoInteger(ACCOUNT_TRADE_ALLOWED)?"true":"false")+
      ",\"ea\":"+(AccountInfoInteger(ACCOUNT_TRADE_EXPERT)?"true":"false")+",\"tm\":"+(SymbolInfoInteger(g_sym,SYMBOL_TRADE_MODE)==SYMBOL_TRADE_MODE_FULL?"true":"false")+
      ",\"ping\":"+IntegerToString((int)(TerminalInfoInteger(TERMINAL_PING_LAST)/1000))+"}";
   s+=",\"mode\":\""+(g_mode==YM_BOTH?"BOTH":(g_mode==YM_BUY?"BUY":(g_mode==YM_SELL?"SELL":"NONE")))+"\"";
   s+=",\"buy\":"+DoubleToString(g_buyLevel,g_digits)+",\"sell\":"+DoubleToString(g_sellLevel,g_digits);
   s+=",\"risk\":"+D2(g_initRisk)+",\"cur\":"+D2(g_curRisk)+",\"acc\":"+D2(g_accLoss);
   s+=",\"cyc\":{\"id\":"+IntegerToString((int)g_cycId)+",\"net\":"+D2(g_cycNet)+",\"rem\":"+D2(MathMax(g_target-g_cycNet,0.0))+",\"loss\":"+D2(g_cycLosses)+",\"n\":"+IntegerToString(g_cycTrades)+",\"st\":\""+CycStateText()+"\"}";   // v2.38
   s+=",\"rstStart\":"+(InpResetRiskOnStart?"true":"false");   // v2.29: the app warns that START after STOP clears the loss when this is on
   s+=",\"seq\":"+IntegerToString(g_seq)+",\"no\":"+IntegerToString(g_tradeNo);
   s+=",\"target\":"+D2(g_target)+",\"rr\":"+DoubleToString(g_rr,2);
   s+=",\"maxDev\":"+IntegerToString(g_maxDev)+",\"warn\":"+IntegerToString(g_warn);
   s+=",\"breach\":\""+((!YT_REAL_ORDERS_ONLY && InpBreachPolicy==BREACH_MARKET)?"MARKET":"WAIT")+"\",\"entry\":\""+((YT_REAL_ORDERS_ONLY || InpEntryMode==ENTRY_PENDING)?"PENDING":"VIRTUAL")+"\"";
   s+=",\"wcode\":\""+(frz?"":g_wcode)+"\",\"bs\":"+BsJson()+",\"rk\":"+RkJson();
   s+=",\"rec\":"+(g_recHold?"{\"hold\":true,\"why\":\""+JEsc(g_recWhy)+"\"}":"null");      // v4.30: REQUIRED_RECOVERY is shown to the user, not only logged / sent to Telegram
   s+=",\"spread\":"+IntegerToString((int)SymbolInfoInteger(g_sym,SYMBOL_SPREAD));
   if(g_fresh && g_pendBuy>0.0 && g_pendSell>0.0)
      s+=",\"pend\":{\"buy\":"+DoubleToString(g_pendBuy,g_digits)+",\"sell\":"+DoubleToString(g_pendSell,g_digits)+",\"risk\":"+D2(g_initRisk)+",\"target\":"+D2(g_target)+",\"rr\":"+DoubleToString(g_rr,2)+"}";
   else s+=",\"pend\":null";
   ulong tk,pid; bool buy; double vol,entry,sl,tp,pr;
   if(OwnPosInfo(tk,pid,buy,vol,entry,sl,tp,pr))
      s+=",\"pos\":{\"pid\":"+IntegerToString((long)pid)+",\"side\":\""+(buy?"BUY":"SELL")+"\",\"entry\":"+DoubleToString(entry,g_digits)+",\"sl\":"+DoubleToString(sl,g_digits)+",\"tp\":"+DoubleToString(tp,g_digits)+
         ",\"lot\":"+DoubleToString(vol,g_lotDigits)+",\"est\":"+D2(vol*PerLotLossSL(buy,entry,sl))+",\"risk\":"+D2(PGV(pid,"R",g_curRisk))+
         ",\"no\":"+IntegerToString((long)PGV(pid,"N",0))+",\"profit\":"+D2(pr)+"}";
   else s+=",\"pos\":null";
   s+=",\"hist\":"+BrHistJson();
   s+=",\"orders\":"+BrOrdersJson();
   s+=",\"cmds\":"+BrCmdsJson();
   double pf=(g_st.totLoss>1e-9)?g_st.totProfit/g_st.totLoss:(g_st.totProfit>0?99.0:0.0);
   s+=",\"stats\":{\"total\":"+IntegerToString((int)g_st.total)+",\"wins\":"+IntegerToString((int)g_st.wins)+",\"losses\":"+IntegerToString((int)g_st.losses)+",\"net\":"+D2(g_st.net)+
      ",\"buys\":"+IntegerToString((int)g_st.buys)+",\"sells\":"+IntegerToString((int)g_st.sells)+",\"gp\":"+D2(g_st.totProfit)+",\"gl\":"+D2(g_st.totLoss)+
      ",\"avgW\":"+D2(g_st.avgProfit)+",\"avgL\":"+D2(g_st.avgLoss)+",\"maxW\":"+D2(g_st.maxProfit)+",\"maxL\":"+D2(g_st.maxLoss)+",\"pf\":"+D2(pf)+
      ",\"streak\":"+IntegerToString((int)g_st.streak)+",\"comm\":"+D2(g_st.commission)+",\"swap\":"+D2(g_st.swap)+",\"vol\":"+DoubleToString(g_st.volume,g_lotDigits)+
      ",\"hiRisk\":"+D2(g_st.highRisk)+",\"hiLot\":"+DoubleToString(g_st.highLot,g_lotDigits)+"}";
   s+=",\"acct\":{\"bal\":"+D2(AcM(AccountInfoDouble(ACCOUNT_BALANCE)))+",\"eq\":"+D2(AcM(AccountInfoDouble(ACCOUNT_EQUITY)))+",\"mg\":"+D2(AcM(AccountInfoDouble(ACCOUNT_MARGIN)))+
      ",\"fm\":"+D2(AcM(AccountInfoDouble(ACCOUNT_MARGIN_FREE)))+",\"fl\":"+D2(AcM(AccountInfoDouble(ACCOUNT_PROFIT)))+",\"lev\":"+IntegerToString((int)AccountInfoInteger(ACCOUNT_LEVERAGE))+
      ",\"cur\":\""+JEsc(AccCcy())+"\",\"login\":"+IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN))+",\"srv\":\""+JEsc(AccountInfoString(ACCOUNT_SERVER))+"\"";
   int npos=0; double ovol=BrOpenVolume(npos);
   s+=",\"ovol\":"+DoubleToString(ovol,g_lotDigits)+",\"np\":"+IntegerToString(npos)+",\"ml\":"+D2(AccountInfoDouble(ACCOUNT_MARGIN_LEVEL))+"}";
   if(StringLen(g_brLastId)>0)
      s+=",\"lastCmd\":{\"id\":\""+JEsc(g_brLastId)+"\",\"ok\":"+(g_brLastOk?"true":"false")+",\"text\":\""+JEsc(g_brLastText)+"\"}";
   s+="}";
   return s;
  }

//--- executes ONE command through the existing Telegram-command functions
string BrExec(const string cmd,const string seg)
  {
   ulong tk[];
   if(cmd=="start") return DoStart("MiniApp");
   if(cmd=="stop")
     {
      bool d=ExecStop(2,0);
      return StopResultText(d);
     }
   if(cmd=="close")
     {
      if(OwnPositions(tk)==0) return "ℹ️ No open Yetimmm position.";
      bool p=CleanupPositions(3);
      CheckClosures();
      g_dirty=true;
      return p?"✅ Open position closed.":"❌ Could not close the open position.";
     }
   if(cmd=="delete")
     {
      double tkd;
      if(!JDbl(seg,"ticket",tkd) || tkd<=0.0)
        {
         string sdl=JStr(seg,"\"side\":\"");
         StringToUpper(sdl);
         if(sdl!="BUY" && sdl!="SELL") return "❌ Invalid command: order ticket or side missing.";
         return ExecDeleteLevel(sdl=="BUY","MiniApp");
        }
      return ExecDeleteOrder((ulong)tkd,"MiniApp");
     }
   if(cmd=="delpend")
     {
      if(!(g_pendBuy>0.0 && g_pendSell>0.0)) return "ℹ️ No queued order to delete.";
      g_pendBuy=0.0; g_pendSell=0.0;
      SaveState();
      g_dirty=true;
      return "✅ Queued order deleted.";
     }
   if(cmd=="cancel")
     {
      if(g_state==YT_STOPPED)
        {
         //--- fix15: a STOPPED bot with an open debt could never be ended from the app. Cancel now ends the cycle (ledger zeroed) when nothing of the EA is left.
         ulong sp[],so[];
         if(OwnPositions(sp)>0 || OwnOrders(so)>0) return "ℹ️ Bot is stopped - close the open trade / orders first (or use CLOSE), then Cancel ends the cycle.";
         GS("CANCELEND",(double)TimeLocal());
         if(CancelEndTry("MiniApp CANCEL (stopped)")) { g_dirty=true; SyncAll(); return "🛑 CYCLE ENDED: ledger zeroed, accumulated loss 0. Send levels to start a new cycle from zero."; }
         return "⏳ Cycle ends as soon as the last closed trade is booked.";
        }
      string r=ExecCancel(false);
      g_dirty=true; SyncAll();
      return r;
     }
   if(cmd=="modify" || cmd=="place")
     {
      double tkm=0.0, px=0.0;
      if(!JDbl(seg,"price",px) || px<=0.0) return "❌ Invalid command: price missing.";
      if(g_state!=YT_ARMED) return "❌ Orders can be changed only while the bot is ARMED (state: "+StateText()+").";
      bool isBuy;
      if(cmd=="modify")
        {
         bool hasTk=(JDbl(seg,"ticket",tkm) && tkm>0.0);
         if(!hasTk)
           {
            string sdm=JStr(seg,"\"side\":\"");
            StringToUpper(sdm);
            if(sdm!="BUY" && sdm!="SELL") return "❌ Invalid command: order ticket or side missing.";
            isBuy=(sdm=="BUY");
            if(WaitLevelNow(isBuy)<=0.0) return "❌ That level is not waiting (it is a live order - use its ticket).";
           }
         else
           {
            if(!OrderSelect((ulong)tkm)) return "❌ Order not found (already filled or deleted).";
            long ty=OrderGetInteger(ORDER_TYPE);
            if(ty!=ORDER_TYPE_BUY_STOP && ty!=ORDER_TYPE_SELL_STOP) return "❌ Only Buy Stop / Sell Stop orders can be modified.";
            isBuy=(ty==ORDER_TYPE_BUY_STOP);
           }
        }
      else
        {
         string sd=JStr(seg,"\"side\":\"");
         StringToUpper(sd);
         if(sd!="BUY" && sd!="SELL") return "❌ Invalid command: side must be BUY or SELL.";
         isBuy=(sd=="BUY");
         if(g_mode==YM_BOTH) return "❌ Both orders already exist - use Modify.";
         if(g_mode==YM_NONE) return "❌ No active order set - press Start (restores both orders) or use Apply.";
         if((isBuy && g_mode==YM_BUY) || (!isBuy && g_mode==YM_SELL)) return "❌ That order already exists - use Modify.";
        }
      double nb=isBuy?px:g_buyLevel, ns=isBuy?g_sellLevel:px;
      string er="";
      if(!ApplyLevels(nb,ns,0.0,"MiniApp",er)) return "❌ Invalid Price Configuration: "+er;
      if(g_fresh && g_pendBuy>0.0 && g_pendSell>0.0) return LevelsAcceptedText();   // sequence locked: the change is only PENDING, say so honestly
      if(cmd=="place") { g_mode=YM_BOTH; SaveState(); }
      GS("LVSRC",1.0);
      g_nextPlaceMs=0; ResetSyncBackoff(); SyncAll(); g_dirty=true;
      return (cmd=="place"?"✅ ORDER ADDED\n":"✅ ORDER MODIFIED\n")+(isBuy?"Buy Stop @ ":"Sell Stop @ ")+PX(px);
     }
   if(cmd=="reset")
     {
      if(OwnPositions(tk)>0) return "❌ Cannot reset the risk sequence while a position is open.";
      //--- v2.43: an open debt is cleared ONLY by an explicit, CONFIRMED command (the app asks twice and sends confirm=1). A bare reset never wipes it.
      double cfm=0.0;
      bool hasDebt=(g_accLoss>1e-9 || MathAbs(g_cycNet)>1e-9 || g_seq>0);
      if(hasDebt && !(JDbl(seg,"confirm",cfm) && cfm>0.5))
        {
         LogOrder("RESET_REFUSED",-1,0.0,0.0,0,0,"reset without confirmation refused: Acc.Loss "+D2(g_accLoss)+" Seq "+IntegerToString(g_seq));
         return "❌ RESET REFUSED: the cycle holds a debt (Acc.Loss "+D2(g_accLoss)+" "+AccCcy()+", Seq "+IntegerToString(g_seq)+"). Clearing it needs the explicit confirmed Reset / New Cycle from the Mini App. Nothing was changed.";
        }
      ResetRiskLogged("Mini App RESET (confirmed)");
      GS("CYCDAY",0.0);                                          // v2.34: an explicit reset / new cycle overrides the one-cycle-per-day lock
      g_nextPlaceMs=0;
      ResetSyncBackoff();
      SaveState();
      SyncAll();
      g_dirty=true;
      return "✅ Risk sequence reset.";
     }
   if(cmd=="apply" || cmd=="settings")
     {
      double b,s,r,tg,rr;
      bool hb=JDbl(seg,"buy",b), hs=JDbl(seg,"sell",s), hr=JDbl(seg,"risk",r), ht=JDbl(seg,"target",tg), hrr=JDbl(seg,"rr",rr);
      if(cmd=="apply" && (!hb || !hs)) return "❌ Invalid command: buy/sell missing.";
      double nt=ht?tg:g_target, nrr=hrr?rr:g_rr;
      if(!MathIsValidNumber(nt) || nt<0.0)   return "❌ Recovery Target must be zero or positive.";
      if(!MathIsValidNumber(nrr) || nrr<=0.0) return "❌ Risk/Reward must be greater than zero.";
      bool tradeChanged=(MathAbs(nt-g_target)>1e-9 || MathAbs(nrr-g_rr)>1e-9);
      if(tradeChanged && OwnPositions(tk)>0) return "❌ Recovery Target / Risk-Reward cannot change while a Yetimmm position is open.";
      double oldT=g_target, oldR=g_rr;
      g_target=nt; g_rr=nrr;
      string err="";
      string res="";
      if(hb && hs)
        {
         if(!ApplyLevels(b,s,(hr?r:0.0),"MiniApp",err))
           {
            g_target=oldT; g_rr=oldR;
            return "❌ Invalid Price Configuration: "+err;
           }
         GS("LVSRC",1.0);
         res=LevelsAcceptedText();
        }
      else res="✅ Settings updated.";
      if(tradeChanged)
        {
         g_curRisk=NextRiskForNet(g_cycNet);
         g_nextPlaceMs=0;
         ResetSyncBackoff();
         CfgPutAll();
         CfgSaveFile();
         SaveState();
         SyncAll();
        }
      g_dirty=true;
      return res;
     }
   return "❌ Unknown command: "+cmd;
  }

void BridgeSync()
  {
   if(!InpBrEnable || MQLInfoInteger(MQL_TESTER)) return;
   //--- v4.31.1 fix8: the gate is the connection STATE, not a raw length test. An EA that started with an empty / invalid URL must reach the re-read below
   //--- (an early `return` on the empty URL used to make the recovery code unreachable). The cfg file is re-read at most every 5 s, silently.
   if(g_brState==BR_CONFIG_INVALID || g_brState==BR_CONFIG_LOADING)
     {
      if(TimeLocal()-g_brLast<5) return;
      g_brLast=TimeLocal();
      LoadAutoConfig(true);
      string cfgWhy=BrConfigProblem();
      if(cfgWhy!="")
        {
         if(g_brErrLog==0 || TimeLocal()-g_brErrLog>=60) { g_brErrLog=TimeLocal(); YLog("Mini App bridge: still CONFIG_INVALID - "+cfgWhy+" (settings are re-checked every 5 s; no restart needed once fixed)."); }
         return;
        }
      g_brErrLog=0;
      BrSetState(BR_CONFIG_READY,g_brUrl);
      g_brLast=0;                                          // the first sync starts right away
     }
   if(StringLen(g_brUrl)<12 || StringLen(BrKeyEff())<8) { BrSetState(BR_CONFIG_INVALID,BrConfigProblem()); return; }   // defensive: settings lost at runtime
   if(TimeLocal()-g_brLast<BrRetryDelaySec()) return;   // v4.31.1: normal poll, or exponential back-off (1,2,4,8,10 s) while the Worker is unreachable
   g_brLast=TimeLocal();
   if(g_brState==BR_CONFIG_READY) BrSetState(BR_CONNECTING,"first sync");

   if(!g_brCvLoaded) { g_brCv=(int)StringToInteger(CfgGet("brcv","0")); g_brCvLoaded=true; }
   if(!g_brPairLoaded) { g_brPairNeed=(CfgGet("brpaired","0")!="1"); g_brPairLoaded=true; }
   //--- v2.20: broker time offset every sync; calendar hash every sync; full table only when it changed / was requested
   CalTick();
   string calPart=",\"tzo\":"+IntegerToString(BrTzOffset());
   bool   calSending=false;
   string calHashSent=g_calHash;
   if(StringLen(g_calHash)>0)
     {
      calPart+=",\"calv\":\""+g_calHash+"\"";
      if(g_calHash!=g_calSent || g_calNeed) { calPart+=",\"cal\":"+g_calJson; calSending=true; }
     }
   string body="{\"login\":\""+IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN))+"\",\"srv\":\""+JEsc(AccountInfoString(ACCOUNT_SERVER))+"\",\"fresh\":"+(g_brFresh?"true":"false")+",\"reset\":"+(InpBrResetPw?"true":"false")+",\"cv\":"+IntegerToString(g_brCv)+calPart+",\"inst\":\""+g_instId+"\",\"state\":"+BrStateJson()+",\"ack\":[";
   for(int i=0;i<ArraySize(g_brAck);i++) body+=(i>0?",":"")+"\""+g_brAck[i]+"\"";
   body+="],\"ev\":"+EvJson()+",\"net\":"+BrNetJson()+"}";
   string url=g_brUrl;
   while(StringLen(url)>0 && StringSubstr(url,StringLen(url)-1,1)=="/") url=StringSubstr(url,0,StringLen(url)-1);
   url+="/api/ea/sync";

   char data[],res[];
   string rh;
   int n=StringToCharArray(body,data,0,WHOLE_ARRAY,CP_UTF8);
   if(n>0) ArrayResize(data,n-1);
   ResetLastError();
   string hdr="Content-Type: application/json\r\nX-EA-Secret: "+BrKeyEff()+"\r\n";
   string pairCode=g_brPair;
   StringTrimLeft(pairCode); StringTrimRight(pairCode);
   if(g_brPairNeed && StringLen(pairCode)>0) hdr+="X-EA-Pair: "+pairCode+"\r\n";   // sent ONLY until the Worker confirmed the pairing (and again if it ever asks for it)
   g_brNetMs=GetTickCount64();           // v2.45.1: the bridge's own allowance restarts from the moment a request really leaves
   int code=WebRequest("POST",url,hdr,NetTimeout(),data,res,rh);
   if(code==-1)
     {
      int e=GetLastError();
      //--- v4.31.1: a network failure is RECOVERABLE (retry with back-off, never gives up); 4014 is a settings problem and is explained once per minute
      if(e==4014)
        {
         BrFail("wr4014",0,"WebRequest error 4014 - tick 'Allow WebRequest for listed URL' and add: "+AllowUrlsHint()+" (Tools > Options > Expert Advisors; shortcut: close MT5 and run tools\\allow-urls.bat)");
         AllowUrlsAlertOnce();
        }
      else BrFail("wr"+IntegerToString(e),0,"WebRequest failed (MT5 error "+IntegerToString(e)+"; internet down / timeout / DNS)");
      return;
     }
   string resp=CharArrayToString(res,0,WHOLE_ARRAY,CP_UTF8);
   if(code!=200 || StringFind(resp,"\"ok\":true")<0)
     {
      g_brOk=false;
      string werr=JStr(resp,"\"error\":\"");
      bool explainNow=(g_brFails==0 || g_brErrLog==0 || TimeLocal()-g_brErrLog>=60);   // decided BEFORE BrFail() refreshes the log clock
      BrFail((werr!="")?werr:"http"+IntegerToString(code),code,"HTTP "+IntegerToString(code)+((werr!="")?" '"+werr+"'":""));   // v4.31.1: state + counters + first-failure log
      if(werr=="secret" || werr=="pair_required") g_brPairNeed=true;       // the Worker does not know this EA's secret: present the pairing code on the next sync
      if(explainNow)
        {
         if(werr=="pair_required")     YLog("Mini App bridge: this MT5 account is NOT PAIRED yet - run `npm run setup` (or set InpBrPairCode to the Worker secret PAIR_CODE (or the app password if PAIR_CODE is not set).");
         else if(werr=="pair_bad")     YLog("Mini App bridge: pairing code REJECTED - the pairing code must equal the Worker secret PAIR_CODE (or APP_PASSWORD when PAIR_CODE is not set).");
         else if(werr=="pair_locked")  YLog("Mini App bridge: too many wrong pairing codes - pairing is locked for a few minutes.");
         else if(werr=="secret")       YLog(StringLen(pairCode)>0?"Mini App bridge: this account is bound to another EA install - re-pairing with InpBrPairCode.":"Mini App bridge: this account is bound to another EA install (or the EA settings file was lost) - set InpBrPairCode to re-pair.");
         else if(werr=="pair_not_configured") YLog("Mini App bridge: HTTP 503 pair_not_configured - the Worker has no PAIR_CODE. Deploy worker/wrangler.toml (it now carries PAIR_CODE) or run: npx wrangler secret put PAIR_CODE  (value must equal InpBrPairCode).");
         else if(werr=="not_configured")    YLog("Mini App bridge: HTTP 503 not_configured - the Worker has no APP_PASSWORD secret (npx wrangler secret put APP_PASSWORD).");
         else if(werr!="")                  YLog("Mini App bridge: HTTP "+IntegerToString(code)+" - Worker answered '"+werr+"'.");
         else if(code==404)                 YLog("Mini App bridge: HTTP 404 - Worker URL is wrong (check the Worker URL: "+UrlOrigin(g_brUrl)+").");
         else YLog("Mini App bridge: HTTP "+IntegerToString(code)+" (Worker not deployed / Worker error - open "+UrlOrigin(g_brUrl)+"/ in a browser: it must answer {\"ok\":true})");
        }
      return;
     }
   BrSuccess();                         // v4.31.1: CONNECTED only now - after a verified "ok":true answer (and the outage report is closed)
   //--- v2.21 pairing: the Worker mints the EA secret (CSPRNG) when the pairing code is accepted; store it and stop sending the code
   string mintedSecret=JStr(resp,"\"es\":\"");
   if(StringLen(mintedSecret)>=32)
     {
      g_brSec=mintedSecret;
      CfgSet("brsec",mintedSecret);
      CfgSet("brpaired","1");
      CfgSaveFile();
      g_brPairNeed=false;
      YLog("Mini App bridge: account PAIRED - a private secret issued by the Worker is stored (the pairing code is no longer sent).");
     }
   else if(g_brPairNeed && StringFind(resp,"\"paired\":true")>=0)
     {
      CfgSet("brpaired","1");
      CfgSaveFile();
      g_brPairNeed=false;
     }
   //--- v2.29: the Worker sees EVERY copy that syncs this account (another PC / VPS included). dupInst = another live copy owns the account.
   //--- This copy stops trading at once, executes no command (the Worker sends none) and halts for good if it lasts YT_DUP_HALT_SEC.
   if(StringFind(resp,"\"dupInst\":true")>=0)
     {
      if(g_dupSince==0)
        {
         g_dupSince=TimeLocal();
         YLog("SECOND COPY SUSPECTED: the Worker reports another live Yetimmm copy for account "+IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN))+" (another PC / VPS / terminal). Trading is paused here.");
         RaiseAlert("DUPINST","Another Yetimmm copy is running on this account (another PC / VPS?). THIS copy paused trading and will halt in "+IntegerToString(YT_DUP_HALT_SEC)+" s unless the other copy stops. Keep ONE copy only.",true,true);
        }
      else if(TimeLocal()-g_dupSince>=YT_DUP_HALT_SEC)
        {
         g_halt=true;
         string hm="Yetimmm: another live copy owns this account (reported by the Worker for "+IntegerToString(YT_DUP_HALT_SEC)+"+ s). THIS copy is halted and sends nothing. Remove it from the chart / VPS.";
         YLog("SECOND COPY CONFIRMED: "+hm);
         Alert(hm);
        }
      return;
     }
   if(g_dupSince>0) { YLog("The other copy is gone: trading resumes on this copy."); g_dupSince=0; ClearAlert("DUPINST"); g_dirty=true; }
   g_brFresh=false;
   ArrayResize(g_brAck,0);              // the acks in this request were delivered
   g_netAckWait=false;
   EvAckFrom(resp);                     // v2.23: events the Worker accepted (or already had) leave the outbox
   if(calSending) { g_calSent=calHashSent; g_calNeed=false; }
   if(StringFind(resp,"\"calNeed\":true")>=0) g_calNeed=true;   // the Worker lost / never had the table: send it on the next sync

   //--- v2.19b: Telegram Bot Token / Chat IDs pushed by the Worker (no manual entry, survives restarts)
   int fpos=StringFind(resp,"\"cfg\":{");
   if(fpos>=0)
     {
      string cs=StringSubstr(resp,fpos);
      int ce=StringFind(cs,"\"commands\":");
      if(ce>0) cs=StringSubstr(cs,0,ce);
      string nTok=JStr(cs,"\"tok\":\"");
      string nAuth=JStr(cs,"\"auth\":\"");
      int nV=(int)StringToInteger(JStr(cs,"\"v\":\""));
      if(nV>0 && nV!=g_brCv)
        {
         bool tokChanged=(nTok!=g_tgTok);
         g_tgTok=InpTgViaWorker?"":nTok;
         g_tgAuth=nAuth;
         ParseIds();
         if(tokChanged)
           {
            GlobalVariableDel(GN("TGINIT"));
            g_tgOk=false;
           }
         g_brCv=nV;
         if(StringLen(nTok)>0 || InpTgViaWorker) { g_brShared=true; g_brSharedLoaded=true; CfgSet("brshared","1"); }
         CfgPutAll();
         CfgSet("brcv",IntegerToString(nV));
         CfgSaveFile();
         g_dirty=true;
         YLog("Telegram config received from the Worker (v"+IntegerToString(nV)+") | token "+(StringLen(g_tgTok)>0?"set":"empty")+" | chat IDs "+IntegerToString(ArraySize(g_tgIds)));
        }
     }

   int cpos=StringFind(resp,"\"commands\":");
   if(cpos<0) { g_brFirst=false; return; }
   string sub=StringSubstr(resp,cpos);
   string marker="\"id\":\"";
   int mlen=StringLen(marker);
   int p=0;
   int discarded=0;
   while(true)
     {
      int a=StringFind(sub,marker,p);
      if(a<0) break;
      int b=StringFind(sub,marker,a+mlen);
      string seg=(b<0)?StringSubstr(sub,a):StringSubstr(sub,a,b-a);
      p=a+mlen;
      string id=JStr(seg,marker);
      string cmd=JStr(seg,"\"cmd\":\"");
      StringToLower(cmd);
      if(StringLen(id)==0) continue;
      if(g_brFirst || BrSeen(id))
        {
         if(g_brFirst) discarded++;
         BrAckAdd(id);                  // never execute twice / never execute what piled up while the EA was off
         continue;
        }
      BrRemember(id);
      double cage=0.0;
      if(InpCmdTtlSec>0 && JDbl(seg,"age",cage) && cage>(double)InpCmdTtlSec)
        {
         //--- v2.23 COMMAND TTL: an old command is EXPIRED - acked, never executed, and the app is told
         YLog("Mini App Command EXPIRED (age "+DoubleToString(cage,0)+" s > "+IntegerToString(InpCmdTtlSec)+" s): "+cmd);
         g_brLastId=id; g_brLastOk=false; g_brLastText="Command expired - not executed. Please try again.";
         BrCmdAdd(id,cmd,"","⌛ EXPIRED (age "+DoubleToString(cage,0)+" s) - not executed",false);
         BrAckAdd(id);
         continue;
        }
      string sigNow=cmd+"|"+BrCmdDetail(cmd,seg);
      if((cmd=="apply" || cmd=="modify" || cmd=="place" || cmd=="delete" || cmd=="settings" || cmd=="start" || cmd=="stop" || cmd=="close" || cmd=="reset" || cmd=="cancel" || cmd=="delpend") && sigNow==g_brSig && GetTickCount64()-g_brSigMs<3000)
        {
         YLog("Mini App Command ignored (duplicate within 3 s): "+cmd);
         BrAckAdd(id);
         continue;
        }
      g_brSig=sigNow; g_brSigMs=GetTickCount64();
      YLog("Mini App Command Received: "+cmd);
      string det=BrCmdDetail(cmd,seg);
      string result=BrExec(cmd,seg);
      YLog("Mini App Command Result: "+result);
      g_brLastId=id;
      g_brLastOk=(StringFind(result,"❌")<0);
      BrCmdAdd(id,cmd,det,result,g_brLastOk);        // v2.14: the command appears in the app's log
      string one=result;
      StringReplace(one,"\n"," | ");
      g_brLastText=(StringLen(one)>160)?StringSubstr(one,0,160):one;
      BrAckAdd(id);
      TgQueue("📱 Mini App → "+cmd+"\n"+result);
      g_brLast=0;                       // sync again on the next timer tick: ack + fresh state
     }
   if(g_brFirst && discarded>0) YLog("Mini App bridge: "+IntegerToString(discarded)+" queued command(s) discarded on startup (not executed).");
   g_brFirst=false;
  }

//--- v2.27: zero-typing setup. `npm run setup` writes Common\Files\Yetimmm.cfg (url=..., pair=...). Inputs, if filled, win.
void LoadAutoConfig(const bool quiet)
  {
   g_brUrl=InpBrUrl; g_brPair=InpBrPairCode;
   StringTrimLeft(g_brUrl); StringTrimRight(g_brUrl); StringTrimLeft(g_brPair); StringTrimRight(g_brPair);
   if(StringLen(g_brUrl)>=12 && StringLen(g_brPair)>0) return;
   int h=FileOpen("Yetimmm.cfg",FILE_READ|FILE_TXT|FILE_ANSI|FILE_COMMON);
   if(h==INVALID_HANDLE) { if(!quiet && StringLen(g_brUrl)<12) YLog("Mini App bridge: Yetimmm.cfg not found in the Common Files folder - run `npm run setup` (or fill InpBrUrl / InpBrPairCode)."); return; }
   while(!FileIsEnding(h))
     {
      string ln=FileReadString(h); StringTrimLeft(ln); StringTrimRight(ln);
      int eq=StringFind(ln,"="); if(eq<1) continue;
      string k=StringSubstr(ln,0,eq), v=StringSubstr(ln,eq+1);
      StringTrimLeft(v); StringTrimRight(v); StringToLower(k);
      if(k=="url"  && StringLen(g_brUrl)<12)  g_brUrl=v;
      if(k=="pair" && StringLen(g_brPair)==0) g_brPair=v;
     }
   FileClose(h);
   if(!quiet) YLog("Mini App bridge: configuration loaded automatically (Yetimmm.cfg).");
  }

//--- v2.33: REAL ORDERS ONLY. Everything "virtual" (zone trigger armed in memory, fast-catch arming, remembered market-entry
//--- expectations) is wiped at start. Real pending orders and open positions are never touched here. The bot then waits for the
//--- user's real commands (/set, /start from Telegram or the Mini App).
void PurgeVirtualState()
  {
   g_vArmed=false; g_catchArmed=false;
   g_nextRevMs=0; g_revFails=0; g_revHard=0;
   ulong pp[];
   if(OwnPositions(pp)==0)
     {
      GS("RVSL",0.0); GS("RVTP",0.0); GS("RVEXP",0.0); GS("RVDEV",0.0);   // no market-entry expectation may survive a restart
      GS("REVERR",0.0);
     }
   if(InpEntryMode==ENTRY_VIRTUAL || InpBreachPolicy==BREACH_MARKET || InpFastCatch)
      YLog("REAL ORDERS ONLY (v2.33): Virtual entry / Market Reversal / Fast Catch are DISABLED - those inputs are ignored. Entries are real Buy Stop / Sell Stop orders created only from your levels.");
  }

//--- v2.27: levels left by the old panel fields / EA inputs / defaults (never confirmed by the Mini App) are removed ONCE.
//--- Open positions are never touched. Levels set from the Mini App (LVSRC=1) survive restarts (Recovery).
void PurgeLegacyLevels()
  {
   if(MQLInfoInteger(MQL_TESTER)) return;
   if(GHas("V227")) return;
   GS("V227",1.0);
   if(GV("LVSRC",0)>0.5) return;
   ulong pt[];
   if(OwnPositions(pt)>0) return;
   if(g_buyLevel<=0.0 && g_sellLevel<=0.0 && g_pendBuy<=0.0 && g_pendSell<=0.0 && g_mode==YM_NONE) return;
   YLog("v2.27 cleanup: legacy levels removed (Buy "+PX(g_buyLevel)+" / Sell "+PX(g_sellLevel)+") - they were not set from the Mini App.");
   g_mode=YM_NONE; g_buyLevel=0.0; g_sellLevel=0.0; g_pendBuy=0.0; g_pendSell=0.0;
   if(g_state==YT_ARMED || g_state==YT_WAITING_REENTRY) g_state=YT_IDLE;
   SaveState();
   CleanupOrders("v2.27 legacy levels cleanup");
  }

//+------------------------------------------------------------------+
//| v2.42 RECOVERY STATE SAFE (report Fix_1, problem 1)              |
//| Replaces the v2.41 automatic Clean Start. After a restart the    |
//| saved state is compared with what the broker REALLY holds, BEFORE|
//| the first synchronisation:                                        |
//|  - an open position            -> adopted, never a second entry   |
//|  - pending orders that match   -> adopted, never deleted, never   |
//|    the saved state                duplicated                      |
//|  - an unresolved request       -> verified first (request ledger) |
//|  - a cycle that must go on     -> continued (history verified)    |
//|  - nothing alive               -> IDLE, waits for the user's order|
//|  - a conflict nobody can prove -> REQUIRED_RECOVERY: no new order,|
//|    nothing deleted, the user decides (/cancel, /stop, /set)       |
//| A stored level / old state never creates an order by itself.     |
//+------------------------------------------------------------------+
string DealReasonText(const long r)
  {
   switch((int)r)
     {
      case DEAL_REASON_SL:     return "STOP LOSS";
      case DEAL_REASON_TP:     return "TAKE PROFIT";
      case DEAL_REASON_SO:     return "STOP OUT";
      case DEAL_REASON_CLIENT: return "MANUAL (desktop)";
      case DEAL_REASON_MOBILE: return "MANUAL (mobile)";
      case DEAL_REASON_WEB:    return "MANUAL (web)";
      case DEAL_REASON_EXPERT: return "EXPERT";
     }
   return "OTHER ("+IntegerToString((int)r)+")";
  }

void RecoveryHold(const string code,const string why)
  {
   if(g_recHold && g_recWhy==why) return;
   g_recHold=true;
   g_recWhy=why;
   YLog("REQUIRED_RECOVERY ("+code+"): "+why);
   LogOrder("RECOVERY_REQUIRED",-1,0.0,0.0,0,0,code+" | "+why+" | no new order is sent and nothing is deleted automatically until this is reconciled or you act (/cancel, /stop, /set + START)");
   RaiseAlert("RECOVERY","⚠️ REQUIRED_RECOVERY: "+why+" No new order is sent and nothing is deleted automatically. Send /cancel to remove the pending orders and wait, or /stop, or /set BUY SELL and START to decide yourself.",false,true);
  }

void RecoveryRelease(const string src)
  {
   if(!g_recHold) return;
   g_recHold=false;
   g_recWhy="";
   ClearAlert("RECOVERY");
   LogOrder("RECOVERY_RELEASED",-1,0.0,0.0,0,0,"REQUIRED_RECOVERY cleared ("+src+")");
   YLog("REQUIRED_RECOVERY cleared ("+src+")");
   g_dirty=true;
  }

//--- is this live order the one the saved state asks for? (right state, right side, and either the tracked ticket or the saved level)
bool RecoveryOrderMatches(const ulong tk)
  {
   if(g_state!=YT_ARMED && g_state!=YT_WAITING_REENTRY) return false;
   if(!OrderSelect(tk)) return false;
   const long ty=OrderGetInteger(ORDER_TYPE);
   const double px=OrderGetDouble(ORDER_PRICE_OPEN);
   if(ty==ORDER_TYPE_BUY_STOP)
      return (g_mode==YM_BOTH || g_mode==YM_BUY) && (tk==g_stopTicket[0] || (g_buyLevel>0.0 && PriceEq(px,g_buyLevel)));
   if(ty==ORDER_TYPE_SELL_STOP)
      return (g_mode==YM_BOTH || g_mode==YM_SELL) && (tk==g_stopTicket[1] || (g_sellLevel>0.0 && PriceEq(px,g_sellLevel)));
   return false;
  }

//--- while REQUIRED_RECOVERY holds: re-checked once a second; it clears by itself when the conflict is gone
void RecoveryHoldTick()
  {
   const ulong now=GetTickCount64();
   if(now<g_recNextMs) return;
   g_recNextMs=now+1000;
   ulong od[];
   const int no=OwnOrders(od);
   if(no==0) { RecoveryRelease("the conflicting pending orders are gone"); return; }
   for(int k=0;k<no;k++)
      if(!RecoveryOrderMatches(od[k])) return;
   RecoveryRelease("every pending order now matches the saved state");
  }

//--- what the order history says about the tickets the saved state tracked (evidence only)
string RecoveryHistoryNote()
  {
   if(!HistorySelect(TimeCurrent()-7*86400,TimeCurrent()+60)) return "order history not readable";
   string t="";
   for(int s=0;s<2;s++)
     {
      const ulong tk=g_stopTicket[s];
      if(tk==0 || OrderSelect(tk)) continue;
      if(!HistoryOrderSelect(tk)) { t+=SideName(s==0)+" #"+UL(tk)+" not in history; "; continue; }
      t+=SideName(s==0)+" #"+UL(tk)+" history state "+IntegerToString((int)HistoryOrderGetInteger(tk,ORDER_STATE))+"; ";
     }
   return t;
  }

void RecoveryStateSafe()
  {
   if(MQLInfoInteger(MQL_TESTER)) return;
   ulong pp[], od[];
   const int np=OwnPositions(pp);
   const int no=OwnOrders(od);
   const bool unc=(g_unc[0].active || g_unc[1].active);
   const bool cycOn=!CycFresh();
   string ev="saved state "+StateText()+" (levels Buy "+PX(g_buyLevel)+" / Sell "+PX(g_sellLevel)+") | cycle #"+IntegerToString((int)g_cycId)+" "+CycStateText()+" net "+D2(g_cycNet)+" seq "+IntegerToString(g_seq)+
             " | broker: "+IntegerToString(np)+" position(s), "+IntegerToString(no)+" pending order(s) | unresolved request: "+(unc?"yes":"no")+" | startup reason "+IntegerToString(UninitializeReason());
   const string hn=RecoveryHistoryNote();
   if(StringLen(hn)>0) ev+=" | history: "+hn;
   string code="RCV_NOTHING", act="nothing to recover";
   if(np>0)
     {
      code="RCV_POSITION";
      act="open position adopted (SL / TP / state / cycle data are verified by the normal pass); NO new entry is sent";
     }
   else if(g_state==YT_BUY_ACTIVE || g_state==YT_SELL_ACTIVE)
     {
      code="RCV_CLOSE_PENDING";
      act="the saved state says a position is open but none exists: the closing deal is read from the history first (SAFE STATE: no order until it is booked)";
     }
   else if(no>0)
     {
      int bad=0;
      string badTxt="";
      for(int k=0;k<no;k++)
         if(!RecoveryOrderMatches(od[k])) { bad++; badTxt+=(StringLen(badTxt)>0?", ":"")+"#"+UL(od[k]); }
      if(bad==0)
        {
         code="RCV_ORDERS_ADOPTED";
         act="the pending order(s) on the server match the saved state: adopted, not deleted, not duplicated";
        }
      else if(g_state==YT_STOPPED || g_state==YT_TP_RESET || g_cycState==YC_COMPLETING)
        {
         code="RCV_STALE_ORDERS";
         act="the cycle is finished / stopped by the user (saved state "+StateText()+") - the pending order(s) "+badTxt+" belong to it and are removed by the normal pass (proven stale)";
        }
      else
        {
         code="RCV_CONFLICT";
         act="pending order(s) "+badTxt+" do not match the saved state ("+StateText()+") and nothing proves which one is right";
         RecoveryHold(code,"The broker holds "+IntegerToString(no)+" pending order(s) of this EA ("+badTxt+") that do not match the saved state ("+StateText()+", Buy "+PX(g_buyLevel)+" / Sell "+PX(g_sellLevel)+").");
        }
     }
   else if(unc)
     {
      code="RCV_UNRESOLVED";
      act="an order request without a confirmed result was restored: it is verified against the server (orders / positions / history) before anything is sent for that side";
     }
   else if(g_cycState==YC_COMPLETING)
     {
      code="RCV_COMPLETING";
      act="a cycle completion was in progress: it finishes exactly once (CycleCompletionTick)";
     }
   else if(g_state==YT_ARMED || g_state==YT_WAITING_REENTRY)
     {
      //--- v2.43 (report Fix_2, problem 4): an OPEN DEBT is never parked in IDLE. While the cycle holds a debt / booked net and valid levels are saved,
      //--- the cycle CONTINUES with those levels (ARMED or WAITING_REENTRY kept); orders are created only when the normal guards allow.
      if(cycOn && g_buyLevel>g_sellLevel && g_sellLevel>0.0)
        {
         code="RCV_CONTINUE_CYCLE";
         act="the compensation cycle still holds a debt (Acc.Loss "+D2(g_accLoss)+", Cycle Net "+D2(g_cycNet)+", Seq "+IntegerToString(g_seq)+"): the cycle CONTINUES with the saved levels (state "+StateText()+" kept, last closing deal "+UL(g_lastDeal)+"); orders are created only when the market and the guards allow - NOT parked in IDLE";
         RaiseAlert("RCVDEBT","Restart recovery: the cycle holds a debt (Acc.Loss "+D2(g_accLoss)+" "+AccCcy()+", Seq "+IntegerToString(g_seq)+") and CONTINUES with the saved levels.",false,true);
        }
      else if(cycOn)
        {
         code="RCV_DEBT_NO_LEVELS";
         act="the cycle holds a debt (Acc.Loss "+D2(g_accLoss)+", Seq "+IntegerToString(g_seq)+") but no valid levels are saved: the DEBT IS KEPT, state WAITING for levels (/set BUY SELL then START continues the same cycle)";
         g_mode=YM_NONE; g_pendBuy=0.0; g_pendSell=0.0; g_fresh=false;
         g_state=YT_TP_RESET;
         SaveState();
         RaiseAlert("RCVDEBT","Restart recovery: the cycle holds a debt (Acc.Loss "+D2(g_accLoss)+" "+AccCcy()+") but no valid levels. The debt is KEPT. Send /set BUY SELL then START to continue the same cycle.",true,true);
        }
      else
        {
         code="RCV_WAIT_USER";
         act="no order, no position, no unresolved request and no running step: saved levels / state removed, the bot WAITS for a new order from the user (nothing is created from old levels)";
         g_mode=YM_NONE; g_buyLevel=0.0; g_sellLevel=0.0; g_pendBuy=0.0; g_pendSell=0.0; g_fresh=false; g_lastSLSide=0;
         g_deferLvl[0]=0.0; g_deferLvl[1]=0.0;
         g_state=YT_IDLE;
         GS("LVSRC",0.0);
         SaveState();
        }
     }
   LogOrder("RECOVERY",-1,0.0,0.0,0,0,code+" | "+act+" | "+ev);
   YLog("RECOVERY STATE SAFE: "+code+" - "+act);
  }

//+------------------------------------------------------------------+
//| v2.28 SINGLE-INSTANCE GUARD                                      |
//| Two copies with the same Magic share the saved state (global     |
//| variables) but keep their own memory: one processes the closing  |
//| deal, the other never sees the transition, falls back to IDLE    |
//| and deletes the first copy's pending orders. Only ONE copy per   |
//| Magic may run: the others refuse to start (or halt).             |
//+------------------------------------------------------------------+
string InstLockName() { return GN("INST"); }
string InstBeatName() { return GN("INSTHB"); }
double InstToken()    { return (double)(ChartID()%900000000000000)+1.0; }   // unique per chart, exactly representable as a double

bool InstAlive()
  {
   if(!GlobalVariableCheck(InstLockName()) || !GlobalVariableCheck(InstBeatName())) return false;
   double hb=GlobalVariableGet(InstBeatName());
   if(hb<=0.0) return false;
   return ((double)TimeLocal()-hb)<=(double)YT_INST_STALE_SEC;
  }

bool InstAcquire()
  {
   if(MQLInfoInteger(MQL_TESTER)) return true;
   double mine=InstToken();
   if(InstAlive() && GlobalVariableGet(InstLockName())!=mine) return false;
   GlobalVariableSet(InstLockName(),mine);
   GlobalVariableSet(InstBeatName(),(double)TimeLocal());
   Sleep(300);                                   // two copies started in the same moment: the last writer wins and both read the same value
   if(GlobalVariableGet(InstLockName())!=mine) return false;
   g_instOwn=true;
   return true;
  }

void InstBeat()
  {
   if(!g_instOwn || g_halt) return;
   ulong nowMs=GetTickCount64();
   if(nowMs-g_instBeatMs<1000) return;
   g_instBeatMs=nowMs;
   if(!GlobalVariableCheck(InstLockName())) GlobalVariableSet(InstLockName(),InstToken());   // vanished (not taken over): re-created
   if(GlobalVariableGet(InstLockName())!=InstToken())
     {
      g_halt=true;
      g_instOwn=false;
      string m="Yetimmm: another copy with Magic "+IntegerToString((int)g_magic)+" took over. THIS copy is halted and no longer trades. Remove it from the chart.";
      YLog("INSTANCE LOCK LOST: "+m);
      Alert(m);
      return;
     }
   GlobalVariableSet(InstBeatName(),(double)TimeLocal());
  }


//--- v2.29: lock ownership is re-verified RIGHT BEFORE every trading operation and every state write (not only once per second).
//--- A copy that lost the lock (or whose heartbeat entry was taken over) halts itself and can neither trade nor overwrite the shared state.
bool InstOk(const string what)
  {
   if(MQLInfoInteger(MQL_TESTER)) return true;
   if(g_halt) return false;
   if(!g_inited && !g_instOwn) return true;                 // OnInit still running (the lock is acquired before anything else is sent)
   if(!g_instOwn) return false;
   if(GlobalVariableCheck(InstLockName()) && GlobalVariableGet(InstLockName())==InstToken()) return true;
   if(!GlobalVariableCheck(InstLockName()))
     {
      //--- the lock variable merely VANISHED (e.g. deleted by hand in Tools > Global Variables): nobody took it over, so it is re-created
      GlobalVariableSet(InstLockName(),InstToken());
      YLog("Instance lock variable was missing - re-created by its owner.");
      return true;
     }
   g_halt=true;
   g_instOwn=false;
   string m="Yetimmm: lock of Magic "+IntegerToString((int)g_magic)+" lost while trying to "+what+". THIS copy is halted and sent NOTHING. Remove it from the chart.";
   YLog("INSTANCE LOCK LOST: "+m);
   Alert(m);
   return false;
  }

bool InstOkTrade(const string what)
  {
   if(!InstOk(what)) return false;
   if(g_dupSince>0 && !MQLInfoInteger(MQL_TESTER))
     {
      static datetime lastLog=0;
      if(TimeLocal()-lastLog>=10) { lastLog=TimeLocal(); YLog("Trading paused: the Worker reports another live copy for this account - NOT trying to "+what+" ("+IntegerToString((int)(TimeLocal()-g_dupSince))+" s so far; halts after "+IntegerToString(YT_DUP_HALT_SEC)+" s)."); }
      return false;
     }
   return true;
  }

void InstRelease()
  {
   if(!g_instOwn) return;
   if(GlobalVariableCheck(InstLockName()) && GlobalVariableGet(InstLockName())==InstToken())
     {
      GlobalVariableDel(InstLockName());
      GlobalVariableDel(InstBeatName());
     }
   g_instOwn=false;
  }

//+------------------------------------------------------------------+
//| v2.29 SEQUENCE AUDIT (alert only - NEVER changes or resets)      |
//| Compares the saved Seq / Acc.Loss with the Trades log of the     |
//| CURRENT cycle (since the last explicit reset or fully repaid TP).|
//| A mismatch is reported, never "fixed" automatically: the user    |
//| decides (restore, or RESET with confirmation).                   |
//+------------------------------------------------------------------+
string SeqAuditText()
  {
   string lines[];
   int n=ReadTradeLines(lines);
   long rstNo=(long)GV("RSTNO",0.0);
   int slRows=0;
   double lastAcc=0.0;
   long lastNo=0;
   bool haveLast=false;
   for(int i=n-1;i>=0;i--)
     {
      string f[];
      if(StringSplit(lines[i],';',f)<30) continue;
      const bool taintRow=(ArraySize(f)>34 && StringFind(f[34],"TAINTED")>=0);
      if(taintRow && !(ArraySize(f)>35 && StringFind(f[35],"LEDGER_BOOKED")>=0)) continue;   // v4.30: a tainted row whose bot share WAS booked still carries the ledger's Acc.Loss
      long tno=(long)StringToInteger(f[0]);
      if(tno<=rstNo) break;                                  // older than the last explicit reset
      double accAfter=StringToDouble(f[27]);
      if(!haveLast) { haveLast=true; lastAcc=accAfter; lastNo=tno; }
      if(accAfter<=0.005) break;                             // this row ended the cycle (everything repaid): it and older rows are not part of the current one
      if(f[23]=="SL" && !taintRow) slRows++;
     }
   if(!haveLast)
      return (g_seq>0 || g_accLoss>0.005)?"Seq "+IntegerToString(g_seq)+" / Acc.Loss "+D2(g_accLoss)+" are saved but the Trades log has no closed trade of the current cycle. ":"";
   string why="";
   if(MathAbs(lastAcc-g_accLoss)>0.02)
      why+="Acc.Loss saved "+D2(g_accLoss)+" vs "+D2(lastAcc)+" after Trade #"+TNo(lastNo)+" in the log. ";
   if(slRows!=g_seq)
      why+="Seq saved "+IntegerToString(g_seq)+" vs "+IntegerToString(slRows)+" SL trade(s) counted in the log. ";
   return why;
  }

void SeqAuditRun()
  {
   if(MQLInfoInteger(MQL_TESTER)) return;
   string w=SeqAuditText();
   if(StringLen(w)==0) { ClearAlert("SEQAUDIT"); return; }
   YLog("SEQUENCE AUDIT: "+w+"(nothing was changed)");
   RaiseAlert("SEQAUDIT","⚠️ Inconsistent risk sequence: "+w+"Nothing was reset or changed. Trading continues with the SAVED values - check Yetimmm_"+IntegerToString((int)g_magic)+"_Trades.csv, then fix by RESET (with confirmation) only if the losses are not real.",false,true);
  }

//--- v2.40 (report section 6): after a restart the saved state is compared with what the broker really holds, and every difference is logged.
//--- Nothing is decided here: the existing safe-state paths (closing deal not booked -> no new order, history re-read, unresolved requests verified) do the work.
void StartupAudit()
  {
   ulong pos[], od[];
   const int np=OwnPositions(pos), no=OwnOrders(od);
   string ps="", os="";
   for(int i=0;i<np;i++)
     {
      if(!PositionSelectByTicket(pos[i])) continue;
      const ulong pid=(ulong)PositionGetInteger(POSITION_IDENTIFIER);
      ps+=(StringLen(ps)>0?", ":"")+"#"+UL(pos[i])+" "+((PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY)?"BUY ":"SELL ")+LotS(PositionGetDouble(POSITION_VOLUME))+" @ "+PX(PositionGetDouble(POSITION_PRICE_OPEN))+(PHas(pid,"N")?"":" (not registered yet)");
     }
   for(int k=0;k<no;k++)
     {
      if(!OrderSelect(od[k])) continue;
      os+=(StringLen(os)>0?", ":"")+"#"+UL(od[k])+" "+OTypeStr(OrderGetInteger(ORDER_TYPE))+" "+LotS(OrderGetDouble(ORDER_VOLUME_CURRENT))+" @ "+PX(OrderGetDouble(ORDER_PRICE_OPEN));
     }
   string diff="";
   const bool active=(g_state==YT_BUY_ACTIVE || g_state==YT_SELL_ACTIVE);
   const bool wantOrders=(g_state==YT_ARMED || g_state==YT_WAITING_REENTRY);
   if(active && np==0) diff+="the saved state says a position is open but none exists (its closing deal is read from the history before anything is sent); ";
   if(!active && np>0) diff+="a position exists although the saved state is "+StateText()+" (it is registered and adopted); ";
   if(np>1)            diff+=IntegerToString(np)+" own positions (only one is allowed); ";
   if(!wantOrders && !active && no>0) diff+="pending orders exist although none is wanted in this state (REQUIRED_RECOVERY or removal as proven by the Recovery State Safe pass - never silently); ";
   if(wantOrders && no==0 && !(g_unc[0].active || g_unc[1].active)) diff+="the pending orders are missing (they are re-created only when the market allows); ";
   if(g_unc[0].active || g_unc[1].active) diff+="an unresolved order request was restored (verified before anything is sent); ";
   LogOrder("STARTUP_AUDIT",-1,0.0,0.0,0,0,"saved state "+StateText()+" | cycle #"+IntegerToString((int)g_cycId)+" net "+D2(g_cycNet)+" seq "+IntegerToString(g_seq)+" trade# "+IntegerToString((int)g_tradeNo)+" last deal "+UL(g_lastDeal)+
            " | positions: "+(StringLen(ps)>0?ps:"none")+" | orders: "+(StringLen(os)>0?os:"none")+" | acct "+(g_netting?"Netting":"Hedging")+" | differences: "+(StringLen(diff)>0?diff:"none"));
   CycleCensus("startup",true);
   if(StringLen(diff)>0)
     {
      YLog("Startup audit - differences between the saved state and the broker: "+diff);
      RaiseAlert("STARTAUD","Startup audit: "+diff,false,true);
     }
  }

int OnInit()
  {
   Print("[Yetimmm] v"+YT_VER+" loaded - Broker/Risk engine | entry "+((YT_REAL_ORDERS_ONLY || InpEntryMode==ENTRY_PENDING)?"PENDING (real orders only)":"VIRTUAL")+" | risk policy "+(InpRiskPolicy==YT_RISK_CLAMP_MIN?"CLAMP_TO_MIN":"STRICT"));
   g_sym=_Symbol;
   g_magic=InpMagic;
   g_instId=StringFormat("%I64d-%I64d-%d",(long)TimeLocal(),(long)ChartID(),(int)(GetTickCount64()%100000));
   g_dupSince=0;
   string up=g_sym;
   StringToUpper(up);
   if(StringFind(up,"XAUUSD")<0)
     {
      Alert("Yetimmm works on XAUUSD only. Current symbol: ",g_sym);
      return INIT_FAILED;
     }
   if(InpRiskReward<=0.0 || InpTargetProfit<0.0 || InpInitialRisk<=0.0 || InpMaxDeviation<0 || InpWarnSpread<0 || InpProtectCloseSec<0)
     {
      Alert("Yetimmm: invalid inputs (Initial Risk and Risk/Reward must be > 0; Target, Deviation and Spread must be >= 0).");
      return INIT_PARAMETERS_INCORRECT;
     }
   if(!MagicGuardOk()) return INIT_FAILED;
   if(!InstAcquire())
     {
      string im="Yetimmm: another copy with Magic "+IntegerToString((int)g_magic)+" is already running on "+g_sym+" (another chart or window). Two copies overwrite each other's state and delete each other's orders, so THIS copy was NOT started. Remove the other copy, or give this one a different Magic, then re-attach. (After an MT5 restart wait "+IntegerToString(YT_INST_STALE_SEC)+" s and re-attach.)";
      YLog("INIT REFUSED: "+im);
      Alert(im);
      return INIT_FAILED;
     }
   SymbolSelect(g_sym,true);
   g_digits=(int)SymbolInfoInteger(g_sym,SYMBOL_DIGITS);
   g_point=SymbolInfoDouble(g_sym,SYMBOL_POINT);
   g_tick=SymbolInfoDouble(g_sym,SYMBOL_TRADE_TICK_SIZE);
   if(g_tick<=0.0) g_tick=g_point;
   double st=SymbolInfoDouble(g_sym,SYMBOL_VOLUME_STEP);
   g_lotDigits=0;
   while(g_lotDigits<8 && MathAbs(st*MathPow(10,g_lotDigits)-MathRound(st*MathPow(10,g_lotDigits)))>1e-9) g_lotDigits++;

   g_contract=SymbolInfoDouble(g_sym,SYMBOL_TRADE_CONTRACT_SIZE);
   g_mscale=DetectMoneyScale();
   if(g_mscale>1.0)
      Print("[Yetimmm] CENT SUPPORT: account currency "+AccCcyRaw()+" - every money figure is in "+AccCcy()+" (1 "+AccCcy()+" = "+DoubleToString(g_mscale,0)+" "+AccCcyRaw()+"). Risk / Target are entered in "+AccCcy()+" exactly like a standard account.");
   CfgInit();                          // runtime configuration: inputs + values saved from the panel
   g_uiTgEn=g_tgEn; g_uiTgNot=g_tgNot; g_uiTgCtl=g_tgCtl;

   g_trade.SetExpertMagicNumber((ulong)g_magic);
   g_trade.SetDeviationInPoints(g_maxDev);
   g_trade.SetTypeFillingBySymbol(g_sym);
   g_trade.SetAsyncMode(false);
   MathSrand((int)GetTickCount());

   YLog("EA Started | "+g_sym+" | magic "+IntegerToString(g_magic));
   g_netting=IsNettingAccount();
   if(g_netting)
     {
      //--- Netting merges every deal on the symbol into one position: refuse to run next to a foreign position
      double ev=ExternalPositionVolume();
      if(ev>0.0)
        {
         Alert("Yetimmm refused to start: Netting account and an external ",g_sym," position exists (",LotS(ev)," lots). Close it first, then re-attach the EA.");
         YLog("INIT REFUSED: Netting account + external "+g_sym+" position ("+LotS(ev)+" lots).");
         return INIT_FAILED;
        }
      YLog("Netting account detected: the bot stays frozen (no orders, no closing) whenever a foreign "+g_sym+" position exists.");
     }

   LoadState();
   TrkLoad();                          // real tickets + last server-verified snapshot survive a restart
   UncLoad();                          // v2.40: an order request without a confirmed outcome survives a restart and is verified first
   ReqJournalRecover();                // v2.42: a request that was SENT without a recorded result becomes an unresolved request (verified, never re-sent blindly)
   g_tgLast=(long)GV("TGLAST",0);
   LoadTradeLog();
   ParseIds();
   LogSpecs();
   if(g_tgEn)
     {
      if(MQLInfoInteger(MQL_TESTER)) YLog("Telegram disabled in the Strategy Tester.");
      else if(StringLen(g_tgTok)==0) YLog("Telegram: waiting for the bot token from the Worker (automatic). Control and notifications go ONLY to the chat IDs registered through the Worker.");
     }
   YLog("Stop-and-reverse (v2.37): "+(InpPreArmReverse?(g_netting?"OFF - Netting account (the reverse order would merge into the open position); the previous re-entry behaviour applies":"ON - the opposite Stop order stays on the server while a position is open"):"OFF (input) - previous re-entry behaviour"));
   YLog("After-SL policy: "+((!YT_REAL_ORDERS_ONLY && InpBreachPolicy==BREACH_MARKET)?"MARKET (advanced / opt-in - reverses at market when the level was already crossed)":"WAIT (literal philosophy - pending Stop at the SL level)")+
        " | Protection emergency-close: "+(InpProtectCloseSec>0?IntegerToString(InpProtectCloseSec)+" s":"OFF (alert + retry only)"));
   //--- v4.31.1 FIX-A: the bridge settings are loaded (inputs, else Common\Files\Yetimmm.cfg) BEFORE they are validated, so a valid
   //--- configuration can never be reported as "INACTIVE" merely because it had not been read yet. Result: CONFIG_READY / CONFIG_INVALID (exact reason).
   if(InpBrEnable && !MQLInfoInteger(MQL_TESTER))
     {
      BrSetState(BR_CONFIG_LOADING,"reading bridge settings");
      LoadAutoConfig();
      string cfgWhy=BrConfigProblem();
      if(cfgWhy!="")
         BrSetState(BR_CONFIG_INVALID,cfgWhy);
      else
        {
         BrSetState(BR_CONFIG_READY,g_brUrl);
         YLog("Mini App bridge: enabled | "+g_brUrl+" | Allowed URLs must contain: "+AllowUrlsHint()+" (error 4014 otherwise).");
        }
      if(CfgGet("brpaired","0")!="1" && StringLen(g_brPair)==0)
         YLog("Mini App bridge: InpBrPairCode is empty - an account that is not yet bound to this Worker will be refused until you enter the pairing code (accounts bound by v2.20 keep working).");
     }
   g_connected=(bool)TerminalInfoInteger(TERMINAL_CONNECTED);
   CycleCompletionTick();                                        // v2.38: a restart in the middle of a completion finishes it exactly once
   if(g_stateRecovered) YLog("State Recovered: "+StateText()+" | Risk "+D2(g_curRisk)+" | Acc.Loss "+D2(g_accLoss)+" | Seq "+IntegerToString(g_seq)+" | Last Trade #"+TNo(g_tradeNo));
   PrintRecoveryPlan();

   //--- v2.27: the Telegram Mini App is the ONLY source of levels/risk. Input levels, panel fields and old defaults never create orders.
   if(InpBuyStop>0.0 || InpSellStop>0.0) YLog("InpBuyStop / InpSellStop are DEPRECATED and ignored (v2.27): set the levels from the Telegram Mini App.");
   if(!(InpBrEnable && !MQLInfoInteger(MQL_TESTER))) LoadAutoConfig();   // v4.31.1: with the bridge enabled the settings were already loaded and validated above
   RecoverHistory();
   PurgeLegacyLevels();
   RecoveryStateSafe();                                           // v2.42: saved state vs the broker (position / pending orders / unresolved request / cycle) - recovered, or the bot waits for the user
   PurgeVirtualState();
   if(!g_stateRecovered) { g_initRisk=InpInitialRisk; g_curRisk=InpInitialRisk; }
   SaveState();
   ChartSetInteger(0,CHART_SHOW_TRADE_LEVELS,true);   // real pending-order / SL / TP levels are drawn by MT5 itself
   CreatePanel();
   BrCmdLoad();
   StartupAudit();                  // v2.40: saved state vs the real positions / orders is written down BEFORE the first synchronisation
   EventSetMillisecondTimer(200);   // v2.13: fast path every 200 ms (Telegram), slow path once per second
   SyncAll();
   UpdatePanel();
   TgQueue("✅ Yetimmm Started\n🔒 Real orders only - waiting for your commands\nStatus: "+RunStatus()+"\nState: "+StateText()+"\nBuy Stop: "+PX(g_buyLevel)+"\nSell Stop: "+PX(g_sellLevel)+"\nRisk: $"+D2(g_curRisk)+
           (g_stateRecovered?"\n♻️ State Recovered | Last Trade #"+TNo(g_tradeNo):""),0,MenuMarkup());
   if(g_stateRecovered && !CycFresh() && g_state==YT_IDLE)
      RaiseAlert("SEQIDLE","⚠️ The bot is IDLE in the middle of a risk sequence (Seq "+IntegerToString(g_seq)+", Acc.Loss "+D2(g_accLoss)+", next risk "+D2(g_curRisk)+"). Send the levels again (/set) and press START to continue the sequence, or use Reset / New Cycle to begin again.",false,true);
   if(g_stateRecovered && g_seq>0 && g_tradeNo<(long)g_seq)
      RaiseAlert("SEQINCONS","⚠️ Saved sequence is inconsistent: Seq "+IntegerToString(g_seq)+" but only "+IntegerToString((int)g_tradeNo)+" trade(s) numbered. Check Yetimmm_"+IntegerToString((int)g_magic)+"_Trades.csv; if the losses are not real, use Reset / New Cycle.",false,true);
   SeqAuditRun();
   g_inited=true;
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   bool wasOwner=g_instOwn;
   if(g_inited && !g_halt)       // a halted copy must NEVER write its stale memory over the shared state
     {
      SaveState();
      TgFlush();
     }
   InstRelease();
   ObjectsDeleteAll(0,UI);
   YLog("EA stopped (reason "+IntegerToString(reason)+")."+((wasOwner||(g_inited && !g_halt))?" State saved.":" (this copy never owned the instance lock - nothing saved)."));
  }

void OnTick()
  {
   if(g_halt) return;
   ulong now=GetTickCount64();
   //--- v2.30: ONE tick read per event; fast-market tracking (silences the network) and FAST CATCH of a crossed level run FIRST, before any throttle
   {
    MqlTick t0;
    if(SymbolInfoTick(g_sym,t0) && t0.ask>0.0 && t0.bid>0.0)
      {
       HotTrack(t0,now);
       ArmTouchWatch(t0,now);             // v2.40: measurement of the armed orders (sends nothing)
       if(CatchTick(t0,now)) return;
      }
   }
   //--- v2.17: SMART WAIT - one comparison per tick against the cached trigger price; the synchroniser is woken the very tick the market allows the order
   //--- v2.30: throttle 100 ms -> 20 ms (a comparison only; the heavy synchroniser still runs at most every 20 ms, and only while a trigger is crossed)
   bool crossed=false;
   if((g_trig[0]>0.0 || g_trig[1]>0.0) && now-g_lastSyncMs>=20)
     {
      MqlTick tk;
      if(SymbolInfoTick(g_sym,tk))
        {
         if(g_zoneGate)
           {
            //--- both orders wait for the zone: wake only when BOTH can be placed (Ask below Buy trigger AND Bid above Sell trigger)
            if(g_trig[0]>0.0 && g_trig[1]>0.0 && tk.ask>0.0 && tk.bid>0.0 && tk.ask<=g_trig[0]+1e-9 && tk.bid>=g_trig[1]-1e-9)
              { crossed=true; if(g_trigMs[0]==0) g_trigMs[0]=now; if(g_trigMs[1]==0) g_trigMs[1]=now; }
           }
         else
           {
            if(g_trig[0]>0.0 && g_sync[0]==YS_WAITING && tk.ask>0.0 && tk.ask<=g_trig[0]+1e-9) { crossed=true; if(g_trigMs[0]==0) g_trigMs[0]=now; }
            if(g_trig[1]>0.0 && g_sync[1]==YS_WAITING && tk.bid>0.0 && tk.bid>=g_trig[1]-1e-9) { crossed=true; if(g_trigMs[1]==0) g_trigMs[1]=now; }
           }
        }
     }
   if(!crossed && now-g_lastSyncMs>=20 && VirtualWake()) crossed=true;   // v2.22: virtual entry reacts on the tick the price crosses
   if(crossed || g_dirty || now-g_lastSyncMs>=300)
     {
      g_dirty=false;
      SyncAll();
     }
  }

void OnTrade()
  {
   if(g_halt) return;
   g_dirty=true;
   UpdatePanel();          // show the real server state immediately (incremental, cheap)
  }

//--- v2.45.1 TP = THE PAIR IS FINISHED: the moment a position of this EA closes by Take Profit and NO own position is left, the opposite pending Stop
//--- (the pre-armed reverse order, or any leftover of the pair) is deleted AT ONCE - it does not wait for the closing deal to reach the history,
//--- for the ledger booking or for the cycle-completion test. A position that is still open (e.g. the reverse order already filled) is never touched.
//--- Whether the cycle ends or continues (net target not reached yet) is still decided by ProcessClosedPosition / the ledger exactly as before.
void TpOppositeSweep(const ulong deal)
  {
   if(g_halt || g_recHold) return;                       // REQUIRED_RECOVERY: nothing is deleted until the conflict is reconciled
   ulong rp[];
   if(OwnPositions(rp)>0) return;                        // a position is still open: its pending reverse order is legitimate
   ulong od[];
   int n=OwnOrders(od);
   if(n<=0) return;
   int gone=0;
   for(int i=0;i<n;i++)
      if(DeleteOrder(od[i],"TP hit (deal #"+UL(deal)+"): the pair is finished - opposite pending order deleted")) { gone++; TgQueue("🗑 OPPOSITE ORDER DELETED (TP hit)\nTicket: "+UL(od[i])); }
   LogOrder(gone==n?"TP_OPPOSITE_DELETED":"TP_OPPOSITE_DELETE_PARTIAL",-1,0.0,0.0,0,0,"TP closing deal #"+UL(deal)+" | pending orders found "+IntegerToString(n)+" | deleted "+IntegerToString(gone)+(gone<n?" | the rest is retried by the normal cleanup":""));
   g_dirty=true;
  }

void OnTradeTransaction(const MqlTradeTransaction &trans,const MqlTradeRequest &request,const MqlTradeResult &result)
  {
   if(g_halt) return;
   //--- v2.40: a LATE answer of a request that had no confirmed outcome: it only wakes the verification (the decision always comes from the server state)
   if(trans.type==TRADE_TRANSACTION_REQUEST)
     {
      if(request.action==TRADE_ACTION_PENDING && request.symbol==g_sym && (long)request.magic==g_magic)
        {
         int rs=(request.type==ORDER_TYPE_BUY_STOP)?0:((request.type==ORDER_TYPE_SELL_STOP)?1:-1);
         if(rs>=0 && g_unc[rs].active)
           {
            if(g_unc[rs].ticket==0 && result.order!=0) g_unc[rs].ticket=result.order;
            LogOrder("UNCERTAIN_LATE_RESULT",(rs==0)?(long)ORDER_TYPE_BUY_STOP:(long)ORDER_TYPE_SELL_STOP,g_unc[rs].level,g_unc[rs].lot,result.order,result.retcode,
                     "req#"+IntegerToString((int)g_unc[rs].id)+" | late trade-server answer (retcode "+IntegerToString((int)result.retcode)+") - the outcome is decided by the server state, not by this event");
            g_unc[rs].nextMs=0;
            g_dirty=true;
           }
        }
      return;
     }
   //--- v2.39: an order appeared / changed / vanished on the server (placed, rejected, expired, deleted outside the EA): the next tick re-checks it at once
   //--- instead of waiting for the 1 s timer. Only a flag is set - nothing is sent from here, so a late or repeated event can never act twice.
   if(trans.type==TRADE_TRANSACTION_ORDER_ADD || trans.type==TRADE_TRANSACTION_ORDER_DELETE || trans.type==TRADE_TRANSACTION_ORDER_UPDATE)
     {
      if(trans.symbol==g_sym)
        {
         g_dirty=true;
         if(trans.type==TRADE_TRANSACTION_ORDER_ADD)     // v2.40: an order appeared - an open request record is verified at once instead of after its back-off
            for(int us=0;us<2;us++) g_unc[us].nextMs=0;
        }
      return;
     }
   if(trans.type!=TRADE_TRANSACTION_DEAL_ADD) return;
   if(trans.symbol!=g_sym) return;
   if(TransDealSeen(trans.deal)) { g_dirty=true; return; }      // v2.40: a repeated event of the same deal is never processed twice
   string closeNote="";
   if(HistoryDealSelect(trans.deal))
     {
      if(HistoryDealGetInteger(trans.deal,DEAL_ENTRY)==DEAL_ENTRY_IN && (long)HistoryDealGetInteger(trans.deal,DEAL_MAGIC)==g_magic)
        {
         ArmFill(trans.deal);
         ulong pid=(ulong)HistoryDealGetInteger(trans.deal,DEAL_POSITION_ID);
         RegisterPosition(pid);
        }
      else if(HistoryDealGetInteger(trans.deal,DEAL_ENTRY)!=DEAL_ENTRY_IN && (long)HistoryDealGetInteger(trans.deal,DEAL_MAGIC)==g_magic)
        {
         //--- v2.42: a closing deal of this EA: the earliest timestamp of a close. The CAUSE is read here, never assumed (it may be a manual close, a TP, a stop-out...);
         //--- the decision (stop loss -> opposite order) is taken by ProcessClosedPosition from the booked deal. The log line is written AFTER the synchronisation.
         g_tlTrMs=GetTickCount64();
         closeNote="closing deal #"+UL(trans.deal)+" of position #"+UL((ulong)HistoryDealGetInteger(trans.deal,DEAL_POSITION_ID))+" | reason "+DealReasonText(HistoryDealGetInteger(trans.deal,DEAL_REASON))+" | price "+PX(HistoryDealGetDouble(trans.deal,DEAL_PRICE));
         if(HistoryDealGetInteger(trans.deal,DEAL_REASON)==DEAL_REASON_TP) TpOppositeSweep(trans.deal);   // v2.45.1: TP -> the opposite pending order goes now
        }
     }
   g_dirty=true;
   SyncAll();
   if(StringLen(closeNote)>0) LogOrder("CLOSE_EVENT",-1,0.0,0.0,0,0,closeNote+" | event -> synchronisation done in "+MsDiff(g_tlTrMs,GetTickCount64()));
  }

int g_timerCount=0;
void OnTimer()
  {
   InstBeat();
   if(g_halt) return;
   //--- v2.30: the catch also runs from the timer (a level can be crossed right after a closure while no tick arrives)
   CatchTimer();
   //--- v2.30: decided ONCE per timer event; a hot market keeps every WebRequest out (it would blind the EA for its whole timeout)
   const bool netOk=NetAllowed();
   //--- FAST PATH (every timer event): receive -> execute -> reply to Telegram commands
   if(netOk) TgPoll();
   //--- SLOW PATH (once per second): monitors, sync, bridge, queue flush, panel
   ulong nowMs=GetTickCount64();
   if(nowMs-g_slowMs<1000) return;
   g_slowMs=nowMs;
   g_timerCount++;
   MonitorConnection();
   g_dirty=false;
   SyncAll();
   StopCleanupTick();
   CancelEndTick();                                 // fix13: finishes a user cancel (cycle end) once every closed result is booked
   if(g_timerCount%30==0 && g_connected) RecoverHistory();
   if(g_timerCount%120==0) RiskScaleAdvisory();    // v2.30: Risk/Target can be changed from the Mini App at any time
   if(g_timerCount%600==0) SeqAuditRun();          // v2.29: every 10 min, alert only
   MonitorSpread();
   BrWaitTrack();                    // v2.17: waiting Mini App commands -> activated / superseded / cancelled
   if(BrNetAllowed()) BridgeSync();   // v2.45.1: own allowance (was `if(netOk)`, shared with TgPoll -> the heartbeat was starved in a hot market)
   if(netOk) TgFlush();
   UpdatePanel();
  }
//+------------------------------------------------------------------+
