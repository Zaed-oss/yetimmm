// v2.35 forensic audit tests - independent re-computation of the numbers in the "urgent compensation report" (the PDF screenshots)
// and a reference model of the EA's lot / ledger rules, transcribed from ea/Yetimmm.mq5 (RiskCompute, NextRiskFor, ProcessClosedPosition).
// HONEST LIMIT: this proves ARITHMETIC and RULES. It does NOT run MQL5 and it does NOT read any broker / account data.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ea = readFileSync(join(root, "ea", "Yetimmm.mq5"), "utf8");
const near = (a, b, e = 0.006) => assert.ok(Math.abs(a - b) < e, `${a} !~ ${b}`);

// ---- transcription of NextRiskFor + RiskCompute (STRICT policy, no commission, no cap) ----
const nextRisk = (L, init, target, rr) => (L <= 1e-9 ? init : (L + target) / rr);
function sizeLot({ risk, perLot, vmin = 0.01, vmax = 100, step = 0.01, accLoss = 0, roundUp = true, maxPct = 0, balance = 0, maxAcc = 0 }) {
  const raw = risk / perLot;
  if (raw < vmin - 1e-9) return { ok: false, code: "RISK_BELOW_MIN_VOLUME" };
  let lot = vmin + Math.floor((raw - vmin) / step + 1e-7) * step;
  if (roundUp && accLoss > 1e-9 && lot * perLot < risk - 1e-9) lot += step;
  lot = Number(lot.toFixed(2));
  if (lot > vmax + 1e-9) return { ok: false, code: "RISK_ABOVE_MAX_VOLUME" };
  // v2.35 final-size caps (judged on the FINAL lot)
  if (maxPct > 0) { const cap = balance > 0 ? balance * maxPct / 100 : 0; if (lot * perLot > cap + 1e-9) return { ok: false, code: "RISK_ABOVE_RISKCAP", lot }; }
  if (maxAcc > 0 && accLoss > 1e-9 && accLoss + lot * perLot > maxAcc + 1e-9) return { ok: false, code: "RISK_ABOVE_ACCCAP", lot };
  return { ok: true, lot, raw, effective: lot * perLot };
}

test("PDF case: accumulated loss 12.22 -> next risk 1.61 (formula (L+target)/RR with target=RR=20)", () => {
  near(nextRisk(12.22, 1, 20, 20), 1.611);
});
test("PDF case: the screenshot's 0.17 lot / 1.70 loss / 34.00 profit are EXACTLY what the EA code produces for risk 1.61 when loss-per-lot = 10 (recovery round-up)", () => {
  const r = sizeLot({ risk: 1.611, perLot: 10, accLoss: 12.22 });
  assert.equal(r.lot, 0.17);
  near(r.effective, 1.70);              // chart loss 1.70
  near(r.lot * 10 * 20, 34.0);          // chart profit at TP 34.00
  // the same request WITHOUT a debt (first trade) is rounded DOWN: real risk never above the request
  assert.equal(sizeLot({ risk: 1.611, perLot: 10, accLoss: 0 }).lot, 0.16);
});
test("the 1.61 vs 1.70 gap is not a rounding error of display: it is the deliberate round-up (InpRecoveryRoundUp=true) and is bounded by ONE lot step", () => {
  assert.match(ea, /input bool\s+InpRecoveryRoundUp\s*=\s*true/);
  for (const risk of [1.0, 1.05, 1.611, 2.5, 7.77, 40]) {
    const r = sizeLot({ risk, perLot: 10, accLoss: 5 });
    assert.ok(r.effective >= risk - 1e-9 && r.effective < risk + 10 * 0.01 + 1e-9, `risk ${risk} -> ${r.effective}`);
  }
});
test("with the round-up, TP net >= losses + target (the reason the EA rounds up); with floor it can fall short", () => {
  const L = 12.22, need = L + 20;
  const up = sizeLot({ risk: nextRisk(L, 1, 20, 20), perLot: 10, accLoss: L });
  const dn = sizeLot({ risk: nextRisk(L, 1, 20, 20), perLot: 10, accLoss: L, roundUp: false });
  assert.ok(up.lot * 10 * 20 >= need);          // 34.00 >= 32.22
  assert.ok(dn.lot * 10 * 20 < need);           // 32.00 <  32.22  -> a permanent 0.22 debt per cycle would remain
});
test("net P/L (-4.62) and accumulated loss (12.22) are DIFFERENT ledgers: 10000-4.62 = 9995.38 is consistent, and the gap 7.60 is NOT explained by sizing", () => {
  near(10000 - 4.62, 9995.38, 1e-9);
  near(12.22 - 4.62, 7.60, 1e-9);
  // 12.22 is the debt of the CURRENT chain; account P/L also contains earlier chains / manual trades / non-counted closes. Needs the Trades log to prove.
});

