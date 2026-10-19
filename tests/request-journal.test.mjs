// v4.28.0 (EA 2.42): REQUEST JOURNAL + reconciliation of unresolved requests (Fix_1, problem 2).
//   SOURCE - structure of Yetimmm.mq5 (NOT compiled or run here).   MODEL - JavaScript transcription of the journal / ledger rules driven through the report's scenarios.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const ea = readFileSync(new URL("../ea/Yetimmm.mq5", import.meta.url), "utf8");
const fn = (head, next) => { const i = ea.indexOf(head); assert.ok(i > 0, head + " missing"); const j = ea.indexOf(next, i + head.length); assert.ok(j > i, next + " missing"); return ea.slice(i, j); };
const tp = fn("bool TryPlace(", "void EnforceSinglePosition(");

// ---------------------------------------------------------------- SOURCE
test("SOURCE 2.42 the journal has the five phases and is saved to the global variables (survives a restart)", () => {
  for (const k of ["#define YJ_PREPARED   1", "#define YJ_SENT       2", "#define YJ_CONFIRMED  3", "#define YJ_REJECTED   4", "#define YJ_UNKNOWN    5", "long ReqPrepare(", "void ReqMark(", "bool ReqIsDuplicate(", "void ReqJournalRecover("]) assert.ok(ea.includes(k), k);
  const prep = fn("long ReqPrepare(", "//--- moves the record");
  for (const k of ['"I"', '"P"', '"L"', '"T"', '"C"', '"Q"', '"D"', "YJ_PREPARED"]) assert.ok(prep.includes(k), k);
  assert.ok(/st==YJ_SENT \|\| st==YJ_UNKNOWN\) GlobalVariablesFlush\(\)/.test(fn("void ReqMark(", "//--- is this exact request")), "SENT and UNKNOWN are flushed to disk");
});

test("SOURCE 2.42 the request is journaled BEFORE it leaves the terminal, and every answer path closes the record", () => {
  const prep = tp.indexOf("ReqPrepare(buy,level,lot)"), sent = tp.indexOf("ReqMark(s,YJ_SENT)"), send = tp.indexOf("g_trade.BuyStop(lot,level");
  assert.ok(prep > 0 && sent > prep && send > sent, "PREPARED < SENT < the broker call");
  assert.ok(tp.indexOf("PlanCheck(buy,level,lot);") < prep, "the financial plan is checked before the journal (latency-neutral)");
  for (const mark of ["ReqMark(s,verified?YJ_CONFIRMED:YJ_UNKNOWN)", "ReqMark(s,YJ_REJECTED)", "ReqMark(s,YJ_UNKNOWN)"]) assert.ok(tp.includes(mark), mark);
  assert.equal((tp.match(/ReqMark\(s,YJ_REJECTED\)/g) || []).length, 2, "price-moved race + definite rejection");
  assert.ok(/ReqMark\(s,\(pr==YU_ORDER \|\| pr==YU_FILLED\)\?YJ_CONFIRMED:YJ_REJECTED\)/.test(fn("void UncClose(", "//--- true => still undecided")), "the request ledger settles the journal");
});

test("SOURCE 2.42 before any send: position / pending order / unresolved request / cycle state / duplicate request are all checked", () => {
  const checks = ["OwnPositions(gp)", "SideOrderExists(buy)", "UncBlocks(buy)", "g_state!=YT_ARMED && g_state!=YT_WAITING_REENTRY", "ReqIsDuplicate(buy,level,lot)", "ClosurePendingBlocks()", "if(g_recHold) return false;"];
  for (const c of checks) assert.ok(tp.includes(c), c);
  assert.ok(tp.indexOf("UncBlocks(buy)") < tp.indexOf("g_trade.BuyStop(lot,level"));
});

test("SOURCE 2.42 restart: PREPARED is discarded (never sent), SENT / UNKNOWN is handed to the request ledger and verified; nothing is re-sent from the journal", () => {
  const r = fn("void ReqJournalRecover()", "//+------------------------------------------------------------------+\n//| v2.40 ARM TIMELINE");
  assert.ok(r.includes("REQ_NOT_SENT") && r.includes("UncOpen(buy,lv,lt,0,0,"));
  assert.ok(!/TryPlace\(|g_trade\.|OrderSend/.test(r.replace(/\/\/.*$/gm, "")), "the recovery only records, it never sends");
  const init = fn("int OnInit()", "void OnDeinit(");
  assert.ok(init.indexOf("UncLoad();") < init.indexOf("ReqJournalRecover();") && init.indexOf("ReqJournalRecover();") < init.indexOf("SyncAll();"));
});

test("SOURCE 2.42 a timeout alone never releases a side: the ledger needs >=5 checks, >=3 successful empty history reads and the verified-connection window", () => {
  const v = fn("bool UncVerify(", "//--- called by TryPlace before ANY request");
  assert.ok(/pr==YU_UNKNOWN && g_unc\[s\]\.checks>=5 && g_unc\[s\]\.histOk>=3 && \(now-g_unc\[s\]\.startMs\)>=\(ulong\)YT_UNC_SETTLE_SEC\*1000/.test(v));
  assert.ok(/pr==YU_NOHIST\) g_unc\[s\]\.histOk=0/.test(v), "an unreadable history resets the evidence");
  assert.ok(v.includes("g_unc[s].startMs=now;"), "a connection loss restarts the window");
  assert.ok(/YU_NOHIST/.test(fn("int UncProbe(", "void UncClose(")));
});

