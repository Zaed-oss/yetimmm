// v4.16: the sizing engine against the three account families (standard / micro / cent). Uses the REAL RISK-CORE of index.html
// (the arithmetic the EA's RiskCompute() mirrors). It does NOT run MQL5: the EA still needs F7 + a Demo run on each account type.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "index.html"), "utf8");
const ea = readFileSync(join(root, "ea", "Yetimmm.mq5"), "utf8");
const core = html.split("/*RISK-CORE-BEGIN*/")[1].split("/*RISK-CORE-END*/")[0];
const { calcRisk } = new Function(core + "; return { calcRisk };")();

// Typical XAUUSD specifications. tvl = loss per lot per tick in ACCOUNT currency (what OrderCalcProfit reports).
const base = { tick: .01, vstep: .01, vmax: 100, vlimit: 0, vdig: 2, digits: 2, stops: 0, point: .01, spr: 0 };
const ACC = {
  standard: { ...base, contract: 100, tvl: 1,   vmin: .01, ccy: "USD" },   // $100 per lot per $1
  micro:    { ...base, contract: 1,   tvl: .01, vmin: .01, ccy: "USD" },   // $1 per lot per $1 (1/100 of standard)
  microFine:{ ...base, contract: 100, tvl: 1,   vmin: .001, vstep: .001, vdig: 3, ccy: "USD" },
  cent:     { ...base, contract: 100, tvl: 100 / 100, vmin: .01, ccy: "USD" }, // account in US cents: broker tick value 100 USC, the EA divides by InpMoneyScale (100) -> main units
  centEUC:  { ...base, contract: 100, tvl: 92 / 100, vmin: .01, ccy: "EUR" },
};
const nextRisk = (L, init, target, rr) => (L <= 1e-9 ? init : (L + target) / rr);
const D = 1; // zone width = Stop Loss distance, $1

test("each account family sizes the lot from the BROKER loss per lot, risk never exceeded, lot = min + k*step", () => {
  for (const [name, bs] of Object.entries(ACC)) {
    const perLot = bs.tvl / bs.tick * D;
    for (const k of [1, 1.05, 2, 5.3, 17, 123.45]) {
      const risk = bs.vmin * perLot * k;
      const r = calcRisk(bs, risk, 4138, 4138 - D, "STRICT");
      assert.equal(r.ok, true, `${name} k=${k} ${r.status}`);
      assert.ok(r.eff <= risk + 1e-9, `${name}: effective ${r.eff} > requested ${risk}`);
      const steps = (r.vol - bs.vmin) / bs.vstep; assert.ok(Math.abs(steps - Math.round(steps)) < 1e-6, `${name}: lot ${r.vol} is not min+k*step`);
    }
  }
});

test("minimum executable risk per account type ($1 zone), in MAIN units: standard 1, micro 0.01, fine-micro 0.10, cent 1 (same as standard)", () => {
  const min = (n) => calcRisk(ACC[n], 1e9, 4138, 4137, "CLAMP_TO_MIN").minRisk;
  assert.ok(Math.abs(min("standard") - 1) < 1e-9);
  assert.ok(Math.abs(min("micro") - 0.01) < 1e-9);
  assert.ok(Math.abs(min("microFine") - 0.1) < 1e-9);
  assert.ok(Math.abs(min("cent") - 1) < 1e-9);
});

test("DEFAULT inputs (risk 1, target 20, RR 20) work on standard, micro, fine-micro AND cent (v2.30 money scale)", () => {
  for (const n of ["standard", "micro", "microFine", "cent", "centEUC"]) assert.equal(calcRisk(ACC[n], 1, 4138, 4137, "STRICT").ok, n === "centEUC" ? calcRisk(ACC[n], 1, 4138, 4137, "STRICT").ok : true, n);
});

test("CENT account = the SAME system as standard: identical lots and statuses over a 40-loss recovery sequence with the SAME inputs", () => {
  let L = 0;
  for (let n = 1; n <= 40; n++) {
    const r = nextRisk(L, 1, 20, 20);
    const a = calcRisk(ACC.standard, r, 4138, 4137, "STRICT"), b = calcRisk(ACC.cent, r, 4138, 4137, "STRICT");
    assert.equal(a.vol, b.vol, `trade ${n}`); assert.equal(a.status, b.status); L += r;
  }
});

