// v4.28.0 (EA 2.42): FAST REVERSE after a stop-loss close (Fix_1, problem 3).
//   SOURCE - structure of Yetimmm.mq5 (NOT compiled or run here).   MODEL - JavaScript transcription of the sequencing / de-duplication rules.
// No claim is made about milliseconds: the speed depends on the connection, the broker and the trade server. The EA MEASURES it (REVERSE_TIMELINE in Orders.csv).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const ea = readFileSync(new URL("../ea/Yetimmm.mq5", import.meta.url), "utf8");
const fn = (head, next) => { const i = ea.indexOf(head); assert.ok(i > 0, head + " missing"); const j = ea.indexOf(next, i + head.length); assert.ok(j > i, next + " missing"); return ea.slice(i, j); };
const pcp = fn("bool ProcessClosedPosition(", "void CheckClosures()");
const tp = fn("bool TryPlace(", "void EnforceSinglePosition(");
const ots = fn("void OnTradeTransaction(", "int g_timerCount=0;");

// ---------------------------------------------------------------- SOURCE
test("SOURCE 2.42 the close is detected from OnTradeTransaction (not only from the periodic pass), its CAUSE is read and logged after the synchronisation", () => {
  assert.ok(ots.includes("g_tlTrMs=GetTickCount64();"));
  assert.ok(ots.includes("DealReasonText(HistoryDealGetInteger(trans.deal,DEAL_REASON))"), "the cause is read, never assumed");
  assert.ok(ots.indexOf("SyncAll();") > 0 && ots.indexOf('LogOrder("CLOSE_EVENT"') > ots.indexOf("SyncAll();"), "the log line is written AFTER the synchronisation (no extra latency before the reversal)");
  assert.ok(ots.includes("TransDealSeen(trans.deal)"), "a repeated event of the same deal is never processed twice");
  for (const r of ["STOP LOSS", "TAKE PROFIT", "STOP OUT", "MANUAL (desktop)", "MANUAL (mobile)", "MANUAL (web)"]) assert.ok(ea.includes('"' + r + '"'), r);
});

test("SOURCE 2.42 the reversal starts only for a VERIFIED stop loss: booked + saved first, no other position, state WAITING_REENTRY, not an old event", () => {
  const i = pcp.indexOf("FastReverseNow();");
  assert.ok(i > 0);
  const before = pcp.slice(pcp.lastIndexOf("SaveState();", i), i);
  assert.ok(/if\(isSL && !bookkeeping && !keepState && !tainted && others==0 && g_state==YT_WAITING_REENTRY\)/.test(before));
  const b2 = pcp.slice(0, i);
  assert.ok(b2.lastIndexOf("g_lastDeal=dealOut;") > b2.lastIndexOf("CycleBook(net,\"SL\")"), "the closing deal id is saved together with the new ledger before the placement starts");
  assert.ok(i < pcp.indexOf("AppendLine(TradeFile()"), "the order starts BEFORE the trade-log file, statistics and notifications are written");
  assert.equal((pcp.match(/FastReverseNow\(\);/g) || []).length, 1, "one call site, only the stop-loss path");
});

test("SOURCE 2.42 the booked-but-not-yet-logged position never blocks its own reversal, and the exception is closed right after the log is written", () => {
  assert.ok(/if\(g_bookedPid!=0 && g_pids\[i\]==g_bookedPid\) continue;/.test(fn("bool ClosurePendingBlocks()", "//--- v2.34: every reason")));
  assert.ok(/MarkLogged\(pid,dealOut\);\n   g_bookedPid=0;/.test(pcp));
  const f = fn("void FastReverseNow()", "//+------------------------------------------------------------------+\n//| Reconcile");
  assert.ok(f.includes("if(g_recHold || g_halt) return;") && f.includes("Reconcile();"), "it runs the normal placement pass - same guards, same rules");
});

