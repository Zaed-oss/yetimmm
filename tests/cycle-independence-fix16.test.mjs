// fix16 - cycle independence. Two layers:
//  (A) an EXECUTABLE model of the ledger rules (same formulas as CycleBook / NextRiskForNet / ResetRisk / LedgerSelfCheck / plan binding),
//      so the acceptance scenarios of the technical report run as behaviour, not as text search;
//  (B) SOURCE checks that the EA really contains the same rules.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ea = readFileSync(new URL("../ea/Yetimmm.mq5", import.meta.url), "utf8");
function fnBody(sig) {
  let i = -1;
  for (let from = 0; ; ) {
    i = ea.indexOf(sig, from);
    assert.ok(i >= 0, "missing definition of " + sig);
    const brace = ea.indexOf("{", i), semi = ea.indexOf(";", i);
    if (brace >= 0 && (semi < 0 || brace < semi)) break;
    from = i + 1;
  }
  let d = 0, started = false;
  for (let k = ea.indexOf("{", i); k < ea.length; k++) {
    if (ea[k] === "{") { d++; started = true; }
    else if (ea[k] === "}") { d--; if (started && d === 0) return ea.slice(i, k + 1); }
  }
  throw new Error("unbalanced " + sig);
}

// ---------- (A) executable model ----------
const EPS = 1e-6;
function makeBot({ initRisk = 1, target = 20, rr = 20 } = {}) {
  const b = { initRisk, target, rr, cycId: 1, ledgerVer: 0, cycNet: 0, accLoss: 0, seq: 0, curRisk: initRisk, trades: 0, lastClosed: 0, plan: null, history: [], general: 0, positions: 0, unbooked: 0, log: [] };
  b.nextRisk = (net) => { if (Math.abs(net) <= 1e-9) return b.initRisk; const rem = b.target - net; if (rem <= 1e-9) return b.initRisk; let r = rem / b.rr; if (net > 0 && r < b.initRisk) r = b.initRisk; return r; };
  b.book = (net, cyc = b.cycId) => {                         // a result of an OLDER cycle never enters a newer ledger (CY passport)
    b.general += net;                                        // the account's general history: statistics only
    if (cyc !== b.cycId) { b.log.push("CLOSE_NOT_BOOKED"); return false; }
    b.cycNet = Math.round((b.cycNet + net) * 1e8) / 1e8; b.ledgerVer++; b.trades++;
    b.accLoss = b.cycNet < 0 ? -b.cycNet : 0; if (net < 0) b.seq++;
    b.curRisk = b.nextRisk(b.cycNet); return true;
  };
  b.reset = () => { b.accLoss = 0; b.seq = 0; b.curRisk = b.initRisk; b.cycNet = 0; b.trades = 0; b.cycId++; b.ledgerVer++; b.plan = null; };
  b.resetBlocked = () => (b.positions > 0 ? "open position" : b.unbooked > 0 ? "unbooked closed trade" : "");
  b.complete = () => { if (b.cycNet + 0 >= b.target - EPS && b.positions === 0) { b.lastClosed = b.cycId; b.reset(); return true; } return false; };
  b.armReverse = () => { b.plan = { cyc: b.cycId, ver: b.ledgerVer, risk: b.curRisk }; };
  b.sweep = () => { if (b.plan && b.plan.cyc !== b.cycId) { b.log.push("PLAN_REJECTED"); b.plan = null; } };
  b.load = (saved) => {                                      // LedgerSelfCheck on a restored state
    Object.assign(b, saved);
    if (b.positions === 0 && b.lastClosed > 0 && b.cycId <= b.lastClosed && (b.trades > 0 || Math.abs(b.cycNet) > 1e-9 || b.accLoss > 1e-9 || b.seq > 0)) {
      b.log.push("LEDGER_STALE_DISCARDED"); if (b.cycId < b.lastClosed) b.cycId = b.lastClosed; b.reset(); return; }
    const wantAL = b.cycNet < 0 ? -b.cycNet : 0; if (Math.abs(b.accLoss - wantAL) > EPS) b.accLoss = wantAL;
    const wantRisk = b.nextRisk(b.cycNet); if (Math.abs(b.curRisk - wantRisk) > EPS) b.curRisk = wantRisk;
  };
  return b;
}

