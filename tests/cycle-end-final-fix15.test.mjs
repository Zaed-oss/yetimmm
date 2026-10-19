import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ea = readFileSync(new URL("../ea/Yetimmm.mq5", import.meta.url), "utf8");
function fnBody(sig) {
  let i = -1;
  for (let from = 0; ; ) {
    i = ea.indexOf(sig, from);
    assert.ok(i >= 0, "missing definition of " + sig);
    const brace = ea.indexOf("{", i), semi = ea.indexOf(";", i);
    if (brace >= 0 && (semi < 0 || brace < semi)) break;
    from = i + 1;
  }
  let d = 0, started = false;
  for (let k = ea.indexOf("{", i); k < ea.length; k++) {
    if (ea[k] === "{") { d++; started = true; }
    else if (ea[k] === "}") { d--; if (started && d === 0) return ea.slice(i, k + 1); }
  }
  throw new Error("unbalanced " + sig);
}

test("fix15 Cancel with a KEPT position still ends the cycle (CANCELEND is set, no recovery order afterwards)", () => {
  const b = fnBody("string ExecCancel(");
  assert.ok(/Open position kept[\s\S]{0,200}ENDED/.test(b) || /GS\("CANCELEND"[\s\S]{0,200}Open position kept/.test(b));
  assert.ok(/else\s*\{[\s\S]{0,700}GS\("CANCELEND",\(double\)TimeLocal\(\)\)/.test(b), "the kept-position branch sets CANCELEND");
});

test("fix15 TryPlace sends NOTHING while a user cancel is closing the cycle (no old-debt recovery order)", () => {
  const b = fnBody("bool TryPlace(");
  const g = b.indexOf('GV("CANCELEND",0.0)>0.5');
  const st = b.indexOf("g_state!=YT_ARMED");
  assert.ok(g > 0 && g < st, "the CANCELEND gate comes before any state check / send");
});

test("fix15 CancelEndTick waits for the kept position and refreshes the 180 s safety stamp", () => {
  const b = fnBody("void CancelEndTick(");
  assert.ok(/OwnPositions\(kp\)>0/.test(b) && /GS\("CANCELEND",\(double\)TimeLocal\(\)\)/.test(b));
  assert.ok(b.indexOf("OwnPositions(kp)") < b.indexOf("CleanupOrders"), "position check is first");
});

test("fix15 Mini App cancel works on a STOPPED bot and ends the cycle only when nothing is left", () => {
  const i = ea.indexOf('if(cmd=="cancel")');
  const seg = ea.slice(i, i + 1400);
  assert.ok(seg.includes("YT_STOPPED") && seg.includes("CancelEndTry(\"MiniApp CANCEL (stopped)\")"));
  assert.ok(/OwnPositions\(sp\)>0 \|\| OwnOrders\(so\)>0/.test(seg));
});

test("fix15 the ledger is still zeroed only by CycleEndByUser / target completion / confirmed reset (STOP stays a pause)", () => {
  assert.ok(!/void ExecStop[\s\S]{0,1500}ResetRisk\(\)/.test(ea.slice(ea.indexOf("bool ExecStop("), ea.indexOf("bool ExecStop(") + 3000)));
  assert.ok(fnBody("void CycleEndByUser(").includes("ResetRiskLogged(src)"));
});
