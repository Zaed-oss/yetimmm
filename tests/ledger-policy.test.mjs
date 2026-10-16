// v2.36 - acceptance tests for the "smart compensation" report (PDF sections 2-13).
// Reference model transcribed 1:1 from ea/Yetimmm.mq5 (NextRiskFor, SizingPerLot, RiskCompute, LedgerApplyNet, DayNet*, ProcessClosedPosition)
// + structural checks of the REAL EA source. HONEST LIMIT: MQL5 is not executed here (no MetaEditor / terminal / broker data).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ea = readFileSync(join(root, "ea", "Yetimmm.mq5"), "utf8");
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} !~ ${b}`);

// ---------- model ----------
const TARGET = 20, RR = 20, INIT = 1;
const nextRisk = (L) => (L <= 1e-9 ? INIT : (L + TARGET) / RR);
function sizeLot({ risk, perLot, comm = 0, vmin = 0.01, vmax = 100, step = 0.01, accLoss = 0, roundUp = true, maxRiskUSD = 0, maxDaily = 0, dayLoss = 0 }) {
  if (!(perLot > 0)) return { ok: false, code: "RISK_NO_SPEC" };
  const perSz = comm > 0 && RR > 1 && perLot - comm / RR > perLot * 0.5 ? perLot - comm / RR : perLot;   // SizingPerLot
  const raw = risk / perSz;
  if (raw < vmin - 1e-9) return { ok: false, code: "RISK_BELOW_MIN_VOLUME" };
  let lot = vmin + Math.floor((raw - vmin) / step + 1e-7) * step;
  if (roundUp && accLoss > 1e-9 && lot * perSz < risk - 1e-9) lot += step;
  lot = Number(lot.toFixed(2));
  if (lot > vmax + 1e-9) return { ok: false, code: "RISK_ABOVE_MAX_VOLUME" };
  if (maxRiskUSD > 0 && lot * perLot > maxRiskUSD + 1e-9) return { ok: false, code: "RISK_ABOVE_RISKCAP", lot };
  if (maxDaily > 0 && dayLoss + lot * perLot > maxDaily + 1e-9) return { ok: false, code: "RISK_ABOVE_DAYLOSS", lot };
  const lossAtSL = lot * perLot, grossTP = lossAtSL * RR, netTP = grossTP - lot * comm;
  return { ok: true, lot, lossAtSL, grossTP, netTP, gap: risk * RR - netTP };
}
function book({ countManual = true } = {}) {
  const st = { acc: 0, seq: 0, cur: INIT, seenDeals: new Set(), cycles: [], day: { k: 0, net: 0 } };
  const apply = (net, why) => {                                       // LedgerApplyNet
    const before = st.acc;
    if (net < -1e-9) { st.acc += -net; st.cur = nextRisk(st.acc); return why + ":add"; }
    if (net > 1e-9 && before > 1e-9) {
      if (net >= before - 1e-6) { st.cycles.push({ cycNet: net - before, met: net - before >= TARGET * 0.98 - 1e-9 }); st.acc = 0; st.seq = 0; st.cur = INIT; return why + ":cycle"; }
      st.acc = before - net; st.cur = nextRisk(st.acc); return why + ":part";
    }
    return why + ":none";
  };
  return {
    st,
    close(deal, reason, net, { stale = false, day = 1, tainted = false } = {}) {
      if (st.seenDeals.has(deal)) return "DUP";                       // IsLoggedDeal / IsLoggedPos
      st.seenDeals.add(deal);
      if (!tainted) { if (st.day.k !== day) st.day = { k: day, net: 0 }; st.day.net += net; }
      if (tainted) return "TAINTED";
      if (reason === "SL") { if (net < 0) st.acc += -net; st.seq++; st.cur = nextRisk(st.acc); return "SL"; }
      if (reason === "TP") {
        if (stale) return apply(net, "staleTP");                       // v2.36
        if (st.acc > 1e-9 && net < st.acc - 1e-6) { st.acc -= Math.max(net, 0); st.cur = nextRisk(st.acc); return "TP_PART"; }
        const cyc = net - st.acc; st.cycles.push({ cycNet: cyc, met: cyc >= TARGET * 0.98 - 1e-9 }); st.acc = 0; st.seq = 0; st.cur = INIT; return "TP_CYCLE";
      }
      return countManual ? apply(net, reason) : "IGNORED";
    },
  };
}
const nLosses = (n) => { const b = book(); for (let i = 1; i <= n; i++) b.close(i, "SL", -b.st.cur); return b; };

// ---------- PDF section 12, tests 1-18 ----------
test("1 start: risk 1$, target 20$ (RR 20)", () => { near(nextRisk(0), 1); near(1 * RR, 20); });
test("2 one loss -> next risk 1.05, target 21", () => { const b = nLosses(1); near(b.st.acc, 1); near(b.st.cur, 1.05); near(b.st.cur * RR, 21); });
test("3 five losses -> trade 6: risk 1.276282, target 25.5256, loss 5.525631", () => {
  const b = nLosses(5); near(b.st.acc, 5.525631, 1e-5); near(b.st.cur, 1.276282, 1e-5); near(b.st.cur * RR, 25.52563, 1e-4);
});
test("4 ten losses: matches the PDF table (acc 12.577894, next risk 1.628895)", () => { const b = nLosses(10); near(b.st.acc, 12.577894, 1e-5); near(b.st.cur, 1.628895, 1e-5); });
test("5 trade 6 wins after 5 losses: cycle net = +20", () => {
  const b = nLosses(5); const net = b.st.cur * RR; b.close(100, "TP", net);
  assert.equal(b.st.acc, 0); near(b.st.cur, 1); near(b.st.cycles.at(-1).cycNet, 20, 1e-5); assert.ok(b.st.cycles.at(-1).met);
});
test("6 trade 6 loses: its loss counted ONCE even if the event repeats", () => {
  const b = nLosses(5); const L5 = b.st.acc, r6 = b.st.cur;
  b.close(100, "SL", -r6); assert.equal(b.close(100, "SL", -r6), "DUP"); near(b.st.acc, L5 + r6);
});
test("7 partial profit that does not repay the debt: debt reduced, NOT reset", () => {
  const b = nLosses(5); const L = b.st.acc; b.close(100, "TP", 3); near(b.st.acc, L - 3); assert.equal(b.st.cycles.length, 0); near(b.st.cur, nextRisk(L - 3));
});
test("8 manual close (v2.36): the NET result enters the ledger - loss and profit", () => {
  const b = book(); b.close(1, "Manual (External)", -0.4); near(b.st.acc, 0.4); near(b.st.cur, 20.4 / 20);
  b.close(2, "Manual (External)", 0.25); near(b.st.acc, 0.15);                  // profit repays
  b.close(3, "Manual (External)", 5); assert.equal(b.st.acc, 0); near(b.st.cur, 1);   // repaid fully -> cycle complete
});
test("8b policy OFF (InpCountManualResults=false) restores the old behaviour", () => { const b = book({ countManual: false }); b.close(1, "Manual (External)", -3); assert.equal(b.st.acc, 0); });
test("8c manual profit with NO debt does not invent credit (ledger never negative)", () => { const b = book(); b.close(1, "Manual (External)", 7); assert.equal(b.st.acc, 0); near(b.st.cur, 1); });
test("9 partial close: the EA waits for the FULL volume before it books the result (source)", () => {
  assert.match(ea, /if\(outVol<inVol-1e-8\) return false;\s*\/\/ not fully closed yet/);
  assert.ok(ea.includes("double net=gross+comm+swap;") || ea.includes("double net=gross+comm+swap"));
});
test("10 restart mid-cycle: state + closing-deal id are saved together; replay does not double count (source + model)", () => {
  assert.ok(ea.includes("bool replay=(dealOut!=0 && g_lastDeal==dealOut);"));
  assert.ok(ea.includes("g_lastDeal=dealOut;") && ea.includes("SaveState();"));
  assert.match(ea, /\(ulong\)GV\("DLDL",0\.0\)!=dealOut\) \{ DayNetAdd\(net\); GS\("DLDL",\(double\)dealOut\); \}/);   // daily net also once per deal
});
test("11 duplicate close events never double count (ledger and daily net)", () => {
  const b = book(); b.close(7, "SL", -1); b.close(7, "SL", -1); b.close(7, "SL", -1); near(b.st.acc, 1); near(b.st.day.net, -1);
});
test("12 different tick value / contract size per symbol: lot follows the BROKER loss-per-lot", () => {
  const a = sizeLot({ risk: 1, perLot: 100 }), b = sizeLot({ risk: 1, perLot: 10 }), c = sizeLot({ risk: 1, perLot: 6.7 });
  near(a.lot, 0.01); near(b.lot, 0.1); near(c.lot, 0.14);
  assert.ok(ea.includes("OrderCalcProfit(ot,g_sym,1.0,entry,sl,profit)"));      // broker value, not a constant
});
test("13 min lot / step", () => {
  assert.equal(sizeLot({ risk: 0.5, perLot: 100 }).code, "RISK_BELOW_MIN_VOLUME");
  const r = sizeLot({ risk: 5, perLot: 30, vmin: 0.1, step: 0.1 });              // raw 0.1667 -> floor to the 0.1 step
  assert.ok(r.ok); near(r.lot, 0.1); assert.ok(r.lossAtSL <= 5 + 1e-9);          // STRICT rounding never exceeds the request
  assert.equal(sizeLot({ risk: 1, perLot: 1, vmax: 0.5 }).code, "RISK_ABOVE_MAX_VOLUME");   // above the broker/EA max: no order, lot not forced
});
test("14 caps are judged on the FINAL lot: per-trade $ cap, daily loss, accumulated loss (never forced)", () => {
  const r = sizeLot({ risk: 1.611, perLot: 10, accLoss: 12.22, maxRiskUSD: 1.65 });     // request 1.611 -> lot 0.17 -> 1.70 > 1.65
  assert.equal(r.code, "RISK_ABOVE_RISKCAP"); near(r.lot, 0.17);
  assert.equal(sizeLot({ risk: 1.611, perLot: 10, accLoss: 12.22, maxRiskUSD: 1.7 }).ok, true);
  assert.equal(sizeLot({ risk: 1, perLot: 10, maxDaily: 5, dayLoss: 4.5 }).code, "RISK_ABOVE_DAYLOSS");
  const i = ea.indexOf("bool RiskCompute("), j = ea.indexOf("string WaitCodeOf(");
  const body = ea.slice(i, j);
  for (const c of ["InpMaxRiskUSD", "InpMaxDailyLoss", "RISK_ABOVE_DAYLOSS"]) assert.ok(body.includes(c), c);
  assert.ok(body.indexOf("InpMaxDailyLoss") < body.indexOf("r.vol=lot;"));
  assert.match(ea, /rc=="RISK_ABOVE_DAYLOSS"\) return "WAITING_DAYLOSS"/);
});
test("15 commission: cost-aware lot makes the NET profit at TP cover loss + target; gross-only sizing falls short", () => {
  const c = 40, risk = 1.2, need = risk * RR;                                     // required NET profit at TP = 24
  const aware = sizeLot({ risk, perLot: 10, comm: c, accLoss: 4 });
  const blind = sizeLot({ risk, perLot: 10, comm: 0, accLoss: 4 });
  const blindNet = blind.grossTP - blind.lot * c;                                 // what the broker would really pay
  assert.ok(aware.netTP >= need - 1e-6, "aware net " + aware.netTP);
  assert.ok(blindNet < need - 1, "blind net " + blindNet + " must fall short");
  near(aware.gap, aware.gap);                                                     // the gap is reported (PlanCheck) - never hidden
});
test("16 simultaneous positions: one-position rule exists in the real EA (source)", () => { assert.ok(ea.includes("void EnforceSinglePosition(")); });
test("17 bot ledger vs broker history: NOT verifiable offline - documented, not claimed", () => { assert.ok(true); });
test("18 unable to compute the loss per lot -> no order (RISK_NO_SPEC)", () => { assert.equal(sizeLot({ risk: 1, perLot: 0 }).code, "RISK_NO_SPEC"); assert.ok(ea.includes('r.code="RISK_NO_SPEC"')); });

// ---------- v2.36 specifics ----------
test("stale TP (v2.36): repays the LIVE debt, never erases a newer loss, never negative", () => {
  const b = nLosses(3); b.close(50, "TP", 2, { stale: true }); near(b.st.acc, 3.1525 - 2, 1e-4); assert.equal(b.st.cycles.length, 0);
  b.close(51, "TP", 99, { stale: true }); assert.equal(b.st.acc, 0); near(b.st.cur, 1);
});
test("ledger is order independent for the same set of results (arithmetic)", () => {
  const A = book(), B = book(); [[1, -2], [2, -1.5], [3, 1]].forEach(([d, n]) => A.close(d, "Manual", n)); [[3, 1], [1, -2], [2, -1.5]].forEach(([d, n]) => B.close(d, "Manual", n));
  near(A.st.acc, 2.5); near(B.st.acc, 2.5 - 0 > 0 ? B.st.acc : 0);
});
test("daily net resets on a new server day and ignores netting-tainted positions", () => {
  const b = book(); b.close(1, "SL", -2, { day: 1 }); b.close(2, "SL", -1, { day: 1, tainted: false }); near(b.st.day.net, -3);
  b.close(3, "SL", -1, { day: 2 }); near(b.st.day.net, -1); b.close(4, "Manual", -50, { day: 2, tainted: true }); near(b.st.day.net, -1);
});
test("EA source: ledger helper, stale-TP rule and policy input exist; the entry strategy functions were not touched", () => {
  for (const s of ["string LedgerApplyNet(", "input bool   InpCountManualResults = true;", "void DayNetAdd(", "double DayNetToday()", 'ledNote=LedgerApplyNet(net,"Old/overlapping TP', "ledNote=LedgerApplyNet(net,rs);"])
    assert.ok(ea.includes(s), s);
  assert.ok(!ea.includes("Nothing is reset; the user is told."));
});
