// v4.23.0 (EA 2.37): STOP-AND-REVERSE on the server. Structural checks of the EA source + a reference model of the planning arithmetic.
// It does NOT run MQL5: compile (F7), then Strategy Tester / Demo (see docs/STOP-AND-REVERSE.md, section "Acceptance test").
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "ea", "Yetimmm.mq5"), "utf8");
const strip = (t) => { let o = "", i = 0; const n = t.length;      // removes comments, keeps string/char literals as empty pairs
  while (i < n) { const c = t[i], d = t[i + 1];
    if (c === "/" && d === "/") { while (i < n && t[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i += 2; while (i < n && !(t[i] === "*" && t[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"' || c === "'") { const q = c; i++; while (i < n && t[i] !== q) { if (t[i] === "\\") i++; i++; } i++; o += q + q; continue; }
    o += c; i++; }
  return o; };
const fn = (sig) => {                       // body of a top-level MQL5 function (brace matched)
  const i = src.indexOf(sig); assert.ok(i > 0, sig + " not found");
  const o = src.indexOf("{", i); let d = 0, k = o;
  for (; k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}") { d--; if (d === 0) break; } }
  return src.slice(i, k + 1);
};

test("input exists, default ON, and netting accounts switch it off", () => {
  assert.match(src, /input\s+bool\s+InpPreArmReverse\s*=\s*true;/);
  assert.match(fn("int ReverseArmDecision("), /if\(!InpPreArmReverse \|\| g_netting\) return 0;/);
});

test("Reconcile: the opposite order is deleted ONLY when the reverse order is not wanted (legacy path unchanged)", () => {
  const r = fn("void Reconcile()");
  assert.match(r, /ReverseArmDecision\(pos\[0\],fillBuy\)/);
  assert.match(r, /if\(revDec==1\) ReverseArmPass\(pos\[0\],fillBuy\);\s*else if\(revDec==0\)/);
  const del = r.indexOf('"Opposite Order Deleted"'), dec = r.indexOf("else if(revDec==0)");
  assert.ok(del > dec, "the legacy deletion must sit inside the revDec==0 branch");
});

test("just-filled position (not registered yet) never loses its opposite order: decision 2 = wait", () => {
  const d = fn("int ReverseArmDecision(");
  assert.match(d, /if\(!PHas\(pid,"N"\)\)[\s\S]*return \(MathAbs\(ageMs\)<3000\)\?2:0;/);
});

test("TryPlace allows a pending order next to a position ONLY in reverse context, ONE position, opposite direction", () => {
  const t = fn("bool TryPlace(");
  assert.match(t, /if\(gpn>0 && !\(g_revCtx && gpn==1\)\)/);
  assert.match(t, /if\(\(PositionGetInteger\(POSITION_TYPE\)==POSITION_TYPE_BUY\)==buy\) return false;/);
  assert.match(t, /GS\("PAO",\(double\)ticket\);[\s\S]*GS\("PAR",g_curRisk\);[\s\S]*GS\("PAA",g_accLoss\);/);
});

test("predicted ledger values: loaded, used, RESTORED, never saved, no early return in between", () => {
  const p = fn("void ReverseArmPass(");
  const a = p.indexOf("g_revSwap=true;"), b = p.indexOf("g_revSwap=false;");
  assert.ok(a > 0 && b > a);
  assert.ok(!/\breturn\b/.test(strip(p.slice(a, b))), "an early return between swap and restore would leak predicted values");
  assert.match(p.slice(b, b + 120), /g_accLoss=sA; g_curRisk=sC; g_seq=sS;/);
  assert.match(fn("void SaveState()"), /if\(g_revSwap\) return;/);
});

test("the next-step plan is booked exactly like ProcessClosedPosition books a stop-out (loss at SL joins the ledger, Seq+1)", () => {
  const p = fn("void ReverseArmPass(");
  assert.match(p, /double predLoss=vol\*\(perLot\+CommPerLotEff\(\)\);/);
  assert.match(p, /const double predNet=g_cycNet-predLoss;[\s\S]*g_accLoss=\(predNet<0\.0\)\?-predNet:0\.0;[\s\S]*g_seq=sS\+1;[\s\S]*g_curRisk=NextRiskForNet\(predNet\);/);   // v2.48: predicted debt derived like CycleBook (max(0,-net))
  assert.match(p, /RecoveryGuardBlocks\(gw,gc\)/);                 // caps are judged on the PREDICTED step
  const c = fn("bool ProcessClosedPosition(");
  assert.match(c, /ledNote=CycleBook\(net,"SL"\);\s*g_seq\+\+;/);
});

test("a fill of the reverse order carries the risk / ledger it was PLANNED with (the stop-out is booked a moment later)", () => {
  const r = fn("long RegisterPosition(");
  assert.match(r, /\(ulong\)GV\("PAO",0\.0\)==order/);
  assert.match(r, /PSet\(pid,"R",useRisk\);/); assert.match(r, /PSet\(pid,"AL",useAL\);/); assert.match(r, /PSet\(pid,"PAF",1\.0\)/);
});

test("fresh reverse trade is not closed as an 'extra position' while the stopped one is still listed", () => {
  const rc = fn("void Reconcile()");
  assert.match(rc, /if\(np>1 && !ReverseSwitchInProgress\(pos,np\)\)/);
  const s = fn("bool ReverseSwitchInProgress(");
  assert.match(s, /PGV\(yp,"PAF",0\.0\)<0\.5\) return false;/); assert.match(s, /MathAbs\(ageMs\)<5000/);
  assert.match(fn("void EnforceSinglePosition("), /PosSLCrossed\(pos\[0\]\)[\s\S]*if\(c0 && !c1\) keep=pos\[1\];/);
});

test("cancel / stop never re-arm: g_revOffPid set by ExecCancel, STOPPED / cleanup state refuses the reverse order", () => {
  assert.match(fn("string ExecCancel("), /g_revOffPid=\(ulong\)PositionGetInteger\(POSITION_IDENTIFIER\)/);
  assert.match(fn("int ReverseArmDecision("), /g_state==YT_STOPPED \|\| g_stopCleanup/);
});

test("STILL real orders only: the EA sends no market order of its own (v2.33 rule intact)", () => {
  assert.match(src, /#define\s+YT_REAL_ORDERS_ONLY\s+true/);
  const sends = [...src.matchAll(/g_trade\.(Buy|Sell)\(/g)].length;
  assert.equal(sends, 2, "market sends must stay inside TryMarketReverse only");
  for (const sig of ["void ReverseArmPass(", "int ReverseArmDecision(", "bool ReverseSwitchInProgress("]) assert.ok(!/g_trade\.(Buy|Sell)\(/.test(fn(sig)));
});

test("reference model: planning the reverse lot BEFORE the stop-out gives the same lot as planning it AFTER (hedging, no slippage)", () => {
  const RR = 20, T = 20, init = 1, perLot = 100, c = 7, vmin = 0.01, step = 0.01;   // $100 per lot per $1 zone, $7 round-trip commission per lot
  const next = (L) => (L <= 1e-9 ? init : (L + T) / RR);
  const lotFor = (risk, L) => { const per = perLot - c / RR; let lot = vmin + Math.floor((risk / per - vmin) / step + 1e-7) * step; if (L > 1e-9 && lot * per < risk - 1e-9) lot += step; return Math.round(lot * 1e8) / 1e8; };
  let L = 0;
  for (let n = 1; n <= 12; n++) {
    const risk = next(L), lot = lotFor(risk, L);
    const predictedLoss = lot * (perLot + c);                    // what ReverseArmPass computes from the OPEN trade
    const predLedger = L + predictedLoss, predRisk = next(predLedger), predLot = lotFor(predRisk, predLedger);
    const actualLedger = L + lot * (perLot + c);                 // what ProcessClosedPosition books at the SL deal
    const actLot = lotFor(next(actualLedger), actualLedger);
    assert.equal(predLot, actLot, `step ${n}`);
    L = actualLedger;
  }
});

test("EA source is brace / parenthesis balanced (cheap syntax guard - NOT a compiler)", () => {
  const clean = strip(src);
  for (const [o, c] of [["{", "}"], ["(", ")"], ["[", "]"]]) assert.equal(clean.split(o).length, clean.split(c).length, `unbalanced ${o}${c}`);
});