test("SOURCE 2.42 a duplicate that appears later is removed on PROOF only: one order per side is kept, the extra one is written down and deleted, the position is re-read", () => {
  const rc = fn("void Reconcile()", "void SyncAll()");
  assert.ok(rc.includes('LogOrder("DUPLICATE_PROVEN"') && rc.includes("kept #") && rc.includes("removed only #"));
  assert.ok(rc.includes("if(od[i]==keepT[0] || od[i]==keepT[1]) continue;"), "the kept order is never touched");
  assert.ok(/bool dup=\(\(isB && needBuy\) \|\| \(isS && needSell\)\);/.test(rc), "only an order of a wanted side whose canonical sibling exists is a duplicate (no deletion by similarity)");
  assert.ok(rc.includes("if(dup) g_dirty=true;"), "the state is re-checked after the removal");
});

// ---------------------------------------------------------------- MODEL
// Transcription of ReqPrepare / ReqMark / ReqJournalRecover / the ledger release rule. `server` is injected per scenario.
function makeBot(server) {
  const st = { j: null, unc: null, sends: 0, log: [], t: 0, histOk: 0, checks: 0 };
  const L = (e) => st.log.push(e);
  const send = (side, level, lot, { crashAt = null, answer = "OK" } = {}) => {
    if (st.unc) { L("BLOCK_UNC"); return "blocked"; }
    if (st.j && ["PREPARED", "SENT", "UNKNOWN"].includes(st.j.s) && st.j.level === level && st.j.lot === lot) { L("BLOCK_DUP"); return "blocked"; }
    if (server.orders.some((o) => o.side === side) || server.positions.some((p) => p.side === side)) { L("BLOCK_EXISTS"); return "blocked"; }
    st.j = { s: "PREPARED", side, level, lot, t: st.t };                 // saved
    if (crashAt === "afterPrepare") throw new Error("crash");
    st.j.s = "SENT";                                                     // saved + flushed
    if (crashAt === "afterSent") { st.sends++; if (answer === "OK") server.orders.push({ side, level, lot }); throw new Error("crash"); }
    st.sends++;
    if (answer === "OK") { server.orders.push({ side, level, lot }); st.j.s = "CONFIRMED"; return "ok"; }
    if (answer === "REJECT") { st.j.s = "REJECTED"; return "rejected"; }
    st.j.s = "UNKNOWN"; st.unc = { side, level, lot, reqT: st.t, histOk: 0, checks: 0, start: st.t }; return "unknown";   // timeout: no answer
  };
  const restart = () => {                                                // ReqJournalRecover
    if (!st.j) return;
    if (st.j.s === "PREPARED") { L("REQ_NOT_SENT"); st.j.s = "NONE"; st.j = null; return; }
    if (st.j.s === "SENT" || st.j.s === "UNKNOWN") { if (!st.unc) st.unc = { side: st.j.side, level: st.j.level, lot: st.j.lot, reqT: st.j.t, histOk: 0, checks: 0, start: st.t }; st.j.s = "UNKNOWN"; L("UNC_RESTORED"); }
  };
  const verify = (connected = true, histReadable = true) => {            // UncVerify
    const u = st.unc; if (!u) return "none";
    st.checks++; u.checks++;
    if (!connected) { u.start = st.t; return "paused"; }
    const hasOrder = server.orders.some((o) => o.side === u.side), hasPos = server.positions.some((p) => p.side === u.side);
    if (hasOrder || hasPos) { st.unc = null; st.j.s = "CONFIRMED"; L("RESOLVED"); return "resolved"; }
    if (!histReadable) { u.histOk = 0; return "open"; }
    if (server.history.some((h) => h.side === u.side)) { st.unc = null; st.j.s = "REJECTED"; L("GONE"); return "resolved"; }
    u.histOk++;
    if (u.checks >= 5 && u.histOk >= 3 && st.t - u.start >= 30) { st.unc = null; st.j.s = "REJECTED"; L("ABSENT"); return "absent"; }
    return "open";
  };
  return { st, send, restart, verify };
}
const fresh = () => ({ orders: [], positions: [], history: [] });

