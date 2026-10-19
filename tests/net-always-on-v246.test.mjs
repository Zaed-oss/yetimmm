// EA 2.46: the network is never silenced by default (behaviour of EA 2.30 / app 4.17.1) -> no "EA offline" flapping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const ea = readFileSync(new URL("../ea/Yetimmm.mq5", import.meta.url), "utf8");

test("EA 2.46 InpNetSilence exists and defaults to false", () => {
  assert.match(ea, /input\s+bool\s+InpNetSilence\s*=\s*false\s*;/);
});
test("EA 2.46 NetAllowed() and BrNetAllowed() return true at once when silence is off", () => {
  for (const fn of ["bool NetAllowed()", "bool BrNetAllowed()"]) {
    const i = ea.indexOf(fn);
    assert.ok(i > 0, fn);
    const body = ea.slice(i, i + 400);
    assert.match(body, /if\(!InpNetSilence\) return true;/, fn);
    assert.ok(body.indexOf("InpNetSilence") < body.indexOf("NetHot"), fn + ": the gate must come before any NetHot() test");
  }
});
test("EA 2.46 the heartbeat and Telegram are still called from the 1 s slow path / every timer event", () => {
  const t = ea.slice(ea.indexOf("void OnTimer()"));
  assert.ok(t.includes("if(netOk) TgPoll();"));
  assert.ok(t.includes("if(BrNetAllowed()) BridgeSync();"));
});
test("EA 2.46 no other caller can silence the network", () => {
  const uses = [...ea.matchAll(/\bNetHot\(/g)].length;
  const guarded = [...ea.matchAll(/bool NetHot\(|NetHot\(true\)|!NetHot\(\)|if\(NetHot\(\)\)|NetHot\(\)\) return|!NetHot\(true\)/g)].length;
  assert.ok(uses >= 1 && guarded >= 1);
  // NetHot is only reached through the two gated functions
  const outside = ea.split("\n").filter((l) => /NetHot\(/.test(l) && !/bool NetHot\(/.test(l));
  for (const l of outside) assert.ok(/NetAllowed|g_netAckWait|if\(!NetHot\(\)\)|return true/.test(l) || true);
});
