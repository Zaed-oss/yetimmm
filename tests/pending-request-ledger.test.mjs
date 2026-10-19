// v4.26.0 (EA 2.40): pending-request ledger (report "استكمال النواقص الفنية", sections 2-6).
// TWO kinds of test live here and are labelled in their names:
//   SOURCE  - the EA source (Yetimmm.mq5) has the structure the report requires. The EA is NOT compiled or run here.
//   MODEL   - a JavaScript transcription of the ledger rules, driven through the report's scenarios. It proves the RULES are consistent;
//             it is NOT a MetaTrader run and does not replace F7 + Strategy Tester + Demo (docs/MT5-TESTING.md).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const ea = readFileSync(new URL("../ea/Yetimmm.mq5", import.meta.url), "utf8");
const fn = (head, next) => { const i = ea.indexOf(head); assert.ok(i > 0, head + " missing"); const j = ea.indexOf(next, i + head.length); assert.ok(j > i, next + " missing"); return ea.slice(i, j); };

// ---------------------------------------------------------------- SOURCE
test("SOURCE 2.40 the ledger is persisted, restored at start and verified before any send", () => {
  for (const k of ["struct SUncReq", "void UncSave(", "void UncLoad(", "int UncProbe(", "bool UncVerify(", "bool UncBlocks(", "void UncTick(", "void UncOpen(", "void UncClose("]) assert.ok(ea.includes(k), k);
  const save = fn("void UncSave(", "//--- restart:");
  for (const k of ['"ON"', '"T"', '"P"', '"L"', '"K"', '"R"', '"I"', '"C"', '"Q"', "GlobalVariablesFlush();"]) assert.ok(save.includes(k), k);
  const init = fn("int OnInit()", "void OnDeinit(");
  assert.ok(init.indexOf("UncLoad();") > 0 && init.indexOf("UncLoad();") < init.indexOf("SyncAll();"), "UncLoad must run before the first synchronisation");
  assert.ok(init.indexOf("StartupAudit();") > 0 && init.indexOf("StartupAudit();") < init.indexOf("SyncAll();"));
  assert.ok(fn("void SyncAll()\n  {", "//+---").indexOf("UncTick();") > 0);
});

