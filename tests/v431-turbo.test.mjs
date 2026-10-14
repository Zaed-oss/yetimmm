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
  assert.match(ea, /SetDeviationInPoints\(InpTurbo\?MathMax\(g_maxDev,InpTurboDevPts\):g_maxDev\)/);
});
test("requote / price-changed in a fast market is retried within 150 ms (bounded)", () => {
  assert.match(ea, /InpTurbo && RevRetcodeTransient\(rc\) && g_revFails<=8\) g_nextRevMs=nowMs\+150/);
});
test("version unchanged (2.31 = Worker EA_PROTOCOL)", () => {
  assert.match(ea, /#define YT_VER "2\.31"/);
});
