// EA 2.45.1: the bridge heartbeat has its OWN network allowance (root cause of the "EA offline 35-80 s" drops).
// Structural checks of the MQL5 source + an executable model of OnTimer() scheduling (MQL5 is not run here: compile with F7, then follow docs/FIX6-HEARTBEAT-2.45.1.md).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ea = readFileSync(join(root, "ea", "Yetimmm.mq5"), "utf8");
function body(sig) {
  const i = ea.indexOf(sig); assert.ok(i >= 0, sig + " not found");
  const j = ea.indexOf("{", i); let d = 0, k = j;
  for (; k < ea.length; k++) { if (ea[k] === "{") d++; else if (ea[k] === "}" && --d === 0) break; }
  return ea.slice(j, k + 1);
}

test("OnTimer: BridgeSync is gated by its own allowance, not by the one TgPoll uses", () => {
  const t = body("void OnTimer(");
  assert.ok(/if\(BrNetAllowed\(\)\) BridgeSync\(\);/.test(t));
  assert.ok(!/if\(netOk\) BridgeSync\(\);/.test(t), "the shared allowance must not gate the heartbeat");
  assert.ok(/if\(netOk\) TgPoll\(\);/.test(t), "Telegram polling keeps its rule");
});
test("BrNetAllowed: quiet market always allowed; hot market at most 1 call per InpNetMaxDeferSec measured from the last REAL request", () => {
  const b = body("bool BrNetAllowed(");
  assert.ok(b.includes("if(!NetHot()) return true;"));
  assert.ok(b.includes("now-g_brNetMs>=(ulong)MathMax(1,InpNetMaxDeferSec)*1000"));
  assert.ok(b.includes("g_netAckWait && now-g_netPrioMs>=500 && !NetHot(true)"), "priority ack rule kept");
  assert.ok(!b.includes("g_netDeferSince"), "does not touch the Telegram allowance state");
});
test("BridgeSync stamps g_brNetMs right before the WebRequest (the allowance is consumed only by a request that really leaves)", () => {
  const b = body("void BridgeSync(");
  const a = b.indexOf("g_brNetMs=GetTickCount64();"), w = b.indexOf("WebRequest(");
  assert.ok(a > 0 && w > a);
});
test("a heartbeat gap is logged, never hidden; offline limit and trading code untouched", () => {
  assert.ok(body("void BrSuccess(").includes("heartbeat gap of"));
  assert.ok(ea.includes("const int YT_BR_OFFLINE_SEC=30;"));
  assert.ok(ea.includes("input int    InpNetMaxDeferSec = 5;"));
  assert.ok(ea.includes("#define YT_VER \"2.46\""));
});

// ---- executable model of OnTimer(): 200 ms timer (+jitter), slow path once per second, market ALWAYS hot, InpNetMaxDeferSec = 5 ----
function model(mode, seed, hours = 12) {
  let s = seed; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  let now = 0, slow = 0, deferSince = 0, lastSent = 0, lastOk = 0; const gaps = [];
  while (now < hours * 3600e3) {
    now += 200 + Math.floor(rnd() * 60);
    let netOk = false;
    if (mode === "old") { if (!deferSince) deferSince = now; if (now - deferSince >= 5000) { deferSince = now; netOk = true; } }   // TgPoll takes it first
    if (now - slow < 1000) continue;
    slow = now;
    const go = mode === "old" ? netOk : now - lastSent >= 5000;
    if (go) { lastSent = now; if (lastOk) gaps.push(now - lastOk); lastOk = now; now += rnd() * 300; }
  }
  return { max: Math.max(...gaps), over30: gaps.filter((g) => g > 30000).length };
}
test("model: the OLD shared allowance reproduces the drops (gaps > 30 s), the NEW one never exceeds ~6 s", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const o = model("old", seed), n = model("new", seed);
    assert.ok(o.over30 > 100 && o.max > 60, "old design drops: " + JSON.stringify(o));
    assert.equal(n.over30, 0);
    assert.ok(n.max < 8000, "new max gap " + n.max);
  }
});
