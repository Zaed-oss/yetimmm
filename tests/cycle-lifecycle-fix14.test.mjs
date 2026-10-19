// fix14b (EA source, NOT compiled / run on MT5 here): every cycle has one traceable life; every trade carries a passport; mine vs foreign is explicit.
// SOURCE = structural checks of ea/Yetimmm.mq5 (journal only: no lot / state / ledger value is changed by this layer).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const ea = readFileSync(new URL("../ea/Yetimmm.mq5", import.meta.url), "utf8");
const fn = (head, next) => { const i = ea.indexOf(head); assert.ok(i > 0, head + " missing"); const j = ea.indexOf(next, i + head.length); assert.ok(j > i, next + " missing"); return ea.slice(i, j); };
const block = fn("//| v2.48 CYCLE LIFECYCLE JOURNAL", 'LogOrder("CYCLE_CENSUS"');

test("SOURCE the journal block is defined AFTER LogOrder / CycStateText and BEFORE every caller (MQL5 needs declaration order)", () => {
  const at = (s) => ea.indexOf(s);
  for (const caller of ["string CycleBook(", "long RegisterPosition(", "void CycleFinishLedger(", "void CycleEndByUser(", "void SyncAll()"]) assert.ok(at("void CycleCensus(") < at(caller), caller);
  assert.ok(at("void LogOrder(") < at("void CycleCensus(") && at("string CycStateText()") < at("void CycleCensus("));
});

test("SOURCE the lifecycle journal has a fixed schema: cycle, event, trade, position, side, lot, role, owner, net before/after, target, seq", () => {
  assert.ok(ea.includes('const string LIFE_HEADER="Time;CycleId;Event;Trade;Position;Side;Lot;Role;Owner;NetBefore;NetAfter;Target;Seq;Note";'));
  assert.ok(ea.includes('"_CycleLife.csv"'));
});

test("SOURCE a cycle's life: OPEN at its first trade/booking (once per CycleId, persisted), CLOSE with a full summary for BOTH ends (target met / cancelled)", () => {
  const o = fn("void CycOpenIfNeeded(", "//--- the end of a cycle's life");
  assert.match(o, /if\(\(long\)GV\("CYCOP",0\.0\)==g_cycId\) return;/);
  assert.ok(o.includes('GS("CYCOP",(double)g_cycId);') && o.includes('"CYCLE_OPEN"'));
  const c = fn("void CycCloseLife(", "bool FgSeen(");
  for (const k of ["opened ", "lasted ", "trades ", "SL steps ", "cycle losses ", "net ", "target "]) assert.ok(c.includes(k), k);
  assert.ok(c.includes('GS("CYCOP",0.0);'));
  assert.ok(fn("void CycleFinishLedger(", "bool CycleTryComplete(").includes('CycCloseLife(id,"TARGET_MET"'));
  assert.ok(fn("void CycleEndByUser(", "TgQueue(\"🛑 CYCLE #").includes('CycCloseLife(id,"CANCELLED_BY_USER"'));
});

test("SOURCE every trade carries a passport (cycle id, target, role, cycle net at birth) that is cleaned with the position and journaled as TRADE_OPEN", () => {
  const r = fn("long RegisterPosition(", "void RegisterLivePositions()");
  assert.ok(r.includes('PSet(pid,"CY",(double)g_cycId);'));
  assert.ok(r.includes('PSet(pid,"CT",g_target); PSet(pid,"RL",revFill?1.0:0.0); PSet(pid,"CO",g_cycNet);'));
  assert.ok(r.includes('"TRADE_OPEN"') && r.includes('"REVERSE_PREARM"') && r.includes('"RE_ENTRY"'));
  assert.ok(ea.includes('"PM","TAINT","CY","CT","RL","CO"}'), "no leaked passport variables");
});

test("SOURCE every booking names its trade (number, ticket, side, lot, role) and the ledger before/after; the context is cleared right after", () => {
  const b = fn("string CycleBook(", "long g_lastCycIdShown()");
  assert.ok(b.includes('CycLife(g_cycId,"BOOK",g_bookTno,g_bookPid,g_bookSide,g_bookLot,g_bookRole,"MINE",before,g_cycNet,'));
  assert.ok(b.includes('g_bookTno=0; g_bookPid=0;'));
  const p = fn("bool ProcessClosedPosition(", "void CheckClosures()");
  assert.match(p, /g_bookTno=tno; g_bookPid=pid; g_bookSide=buy\?"BUY":"SELL"; g_bookLot=inVol;/);
});

test("SOURCE a result of an OLDER cycle is journaled as CLOSE_NOT_BOOKED (owner MINE_OLD_CYCLE) and still never enters the current cycle", () => {
  const p = fn("bool ProcessClosedPosition(", "void CheckClosures()");
  assert.ok(p.includes('"CLOSE_NOT_BOOKED"') && p.includes('"MINE_OLD_CYCLE"'));
  assert.match(p, /bool orphanCyc=\(posCyc>0 && posCyc!=g_cycId\);/);
});

test("SOURCE ownership census: Symbol+Magic = mine, saved cycle id = which cycle, everything else FOREIGN (logged once, never counted, never touched)", () => {
  const c = fn("void CycleCensus(", 'LogOrder("CYCLE_CENSUS"');
  for (const k of ["FOREIGN_SEEN", "OLD_CYCLE_POSITION", "FgSeen(t)", "mine in this cycle", "mine in an old cycle", "FOREIGN", "pending orders: mine", "not counted", "not touched"]) assert.ok(c.includes(k), k);
  assert.ok(!/g_trade\.|OrderSend|PositionClose|Delete/.test(c), "read-only: it never trades, closes or deletes");
  assert.ok(fn("void SyncAll()", "//| Levels / Start").includes('CycleCensus("sync",false);'));
  assert.ok(ea.includes('CycleCensus("startup",true);'));
});

test("SOURCE the journal changes nothing: no lot, state, mode, level or ledger assignment inside the new block", () => {
  const body = block.replace(/\/\/[^\n]*/g, "");
  for (const bad of ["g_curRisk=", "g_accLoss=", "g_cycNet=", "g_seq=", "g_state=", "g_mode=", "g_buyLevel=", "g_sellLevel="]) assert.ok(!body.includes(bad), bad);
});
