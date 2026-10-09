// Reference model of the Recovery Plan (PDF "risk multiplication system") and of EA v2.24 RecoveryGuardBlocks().
// It proves the ARITHMETIC and the guard LOGIC. It does NOT run MQL5: compile (F7) and test in the Strategy Tester.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ea = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "ea", "Yetimmm.mq5"), "utf8");
const near = (a, b, e = 0.006) => assert.ok(Math.abs(a - b) < e, `${a} !~ ${b}`);

// mirrors NextRiskFor(L): L<=1e-9 -> initRisk, else (L + target) / rr
const nextRisk = (L, init = 1, target = 20, rr = 20) => (L <= 1e-9 ? init : (L + target) / rr);
const plan = (n, init = 1, target = 20, rr = 20) => {
  const rows = []; let L = 0;
  for (let i = 1; i <= n; i++) { const r = nextRisk(L, init, target, rr); L += r; rows.push({ n: i, risk: r, tp: r * rr, cum: L }); }
  return rows;
};
// mirrors RecoveryGuardBlocks()
const guard = ({ seq, accLoss, curRisk, balance, maxSeq = 0, maxPct = 0 }) => {
  if (maxSeq > 0 && accLoss > 1e-9 && seq >= maxSeq) return "WAITING_SEQCAP";
  if (maxPct > 0) { const cap = balance > 0 ? balance * maxPct / 100 : 0; if (curRisk > cap + 1e-9) return "WAITING_RISKCAP"; }
  return "";
};

test("first trades match the PDF table: 1.00/20.00/1.00, 1.05/21.00/2.05, 1.10/22.05/3.15", () => {
  const p = plan(3);
  near(p[0].risk, 1); near(p[0].tp, 20); near(p[0].cum, 1);
  near(p[1].risk, 1.05); near(p[1].tp, 21); near(p[1].cum, 2.05);
  near(p[2].risk, 1.1025); near(p[2].tp, 22.05); near(p[2].cum, 3.1525);
});
test("risk grows exactly 5% after every loss", () => {
  const p = plan(80);
  for (let i = 1; i < p.length; i++) near(p[i].risk / p[i - 1].risk, 1.05, 1e-12);
});
test("closed form: L_n = (1.05^n - 1) / 0.05 and R_n = 1.05^(n-1)", () => {
  const p = plan(80);
  for (const n of [1, 5, 10, 40, 80]) { near(p[n - 1].cum, (1.05 ** n - 1) / 0.05, 1e-9); near(p[n - 1].risk, 1.05 ** (n - 1), 1e-9); }
});
test("every trade is exactly 20:1 (TP profit = 20 x risk)", () => {
  for (const r of plan(80)) near(r.tp / r.risk, 20, 1e-9);
});
test("a win at any step nets exactly +20 after repaying all earlier losses", () => {
  const p = plan(80);
  for (let i = 0; i < 80; i++) { const before = i === 0 ? 0 : p[i - 1].cum; near(p[i].tp - before, 20, 1e-9); }
});
test("the PDF table is approximate: exact loss #80 = 971.23 (PDF 957.55), exact risk #80 = 47.20 (PDF 46.46)", () => {
  const r = plan(80)[79];
  near(r.cum, 971.23); near(r.risk, 47.20);
  assert.ok(Math.abs(r.cum - 957.55) > 10);
});
test("exact reference values used in docs/RECOVERY-PLAN.md", () => {
  const p = plan(80);
  near(p[5].cum, 6.80); near(p[9].cum, 12.58); near(p[19].cum, 33.07); near(p[29].cum, 66.44);
  near(p[39].cum, 120.80); near(p[49].cum, 209.35); near(p[59].cum, 353.58); near(p[69].cum, 588.53);
});
test("balance needed for a 20-loss cap is about 33.07 and for 15 about 21.58", () => {
  const p = plan(20); near(p[19].cum, 33.07); near(plan(15)[14].cum, 21.58);
});
test("break-even win rate at 20:1 is 1/21 = 4.76%", () => { near(100 / 21, 4.7619, 1e-3); });
test("probability of 80 straight losses: 5% win rate ~1.6%, 10% ~0.02%", () => {
  near(0.95 ** 80 * 100, 1.65, 0.1); near(0.9 ** 80 * 100, 0.0218, 0.01);
});
test("a different RR keeps the same recurrence: RR=10, target=10 -> growth 10%", () => {
  const p = plan(5, 1, 10, 10); for (let i = 1; i < 5; i++) near(p[i].risk / p[i - 1].risk, 1.1, 1e-9);
});
test("guard: off by default (0/0) never blocks, even at 80 losses", () => {
  assert.equal(guard({ seq: 80, accLoss: 971, curRisk: 47, balance: 100 }), "");
});
test("guard: sequence cap blocks at N losses and only while a debt exists", () => {
  assert.equal(guard({ seq: 19, accLoss: 30, curRisk: 2, balance: 1000, maxSeq: 20 }), "");
  assert.equal(guard({ seq: 20, accLoss: 33.07, curRisk: 2.5, balance: 1000, maxSeq: 20 }), "WAITING_SEQCAP");
  assert.equal(guard({ seq: 20, accLoss: 0, curRisk: 1, balance: 1000, maxSeq: 20 }), "");
});
test("guard: risk-% cap blocks only when the next risk exceeds the share of the balance", () => {
  assert.equal(guard({ seq: 0, accLoss: 0, curRisk: 1, balance: 100, maxPct: 2 }), "");                 // 2% of 100 = 2 >= 1
  assert.equal(guard({ seq: 6, accLoss: 6.8, curRisk: 2.01, balance: 100, maxPct: 2 }), "WAITING_RISKCAP");
  assert.equal(guard({ seq: 0, accLoss: 0, curRisk: 1, balance: 0, maxPct: 2 }), "WAITING_RISKCAP");     // no balance -> never arm
});
test("EA v2.24 contains the exact recurrence, the guard, both inputs, both wait codes and both hooks", () => {
  assert.match(ea, /return\s*\(L\+g_target\)\/g_rr;/);
  for (const need of ["bool RecoveryGuardBlocks(", "void PrintRecoveryPlan(", "input int    InpMaxSeqLosses", "input double InpMaxRiskPctBal", "WAITING_SEQCAP", "WAITING_RISKCAP"]) assert.ok(ea.includes(need), need);
  assert.equal((ea.match(/RecoveryGuardBlocks\(rgw,rgc\)/g) || []).length, 2);
});
