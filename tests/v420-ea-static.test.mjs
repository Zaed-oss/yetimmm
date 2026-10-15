// EA 2.32 structural guards (they read the EA source; they do NOT prove it compiles - press F7 in MetaEditor - or behaves - run a demo account).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const ea = readFileSync(new URL("../ea/Yetimmm.mq5", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("gold is recognised on any broker naming (XAUUSD*, GOLD*, base currency XAU) - no hard-coded XAUUSD check left", () => {
  assert.match(ea, /bool IsGoldSymbol\(const string sym\)/);
  assert.match(ea, /SYMBOL_CURRENCY_BASE/);
  assert.equal((ea.match(/StringFind\(up,"XAUUSD"\)<0/g) || []).length, 0);
  assert.equal((ea.match(/StringFind\(g_sym,"XAUUSD"\)<0/g) || []).length, 0);
  assert.ok(ea.includes("!IsGoldSymbol(g_sym)"));
});
test("broker specification is re-read every second and at start; filling mode follows the symbol", () => {
  assert.match(ea, /void RefreshBrokerSpec\(\)\s*\{[\s\S]*SetTypeFillingBySymbol\(g_sym\)[\s\S]*\}/);
  assert.match(ea, /MonitorConnection\(\);\s*RefreshBrokerSpec\(\);/);
  assert.match(ea, /SetAsyncMode\(false\);\s*RefreshBrokerSpec\(\);/);
  for (const k of ["SYMBOL_DIGITS", "SYMBOL_POINT", "SYMBOL_TRADE_TICK_SIZE", "SYMBOL_TRADE_CONTRACT_SIZE", "SYMBOL_VOLUME_STEP", "SYMBOL_FILLING_MODE", "ACCOUNT_SERVER"]) assert.ok(ea.includes(k), k);
});
test("RefreshBrokerSpec is declared before OnInit uses it", () => {
  const decl = ea.indexOf("void RefreshBrokerSpec();"), use = ea.indexOf("RefreshBrokerSpec();                // v2.32: the first reading");
  assert.ok(decl > 0 && use > decl);
});
test("the card price is the live tick (bid, ask, same SymbolInfoTick) and is no longer frozen by default", () => {
  assert.match(ea, /input bool\s+InpFreezePriceWhenStopped\s*=\s*false/);
  assert.match(ea, /bool useFrz=\(frz && InpFreezePriceWhenStopped\)/);
  assert.match(ea, /\\"frzPx\\":/);
});
test("fast lane: light exchange between full syncs, hot-state aware, pace tied to the measured round trip, shared command loop", () => {
  assert.match(ea, /input int\s+InpBrFastMs\s*=\s*300/);
  assert.match(ea, /void BrRunCommands\(const string resp,const bool viaLane\)/);
  assert.equal((ea.match(/BrRunCommands\(resp,(true|false)\);/g) || []).length, 2, "full sync and light lane share ONE command executor");
  assert.equal((ea.match(/string result=BrExec\(cmd,seg\);/g) || []).length, 1, "the executor exists once");
  assert.match(ea, /void BridgeLite\(\)/);
  assert.match(ea, /bool NetHotNow\(\)/);
  assert.match(ea, /100\.0\*\(double\)g_brRtt\/duty/);   // v2.33: the duty rule replaced the fixed 3x round trip
  assert.match(ea, /TgPoll\(\);\s*BridgeLite\(\);/);
  assert.match(ea, /EventSetMillisecondTimer\(100\)/);
  assert.ok(ea.includes('\\"lite\\":true'));
});
test("the light lane never runs before the first full sync, while pairing is pending, or while a second copy is suspected", () => {
  const f = ea.slice(ea.indexOf("void BridgeLite()"));
  assert.ok(f.includes("!g_brOk || g_brFirst || g_brPairNeed || g_dupSince>0 || g_halt"));
});
test("app: price lane polls /px twice per second while the user interacts (v4.23: was ~3x) and the card never freezes", () => {
  assert.match(app, /pxMs:500/);
  assert.match(app, /async px\(\)\{/);
  assert.match(app, /Bridge\.loop\(Bridge\.px,Bridge\.dPx\)/);
  assert.match(app, /function feed\(\)\{if\(!\(S\.price>0\)\)return;/);
});
