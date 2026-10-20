// fix14 (EA source, NOT compiled / run on MT5 here): loss -> ledger -> risk -> lot -> order chain hardening after a stop-loss.
// SOURCE = structural checks of ea/Yetimmm.mq5.  MODEL = JavaScript transcription of the two arithmetic rules that changed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const ea = readFileSync(new URL("../ea/Yetimmm.mq5", import.meta.url), "utf8");
const fn = (head, next) => { const i = ea.indexOf(head); assert.ok(i > 0, head + " missing"); const j = ea.indexOf(next, i + head.length); assert.ok(j > i, next + " missing"); return ea.slice(i, j); };

// ---- MODEL of NextRiskForNet / predicted debt
const R0 = 10, T = 20, RR = 2;
const nextRisk = (net) => { if (Math.abs(net) <= 1e-9) return R0; const rem = T - net; if (rem <= 1e-9) return R0; let r = rem / RR; if (net > 0 && r < R0) r = R0; return r; };
const predDebtOld = (accLoss, pred) => accLoss + pred;
const predDebtNew = (net, pred) => { const n = net - pred; return n < 0 ? -n : 0; };

test("MODEL a loss of either direction raises the next risk (the ledger has no BUY/SELL split)", () => {
  assert.equal(nextRisk(0), 10);
  assert.equal(nextRisk(-10), 15);        // (L+T)/RR
  assert.equal(nextRisk(-10), nextRisk(-10));
});

test("MODEL predicted debt: identical to the old rule when the cycle is in debt, correct when it is in partial profit", () => {
  assert.equal(predDebtNew(-4, 3), predDebtOld(4, 3));     // debt: unchanged
  assert.equal(predDebtNew(0, 3), predDebtOld(0, 3));
  assert.equal(predDebtNew(5, 3), 0);                       // partial profit 5, loss 3 -> net +2: NO debt (old rule said 3)
  assert.equal(predDebtOld(0, 3), 3);
  assert.equal(predDebtNew(2, 3), 1);                       // net +2, loss 3 -> -1: debt 1
});

test("SOURCE the pre-armed plan derives its debt from the predicted NET (same rule as CycleBook)", () => {
  const p = fn("void ReverseArmPass(", "//--- v2.42 PREPARED PLAN");
  assert.match(p, /const double predNet=g_cycNet-predLoss;/);
  assert.match(p, /g_accLoss=\(predNet<0\.0\)\?-predNet:0\.0;/);
  assert.ok(!p.includes("g_accLoss=sA+predLoss;"));
  assert.match(p, /g_accLoss=sA; g_curRisk=sC; g_seq=sS;/, "the saved ledger is restored right after the plan (SaveState stays frozen meanwhile)");
});

test("SOURCE (fix16 supersedes the 90 s release) a closed-but-unbooked trade holds the next sizing until it is booked - LOUD alert after 90 s, NO release", () => {
  const c = fn("bool ClosurePendingBlocks()", "//--- v2.34: every reason");
  assert.match(c, /waited>=90000/);
  assert.ok(!c.includes("<20000;"), "the old silent 20 s release is gone");
  assert.ok(!c.includes("LEDGER_STALE_RELEASE") && c.includes("LEDGER_STALE_HOLD") && c.includes("RaiseAlert(\"CLSTALE\""));
  assert.ok(/return true;\s*\}\s*$/.test(c.trim()), "the function ends with return true: the gate is never released by a timer");
  assert.ok(c.includes("g_clRelLogged"), "one release message per pending closure");
});

test("SOURCE RecoveryTrace logs the whole chain and flags a lot that did not grow after a loss, with the reason", () => {
  const t = fn("void RecoveryTrace(", "bool TryPlace(");
  for (const k of ["RECOVERY_TRACE", "RECOVERY_LOT_NOT_GROWN", "cycle net", "required risk", "raw lot", "final lot", "FLOOR_STEP_TOO_COARSE", "CLAMP_MIN", "Max Lot cap", "The ledger is NOT cleared"]) assert.ok(t.includes(k), k);
  // diagnostics never change a lot, never return a value, never send anything
  assert.ok(!/g_trade\./.test(t) && !/OrderSend/.test(t));
  assert.match(t, /^void RecoveryTrace/);
});

test("SOURCE the trace is called at every sizing site: pre-arm, placement, and the reverse fill is logged with its FILLED lot", () => {
  const p = fn("void ReverseArmPass(", "//--- v2.42 PREPARED PLAN");
  assert.ok(p.includes('RecoveryTrace("REVERSE_PREARM",revBuy,g_curRisk,lot,vol);'));
  const tp = fn("bool TryPlace(", "void EnforceSinglePosition(");
  assert.ok(tp.includes('RecoveryTrace(g_revCtx?"REVERSE_PLACE"'));
  const r = fn("long RegisterPosition(", "void RegisterLivePositions()");
  assert.ok(r.includes('"REVERSE_FILLED"') && r.includes("FILLED lot"));
  const c = fn("bool ProcessClosedPosition(", "void CheckClosures()");
  assert.match(c, /ledNote=CycleBook\(net,"SL"\);\s*g_seq\+\+;\s*g_lastLossLot=inVol;/);
});

test("SOURCE nothing was loosened: caps, STRICT policy, single booking per deal and the Netting rules are untouched", () => {
  for (const k of ["RecoveryGuardBlocks(gw,gc)", "if(IsLoggedDeal(dealOut))", "if(!InpPreArmReverse || g_netting) return 0;", "if(ClosurePendingBlocks()) return;"]) assert.ok(ea.includes(k), k);
  assert.ok(ea.includes('RISK_ABOVE_MAX_VOLUME') && ea.includes("the lot is NOT forced higher"));
});
