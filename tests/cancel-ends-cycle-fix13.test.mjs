import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ea = readFileSync(new URL("../ea/Yetimmm.mq5", import.meta.url), "utf8");
function fnBody(sig) {
  let i = -1;
  for (let from = 0; ; ) {                       // skip forward declarations (";" before the first "{")
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

test("fix13 a full cancel ends the cycle: ledger zeroed, levels deleted, state IDLE, nothing inherited", () => {
  const b = fnBody("void CycleEndByUser(");
  assert.ok(b.includes("ResetRiskLogged(src)"));
  assert.ok(/g_buyLevel=0\.0; g_sellLevel=0\.0; g_pendBuy=0\.0; g_pendSell=0\.0; g_fresh=false;/.test(b));
  assert.ok(b.includes("g_state=YT_IDLE") && b.includes("g_cycState=YC_IDLE"));
  assert.ok(b.includes("CANCELLED_BY_USER"));
});

test("fix13 ExecCancel ends the cycle only when no position is left (a kept position keeps the cycle alive)", () => {
  const b = fnBody("string ExecCancel(");
  assert.ok(/if\(OwnPositions\(pk\)==0\)/.test(b) && b.includes("CancelEndTry(\"Telegram CANCEL\")"));
  assert.ok(b.includes("Open position kept"));
});

test("fix13 a closed trade whose result is not booked yet can never leak into the next cycle", () => {
  const b = fnBody("bool CancelEndTry(");
  assert.ok(b.indexOf("CheckClosures()") < b.indexOf("PendingClosedRecords()") && b.indexOf("PendingClosedRecords()") < b.indexOf("CycleEndByUser(src)"));
  assert.ok(fnBody("void CancelEndTick(").includes("history timeout"));
  assert.ok(ea.includes("CancelEndTick();"), "the tick runs in the slow path");
});

test("fix13 /set and START wait for a cancel that is still closing its last trade", () => {
  assert.ok(fnBody("bool ApplyLevels(").includes("CancelEndTry"));
  assert.ok(fnBody("string DoStart(").includes("CancelEndTry"));
  assert.ok(/CANCELCLOSE[\s\S]{0,400}CancelEndTry\("Telegram CANCEL \+ CLOSE"\)/.test(ea));
});

test("fix13 STOP stays a pause: it never zeroes the ledger", () => {
  assert.ok(!fnBody("bool ExecStop(").includes("ResetRisk"));
  assert.ok(fnBody("void ImplicitResetGuarded(").includes("DEBT_KEPT"));
});