test("MODEL crash BEFORE the send (PREPARED only): nothing reached the server, the record is discarded and the request may be made again once", () => {
  const sv = fresh(), b = makeBot(sv);
  assert.throws(() => b.send("BUY", 4200, 0.01, { crashAt: "afterPrepare" }));
  b.restart();
  assert.equal(b.st.j, null); assert.deepEqual(sv.orders, []);
  assert.equal(b.send("BUY", 4200, 0.01), "ok"); assert.equal(sv.orders.length, 1);
});
test("MODEL crash AFTER the send, the server DID accept it: after the restart the order is found and adopted - never a second order", () => {
  const sv = fresh(), b = makeBot(sv);
  assert.throws(() => b.send("BUY", 4200, 0.01, { crashAt: "afterSent" }));
  b.restart();
  assert.equal(b.send("BUY", 4200, 0.01), "blocked");
  assert.equal(b.verify(), "resolved");
  assert.equal(sv.orders.length, 1); assert.equal(b.st.sends, 1);
});
test("MODEL crash AFTER the send, the server did NOT get it: the side stays blocked until the evidence is complete, then ONE new request is allowed", () => {
  const sv = fresh(), b = makeBot(sv);
  assert.throws(() => b.send("BUY", 4200, 0.01, { crashAt: "afterSent", answer: "LOST" }));
  b.restart();
  for (let i = 0; i < 4; i++) { b.st.t += 3; assert.equal(b.verify(), "open"); assert.equal(b.send("BUY", 4200, 0.01), "blocked"); }
  b.st.t = 31; assert.equal(b.verify(), "absent");
  assert.equal(b.send("BUY", 4200, 0.01), "ok"); assert.equal(sv.orders.length, 1);
});
test("MODEL a timeout (no answer) is UNKNOWN: it is NOT a rejection and 30 s alone never trigger a resend; a late order is adopted without a duplicate", () => {
  const sv = fresh(), b = makeBot(sv);
  assert.equal(b.send("SELL", 4190, 0.02, { answer: "TIMEOUT" }), "unknown");
  b.st.t = 999;                                              // a very long time passes ...
  assert.equal(b.verify(true, false), "open");               // ... but the history cannot be read: nothing can be concluded
  assert.equal(b.send("SELL", 4190, 0.02), "blocked");
  sv.orders.push({ side: "SELL", level: 4190, lot: 0.02 });  // the late order appears
  assert.equal(b.verify(), "resolved"); assert.equal(sv.orders.length, 1); assert.equal(b.st.sends, 1);
});
test("MODEL connection loss: the absence observed while offline proves nothing - the window restarts after the reconnection", () => {
  const sv = fresh(), b = makeBot(sv);
  b.send("BUY", 4200, 0.01, { answer: "TIMEOUT" });
  for (let i = 0; i < 6; i++) { b.st.t += 10; assert.equal(b.verify(false), "paused"); }
  assert.equal(b.verify(true), "open");                       // first check after the reconnection
  assert.equal(b.send("BUY", 4200, 0.01), "blocked");
});
test("MODEL the broker REJECTED it: that is a definite answer - the side is free, the retry follows the strategy rules", () => {
  const sv = fresh(), b = makeBot(sv);
  assert.equal(b.send("BUY", 4200, 0.01, { answer: "REJECT" }), "rejected");
  assert.equal(b.st.unc, null); assert.equal(b.send("BUY", 4200, 0.01), "ok");
});
test("MODEL the execution happened (position) or the order sits in the history as processed: resolved without any resend", () => {
  const a = fresh(), ba = makeBot(a); ba.send("BUY", 4200, 0.01, { answer: "TIMEOUT" }); a.positions.push({ side: "BUY", time: 1 });
  assert.equal(ba.verify(), "resolved"); assert.equal(ba.st.sends, 1);
  const h = fresh(), bh = makeBot(h); bh.send("BUY", 4200, 0.01, { answer: "TIMEOUT" }); h.history.push({ side: "BUY", state: "CANCELED" });
  assert.equal(bh.verify(), "resolved"); assert.equal(bh.st.sends, 1);
});
test("MODEL a duplicate that appeared later: only the extra order is removed, the correct one is kept (never by similarity of side / price / volume alone)", () => {
  const orders = [{ ticket: 11, side: "BUY", price: 4200, tracked: true }, { ticket: 14, side: "BUY", price: 4200, tracked: false }];
  const canon = (side, level) => { const t = orders.find((o) => o.side === side && o.tracked); if (t) return t.ticket; return orders.filter((o) => o.side === side).sort((a, b) => (b.price === level) - (a.price === level) || a.ticket - b.ticket)[0]?.ticket; };
  const keep = canon("BUY", 4200), remove = orders.filter((o) => o.side === "BUY" && o.ticket !== keep).map((o) => o.ticket);
  assert.equal(keep, 11); assert.deepEqual(remove, [14]);
});