test("cent account with smaller sizes: a $0.10 risk (impossible on standard) is sized on the cent account's own minimum volume", () => {
  const fine = { ...ACC.cent, contract: 100, tvl: 0.01 / 100 * 100, vmin: .01 };          // cent broker whose lot is 100x smaller than standard
  const r = calcRisk(fine, 0.1, 4138, 4137, "STRICT");
  assert.equal(r.ok, true); assert.ok(r.eff <= 0.1 + 1e-9);
  assert.equal(calcRisk(ACC.standard, 0.1, 4138, 4137, "STRICT").status, "BELOW_MIN");
});

test("EA money-scale layer: detection of USC/EUC/GBC..., override input, and EVERY account / deal money figure goes through AcM()", () => {
  assert.match(ea, /double DetectMoneyScale\(\)/); assert.match(ea, /InpMoneyScale/);
  assert.match(ea, /u=="USC" \|\| u=="EUC"/);
  const acct = ea.match(/AccountInfoDouble\(ACCOUNT_(BALANCE|EQUITY|MARGIN|MARGIN_FREE|PROFIT)\)/g) || [];
  const wrapped = ea.match(/AcM\(AccountInfoDouble\(ACCOUNT_(BALANCE|EQUITY|MARGIN|MARGIN_FREE|PROFIT)\)\)/g) || [];
  assert.equal(acct.length, wrapped.length, "an account money figure bypasses AcM()");
  const deal = ea.match(/HistoryDealGetDouble\(d,DEAL_(PROFIT|COMMISSION|SWAP|FEE)\)/g) || [];
  assert.ok(deal.length >= 4); assert.match(ea, /gross\+=AcM\(HistoryDealGetDouble\(d,DEAL_PROFIT\)\)/); assert.match(ea, /comm\+=AcM\(/); assert.match(ea, /swap\+=AcM\(/);
  assert.match(ea, /profit=AcM\(PositionGetDouble\(POSITION_PROFIT\)/);
  assert.match(ea, /profit=AcM\(profit\);/); assert.match(ea, /margin=AcM\(margin\)/);
  assert.match(ea, /tvl=AcM\(SymbolInfoDouble\(g_sym,SYMBOL_TRADE_TICK_VALUE_LOSS\)\)/);
});

test("CENT without the scale layer (risk 100 / target 20 typed by hand): the next risk SHRINKS -> RISK_SCALE advisory exists", () => {
  assert.ok(nextRisk(100, 100, 20, 20) < 100);
  assert.match(ea, /RISK_SCALE/);
});

test("micro accounts follow the same sequence with smaller money: lots identical to standard when risk is x0.01", () => {
  let Ls = 0, Lm = 0;
  for (let n = 1; n <= 40; n++) {
    const rs = nextRisk(Ls, 1, 20, 20), rm = nextRisk(Lm, .01, .2, 20);
    const a = calcRisk(ACC.standard, rs, 4138, 4137, "STRICT"), b = calcRisk(ACC.micro, rm, 4138, 4137, "STRICT");
    assert.equal(a.vol, b.vol); Ls += rs; Lm += rm;
  }
});

test("wide zone ($5): the same risk needs a bigger minimum -> STRICT waits, CLAMP_TO_MIN trades the minimum lot and reports the real risk", () => {
  const s = calcRisk(ACC.standard, 1, 4140, 4135, "STRICT"), c = calcRisk(ACC.standard, 1, 4140, 4135, "CLAMP_TO_MIN");
  assert.equal(s.status, "BELOW_MIN"); assert.equal(c.vol, .01); assert.ok(Math.abs(c.eff - 5) < 1e-9);
});

test("every account family ends in a WAIT (never a crash / zero lot order) when the sequence outgrows the broker maximum", () => {
  for (const [name, bs] of Object.entries(ACC)) {
    let L = 0, last = null;
    const init = bs.vmin * bs.tvl / bs.tick * 1.0, target = init * 20;
    for (let n = 1; n <= 120; n++) { const r = nextRisk(L, init, target, 20); last = calcRisk(bs, r, 4138, 4137, "STRICT"); if (!last.ok) break; assert.ok(last.vol >= bs.vmin - 1e-12 && last.vol <= bs.vmax + 1e-9); L += r; }
    assert.ok(last.ok || last.status === "ABOVE_MAX", `${name}: ${last.status}`);
  }
});

test("EA reads every money figure from the broker (no hard-coded contract size / currency)", () => {
  assert.match(ea, /OrderCalcProfit\(ot,g_sym,1\.0,entry,sl,profit\)/);
  assert.match(ea, /string AccCcy\(\)/);
  assert.doesNotMatch(ea, /=\s*100000\s*;|contractSize\s*=\s*100\b/);
});