test("SOURCE 2.42 Netting safety is untouched: a residual position, a foreign position, an unresolved request and a pending closing all still block the order", () => {
  assert.ok(/if\(gpn>0 && !\(g_revCtx && gpn==1\)\)/.test(tp), "hard guard: no new order while a position is open");
  assert.ok(ea.includes("if(NettingBlocked()) return;"));
  assert.ok(tp.includes("UncBlocks(buy)") && tp.includes("ClosurePendingBlocks()"));
  assert.ok(/if\(!InpPreArmReverse \|\| g_netting\) return 0;/.test(fn("int ReverseArmDecision(", "//--- maintain the reverse order")), "no pre-armed reverse order next to a Netting position (merge risk) - unchanged");
  assert.equal((ea.match(/g_trade\.(Buy|Sell)\(/g) || []).length, 2, "still no new market-order send");
});

test("SOURCE 2.42 Netting: the plan of the opposite order is prepared while the trade is open (direction, level, predicted risk / lot) and re-validated after the close, never frozen", () => {
  const np = fn("void NetPrepare(", "//--- v2.42: called from ProcessClosedPosition");
  for (const k of ["NextRiskForNet(g_cycNet-predLoss)", "CalcLot(risk,revBuy,level,lot,est,err)", "g_pvOk=true;"]) assert.ok(np.includes(k), k);
  assert.ok(!/TryPlace\(|g_trade\.|OrderSend/.test(np.replace(/\/\/.*$/gm, "")), "the preparation sends nothing");
  assert.ok(/if\(g_netting && np==1 && haveFill\) NetPrepare\(pos\[0\],fillBuy\);/.test(fn("void Reconcile()", "void SyncAll()")));
  assert.ok(tp.includes("CalcLot(g_curRisk,buy,level,lot,est,err)"), "the final lot is computed again from the real ledger before the send");
  assert.ok(tp.includes("recomputed after the close"));
});

test("SOURCE 2.42 one reversal per closed position: a unique id (the closed position id) is recorded in the journal and in the timeline", () => {
  assert.ok(pcp.includes("g_revPid=pid;"));
  assert.ok(fn("long ReqPrepare(", "//--- moves the record").includes('GS(JKey(s,"D"),(double)g_revPid);'));
  assert.ok(tp.includes('"reversal of closed position #"+UL(g_revPid)'));
});

test("SOURCE 2.42 the five timings are measured and written separately: close seen, loss booked, request sent, broker answer, total", () => {
  const i = tp.indexOf('LogOrder("REVERSE_TIMELINE"'); assert.ok(i > 0);
  const t = tp.slice(i, i + 900);
  for (const k of ["close seen -> loss booked", "booked -> request sent", "broker answer (RTT)", "TOTAL close seen -> broker confirmation", "OnTradeTransaction"]) assert.ok(t.includes(k), k);
  assert.ok(tp.includes("const ulong sendMs=GetTickCount64();"));
  assert.ok(pcp.includes("g_tlBookMs=GetTickCount64();"));
  assert.ok(/if\(!isSL\) \{ g_tlTrMs=0; g_tlBookMs=0; \}/.test(pcp), "a TP / manual close never leaves a stale timestamp behind");
});

// ---------------------------------------------------------------- MODEL
// Transcription of: OnTradeTransaction (dedupe) -> ProcessClosedPosition (book once, fast path) -> TryPlace guards -> journal.
function makeWorld({ netting = false, residual = 0, uncOpen = false } = {}) {
  const w = { seenDeals: new Set(), booked: new Set(), logged: new Set(), orders: [], sent: [], log: [], residual, netting, uncOpen, ledgerLoss: 0, seq: 0, t: 0 };
  w.onDeal = (deal) => {                                   // OnTradeTransaction
    if (w.seenDeals.has(deal.id)) { w.log.push("EVENT_DUP_IGNORED"); return; }
    w.seenDeals.add(deal.id); w.tTr = w.tTr ?? w.t;
    w.syncAll(deal);
  };
  w.syncAll = (deal) => {                                  // CheckClosures -> ProcessClosedPosition (+ Reconcile)
    if (w.booked.has(deal.pid)) return;                    // IsLoggedPos / g_lastDeal replay guard: the loss counts once
    w.booked.add(deal.pid);
    if (deal.reason !== "SL") { w.log.push("NO_REVERSAL:" + deal.reason); return; }
    w.ledgerLoss += deal.loss; w.seq++;
    w.revPid = deal.pid; w.tBook = w.t;                    // saved: fast path starts here
    w.fast();
  };
  w.fast = () => {
    if (w.residual > 0) { w.log.push("BLOCK_RESIDUAL"); return; }          // Netting: no order while volume remains
    if (w.uncOpen) { w.log.push("BLOCK_UNC"); return; }
    if (w.orders.some((o) => o.side === "REV")) { w.log.push("BLOCK_EXISTS"); return; }
    w.sent.push({ rev: w.revPid, risk: w.ledgerLoss }); w.orders.push({ side: "REV" }); w.log.push("REVERSE_SENT");
  };
  return w;
}
test("MODEL a stop loss starts exactly ONE reversal even when several events / reads arrive for the same close", () => {
  const w = makeWorld();
  const deal = { id: 900, pid: 55, reason: "SL", loss: 12.5 };
  w.onDeal(deal); w.onDeal(deal); w.syncAll(deal); w.onDeal({ ...deal, id: 901 });        // repeated event, periodic pass, a second deal of the same position
  assert.equal(w.sent.length, 1); assert.equal(w.ledgerLoss, 12.5); assert.equal(w.seq, 1);
});
test("MODEL a manual close or a take profit is NOT a stop loss: no reversal is started", () => {
  for (const reason of ["MANUAL", "TP", "STOP OUT"]) { const w = makeWorld(); w.onDeal({ id: 1, pid: 9, reason, loss: 3 }); assert.equal(w.sent.length, 0, reason); }
});
test("MODEL Netting: with a residual volume the reversal waits (no merged exposure); it is sent once the position is really flat", () => {
  const w = makeWorld({ netting: true, residual: 0.01 });
  w.onDeal({ id: 5, pid: 77, reason: "SL", loss: 8 });
  assert.equal(w.sent.length, 0); assert.ok(w.log.includes("BLOCK_RESIDUAL"));
  w.residual = 0; w.fast(); assert.equal(w.sent.length, 1); assert.equal(w.sent[0].risk, 8);
});
test("MODEL an unresolved previous request blocks the reversal (problem 2 mechanism) - it is verified first, never duplicated", () => {
  const w = makeWorld({ uncOpen: true });
  w.onDeal({ id: 5, pid: 78, reason: "SL", loss: 8 });
  assert.equal(w.sent.length, 0); assert.ok(w.log.includes("BLOCK_UNC"));
});
test("MODEL the loss is booked BEFORE the order starts and the risk sized from the real ledger (a prepared plan is only a forecast)", () => {
  const w = makeWorld();
  const forecast = 10;                                    // NetPrepare predicted loss
  w.onDeal({ id: 6, pid: 80, reason: "SL", loss: 10.4 }); // the real close slipped
  assert.equal(w.sent[0].risk, 10.4); assert.notEqual(w.sent[0].risk, forecast);
});
