// EA 2.47: broker-neutral lot quantisation (QuantizeLot) + LOTCHAIN diagnostics. Model mirrors the MQL5 helper; it does NOT run MQL5.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ea = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "ea", "Yetimmm.mq5"), "utf8");

const q = ({ raw, vmin, step, risk, perSz, debt, roundUp = true, maxOver = 0 }) => {
  let lot = vmin + Math.floor((raw - vmin) / step + 1e-7) * step, how = "FLOOR";
  if (roundUp && debt && lot * perSz < risk - 1e-9) {
    const up = lot + step;
    if (maxOver > 0 && up * perSz > risk * (1 + maxOver / 100) + 1e-9) how = "FLOOR_STEP_TOO_COARSE"; else { lot = up; how = "ROUND_UP"; }
  }
  return { lot: Math.round(lot * 1e6) / 1e6, how };
};
test("source: helper, input (default 0 = previous behaviour) and LOTCHAIN log exist", () => {
  assert.match(ea, /double QuantizeLot\(/);
  assert.match(ea, /input double InpRoundUpMaxOverPct\s*=\s*0\.0;/);
  assert.match(ea, /YLog\("LOTCHAIN risk /);
  assert.match(ea, /QuantizeLot\(raw,vmin,step,risk,perSz,\(g_accLoss>1e-9 \|\| g_cycNet>1e-9\),how\)/);
});
test("limit 0 keeps the old behaviour for every step", () => {
  for (const step of [0.01, 0.1, 1]) {
    const r = q({ raw: 1.05 / 10, vmin: step, step, risk: 1.05, perSz: 10, debt: true });
    assert.equal(r.how, "ROUND_UP");
  }
});
test("a coarse step with a limit does not jump 90%: lot stays, then steps up when it fits", () => {
  const a = q({ raw: 0.105, vmin: 0.1, step: 0.1, risk: 1.05, perSz: 10, debt: true, maxOver: 25 });
  assert.equal(a.lot, 0.1); assert.equal(a.how, "FLOOR_STEP_TOO_COARSE");
  const b = q({ raw: 0.17, vmin: 0.1, step: 0.1, risk: 1.7, perSz: 10, debt: true, maxOver: 25 });
  assert.equal(b.lot, 0.2); assert.equal(b.how, "ROUND_UP");
});
test("fine step: +1 step stays inside the limit (0.10 -> 0.11 for risk 1.05)", () => {
  const r = q({ raw: 0.105, vmin: 0.01, step: 0.01, risk: 1.05, perSz: 10, debt: true, maxOver: 25 });
  assert.equal(r.lot, 0.11);
});
test("no debt: always floor", () => {
  assert.equal(q({ raw: 0.105, vmin: 0.01, step: 0.01, risk: 1.05, perSz: 10, debt: false }).lot, 0.1);
});
