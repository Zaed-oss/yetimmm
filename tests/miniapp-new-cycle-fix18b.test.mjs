// fix18b - Mini App: APPLY begins a NEW cycle (lot from the initial risk) and CLOSE ends the cycle, exactly like Telegram /set and CANCEL+CLOSE.
// Real history that exposed it (20-25/10): #48 SL -1.00 (0.10) -> #49 Close -0.06 -> #50 0.11 ... #52 SL -1.20 -> #53 Close +0.72 -> APPLY -> #54 opened with 0.12.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const ea = readFileSync(new URL("../ea/Yetimmm.mq5", import.meta.url), "utf8");
function fnBody(sig) {
  const i = ea.indexOf(sig); assert.ok(i >= 0, "missing " + sig);
  let d = 0, st = false;
  for (let k = ea.indexOf("{", i); k < ea.length; k++) { if (ea[k] === "{") { d++; st = true; } else if (ea[k] === "}") { d--; if (st && d === 0) return ea.slice(i, k + 1); } }
  throw new Error("unbalanced");
}
// model: lot from the ledger
const lotFor = (net) => Math.ceil(Math.max(1, (20 - net) / 20) / 10 / 0.01 - 1e-7) * 0.01;
test("model: the old flow reproduces 0.12 after the user's Close + APPLY; the new flow gives 0.10", () => {
  let net = 0; const lots = [];
  for (const r of [-1.0, -0.06, -1.1, -1.1, -1.2, +0.72]) { lots.push(lotFor(net).toFixed(2)); net += r; }
  assert.equal(lotFor(net).toFixed(2), "0.12", "old: debt kept -> 0.12");
  net = 0;                                    // new: Close ended the cycle / APPLY starts from zero
  assert.equal(lotFor(net).toFixed(2), "0.10");
});
test("EA: Mini App close goes through ExecCancel(true) (ends the cycle) and no longer calls CleanupPositions directly", () => {
  const b = fnBody("string BrExec(");
  const i = b.indexOf('cmd=="close"'); const blk = b.slice(i, i + 700);
  assert.match(blk, /ExecCancel\(true\)/);
  assert.ok(!/CleanupPositions\(3\)/.test(blk));
});
test("EA: Mini App apply starts a new cycle, settings does not", () => {
  const b = fnBody("string BrExec(");
  assert.match(b, /ApplyLevels\(b,s,\(hr\?r:0\.0\),"MiniApp",err,\(cmd=="apply"\)\)/);
});
test("EA: ExecCancel(true) deletes orders, closes the position, sets CANCELEND and ends the cycle", () => {
  const b = fnBody("string ExecCancel(");
  assert.match(b, /StopSweep\(3,"Cancelled by user"\)/); assert.match(b, /CANCELEND/); assert.match(b, /CancelEndTry\("Telegram CANCEL"\)/);
});
