// EA 2.31 TURBO (impulse mode) structural guards. They read the EA source text; they do NOT prove it compiles (MetaEditor F7) or behaves (demo account).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const ea = readFileSync(new URL("../ea/Yetimmm.mq5", import.meta.url), "utf8");

test("TURBO inputs exist and default ON", () => {
  assert.match(ea, /input bool\s+InpTurbo\s*=\s*true;/);
  for (const n of ["InpTurboDevPts", "InpTurboMomPts", "InpTurboMomMs", "InpTurboNearPts", "InpTurboHotMs"]) assert.match(ea, new RegExp("input int\\s+" + n));
});
test("after an SL the market reversal runs in TURBO even with BREACH_WAIT", () => {
  assert.match(ea, /InpBreachPolicy==BREACH_MARKET \|\| InpTurbo \|\| InpEntryMode==ENTRY_VIRTUAL\) && TryMarketReverse\(\)/);
});
test("OnTick: 20 ms gate in TURBO and momentum feed", () => {
  assert.match(ea, /const ulong gateMs=\(InpTurbo\?20:100\)/);
  assert.match(ea, /TurboFeed\(tt,now\)/);
});
test("no network phase starts while the price is near a level / moving fast", () => {
  assert.match(ea, /if\(!hot && TurboHot\(now\)\) hot=true;/);
});
test("slippage of a rocket candle is accepted up to InpTurboDevPts; the market reversal sends the same deviation", () => {
  assert.match(ea, /if\(InpTurbo && \(double\)InpTurboDevPts>devLimit\) devLimit=/);
  assert.match(ea, /int base=InpTurbo\?MathMax\(g_maxDev,InpTurboDevPts\):g_maxDev;/);   // v2.34: ExecDeviation(0) = this exact base, widened only after repeated requotes
  assert.match(ea, /SetDeviationInPoints\(ExecDeviation\(g_revFails\)\)/);
});
test("requote / price-changed in a fast market is retried within 150 ms (bounded)", () => {
  // v2.34: the PRICE class (requote / price changed) retries after 120 ms for the first InpExecFastRetries (8) attempts, then widens - bounded
  assert.match(ea, /if\(cls==RCC_PRICE\)\s+d=\(a<=fast\)\?120\.0:250\.0\*\(double\)\(a-fast\+1\);/);
  assert.match(ea, /if\(rcls==RCC_PRICE \|\| rcls==RCC_FAST\) g_nextRevMs=nowMs\+ExecBackoffMs\(rcls,g_revFails\);/);
});
test("version agrees (2.34 = Worker EA_PROTOCOL)", () => {
  assert.match(ea, /#define YT_VER "2\.34"/);
});
