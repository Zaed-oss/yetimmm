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
test("C: ONE slippage ceiling - InpTurboDevPts is the final cap and is never MathMax-ed with Max Slippage Check", () => {
  assert.match(ea, /int TurboDevCeiling\(\)/);
  assert.match(ea, /int c=\(InpTurbo && InpTurboDevPts>0\)\?InpTurboDevPts:g_maxDev;/);
  assert.match(ea, /double devLimit=\(double\)TurboDevCeiling\(\);/);
  assert.doesNotMatch(ea, /MathMax\(g_maxDev,InpTurboDevPts\)/);
});
test("C: adaptive tolerance = base + spread cushion (+ momentum room), clamped to the ceiling, never widened to get a fill", () => {
  assert.match(ea, /int TurboDeviationLimit\(const ulong now\)/);
  assert.match(ea, /double allow=\(double\)g_maxDev\+2\.0\*spreadPts;/);
  assert.match(ea, /if\(now<g_hotUntil\) allow\+=0\.5\*\(double\)MathMax\(1,InpTurboMomPts\);/);
  assert.match(ea, /if\(allow>\(double\)ceilPts\) allow=\(double\)ceilPts;/);
});
test("C: TurboWorstEntry - Buy = Ask + slip (rounded up), Sell = Bid - slip (rounded down)", () => {
  assert.match(ea, /double TurboWorstEntry\(const bool buy,const double quoted,const int devPts\)/);
  assert.match(ea, /px=buy\?MathCeil\(px\/tk-1e-6\)\*tk:MathFloor\(px\/tk\+1e-6\)\*tk;/);
});
test("C: the market reversal sizes the lot from the worst entry, sends the SAME adaptive deviation, then restores the default", () => {
  assert.match(ea, /double sizeEntry=InpTurbo\?TurboWorstEntry\(revBuy,entry,devPts\):entry;/);
  assert.match(ea, /CalcLotSL\(g_curRisk,revBuy,sizeEntry,slp,lot,est,err\)/);
  assert.match(ea, /g_trade\.SetDeviationInPoints\(devPts\);/);
  assert.match(ea, /g_trade\.SetDeviationInPoints\(g_maxDev\);\s+\/\/ restore/);
});
test("C: order inside TryMarketReverse = guard -> lot (worst entry) -> TP from the FINAL lot -> pre-flight -> delete pendings -> send", () => {
  const a = ea.indexOf("bool TryMarketReverse(");
  const body = ea.slice(a, ea.indexOf("//| v2.22 VIRTUAL ENTRY", a));
  const order = ["RecoveryGuardBlocks(rgw,rgc)", "CalcLotSL(g_curRisk,revBuy,sizeEntry", "TPPriceLot(revBuy,sizeEntry,slp,lot,perLotAtSize)", "MarketPreflight(revBuy,slp,tpp,why)", "DeleteOrder(od[i]", "g_trade.Buy(lot"].map(k => body.indexOf(k));
  assert.ok(order.every(i => i > 0), "marker missing: " + order);
  assert.deepEqual([...order].sort((x, y) => x - y), order);
});
test("C STRICT: a lot that does not fit the risk is a WAIT - the reversal never falls back to the minimum lot", () => {
  const a = ea.indexOf("bool TryMarketReverse(");
  const body = ea.slice(a, ea.indexOf("//| v2.22 VIRTUAL ENTRY", a));
  assert.match(body, /if\(!CalcLotSL\([^)]*\)\)\s*\{[^}]*HandleLotError\(err\);[^}]*return true;/);
  assert.doesNotMatch(body, /SYMBOL_VOLUME_MIN/);
});
test("C: real risk at the ACTUAL fill is logged and an over-target fill raises RISKOVER (not for CLAMP_TO_MIN)", () => {
  assert.match(ea, /double realRisk=vol\*\(plf\+CommissionPerLot\(\)\);/);
  assert.match(ea, /InpRiskPolicy!=YT_RISK_CLAMP_MIN && realRisk>g_curRisk\*1\.005\+0\.01/);
  assert.match(ea, /RaiseAlert\("RISKOVER"/);
});
test("C: the cumulative-loss / sequence engine is not duplicated (no second risk engine added)", () => {
  assert.equal(ea.split("RiskCompute(").length - 1, 5);
});
test("requote / price-changed in a fast market is retried within 150 ms (bounded)", () => {
  assert.match(ea, /InpTurbo && RevRetcodeTransient\(rc\) && g_revFails<=8\) g_nextRevMs=nowMs\+150/);
});
test("version unchanged (2.31 = Worker EA_PROTOCOL)", () => {
  assert.match(ea, /#define YT_VER "2\.31"/);
});

// Arithmetic model of the sizing rule (mirrors CalcLotSL/TurboWorstEntry for a buy; XAUUSD-like: 1 lot = 100 oz, point 0.01).
test("C model: lot sized at Ask+slip keeps the loss at SL <= risk for EVERY fill inside the allowed slip; sizing at the ideal quote does not", () => {
  const risk = 20, contract = 100, step = 0.01, point = 0.01, comm = 0;
  const ask = 2000.0, sl = 1990.0, dev = 300;                       // 300 pts = 3.00 USD
  const lotAt = (e) => Math.floor(risk / ((e - sl) * contract + comm) / step + 1e-7) * step;
  const worst = ask + dev * point;
  const lotC = lotAt(worst), lotOld = lotAt(ask);
  for (let slip = 0; slip <= dev; slip += 25) assert.ok(lotC * ((ask + slip * point - sl) * contract + comm) <= risk + 1e-9);
  assert.ok(lotOld * ((worst - sl) * contract) > risk);              // the original behaviour overshoots at the worst allowed fill
  assert.ok(lotC < lotOld);
});
