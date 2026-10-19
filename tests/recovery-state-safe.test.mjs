// v4.28.0 (EA 2.42): RECOVERY STATE SAFE (Fix_1, problem 1) - the bot recovers what the broker REALLY holds after a stop / power cut / crash,
// and waits for the user when nothing alive requires it to continue. Replaces the automatic CLEAN START of v2.41.
//   SOURCE - the EA source (Yetimmm.mq5) has the structure the report requires. The EA is NOT compiled or run here.
//   MODEL  - a JavaScript transcription of the decision table of RecoveryStateSafe(), driven through the report's three situations.
//            It proves the RULES are consistent; it is NOT a MetaTrader run (docs/MT5-TESTING.md).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const ea = readFileSync(new URL("../ea/Yetimmm.mq5", import.meta.url), "utf8");
const fn = (head, next) => { const i = ea.indexOf(head); assert.ok(i > 0, head + " missing"); const j = ea.indexOf(next, i + head.length); assert.ok(j > i, next + " missing"); return ea.slice(i, j); };
const rsf = fn("void RecoveryStateSafe()", "//+------------------------------------------------------------------+\n//| v2.28 SINGLE-INSTANCE GUARD");
const oninit = fn("int OnInit()", "void OnDeinit(");

// ---------------------------------------------------------------- SOURCE
test("SOURCE 2.42 RecoveryStateSafe replaces the automatic StartClean and runs in OnInit after the history recovery, before the first synchronisation", () => {
  assert.ok(!/\bStartClean\(/.test(ea.replace(/\/\/.*$/gm, "")), "the automatic StartClean must be gone");
  const a = oninit.indexOf("RecoverHistory();"), p = oninit.indexOf("PurgeLegacyLevels();"), b = oninit.indexOf("RecoveryStateSafe();"), au = oninit.indexOf("StartupAudit();"), c = oninit.indexOf("SyncAll();");
  assert.ok(a > 0 && p > a && b > p && au > b && c > au, "order: RecoverHistory < PurgeLegacyLevels < RecoveryStateSafe < StartupAudit < SyncAll");
  assert.ok(oninit.indexOf("UncLoad();") < oninit.indexOf("ReqJournalRecover();") && oninit.indexOf("ReqJournalRecover();") < b, "unresolved requests are restored BEFORE the recovery decision");
});

test("SOURCE 2.42 the recovery pass classifies position -> pending orders -> unresolved request -> running cycle -> nothing, in that order", () => {
  const order = ["RCV_POSITION", "RCV_CLOSE_PENDING", "RCV_ORDERS_ADOPTED", "RCV_STALE_ORDERS", "RCV_CONFLICT", "RCV_UNRESOLVED", "RCV_COMPLETING", "RCV_CONTINUE_CYCLE", "RCV_WAIT_USER"];
  let last = -1;
  for (const c of order) { const i = rsf.indexOf('"' + c + '"'); assert.ok(i > last, c + " missing or out of order"); last = i; }
  assert.ok(rsf.includes('LogOrder("RECOVERY"'), "the decision and its evidence are written to Orders.csv");
});

test("SOURCE 2.42 the recovery pass never deletes an order and never creates one (no CleanupOrders / DeleteOrder / TryPlace / ResetRisk inside)", () => {
  const code = rsf.replace(/\/\/.*$/gm, "");
  for (const bad of ["CleanupOrders(", "DeleteOrder(", "TryPlace(", "ResetRisk", "g_trade.", "ExecStop(", "ExecCancel("]) assert.ok(!code.includes(bad), "RecoveryStateSafe must not call " + bad);
  const hold = fn("void RecoveryHold(", "void RecoveryRelease(");
  assert.ok(!/DeleteOrder\(|CleanupOrders\(|TryPlace\(/.test(hold));
});

test("SOURCE 2.42 an open position is adopted untouched: the position branch changes no state, no level and no ledger", () => {
  const i = rsf.indexOf("if(np>0)"), j = rsf.indexOf("else if(g_state==YT_BUY_ACTIVE");
  const pos = rsf.slice(i, j);
  assert.ok(pos.includes('code="RCV_POSITION"'));
  for (const bad of ["g_state=", "g_mode=", "g_buyLevel=", "g_sellLevel=", "SaveState", "g_cyc", "g_seq"]) assert.ok(!pos.includes(bad), "position branch must not touch " + bad);
});

test("SOURCE 2.42 a conflict nobody can prove becomes REQUIRED_RECOVERY: no placement, no deletion, released only by the conflict disappearing or an explicit user action", () => {
  assert.ok(ea.includes("bool          g_recHold=false;"));
  assert.ok(/if\(g_recHold\) return false;/.test(fn("bool TryPlace(", "void EnforceSinglePosition(")), "TryPlace is blocked while the hold stands");
  assert.ok(/if\(g_recHold\) \{ RecoveryHoldTick\(\); return; \}/.test(fn("void Reconcile()", "void SyncAll()")), "Reconcile only re-checks the hold (no delete, no place)");
  const tick = fn("void RecoveryHoldTick()", "//--- what the order history says");
  assert.ok(tick.includes("RecoveryRelease(") && !tick.includes("DeleteOrder("));
  for (const f of ["string ExecCancel(", "bool ExecStop(", "bool ApplyLevels("]) assert.ok(/RecoveryRelease\(/.test(fn(f, "\n  }\n")), f + " must release the hold (explicit user decision)");
  const ds = fn("string DoStart(", "bool CleanupPositions(");
  assert.ok(/if\(g_recHold\) return "❌ START FAILED/.test(ds), "START is refused while REQUIRED_RECOVERY stands");
});

test("SOURCE 2.42 only the case 'no order, no position, no unresolved request, no running step' clears the saved levels and goes IDLE; the cycle ledger is never reset", () => {
  const i = rsf.indexOf('code="RCV_WAIT_USER"');
  const w = rsf.slice(i, rsf.indexOf('LogOrder("RECOVERY"'));
  for (const need of ["g_buyLevel=0.0", "g_sellLevel=0.0", "g_pendBuy=0.0", "g_pendSell=0.0", "g_mode=YM_NONE", "g_state=YT_IDLE", "SaveState();"]) assert.ok(w.includes(need), need);
  for (const keep of ["g_cycNet", "g_cycId", "g_accLoss", "g_seq", "g_tradeNo", "g_cycLosses", "ResetRisk"]) assert.ok(!w.includes(keep), "WAIT_USER must not touch " + keep);
  assert.ok(/if\(cycOn && g_buyLevel>g_sellLevel && g_sellLevel>0\.0\)/.test(rsf), "v2.43: a cycle holding a debt continues instead of being dropped (ARMED or WAITING_REENTRY)");
  assert.ok(rsf.includes("RCV_DEBT_NO_LEVELS"), "v2.43: a debt without saved levels is KEPT and waits for levels (never IDLE)");
});

test("SOURCE 2.42 the startup alert about an idle mid-cycle bot and the StartupAudit text stay consistent with the new rule", () => {
  assert.ok(oninit.includes('RaiseAlert("SEQIDLE"'));
  assert.ok(!/pending orders exist although none is wanted in this state \(they are removed\)/.test(ea));
  assert.ok(ea.includes("RECOVERY: REQUIRED_RECOVERY - "), "/status shows the hold");
});

test("SOURCE 2.42 no input of the strategy / risk was added or changed", () => {
  const orig = readFileSync(new URL("./fixtures/ea-2.39-inputs.txt", import.meta.url), "utf8").trim().split("\n");
  const now = ea.split("\n").filter((l) => /^\s*input\s/.test(l)).map((l) => l.trim());
  assert.deepEqual(now, orig.map((l) => l.trim()));
});

// ---------------------------------------------------------------- MODEL
// pure transcription of RecoveryStateSafe() / RecoveryOrderMatches()
const matches = (s, o) => (s.state === "ARMED" || s.state === "WAITING_REENTRY") &&
  ((o.side === "BUY" && (s.mode === "BOTH" || s.mode === "BUY") && (o.ticket === s.tkBuy || o.price === s.buy)) ||
   (o.side === "SELL" && (s.mode === "BOTH" || s.mode === "SELL") && (o.ticket === s.tkSell || o.price === s.sell)));
function recover(s, b) {
  const cycOn = !(s.accLoss === 0 && s.cycNet === 0);
  if (b.positions > 0) return { code: "RCV_POSITION", hold: false, sendsNew: false, deletes: false };
  if (s.state === "BUY_ACTIVE" || s.state === "SELL_ACTIVE") return { code: "RCV_CLOSE_PENDING", hold: false, sendsNew: false, deletes: false };
  if (b.orders.length > 0) {
    const bad = b.orders.filter((o) => !matches(s, o));
    if (bad.length === 0) return { code: "RCV_ORDERS_ADOPTED", hold: false, sendsNew: false, deletes: false };
    if (s.state === "STOPPED" || s.state === "TP_RESET" || s.cycState === "COMPLETING") return { code: "RCV_STALE_ORDERS", hold: false, sendsNew: false, deletes: true };
    return { code: "RCV_CONFLICT", hold: true, sendsNew: false, deletes: false };
  }
  if (b.unc) return { code: "RCV_UNRESOLVED", hold: false, sendsNew: false, deletes: false };
  if (s.cycState === "COMPLETING") return { code: "RCV_COMPLETING", hold: false, sendsNew: false, deletes: false };
  if (s.state === "ARMED" || s.state === "WAITING_REENTRY") {
    if (cycOn && s.buy > s.sell && s.sell > 0) return { code: "RCV_CONTINUE_CYCLE", hold: false, sendsNew: false, deletes: false, keepsLedger: true };
    if (cycOn) return { code: "RCV_DEBT_NO_LEVELS", hold: false, sendsNew: false, deletes: false, keepsLedger: true };
    return { code: "RCV_WAIT_USER", hold: false, sendsNew: false, deletes: false, clearsLevels: true, keepsLedger: true };
  }
  return { code: "RCV_NOTHING", hold: false, sendsNew: false, deletes: false };
}
const S = (o = {}) => ({ state: "ARMED", mode: "BOTH", buy: 4200, sell: 4190, tkBuy: 11, tkSell: 12, accLoss: 0, cycNet: 0, lastDeal: 0, cycState: "ACTIVE", ...o });

test("MODEL situation 1 - the order was executed at the broker and the bot died: the open trade is adopted, NO duplicate entry, ledger untouched", () => {
  const r = recover(S({ state: "BUY_ACTIVE", accLoss: 30, cycNet: -30 }), { positions: 1, orders: [{ side: "SELL", ticket: 12, price: 4190 }], unc: false });
  assert.equal(r.code, "RCV_POSITION"); assert.equal(r.sendsNew, false); assert.equal(r.deletes, false); assert.equal(r.hold, false);
});
test("MODEL situation 1b - the trade was executed AND closed during the downtime: the history decides (safe state, no order before the closing deal is booked)", () => {
  const r = recover(S({ state: "SELL_ACTIVE", accLoss: 12, cycNet: -12 }), { positions: 0, orders: [], unc: false });
  assert.equal(r.code, "RCV_CLOSE_PENDING"); assert.equal(r.sendsNew, false);
});
test("MODEL situation 2 - a pending order waits at the broker and matches the saved state: adopted, not deleted, not duplicated", () => {
  const r = recover(S(), { positions: 0, orders: [{ side: "BUY", ticket: 11, price: 4200 }, { side: "SELL", ticket: 12, price: 4190 }], unc: false });
  assert.deepEqual([r.code, r.deletes, r.sendsNew, r.hold], ["RCV_ORDERS_ADOPTED", false, false, false]);
  const one = recover(S(), { positions: 0, orders: [{ side: "SELL", ticket: 99, price: 4190 }], unc: false });   // the other side is created later by the normal pass, only if missing
  assert.equal(one.code, "RCV_ORDERS_ADOPTED");
});
test("MODEL situation 3 - no order, no position, no unresolved request, no running step: the bot waits for the user and creates nothing from old levels", () => {
  const r = recover(S(), { positions: 0, orders: [], unc: false });
  assert.deepEqual([r.code, r.sendsNew, r.clearsLevels, r.keepsLedger], ["RCV_WAIT_USER", false, true, true]);
  assert.equal(recover(S({ state: "IDLE" }), { positions: 0, orders: [], unc: false }).code, "RCV_NOTHING");
});
test("MODEL a cycle that must go on (stop loss booked, compensation running) is continued, not dropped; an unresolved request is verified first", () => {
  assert.equal(recover(S({ state: "WAITING_REENTRY", accLoss: 20, cycNet: -20, lastDeal: 777 }), { positions: 0, orders: [], unc: false }).code, "RCV_CONTINUE_CYCLE");
  assert.equal(recover(S(), { positions: 0, orders: [], unc: true }).code, "RCV_UNRESOLVED");
});
test("MODEL a conflict nobody can prove -> REQUIRED_RECOVERY (no new order, nothing deleted); a finished / stopped cycle's leftovers are provably stale", () => {
  const conflict = recover(S({ state: "IDLE" }), { positions: 0, orders: [{ side: "BUY", ticket: 5, price: 4300 }], unc: false });
  assert.deepEqual([conflict.code, conflict.hold, conflict.deletes, conflict.sendsNew], ["RCV_CONFLICT", true, false, false]);
  const moved = recover(S(), { positions: 0, orders: [{ side: "BUY", ticket: 55, price: 4300 }], unc: false });
  assert.equal(moved.code, "RCV_CONFLICT");
  const stale = recover(S({ state: "STOPPED" }), { positions: 0, orders: [{ side: "BUY", ticket: 5, price: 4300 }], unc: false });
  assert.deepEqual([stale.code, stale.hold, stale.deletes], ["RCV_STALE_ORDERS", false, true]);
});
test("MODEL a restart can never zero the cumulative loss or the sequence in ANY branch", () => {
  for (const st of ["ARMED", "WAITING_REENTRY", "IDLE", "BUY_ACTIVE", "STOPPED", "TP_RESET"])
    for (const orders of [[], [{ side: "BUY", ticket: 1, price: 4200 }]])
      for (const unc of [false, true]) {
        const r = recover(S({ state: st, accLoss: 25, cycNet: -25, lastDeal: 5 }), { positions: 0, orders, unc });
        assert.ok(!("resetsLedger" in r) && r.sendsNew === false, `${st}/${orders.length}/${unc}`);
      }
});

test("MODEL v2.43 an ARMED cycle with a debt and saved levels continues after a restart (never IDLE); without levels the debt waits, kept", () => {
  assert.equal(recover(S({ state: "ARMED", accLoss: 40, cycNet: -40 }), { positions: 0, orders: [], unc: false }).code, "RCV_CONTINUE_CYCLE");
  const nl = recover(S({ state: "ARMED", accLoss: 40, cycNet: -40, buy: 0, sell: 0 }), { positions: 0, orders: [], unc: false });
  assert.deepEqual([nl.code, nl.keepsLedger, nl.sendsNew], ["RCV_DEBT_NO_LEVELS", true, false]);
});