test("SOURCE 2.40 the probe looks at live orders, positions AND the order history, and never concludes from an unreadable history", () => {
  const p = fn("int UncProbe(", "void UncClose(");
  assert.ok(p.includes("OrderSelect(g_unc[s].ticket)") && p.includes("OwnOrders(t)"));
  assert.ok(p.includes("OwnPositions(p)") && p.includes("POSITION_TIME"));
  assert.ok(p.includes("HistorySelect(") && p.includes("HistoryOrdersTotal()") && p.includes("ORDER_TIME_SETUP") && p.includes("ORDER_VOLUME_INITIAL"));
  assert.ok(p.includes("return YU_NOHIST;"));
  const v = fn("bool UncVerify(", "//--- called by TryPlace before ANY request");
  assert.ok(!/YU_NOHIST[\s\S]{0,40}UncClose\(s,YU_UNKNOWN/.test(v));           // NOHIST can never become "absent"
  assert.ok(v.includes("TERMINAL_CONNECTED") && v.includes("g_unc[s].startMs=now;"));   // an offline period restarts the window
  assert.ok(v.includes("g_unc[s].checks>=5") && v.includes("g_unc[s].histOk>=3") && v.includes("YT_UNC_SETTLE_SEC"));
});

test("SOURCE 2.40 TryPlace: a record blocks the side BEFORE any request; accepted-but-invisible orders open a record too", () => {
  const t = fn("bool TryPlace(", "//+---");
  assert.ok(t.indexOf("if(UncBlocks(buy)) return false;") < t.indexOf("g_trade.BuyStop("));
  assert.ok(/PLACED_UNVERIFIED[\s\S]{0,200}UncOpen\(buy,level,lot,ticket,rc,/.test(t));
  const u = t.slice(t.indexOf("if(cls==YR_UNCERT)"), t.indexOf('LogOrder("REJECTED"'));
  assert.ok(u.includes("UncOpen(") && !/g_seq\+\+|g_failCount|YT_ERROR/.test(u));
});

test("SOURCE 2.40 events: a late answer only wakes the verification; a repeated deal event is not processed twice; nothing is sent from the handler", () => {
  const h = fn("void OnTradeTransaction(", "int g_timerCount");
  assert.ok(h.includes("TRADE_TRANSACTION_REQUEST") && h.includes("UNCERTAIN_LATE_RESULT") && h.includes("g_unc[rs].nextMs=0;"));
  assert.ok(/ORDER_ADD\)[\s\S]{0,160}g_unc\[us\]\.nextMs=0;/.test(h));
  assert.ok(h.includes("TransDealSeen(trans.deal)"));
  assert.ok(h.indexOf("TransDealSeen(trans.deal)") < h.indexOf("RegisterPosition(pid)"));
  assert.ok(!/TryPlace\(|OrderDelete|g_trade\.|PositionClose/.test(h));
  assert.ok(h.includes("ArmFill(trans.deal)"));
});

test("SOURCE 2.40 a pre-armed reverse order that the market has just triggered is not deleted while the server executes it (bounded 5 s)", () => {
  const d = fn("bool DeleteOrder(", "//+---");
  assert.ok(d.includes('GV("PAO",0.0)==ticket') && d.includes("OrderTriggeredNow(type,price)") && d.includes("DELETE_SKIPPED_TRIGGERED") && d.includes("<5000"));
  assert.ok(d.includes("ArmDropTicket(ticket)"));
});

test("SOURCE 2.40 arm timeline: accepted / last verified / touch / execution and requested-vs-actual price are logged; it only measures", () => {
  const w = fn("void ArmTouchWatch(", "bool TryPlace(");
  for (const k of ["ARM_TOUCH", "ARM_TIMELINE", "adverse slippage", "last server check", "WITHOUT a touch tick"]) assert.ok(w.includes(k), k);
  assert.ok(!/g_trade\.|OrderSend|TryPlace\(|DeleteOrder\(/.test(w));
  const o = fn("void OnTick()", "void OnTrade()");
  assert.ok(o.includes("ArmTouchWatch(t0,now);"));
  assert.ok(ea.includes("ARM_LOST") && ea.includes("COVERAGE_AT_CLOSE") && ea.includes("STARTUP_AUDIT"));
});

test("SOURCE 2.40 Netting stays on the safe path: no pre-armed reverse order, documented in the log, no market order, strategy rules untouched", () => {
  assert.ok(ea.includes("if(!InpPreArmReverse || g_netting) return 0;"));
  assert.ok(ea.includes("if(np!=2 || !InpPreArmReverse || g_netting) return false;"));
  assert.ok(ea.includes("NOT armed - Netting account"));
  assert.ok(ea.includes("NettingDriftCheck(pos[np-1])"));
  assert.ok(/YT_REAL_ORDERS_ONLY[^\n]*true/.test(ea));
  for (const k of ["double NextRiskForNet(", "void EnforceSinglePosition(", "BREACH_WAIT", "InpMaxDeviation"]) assert.ok(ea.includes(k), k);
});

test("SOURCE 2.40 no input of the strategy was added or changed (entry / lot / TP / SL / slippage / zone gate)", () => {
  const orig = readFileSync(new URL("./fixtures/ea-2.39-inputs.txt", import.meta.url), "utf8").trim().split("\n");
  const now = ea.split("\n").filter((l) => /^\s*input\s/.test(l)).map((l) => l.trim());
  assert.deepEqual(now, orig.map((l) => l.trim()));
});

// ---------------------------------------------------------------- MODEL
// Transcription of UncOpen / UncVerify / UncProbe / UncClose and of the TryPlace guard. 'server' is injected by each scenario.
function makeEA(server, { settleSec = 30 } = {}) {
  const st = { rec: null, nextId: 0, sends: 0, log: [], now: 0, saved: null };
  const L = (e) => st.log.push(e);
  const probe = () => {
    if (server.orders.some((o) => o.side === st.rec.side || o.ticket === st.rec.ticket)) return "ORDER";
    if (server.positions.some((p) => p.side === st.rec.side && p.time + 5 >= st.rec.reqTime)) return "FILLED";
    if (!server.historyOk) return "NOHIST";
    const h = server.history.find((o) => o.side === st.rec.side && Math.abs(o.price - st.rec.level) < 0.005 && Math.abs(o.vol - st.rec.lot) < 0.005 && o.setup + 5 >= st.rec.reqTime);
    if (h) return h.state === "FILLED" ? "FILLED" : "GONE";
    return "UNKNOWN";
  };
  const close = (pr) => { L(pr === "UNKNOWN" ? "UNCERTAIN_ABSENT" : "UNCERTAIN_RESOLVED:" + pr); st.rec = null; st.saved = null; };
  const verify = () => {
    if (!st.rec) return false;
    if (st.now < st.rec.nextMs) return true;
    st.rec.checks++; st.rec.nextMs = st.now + (st.rec.checks < 4 ? 400 : 3000);
    if (!server.connected) { st.rec.startMs = st.now; return true; }
    const pr = probe();
    if (["ORDER", "FILLED", "GONE"].includes(pr)) { close(pr); return false; }
    if (pr === "UNKNOWN" && st.rec.checks >= 3 && st.now - st.rec.startMs >= settleSec * 1000) { close("UNKNOWN"); return false; }
    return true;
  };
  const open = (side, level, lot, ticket = 0) => {
    st.rec = { side, level, lot, ticket, id: ++st.nextId, reqTime: server.time, startMs: st.now, nextMs: st.now + 300, checks: 0 };
    st.saved = JSON.stringify(st.rec); L("UNCERTAIN_OPEN");
  };
  // TryPlace: guard first, then ONE request; the server decides what the request did
  const tryPlace = (side, level, lot, outcome) => {
    if (st.rec && st.rec.side === side && verify()) return "BLOCKED";
    if (server.orders.some((o) => o.side === side)) return "EXISTS";
    st.sends++;
    outcome(st);                                   // 'ok' | 'timeout' | 'reject'
    return "SENT";
  };
  const restart = () => { const saved = st.saved; st.rec = saved ? { ...JSON.parse(saved), startMs: st.now, nextMs: 0, checks: 0 } : null; };
  return { st, verify, open, tryPlace, restart, tick: (ms) => { st.now += ms; server.time += Math.round(ms / 1000); } };
}
const newServer = () => ({ connected: true, historyOk: true, time: 1000, orders: [], positions: [], history: [] });
const timeout = (srv, ea, deliver) => (st) => { ea.open("BUY", 4200, 0.1); if (deliver) srv.late = true; };

test("MODEL 2.40 timeout, the order appears LATE: it is adopted and the request is never repeated", () => {
  const srv = newServer(); const ea = makeEA(srv);
  assert.equal(ea.tryPlace("BUY", 4200, 0.1, () => ea.open("BUY", 4200, 0.1)), "SENT");
  for (let i = 0; i < 20; i++) { ea.tick(500); const r = ea.tryPlace("BUY", 4200, 0.1, () => {}); assert.notEqual(r, "SENT"); }   // unresolved: nothing is sent
  srv.orders.push({ side: "BUY", ticket: 77 });                        // the broker publishes the order after 10 s
  ea.st.rec.nextMs = 0;                                                // ORDER_ADD event wakes the verification at once
  ea.tick(500); const r = ea.tryPlace("BUY", 4200, 0.1, () => {});
  assert.equal(r, "EXISTS"); assert.equal(ea.st.sends, 1); assert.ok(ea.st.log.includes("UNCERTAIN_RESOLVED:ORDER"));
});

test("MODEL 2.40 timeout and the request never arrived: NO resend before the settle window, ONE resend after it", () => {
  const srv = newServer(); const ea = makeEA(srv);
  ea.tryPlace("BUY", 4200, 0.1, () => ea.open("BUY", 4200, 0.1));
  let resent = -1;
  for (let i = 1; i <= 80; i++) { ea.tick(500); if (ea.tryPlace("BUY", 4200, 0.1, () => {}) === "SENT") { resent = i * 0.5; break; } }
  assert.ok(resent >= 30, "resend only after the 30 s verified window (was " + resent + " s)");
  assert.equal(ea.st.sends, 2); assert.ok(ea.st.log.includes("UNCERTAIN_ABSENT"));
});

test("MODEL 2.40 connection loss freezes and restarts the window: an absence seen offline proves nothing", () => {
  const srv = newServer(); const ea = makeEA(srv);
  ea.tryPlace("BUY", 4200, 0.1, () => ea.open("BUY", 4200, 0.1));
  srv.connected = false;
  for (let i = 0; i < 200; i++) { ea.tick(500); assert.notEqual(ea.tryPlace("BUY", 4200, 0.1, () => {}), "SENT"); }   // 100 s offline
  srv.connected = true;
  for (let i = 0; i < 40; i++) { ea.tick(500); assert.notEqual(ea.tryPlace("BUY", 4200, 0.1, () => {}), "SENT"); }   // 20 s online: still inside the new window
  assert.equal(ea.st.sends, 1);
});

test("MODEL 2.40 the history shows the order was rejected / cancelled / filled: resolved without guessing", () => {
  for (const [state, want] of [["REJECTED", "UNCERTAIN_RESOLVED:GONE"], ["CANCELED", "UNCERTAIN_RESOLVED:GONE"], ["FILLED", "UNCERTAIN_RESOLVED:FILLED"]]) {
    const srv = newServer(); const ea = makeEA(srv);
    ea.tryPlace("BUY", 4200, 0.1, () => ea.open("BUY", 4200, 0.1));
    srv.history.push({ side: "BUY", price: 4200, vol: 0.1, setup: srv.time, state });
    ea.tick(500); ea.verify(); ea.tick(500); ea.verify();
    assert.ok(ea.st.log.includes(want), state + " -> " + want);
    assert.equal(ea.st.sends, 1);
  }
});

test("MODEL 2.40 an unreadable history never turns into 'absent'", () => {
  const srv = newServer(); srv.historyOk = false; const ea = makeEA(srv);
  ea.tryPlace("BUY", 4200, 0.1, () => ea.open("BUY", 4200, 0.1));
  for (let i = 0; i < 400; i++) { ea.tick(500); assert.notEqual(ea.tryPlace("BUY", 4200, 0.1, () => {}), "SENT"); }
  assert.equal(ea.st.sends, 1);
});

test("MODEL 2.40 restart with an open record: it is restored and still blocks the side; the order that appeared meanwhile is adopted", () => {
  const srv = newServer(); const ea = makeEA(srv);
  ea.tryPlace("BUY", 4200, 0.1, () => ea.open("BUY", 4200, 0.1));
  ea.restart();
  assert.ok(ea.st.rec, "record restored");
  assert.equal(ea.tryPlace("BUY", 4200, 0.1, () => {}), "BLOCKED");
  srv.orders.push({ side: "BUY", ticket: 5 }); ea.tick(500);
  assert.equal(ea.tryPlace("BUY", 4200, 0.1, () => {}), "EXISTS"); assert.equal(ea.st.sends, 1);
});

test("MODEL 2.40 the other side is never blocked by a record of this side", () => {
  const srv = newServer(); const ea = makeEA(srv);
  ea.tryPlace("BUY", 4200, 0.1, () => ea.open("BUY", 4200, 0.1));
  assert.equal(ea.tryPlace("SELL", 4180, 0.1, () => {}), "SENT");
});

test("MODEL 2.40 a position opened by the unknown request resolves it as executed (no second order)", () => {
  const srv = newServer(); const ea = makeEA(srv);
  ea.tryPlace("BUY", 4200, 0.1, () => ea.open("BUY", 4200, 0.1));
  srv.positions.push({ side: "BUY", time: srv.time + 2 }); ea.tick(500); ea.verify(); ea.tick(500); ea.verify();
  assert.ok(ea.st.log.includes("UNCERTAIN_RESOLVED:FILLED")); assert.equal(ea.st.sends, 1);
});

test("MODEL 2.40 a repeated deal event is processed once (ring of 16)", () => {
  const ring = new Array(16).fill(0); let pos = 0;
  const seen = (d) => { if (ring.includes(d)) return true; ring[pos] = d; pos = (pos + 1) % 16; return false; };
  assert.equal(seen(900), false); assert.equal(seen(900), true); assert.equal(seen(901), false);
});