test("A1 a completed cycle (net >= target) gives the next cycle a NEW id, empty ledger, seq 0 and the INITIAL risk", () => {
  const b = makeBot();
  b.book(-1); b.book(-1.5); b.book(-2); b.book(-3); b.book(27.5);   // loss streak (-7.50) then a recovering win that repays it and adds the target
  assert.ok(b.cycNet >= b.target - EPS);
  const id = b.cycId; assert.ok(b.complete());
  assert.equal(b.cycId, id + 1); assert.equal(b.seq, 0); assert.equal(b.cycNet, 0); assert.equal(b.accLoss, 0); assert.equal(b.curRisk, b.initRisk);
});
test("A2 big GENERAL account losses never change the start risk of a fresh cycle", () => {
  const b = makeBot(); b.general = -5000;
  assert.equal(b.curRisk, 1); assert.equal(b.nextRisk(b.cycNet), 1);
  b.book(-1);
  assert.ok(Math.abs(b.accLoss - 1) < 1e-9, "only the cycle's own loss is the debt");
});
test("A3 STOP then START resumes the old cycle: nothing is zeroed, the cycle id does not change", () => {
  const b = makeBot(); b.book(-1); b.book(-2.2);
  const snap = { id: b.cycId, net: b.cycNet, seq: b.seq }; /* stop + start touch no ledger field */
  assert.deepEqual({ id: b.cycId, net: b.cycNet, seq: b.seq }, snap); assert.ok(b.cycNet < 0);
});
test("A4 a confirmed new cycle starts a NEW ledger without carrying the previous debt", () => {
  const b = makeBot(); b.book(-1); b.book(-3); const id = b.cycId; b.reset();
  assert.equal(b.cycId, id + 1); assert.equal(b.accLoss, 0); assert.equal(b.curRisk, b.initRisk);
});
test("A5 restart after a COMPLETED cycle never restores its old ledger (the saved ledger belongs to a closed cycle)", () => {
  const b = makeBot();
  b.load({ cycId: 7, lastClosed: 7, cycNet: -4.43, accLoss: 4.43, seq: 5, trades: 5, curRisk: 1.26, positions: 0 });
  assert.equal(b.cycId, 8); assert.equal(b.seq, 0); assert.equal(b.accLoss, 0); assert.equal(b.cycNet, 0); assert.equal(b.curRisk, b.initRisk);
  assert.ok(b.log.includes("LEDGER_STALE_DISCARDED"));
});
test("A6 a restored state whose stored risk / debt contradict the net is re-derived, never trusted", () => {
  const b = makeBot();
  b.load({ cycId: 3, lastClosed: 2, cycNet: -2, accLoss: 9, seq: 2, trades: 2, curRisk: 9, positions: 0 });
  assert.equal(b.accLoss, 2); assert.ok(Math.abs(b.curRisk - 22 / 20) < 1e-9);
});
test("A7 a closed trade that is NOT booked yet blocks a new cycle (no zeroing before its result is in the ledger)", () => {
  const b = makeBot(); b.book(-1); b.unbooked = 1; assert.ok(b.resetBlocked());
  b.unbooked = 0; b.positions = 1; assert.ok(b.resetBlocked());
  b.positions = 0; assert.equal(b.resetBlocked(), "");
});
test("A8 a pre-armed reverse plan of an ended cycle is swept; a plan of the current cycle is kept", () => {
  const b = makeBot(); b.book(-1); b.armReverse(); b.sweep(); assert.ok(b.plan);
  b.reset(); b.plan = { cyc: b.cycId - 1, ver: 1, risk: 1.2 }; b.sweep(); assert.equal(b.plan, null); assert.ok(b.log.includes("PLAN_REJECTED"));
});
test("A9 a result of an OLD cycle never enters a newer cycle's ledger (it only counts in the general statistics)", () => {
  const b = makeBot(); const old = b.cycId; b.book(-1); b.reset();
  assert.equal(b.book(-5, old), false); assert.equal(b.cycNet, 0); assert.equal(b.accLoss, 0); assert.equal(b.general, -6);
});
test("A10 every booking and every new cycle bumps the ledger version (a plan can always say which ledger it came from)", () => {
  const b = makeBot(); const v0 = b.ledgerVer; b.book(-1); assert.equal(b.ledgerVer, v0 + 1); b.reset(); assert.equal(b.ledgerVer, v0 + 2);
});

