// v4.19.0 (EA 2.33): the EA must never open a market trade by its own decision.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "ea", "Yetimmm.mq5"), "utf8");
const body = (sig) => { const i = src.indexOf(sig); assert.ok(i > 0, sig + " not found"); return src.slice(i, i + 700); };

test("real-orders-only constant is on", () => {
  assert.match(src, /#define\s+YT_REAL_ORDERS_ONLY\s+true/);
});
test("every market / virtual entry function is guarded first", () => {
  assert.match(body("bool TryMarketReverse("), /if\(YT_REAL_ORDERS_ONLY\) return false;/);
  assert.match(body("bool CatchTick("), /YT_REAL_ORDERS_ONLY \|\|/);
  assert.match(body("void CatchTimer()"), /YT_REAL_ORDERS_ONLY \|\|/);
  assert.match(body("bool VirtualWake()"), /YT_REAL_ORDERS_ONLY \|\|/);
  assert.match(body("void VirtualEntryPass()"), /if\(YT_REAL_ORDERS_ONLY\)/);
});
test("TryMarketReverse is the ONLY place that sends a market order, and it is guarded before it", () => {
  const sends = [...src.matchAll(/g_trade\.(Buy|Sell)\(/g)].map((m) => m.index);
  assert.equal(sends.length, 2, "market sends must stay inside TryMarketReverse (one ternary line)");
  const fn = src.indexOf("bool TryMarketReverse("), guard = src.indexOf("if(YT_REAL_ORDERS_ONLY) return false;", fn);
  assert.ok(fn > 0 && guard > fn && guard < sends[0]);
  assert.ok(sends[0] > fn && sends[0] < src.indexOf("bool VirtualInside()"));
});
test("main pass: no virtual/market branch can run, and the call sites are gated", () => {
  assert.match(src, /if\(!YT_REAL_ORDERS_ONLY && g_state==YT_WAITING_REENTRY[^\n]*TryMarketReverse\(\)\) return;/);
  assert.match(src, /if\(!YT_REAL_ORDERS_ONLY && InpEntryMode==ENTRY_VIRTUAL/);
});
test("defaults: Fast Catch off, entry PENDING, after-SL WAIT; startup purges virtual state", () => {
  assert.match(src, /input\s+bool\s+InpFastCatch\s*=\s*false/);
  assert.match(src, /input\s+bool\s+InpCatchAfterSL\s*=\s*false/);
  assert.match(src, /InpEntryMode\s*=\s*ENTRY_PENDING/);
  assert.match(src, /InpBreachPolicy\s*=\s*BREACH_WAIT/);
  const init = src.indexOf("PurgeLegacyLevels();\n   PurgeVirtualState();");
  assert.ok(init > 0, "PurgeVirtualState must run in OnInit");
});
test("state reported to the Mini App can never say MARKET / VIRTUAL", () => {
  assert.match(src, /\(!YT_REAL_ORDERS_ONLY && InpBreachPolicy==BREACH_MARKET\)\?"MARKET":"WAIT"/);
  assert.match(src, /\(YT_REAL_ORDERS_ONLY \|\| InpEntryMode==ENTRY_PENDING\)\?"PENDING":"VIRTUAL"/);
});