// ---- v2.35 final-size caps ----
test("v2.35: a cap that only saw the REQUEST (old guard) would let the rounded-up lot exceed it; the final-size cap blocks it", () => {
  const balance = 100, maxPct = 1.65;                 // cap = 1.65
  // old guard: requested 1.611 <= 1.65 -> passes
  assert.ok(1.611 <= balance * maxPct / 100);
  // final lot 0.17 risks 1.70 > 1.65 -> blocked by the new check
  const r = sizeLot({ risk: 1.611, perLot: 10, accLoss: 12.22, maxPct, balance });
  assert.equal(r.ok, false); assert.equal(r.code, "RISK_ABOVE_RISKCAP");
});
test("v2.35: caps OFF (0) or satisfied -> sizing identical to v2.34", () => {
  const a = sizeLot({ risk: 1.611, perLot: 10, accLoss: 12.22 });
  const b = sizeLot({ risk: 1.611, perLot: 10, accLoss: 12.22, maxPct: 0, maxAcc: 0 });
  assert.deepEqual(a, b);
  assert.equal(sizeLot({ risk: 1.611, perLot: 10, accLoss: 12.22, maxPct: 2, balance: 100 }).lot, 0.17);
});
test("v2.35: accumulated-loss cap uses the final lot (12.22 + 1.70 = 13.92)", () => {
  assert.equal(sizeLot({ risk: 1.611, perLot: 10, accLoss: 12.22, maxAcc: 13.9 }).code, "RISK_ABOVE_ACCCAP");
  assert.equal(sizeLot({ risk: 1.611, perLot: 10, accLoss: 12.22, maxAcc: 13.95 }).ok, true);
});
test("v2.35 EA source: both final-size checks exist inside RiskCompute, are mapped to WAITING_* (never a fatal error) and the version is 2.35", () => {
  const i = ea.indexOf("bool RiskCompute("), j = ea.indexOf("string WaitCodeOf(");
  const body = ea.slice(i, j);
  assert.ok(body.includes("RISK_ABOVE_RISKCAP") && body.includes("RISK_ABOVE_ACCCAP"));
  assert.ok(body.indexOf("RISK_ABOVE_RISKCAP") < body.indexOf("r.vol=lot;"), "cap must be checked BEFORE the lot is accepted");
  assert.match(ea, /rc=="RISK_ABOVE_RISKCAP"\) return "WAITING_RISKCAP"/);
  assert.match(ea, /rc=="RISK_ABOVE_ACCCAP"\) return "WAITING_ACCLOSSCAP"/);
  assert.match(ea, /#define YT_VER "2\.36"/);
});

// ---- ledger rules transcribed from ProcessClosedPosition (idempotent, net-only TP reset) ----
function ledger({ target = 20, rr = 20, init = 1, netOnly = true } = {}) {
  const st = { acc: 0, seq: 0, cur: init, seen: new Set(), cycles: [] };
  return {
    st,
    close(dealId, reason, net) {
      if (st.seen.has(dealId)) return "DUP_IGNORED";            // IsLoggedDeal / IsLoggedPos
      st.seen.add(dealId);
      if (reason === "SL") { if (net < 0) st.acc += -net; st.seq++; st.cur = nextRisk(st.acc, init, target, rr); return "SL"; }
      if (reason === "TP") {
        if (netOnly && st.acc > 1e-9 && net < st.acc - 1e-6) { st.acc = st.acc - Math.max(net, 0); st.cur = nextRisk(st.acc, init, target, rr); return "TP_PARTIAL"; }
        st.cycles.push(net - st.acc); st.acc = 0; st.seq = 0; st.cur = init; return "TP_RESET";
      }
      return "NOT_COUNTED";
    }
  };
}
test("ledger test 1+2: one SL adds its REAL loss once; consecutive SLs accumulate; duplicate close event never double counts", () => {
  const L = ledger();
  L.close("d1", "SL", -1.0); near(L.st.acc, 1.0);
  assert.equal(L.close("d1", "SL", -1.0), "DUP_IGNORED"); near(L.st.acc, 1.0);
  L.close("d2", "SL", -1.05); near(L.st.acc, 2.05); near(L.st.cur, (2.05 + 20) / 20);
});
test("ledger test 3+4: a TP that does not repay the debt keeps the remainder; a TP that repays resets exactly once", () => {
  const L = ledger();
  L.close("a", "SL", -12.22);
  assert.equal(L.close("b", "TP", 5), "TP_PARTIAL"); near(L.st.acc, 7.22);
  assert.equal(L.close("c", "TP", 34), "TP_RESET"); near(L.st.acc, 0); assert.equal(L.st.seq, 0);
  near(L.st.cycles[0], 34 - 7.22);
});
test("ledger test 5: a TP event repeated twice does not credit twice", () => {
  const L = ledger(); L.close("a", "SL", -12.22);
  L.close("t", "TP", 34); assert.equal(L.close("t", "TP", 34), "DUP_IGNORED");
  assert.equal(L.st.cycles.length, 1);
});
test("documented GAP (not changed, owner decision): a manual / external close is NOT counted in either direction, so account P/L and accumulated loss can legitimately differ", () => {
  const L = ledger(); L.close("a", "SL", -12.22);
  assert.equal(L.close("m", "Manual (External)", +7.6), "NOT_COUNTED");
  near(L.st.acc, 12.22);   // account is +7.6 richer, the debt is unchanged -> exactly the kind of 12.22 vs 4.62 gap seen in the screenshot
  assert.ok(/bool isSL=\(rs=="SL" && !tainted && !markedExtra\)/.test(ea) && /if\(isExtra && net<0\.0\)/.test(ea));
});
test("v2.36 CLOSED the old gap: an OLD/overlapping TP (keepState) now repays the live debt through LedgerApplyNet", () => {
  assert.match(ea, /else if\(isTP && keepState\)\s*\{[^}]*LedgerApplyNet\(net,"Old\/overlapping TP/s);
});