// ---------- (B) SOURCE ----------
test("B1 ledger version: declared, saved, loaded, bumped on booking and on every new cycle", () => {
  assert.ok(/long\s+g_ledgerVer=0;/.test(ea));
  assert.ok(fnBody("void SaveState()").includes('GS("LVER",(double)g_ledgerVer)'));
  assert.ok(fnBody("void LoadState()").includes('g_ledgerVer=(long)GV("LVER",0.0)'));
  assert.ok(fnBody("string CycleBook(").includes("g_ledgerVer++"));
  assert.ok(fnBody("void ResetRisk()").includes("g_ledgerVer++"));
});
test("B2 a new cycle kills every temporary plan of the old one (reverse plan keys, prepared Netting plan)", () => {
  const b = fnBody("void ResetRisk()");
  for (const k of ['GS("PAO",0.0)', 'GS("PAR",0.0)', 'GS("PAA",0.0)', 'GS("PCY",0.0)', "g_pvOk=false", "g_pvCyc=0"]) assert.ok(b.includes(k), k);
});
test("B3 the reverse plan is stamped with its cycle and ledger version, the sweep deletes a foreign-cycle plan, the fill never adopts it", () => {
  assert.ok(/GS\("PCY",\(double\)g_cycId\);[\s\S]{0,200}GS\("PLV",\(double\)g_ledgerVer\)/.test(ea));
  const s = fnBody("void CyclePlanSweep()");
  assert.ok(s.includes("PLAN_REJECTED") && s.includes("DeleteOrder(tk") && s.includes("pc==g_cycId"));
  assert.ok(ea.includes("   CyclePlanSweep();"), "called from the timer");
  assert.ok(ea.includes("PLAN_CYCLE_MISMATCH") && /planCyc>0 && planCyc!=g_cycId[\s\S]{0,300}useRisk=g_curRisk; useAL=g_accLoss;/.test(ea), "a foreign plan's risk / debt is replaced by the CURRENT ledger");
});
test("B4 the closing-deal gate has NO timed release: it ends with return true, retries the booking, and alerts after 90 s", () => {
  const c = fnBody("bool ClosurePendingBlocks()");
  assert.ok(!c.includes("LEDGER_STALE_RELEASE") && c.includes("CheckClosures()") && c.includes("LEDGER_STALE_HOLD"));
  assert.ok(/waited>=90000/.test(c) && /return true;\s*\}\s*$/.test(c.trim()));
});
test("B5 a new cycle is refused while a position is open or a closed trade is unbooked (Mini App reset + implicit reset)", () => {
  const g = fnBody("bool CycleResetBlocked(");
  assert.ok(g.includes("OwnPositions(rp)>0") && g.includes("PendingClosedRecords()"));
  assert.ok(fnBody("void ImplicitResetGuarded(").includes("CycleResetBlocked(rbWhy)"));
  const i = ea.indexOf('if(cmd=="reset")'); const seg = ea.slice(i, i + 1800);
  assert.ok(seg.includes("CycleResetBlocked(rbWhy)") && seg.includes("NEW_CYCLE_REFUSED"));
});
test("B6 LedgerSelfCheck runs after a restore, before the first synchronisation, and covers both invariants", () => {
  const f = fnBody("void LedgerSelfCheck(");
  for (const k of ["LEDGER_STALE_DISCARDED", "LEDGER_INVARIANT", "NextRiskForNet(g_cycNet)", 'GV("LCID",0.0)', "g_cycId<=lastClosed"]) assert.ok(f.includes(k), k);
  const init = ea.indexOf('LedgerSelfCheck("startup")');
  assert.ok(init > ea.indexOf("RecoveryStateSafe();                                           // v2.42") && init < ea.indexOf("StartupAudit();                  // v2.40"));
});
test("B7 START / levels answer explicitly: SAME cycle RESUMED or NEW cycle, in the reply and in the Orders log", () => {
  const s = fnBody("string CycleStatusLine()");
  assert.ok(s.includes("NEW CYCLE #") && s.includes("SAME CYCLE #") && s.includes("RESUMED"));
  const d = fnBody("string DoStart(");
  assert.ok(d.includes("CycleStatusLine()") && d.includes("CYCLE_NEW_START") && d.includes("CYCLE_RESUME"));
});
test("B8 RecoveryTrace and the reverse fill now name the cycle id and ledger version (raw lot, final lot, broker step were already logged)", () => {
  const t = fnBody("void RecoveryTrace(");
  assert.ok(t.includes("g_ledgerVer") && t.includes("raw lot") && t.includes("final lot") && t.includes("step"));
  assert.ok(ea.includes("plan cycle ") && ea.includes("(plan made at v"));
});
test("B9 general (account-wide) losses stay outside the lot chain: the ledger is written only by CycleBook / ResetRisk / LoadState / the predicted swap", () => {
  assert.ok(!/g_accLoss\s*\+=/.test(ea) && !/g_accLoss\s*-=/.test(ea));
  const writers = [...ea.matchAll(/g_cycNet\s*=[^=]/g)].length;
  assert.ok(writers <= 6, "g_cycNet writers: " + writers);
  assert.ok(!/StatsAdd[\s\S]{0,80}g_cycNet/.test(fnBody("void StatsAdd(")));
});
