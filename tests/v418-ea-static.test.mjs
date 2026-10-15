// v4.18 / EA 2.31 STRUCTURAL guards. These read the EA source text: they prove the fixes are present and not silently reverted.
// They do NOT prove the EA compiles or behaves correctly (MetaEditor F7 + Strategy Tester + demo account are still required).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const ea = readFileSync(new URL("../ea/Yetimmm.mq5", import.meta.url), "utf8");
const body = (name) => { const a = ea.indexOf(name); assert.ok(a >= 0, name + " missing"); return ea.slice(a, a + 6000); };

test("modify and delete share ONE ownership rule (OwnOrderTicket) before any OrderSelect", () => {
  assert.match(ea, /bool OwnOrderTicket\(const double tkd\)/);
  const uses = ea.match(/OwnOrderTicket\(/g).length; assert.ok(uses >= 3, "definition + modify + delete");
  assert.match(ea, /!OwnOrderTicket\(tkm\) \|\| !OrderSelect\(\(ulong\)tkm\)/);
  assert.match(ea, /if\(!OwnOrderTicket\(tkd\)\) return/);
  assert.ok(!/if\(!OrderSelect\(\(ulong\)tkm\)\) return/.test(ea), "the old unchecked OrderSelect is gone");
});
test("JSON: control characters removed, st escaped, NaN-safe numbers", () => {
  assert.match(body("string JEsc(const string s)\n"), /ch<32 \|\| ch==127/);
  assert.match(ea, /string JNumSafe\(const double v,const int digits\)/);
  assert.match(ea, /\\"st\\":\\""\+JEsc\(g_cmSt\[i\]\)/);
  assert.match(ea, /\\"state\\":\\""\+JEsc\(StateText\(\)\)/);
});
test("network: no 3000 ms WebRequest left, backoff + one blocking phase per second + entry deferral", () => {
  assert.ok(!/WebRequest\([^;]*,3000,/.test(ea), "no 3 s timeouts");
  assert.match(ea, /\(calSending\?4000:2000\)/);
  assert.match(ea, /GetTickCount64\(\)<g_brNetBackoffUntil/);
  assert.match(ea, /if\(!NetDeferForEntry\(\)\)/);
  assert.match(ea, /sent<2\)/);
  const bf = body("void  BrNetFail()"); assert.match(bf, /MathMin\(30000\.0/);
});
test("config file: sealed with acct + chk and refused when it does not match", () => {
  assert.match(ea, /FileWriteString\(h,"chk="\+seal/);
  assert.match(ea, /FAILED its integrity \/ account check/);
});
test("versions agree: EA 2.34 = Worker EA_PROTOCOL", () => {
  assert.match(ea, /#define YT_VER "2\.34"/); assert.match(ea, /#property version   "2\.34"/);
});
test("risk decisions untouched: ValidateRisk / InpMaxSeqLosses / InpMaxRiskPctBal still present and identical in count", () => {
  const orig = readFileSync(new URL("../tests/fixtures/risk-markers.json", import.meta.url), "utf8");
  const m = JSON.parse(orig);
  for (const k of Object.keys(m)) assert.equal(ea.split(k).length - 1, m[k], k);
});

test("EA: Worker URL must be https and is PINNED once paired (a shared cfg file cannot redirect the secret)", () => {
  assert.match(ea, /void BrUrlGuard\(const bool fromCfg\)/);
  assert.match(ea, /StringFind\(low,"https:\/\/"\)!=0/);
  assert.match(ea, /fromCfg && StringLen\(pin\)>0 && pin!=org/);
  assert.match(ea, /BrUrlPin\(\);\s+\/\/ v2\.31/);
  assert.match(ea, /if\(StringFind\(lo,"https:\/\/"\)!=0\) return;/);               // belt and braces at send time
});
