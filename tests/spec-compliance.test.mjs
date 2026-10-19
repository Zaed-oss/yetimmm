// v4.21.0 (EA 2.34): the "Fix.pdf" technical report (net-target recovery system) mapped to code.
// Reference model of the new arithmetic + structural checks of the EA source. It does NOT run MQL5: compile (F7), then Strategy Tester / Demo.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ea = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "ea", "Yetimmm.mq5"), "utf8");
const near = (a, b, e = 0.006) => assert.ok(Math.abs(a - b) < e, `${a} !~ ${b}`);

// mirrors NextRiskFor / SizingPerLot / the lot rounding of RiskCompute
const nextRisk = (L, init = 1, T = 20, RR = 20) => (L <= 1e-9 ? init : (L + T) / RR);
const sizingPerLot = (perLot, c, RR = 20) => (c > 0 && RR > 1 && perLot - c / RR > perLot * 0.5 ? perLot - c / RR : perLot);
const lotFor = ({ risk, perLot, c = 0, RR = 20, L = 0, vmin = 0.01, step = 0.01, roundUp = true }) => {
  const perSz = sizingPerLot(perLot, c, RR), raw = risk / perSz;
  if (raw < vmin - 1e-9) return 0;
  let lot = vmin + Math.floor((raw - vmin) / step + 1e-7) * step;
  if (roundUp && L > 1e-9 && lot * perSz < risk - 1e-9) lot += step;
  return Math.round(lot * 1e8) / 1e8;
};
// a full cycle: n losses (each at SL, commission c/lot) then a TP -> NET result of the whole cycle
const cycle = ({ nLoss, perLot, c, RR = 20, T = 20, vmin = 0.01, step = 0.01 }) => {
  let L = 0;
  for (let i = 1; i <= nLoss; i++) {
    const risk = i === 1 ? 1 : nextRisk(L, 1, T, RR);
    const lot = lotFor({ risk, perLot, c, RR, L, vmin, step });
    L += lot * (perLot + c);                       // loss at SL = price loss + commission
  }
  const risk = nLoss === 0 ? 1 : nextRisk(L, 1, T, RR);
  const lot = lotFor({ risk, perLot, c, RR, L, vmin, step });
  const netTP = lot * (perLot * RR - c);
  return { L, lot, netTP, cycleNet: netTP - L };
};

test("cost-aware: with commission 0 the sizing is identical to the old formula (risk / perLot)", () => {
  assert.equal(sizingPerLot(100, 0), 100);
  near(lotFor({ risk: 1.05, perLot: 100, c: 0, L: 1 }), 0.02, 1e-9);   // 0.0105 -> floor 0.01 -> round-up to 0.02 (recovery)
});
test("cost-aware: the lot grows just enough that NET at TP repays loss + target (exact, before step rounding)", () => {
  const perLot = 100, c = 7, RR = 20, risk = 2.05;                       // loss so far 41 -> (41+20)/20... any risk works
  const perSz = sizingPerLot(perLot, c, RR);
  const lotExact = risk / perSz;
  near(lotExact * (perLot * RR - c), risk * RR, 1e-9);                   // net at TP == loss + target (risk*RR)
  assert.ok(lotExact > risk / perLot);                                   // bigger than the commission-blind lot
});
test("cost-aware is ignored when the cost is absurd (> 50% of the loss per lot) or unknown", () => {
  assert.equal(sizingPerLot(10, 0), 10);
  assert.equal(sizingPerLot(10, 200, 20), 10);                           // 10 - 10 = 0 -> not > 5 -> fallback
});
test("cycle net: with step rounding UP the cycle never ends below the losses it repaid (net >= 0 after the TP)", () => {
  for (const c of [0, 3, 7]) for (const n of [1, 2, 3, 5, 8]) {
    const r = cycle({ nLoss: n, perLot: 100, c, step: 0.01, vmin: 0.01 });
    assert.ok(r.lot > 0, "executable lot");
    assert.ok(r.cycleNet > 0, `cycle net ${r.cycleNet} (c=${c}, n=${n})`);
  }
});
test("cost-aware vs commission-blind (exact lots): only the aware lot nets exactly loss + target at TP", () => {
  const perLot = 100, c = 7, RR = 20;
  for (const L of [0, 1, 6.8, 33.07]) {
    const risk = nextRisk(L), need = L + 20;
    const lotAware = risk / sizingPerLot(perLot, c, RR), lotBlind = risk / perLot;
    near(lotAware * (perLot * RR - c), need, 1e-9);
    assert.ok(lotBlind * (perLot * RR - c) < need - 1e-6, "the commission-blind lot misses the net target by lot x c");
    near(need - lotBlind * (perLot * RR - c), lotBlind * c, 1e-9);
  }
});
test("guards (mirror of RecoveryGuardBlocks v2.34): accumulated-loss cap, margin level, one cycle per day", () => {
  const g = ({ accLoss, curRisk, seq = 0, maxAcc = 0, ml = 0, minMl = 0, oneDay = false, cycDay = 0, today = 5 }) => {
    if (maxAcc > 0 && accLoss > 1e-9 && accLoss + curRisk > maxAcc + 1e-9) return "WAITING_ACCLOSSCAP";
    if (minMl > 0 && ml > 0 && ml < minMl) return "WAITING_MARGINLVL";
    if (oneDay && accLoss <= 1e-9 && seq === 0 && cycDay > 0 && cycDay === today) return "WAITING_NEXTDAY";
    return "";
  };
  assert.equal(g({ accLoss: 0, curRisk: 1 }), "");
  assert.equal(g({ accLoss: 30, curRisk: 2.4, maxAcc: 32 }), "WAITING_ACCLOSSCAP");   // 30 + 2.4 > 32
  assert.equal(g({ accLoss: 30, curRisk: 2.4, maxAcc: 33 }), "");
  assert.equal(g({ accLoss: 0, curRisk: 1, maxAcc: 5 }), "");             // no debt -> a fresh cycle is never capped
  assert.equal(g({ accLoss: 0, curRisk: 1, ml: 150, minMl: 200 }), "WAITING_MARGINLVL");
  assert.equal(g({ accLoss: 0, curRisk: 1, ml: 0, minMl: 200 }), "");     // MT5 reports 0 with no margin in use
  assert.equal(g({ accLoss: 0, curRisk: 1, oneDay: true, cycDay: 5, today: 5 }), "WAITING_NEXTDAY");
  assert.equal(g({ accLoss: 0, curRisk: 1, oneDay: true, cycDay: 4, today: 5 }), "");
  assert.equal(g({ accLoss: 2, curRisk: 1.1, seq: 1, oneDay: true, cycDay: 5, today: 5 }), "");   // a running sequence is never stopped by the day lock
});

