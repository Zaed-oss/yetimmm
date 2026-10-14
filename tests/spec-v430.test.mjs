// Binding specification (PDF "تصحيح أساسي لمتطلبات نظام التداول") — reference model + source lints (EA 2.30 / Mini App 4.16).
// The model mirrors the EA algorithm step by step (RiskCompute -> TPPriceLot -> closure rule). It proves the ARITHMETIC and that the
// source contains the rules. It does NOT run MQL5: compile (F7) and test on Demo (docs/MT5-TESTING.md).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ea = readFileSync(join(root, "ea", "Yetimmm.mq5"), "utf8");
const html = readFileSync(join(root, "index.html"), "utf8") + "\n" + readFileSync(join(root, "app.js"), "utf8");
const core = html.split("/*RISK-CORE-BEGIN*/")[1].split("/*RISK-CORE-END*/")[0];
const { calcRisk, SIM_PROFILES } = new Function(core + "; return { calcRisk, SIM_PROFILES };")();
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} !~ ${b}`);

// ---- reference model of the EA -------------------------------------------------------------
const GROW = 1.05, TARGET = 20, TOL = 0.01;
const profile = (o = {}) => ({ ...SIM_PROFILES["XAU-100-0.01"], ...o });
// RiskCompute (STRICT): loss at SL = price loss + round-trip commission per lot; lot rounded DOWN to the step
function riskCompute(bs, risk, d) {
  const perLot = d / bs.tick * bs.tvl, cost = bs.cpl || 0, all = perLot + cost, raw = risk / all;
  if (raw < bs.vmin - 1e-9) return { ok: false, perLot, cost, raw };
  const lot = Number((bs.vmin + Math.floor((raw - bs.vmin) / bs.vstep + 1e-7) * bs.vstep).toFixed(bs.vdig));
  return { ok: true, lot, perLot, cost, eff: lot * all };
}
// TPPriceLot: distance from the ACTUAL lot, rounded UP to the tick
function tpDistance(bs, r, d, requiredNet) {
  const unit = r.perLot / d, gross = requiredNet + r.lot * r.cost, dist = gross / (r.lot * unit);
  return Math.ceil(dist / bs.tick - 1e-6) * bs.tick;
}
const profitAt = (bs, r, dist) => r.lot * (dist / bs.tick * bs.tvl) - r.lot * r.cost;   // net of commission
// run n losing trades (each at its SL), return state
function runLosses(bs, d, n, init = 1) {
  let cur = init, acc = 0; const rows = [];
  for (let i = 1; i <= n; i++) {
    const r = riskCompute(bs, cur, d), need = acc + TARGET;
    rows.push({ n: i, risk: cur, r, need, acc });
    acc += r.ok ? r.eff : cur; cur = cur * GROW;
  }
  return { rows, acc, cur };
}

test("initial risk is exactly $1 and the EA has NO fixed initial lot", () => {
  assert.match(ea, /input double InpInitialRisk\s*=\s*1\.0;/);
  assert.match(ea, /input double InpTargetProfit\s*=\s*20\.0;/);
  assert.ok(!/InpInitialLot|InpBaseLot|InpFixedLot|InpLot\s*=/.test(ea), "no fixed lot input may exist");
  const r = riskCompute(profile(), 1, 0.5);                       // 100 oz contract, SL distance 0.50 -> $50 per lot
  assert.equal(r.lot, 0.01 * 2); near(r.eff, 1);                   // lot = 0.02 computed, not assumed 1.00
});
test("lot is computed from SL distance + point value + broker spec (changes with the zone and the contract)", () => {
  const a = riskCompute(profile(), 1, 0.5).lot, b = riskCompute(profile(), 1, 0.25).lot, c = riskCompute(profile({ contract: 1, tvl: 0.01, vmin: 0.001, vstep: 0.001, vdig: 3 }), 1, 0.5).lot;
  assert.equal(a, 0.02); assert.equal(b, 0.04); assert.equal(c, 2);   // micro-contract broker: a different lot for the same $1
});
test("the trade never risks more than the target (STRICT): effective loss <= requested", () => {
  for (const d of [0.4, 0.5, 0.73, 1, 2.5]) for (let n = 0; n < 80; n += 7) {
    const req = GROW ** n, r = riskCompute(profile(), req, d);
    if (r.ok) assert.ok(r.eff <= req + 1e-9, `d=${d} n=${n}`);
  }
});
test("below the broker minimum lot: reported clearly (not silently exceeded)", () => {
  const r = riskCompute(profile(), 1, 2);                          // $200 per lot -> raw 0.005 < 0.01
  assert.equal(r.ok, false);
  const ui = calcRisk(profile(), 1, 4140, 4138, "STRICT");
  assert.equal(ui.status, "BELOW_MIN"); assert.equal(ui.vol, 0);
  assert.ok(ea.includes("RISK_BELOW_MIN_VOLUME") && ea.includes("WAITING_VOLUME") && ea.includes("RISK_NO_MARGIN"));
});
test("risk grows by exactly 5% of the previous risk: 1, 1.05, 1.1025, 1.157625 ...", () => {
  const { rows } = runLosses(profile(), 0.5, 5);
  near(rows[0].risk, 1); near(rows[1].risk, 1.05); near(rows[2].risk, 1.1025); near(rows[3].risk, 1.157625, 1e-9);
  for (let i = 1; i < 80; i++) near(GROW ** i / GROW ** (i - 1), 1.05, 1e-12);
  assert.match(ea, /g_curRisk=g_curRisk\*GrowthFactor\(\);/);       // applied to the RISK in $, never to the lot
  assert.match(ea, /input double InpRiskGrowthPct\s*=\s*5\.0;/);
  assert.ok(!/g_lot\s*\*=|lot\s*=\s*lot\s*\*\s*1\.05/.test(ea));
});
test("growth is independent of lot rounding (R(n) = R(n-1) x 1.05 even when the executed loss is smaller than the target)", () => {
  const { rows } = runLosses(profile({ vstep: 0.01 }), 0.7, 40);   // $70/lot: lots are rounded down, effective loss < target
  assert.ok(rows.some((x) => x.r.ok && x.r.eff < x.risk - 1e-6), "rounding must actually occur in this scenario");
  for (let i = 1; i < rows.length; i++) near(rows[i].risk / rows[i - 1].risk, 1.05, 1e-12);
});
test("TP is computed from the ACTUAL lot: a win at any step nets >= (all losses + $20) and not more than one tick-value above", () => {
  for (const d of [0.5, 0.7, 1]) for (const cpl of [0, 7]) {
    const bs = profile({ cpl }), { rows } = runLosses(bs, d, 60);
    for (const row of rows) {
      if (!row.r.ok) continue;
      const dist = tpDistance(bs, row.r, d, row.need), net = profitAt(bs, row.r, dist) - row.acc;
      assert.ok(net >= TARGET - 1e-6, `d=${d} cpl=${cpl} n=${row.n}: net ${net}`);
      const oneTick = row.r.lot * (bs.tick / bs.tick * bs.tvl);
      assert.ok(net <= TARGET + oneTick + 1e-6, `d=${d} cpl=${cpl} n=${row.n}: net ${net} overshoots`);
    }
  }
});
test("the fixed 20:1 ratio is NOT the TP rule any more (rounded-down lots would under-deliver)", () => {
  const bs = profile(), d = 0.7, { rows } = runLosses(bs, d, 12), row = rows[5];
  const rrNet = profitAt(bs, row.r, d * 20) - row.acc;              // old rule
  assert.ok(rrNet < TARGET - 0.01, `old rule delivered ${rrNet}`);
  assert.match(ea, /double TPPriceLot\(/); assert.match(ea, /double TPPriceRR\(/);
  assert.ok(/double TPPrice\(const bool buy,const double entry\)[\s\S]*?TPPriceLot\(/.test(ea));
});
test("trading costs are inside the maths: commission shrinks the lot and lifts the TP", () => {
  const free = riskCompute(profile({ cpl: 0 }), 10, 0.5), paid = riskCompute(profile({ cpl: 7 }), 10, 0.5);
  assert.ok(paid.lot < free.lot); assert.ok(paid.eff <= 10 + 1e-9);
  const ui = calcRisk(profile({ cpl: 7 }), 10, 4140.5, 4140, "STRICT");
  assert.equal(ui.vol, paid.lot); near(ui.eff, paid.eff, 1e-9);     // Mini App preview = EA rule
  assert.ok(ea.includes("double CommissionPerLot()") && ea.includes("perLot+cost"));
});
test("closure rule: the sequence ends ONLY if cycle net >= target; otherwise it continues (shortfall carried)", () => {
  const settle = (acc, banked, net) => { const cyc = banked + net - acc; return cyc >= TARGET - TOL - 1e-9 ? { reset: true } : { reset: false, banked: banked + net, missing: TARGET - cyc }; };
  assert.equal(settle(100, 0, 120).reset, true);                    // 100 lost + 20 net
  assert.equal(settle(100, 0, 119.99).reset, true);                 // within 1 cent
  const part = settle(100, 0, 110);
  assert.equal(part.reset, false); near(part.missing, 10);
  const next = settle(100, part.banked, 10);                         // second TP repays the shortfall
  assert.equal(next.reset, true);
  assert.equal(settle(0, 0, 19).reset, false);                       // a first-trade win below the net target does not reset
  assert.match(ea, /double cycleNet=g_banked\+net-g_accLoss;/);
  assert.match(ea, /cycleNet<g_target-MathMax\(InpNetTolerance,0\.0\)/);
  assert.ok(ea.includes('GS("BNK",g_banked)') && ea.includes('g_banked=GV("BNK",0)'), "banked profit survives a restart");
});
test("after a reset the risk returns to $1 and the accumulated numbers are cleared", () => {
  assert.match(ea, /void ResetRisk\(\)\s*\{\s*g_accLoss=0\.0;\s*g_banked=0\.0;\s*g_seq=0;\s*g_curRisk=g_initRisk;/);
});
test("EA prints/writes the 80-trade plan: 8 groups x 10, six columns, from the live spec", () => {
  assert.ok(ea.includes("void BuildPlan(") && ea.includes("for(int n=1;n<=80;n++)") && ea.includes("(n-1)/10+1"));
  for (const col of ["Target Risk", "Lot (auto)", "Expected Loss at SL", "Cumulative Loss", "Required Profit"]) assert.ok(ea.includes(col), col);
  assert.ok(ea.includes("_Plan80.csv") && ea.includes("RiskCompute(risk,true,g_buyLevel,g_sellLevel,r)"));
  assert.ok(/class PLAN|PlanSig\(\)/.test(ea));
});
test("Mini App plan maths (table UI removed in v4.17, formulas kept as the EA reference): 80 rows, lot from the broker spec, required profit = previous losses + net target", () => {
  const src = html.split("function planRows(){")[1].split("/* end planRows */")[0];
  const GROWc = 1.05, bs = profile(), S = { buy: 4140.5, sell: 4140, risk: 1, target: 20, rk: null };
  const rows = new Function("spec", "S", "calcRisk", "GROW", "function planRows(){" + src + "return planRows();")(() => bs, S, calcRisk, GROWc);
  assert.equal(rows.length, 80);
  near(rows[0].risk, 1); near(rows[1].risk, 1.05); near(rows[79].risk, 1.05 ** 79, 1e-9);
  assert.equal(rows[0].lot, 0.02);
  let cum = 0;
  for (const r of rows) { near(r.need, cum + 20, 1e-9); cum += r.loss; near(r.cum, cum, 1e-9); assert.ok(r.loss <= r.risk + 1e-9); }
  // another broker => other lots (nothing is hard-wired to 1.00)
  const micro = new Function("spec", "S", "calcRisk", "GROW", "function planRows(){" + src + "return planRows();")(() => profile({ contract: 1, tvl: 0.01, vmin: 0.001, vstep: 0.001, vdig: 3 }), S, calcRisk, GROWc);
  assert.notEqual(micro[0].lot, rows[0].lot);
});
test("exact reference numbers of the plan with the requested risk (80th trade)", () => {
  let cum = 0, risk;
  for (let n = 1; n <= 80; n++) { risk = 1.05 ** (n - 1); cum += risk; }
  near(risk, 47.2, 0.01); near(cum, 971.23, 0.01);
});
test("Worker release matches the EA protocol and the Mini App sends the 4-decimal risk", () => {
  assert.ok(readFileSync(join(root, "worker", "worker.js"), "utf8").includes('EA_PROTOCOL = "2.31"'));
  assert.ok(ea.includes('DoubleToString(g_curRisk,4)'));
});
