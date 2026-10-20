// fix17 - every user START / Telegram /set begins a NEW cycle from ZERO.
//  (A) executable model of UserNewCycle + CycleBook + NextRiskForNet (same formulas as the EA),
//  (B) SOURCE checks that the EA really contains the rule and that the other paths (modify-side, restart resume) are untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ea = readFileSync(new URL("../ea/Yetimmm.mq5", import.meta.url), "utf8");
function fnBody(sig) {
  const i = ea.indexOf(sig);
  assert.ok(i >= 0, "missing " + sig);
  let d = 0, started = false;
  for (let k = ea.indexOf("{", i); k < ea.length; k++) {
    if (ea[k] === "{") { d++; started = true; } else if (ea[k] === "}") { d--; if (started && d === 0) return ea.slice(i, k + 1); }
  }
  throw new Error("unbalanced " + sig);
}

// ---------- (A) model ----------
const EPS = 1e-9;
function bot({ initRisk = 1, target = 20, rr = 20, perLot = 10 } = {}) {
  const b = { initRisk, target, rr, id: 1, net: 0, seq: 0, trades: 0, curRisk: initRisk, positions: 0, unbooked: 0, orders: 0, closed: [], general: 0 };
  const nextRisk = (net) => { if (Math.abs(net) <= EPS) return b.initRisk; const rem = b.target - net; if (rem <= EPS) return b.initRisk; let r = rem / b.rr; if (net > 0 && r < b.initRisk) r = b.initRisk; return r; };
  b.lot = () => Math.round((b.curRisk / perLot) * 100) / 100;          // lot depends ONLY on the current risk (= the cycle ledger)
  b.book = (net) => { b.net = Math.round((b.net + net) * 1e8) / 1e8; b.trades++; if (net < 0) b.seq++; b.general += net; b.curRisk = nextRisk(b.net); };
  b.userNewCycle = () => {
    if (Math.abs(b.net) <= EPS && b.trades === 0 && b.seq === 0) return 0;
    if (b.positions > 0) return 1;
    if (b.unbooked > 0) return 2;
    b.orders = 0; b.closed.push({ id: b.id, net: b.net, seq: b.seq });
    b.id++; b.net = 0; b.seq = 0; b.trades = 0; b.curRisk = b.initRisk; return 0;
  };
  return b;
}

test("A: the case of the screenshot - a long chain with small wins, then the user's /set: the new cycle starts at the INITIAL lot", () => {
  const b = bot();
  for (const n of [-1.0, -1.1, -1.2, -1.2, -1.3, +0.08, -1.4, +0.25]) b.book(n);
  assert.ok(b.net < 0 && b.lot() > 0.10, "old behaviour: the debt keeps the lot high (" + b.lot() + ")");
  assert.equal(b.userNewCycle(), 0);
  assert.equal(b.id, 2); assert.equal(b.net, 0); assert.equal(b.seq, 0);
  assert.equal(b.curRisk, b.initRisk); assert.equal(b.lot(), 0.10);
});

test("B: twelve consecutive user-started cycles - none inherits anything from the one before", () => {
  const b = bot();
  for (let c = 1; c <= 12; c++) {
    assert.equal(b.id, c); assert.equal(b.lot(), 0.10, "cycle " + c + " must open at the initial lot");
    for (let k = 0; k < (c % 5) + 2; k++) b.book(-1 - k * 0.1);
    if (c % 3 === 0) b.book(+0.5);
    assert.ok(b.lot() >= 0.10);
    assert.equal(b.userNewCycle(), 0);
  }
  assert.equal(b.closed.length, 12);
});

test("C: the account's general loss history never enters the lot", () => {
  const a = bot(), z = bot();
  z.general = -99999; a.general = +5000;
  a.userNewCycle(); z.userNewCycle();
  assert.equal(a.lot(), z.lot());
  for (const n of [-1, -1.1]) { a.book(n); z.book(n); }
  assert.equal(a.lot(), z.lot());
});

test("D: an OPEN trade postpones the new cycle (its result is never lost), unbooked results make it wait", () => {
  const b = bot(); b.book(-1); b.positions = 1;
  assert.equal(b.userNewCycle(), 1); assert.equal(b.id, 1); assert.equal(b.net, -1);
  b.positions = 0; b.unbooked = 1;
  assert.equal(b.userNewCycle(), 2); assert.equal(b.net, -1);
  b.unbooked = 0;
  assert.equal(b.userNewCycle(), 0); assert.equal(b.net, 0);
});

test("E: STOP then START is a NEW cycle; an empty ledger is left alone (idempotent, no double cycle)", () => {
  const b = bot(); b.book(-1); b.book(-1.1);
  assert.equal(b.userNewCycle(), 0); const id = b.id;
  assert.equal(b.userNewCycle(), 0); assert.equal(b.id, id, "second command on an empty ledger does not burn another cycle id");
});

// ---------- (B) source ----------
test("SOURCE: UserNewCycle exists, books offline trades first, refuses while a trade is open, then closes the old cycle and resets", () => {
  const f = fnBody("int UserNewCycle(");
  assert.ok(f.includes("OwnPositions(rp)>0") && f.includes("return 1;"));
  assert.ok(f.includes("RecoverHistory();") && f.includes("PendingClosedRecords()") && f.includes("CleanupOrders("));
  assert.ok(f.includes("CycleEndByUser(") && f.includes('"NEW_CYCLE_BEGIN"') && f.includes('"NEW_CYCLE_COMMIT"'));
});
test("SOURCE: DoStart and the Telegram /set call it; the single-side modify and the restart path do NOT", () => {
  assert.ok(fnBody("string DoStart(").includes('UserNewCycle("START ("+src+")"'));
  assert.ok(fnBody("bool ApplyLevels(").includes("UserNewCycle(src+\" /set\""));
  assert.ok(ea.includes('ApplyLevels(b,s,r,"Telegram",err,true)'));
  assert.ok(!fnBody("string ExecModifySide(").includes("UserNewCycle"));
  assert.ok(!fnBody("void LoadState(").includes("UserNewCycle") && !fnBody("void LedgerSelfCheck(").includes("UserNewCycle"));
});
test("SOURCE: the lot of a cycle comes only from the cycle ledger (NextRiskForNet(g_cycNet)); no history / general-loss variable is read", () => {
  const n = fnBody("double NextRiskForNet(");
  assert.ok(/g_target-net/.test(n) && !/History|g_stats|StatsAdd|DayNet/.test(n));
  const cb = fnBody("string CycleBook(");
  assert.ok(cb.includes("g_curRisk=NextRiskForNet(g_cycNet);"));
});
test("SOURCE: a closed trade of an older cycle is logged only (never booked into the new cycle)", () => {
  assert.ok(fnBody("bool ProcessClosedPosition(").includes("orphanCyc"));
});
test("SOURCE: no new input was added (the rule is not optional)", () => {
  assert.ok(!ea.includes("InpNewCycleOnUserStart"));
});