// ---- structural: the report's requirements are really wired in the EA source
test("EA 2.34 has the new inputs with SAFE defaults (guards off, one-cycle-per-day off, cost-aware on)", () => {
  assert.match(ea, /input double InpMaxAccLoss\s*=\s*0\.0;/);
  assert.match(ea, /input double InpMinMarginLevel\s*=\s*0\.0;/);
  assert.match(ea, /input bool\s+InpCostAware\s*=\s*true;/);
  assert.match(ea, /input double InpCommPerLot\s*=\s*0\.0;/);
  assert.match(ea, /input bool\s+InpOneCyclePerDay\s*=\s*false;/);
});
test("EA 2.34: lot sizing uses SizingPerLot in the raw volume AND in the recovery round-up", () => {
  assert.match(ea, /double perSz=SizingPerLot\(perLot\);/);
  assert.match(ea, /double raw=risk\/perSz;/);
  assert.match(ea, /lot\*perSz<risk-1e-9\) lot\+=step;/);
  assert.match(ea, /double\s+CommPerLotEff\(\)/);
});
test("EA 2.34: real commission is learned from the closing deals and persisted", () => {
  assert.match(ea, /if\(comm<-1e-9 && inVol>0\.0\) \{ g_commLot=-comm\/inVol; GS\("CPL",g_commLot\); \}/);
  assert.match(ea, /GS\("CPL",g_commLot\);\s*\/\/ v2\.34 learned commission per lot/);
  assert.match(ea, /g_commLot=MathMax\(GV\("CPL",0\.0\),0\.0\);/);
});
test("EA 2.34: the financial check runs BEFORE the order is sent, and re-entry results are tagged in the Orders log", () => {
  const iCheck = ea.indexOf("PlanCheck(buy,level,lot);"), iSend = ea.indexOf("g_trade.BuyStop(lot,level");
  assert.ok(iCheck > 0 && iSend > iCheck, "PlanCheck must precede the BuyStop/SellStop send");
  assert.ok(ea.includes('LogOrder("PLAN_CHECK"'));
  assert.ok(ea.includes('(reentryTag?"RE-ENTRY | ":"")+cm'));
  assert.ok(ea.includes('LogOrder("REARM_BLOCKED"'));
});
test("EA 2.34: the cycle result is the net of the whole cycle and is logged / sent", () => {
  assert.ok(ea.includes("g_cycNet=NormalizeDouble(before+net,8);"));     // v2.38: the cycle net is a running sum of EVERY booked result
  assert.ok(ea.includes('LogOrder("CYCLE_COMPLETE"'));
  assert.ok(ea.includes('GS("CYCDAY",(double)DayKeyNow());'));
  assert.ok(ea.includes('GS("CYCDAY",0.0);'));
});
test("EA 2.34: per-trade verification table (report section 10) is written with every required column", () => {
  assert.ok(ea.includes("void WritePlanTable(const string why)"));
  for (const col of ["Trade;Risk;LossBefore;NeededNetProfit;Lot;LossAtSL;NetAtTP;CumLossIfSL;MarginRequired;MarginFree;BalanceNeeded;Status"]) assert.ok(ea.includes(col));
  assert.equal((ea.match(/WritePlanTable\("/g) || []).length >= 2, true);
});
test("EA 2.44: version is consistent and the one-position / opposite-order rules of the report are still present", () => {
  assert.match(ea, /#property version\s+"2\.44"/); assert.match(ea, /#define YT_VER "2\.44"/);
  assert.ok(ea.includes("Opposite Order Deleted"));                       // opposite pending order removed when one side fills
  assert.ok(ea.includes("void EnforceSinglePosition("));
  assert.ok(ea.includes("bool SideOrderExists("));
  assert.ok(ea.includes("bool VerifyPlaced("));
});
