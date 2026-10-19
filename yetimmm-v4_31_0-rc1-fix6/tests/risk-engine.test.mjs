// Reference model of the Risk Engine used by the Mini App preview / simulation (index.html RISK-CORE) — and the spec the EA's RiskCompute() mirrors.
// It proves the ARITHMETIC and the POLICIES from the audit (sections 122-127, 147). It does NOT run MQL5: the EA must still be compiled (F7) and tested in the Strategy Tester.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"), "utf8");
const core = html.split("/*RISK-CORE-BEGIN*/")[1].split("/*RISK-CORE-END*/")[0];
const { calcRisk, SIM_PROFILES } = new Function(core + "; return { calcRisk, SIM_PROFILES };")();
const P = (n) => ({ ...SIM_PROFILES[n] });
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} !~ ${b}`);

test("audit example: risk $1, loss/lot $145 -> raw 0.0069 < min 0.01 -> STRICT waits, minimum executable risk = $1.45", () => {
  const bs = P("XAU-100-0.01"); bs.tvl = 1.45;            // perLot = d/tick*tvl = 1/0.01*1.45 = 145
  const r = calcRisk(bs, 1, 4138, 4137, "STRICT");
  near(r.perLot, 145); near(r.raw, 1 / 145, 1e-12); assert.equal(r.status, "BELOW_MIN"); assert.equal(r.ok, false); assert.equal(r.vol, 0); near(r.minRisk, 1.45);
});
test("same case with CLAMP_TO_MIN: lot = min, effective risk 1.45 is reported (never pretends to be $1)", () => {
  const bs = P("XAU-100-0.01"); bs.tvl = 1.45;
  const r = calcRisk(bs, 1, 4138, 4137, "CLAMP_TO_MIN");
  assert.equal(r.status, "CLAMPED"); assert.equal(r.ok, true); assert.equal(r.vol, 0.01); near(r.eff, 1.45); near(r.req, 1); assert.equal(r.clamped, true);
});
test("risk $10: lot rounded DOWN to the step, effective risk never above the requested one", () => {
  const bs = P("XAU-100-0.01"); bs.tvl = 1.45;
  const r = calcRisk(bs, 10, 4138, 4137, "STRICT");
  assert.equal(r.vol, 0.06); assert.ok(r.eff <= 10 + 1e-9); assert.equal(r.status, "OK");
});
test("risk $1 on XAU-100-0.01 with a 1.00 zone: lot 0.01, loss per lot $100", () => {
  const r = calcRisk(P("XAU-100-0.01"), 1, 4138, 4137, "STRICT");
  assert.equal(r.vol, 0.01); near(r.eff, 1);
});
test("micro lot broker (min/step 0.001): risk $1 -> 0.001..., never rounded to 2 digits", () => {
  const bs = P("XAU-1-0.001");                                      // contract 1 -> $1 per 1.00 per lot
  const r = calcRisk(bs, 0.4, 4138, 4137, "STRICT");
  assert.equal(r.vol, 0.4); assert.equal(r.status, "OK");
  const r2 = calcRisk(bs, 0.0075, 4138, 4137, "STRICT");
  assert.equal(r2.vol, 0.007); near(r2.eff, 0.007);
});
test("large step broker (min/step 0.10): risk $1 on $100/lot -> BELOW_MIN (needs $10); risk $35 -> 0.3 lot", () => {
  const bs = P("XAU-100-0.1");
  assert.equal(calcRisk(bs, 1, 4138, 4137, "STRICT").status, "BELOW_MIN");
  assert.equal(calcRisk(bs, 35, 4138, 4137, "STRICT").vol, 0.3);
});
test("risk 1 / step 0.03 style: volumes are min + k*step", () => {
  const bs = { ...P("XAU-100-0.01"), vmin: 0.03, vstep: 0.03, vdig: 2 };
  const r = calcRisk(bs, 10, 4138, 4137, "STRICT");               // raw 0.1 -> 0.03 + 2*0.03 = 0.09
  assert.equal(r.vol, 0.09);
});
test("above max volume -> ABOVE_MAX (a wait, never an order)", () => {
  const r = calcRisk(P("XAU-100-0.01"), 1000000, 4138, 4137, "STRICT");
  assert.equal(r.status, "ABOVE_MAX"); assert.equal(r.ok, false);
});
test("volume limit exceeded -> ABOVE_LIMIT", () => {
  const r = calcRisk(P("XAU-100-LIMIT1"), 500, 4138, 4137, "STRICT");   // raw 5 lots > limit 1
  assert.equal(r.status, "ABOVE_LIMIT");
});
test("different contract sizes (100 / 1 / 1000) change the lot, not the risk", () => {
  for (const [c, tvl] of [[100, 1], [1, 0.01], [1000, 10]]) {
    const bs = { ...P("XAU-100-0.01"), contract: c, tvl };
    const r = calcRisk(bs, 50, 4138, 4137, "STRICT");
    assert.ok(r.eff <= 50 + 1e-9 && r.eff > 0, `contract ${c}`);
  }
});
test("tick sizes 0.01 / 0.001 / 0.10 do not change the risk for the same price distance", () => {
  const out = [0.01, 0.001, 0.1].map((tick) => calcRisk({ ...P("XAU-100-0.01"), tick, tvl: tick * 100 }, 50, 4138, 4137, "STRICT").perLot);
  near(out[0], out[1]); near(out[0], out[2]);
});
test("account currency is carried from the broker spec (EUR account never shows $)", () => {
  const r = calcRisk(P("XAU-100-EUR"), 10, 4138, 4137, "STRICT");
  assert.equal(r.ccy, "EUR");
});
test("zero distance / missing spec -> NO_SPEC (never throws, never NaN)", () => {
  assert.equal(calcRisk(P("XAU-100-0.01"), 1, 4138, 4138, "STRICT").status, "NO_SPEC");
  assert.equal(calcRisk({ vmin: 0, vstep: 0 }, 1, 4138, 4137, "STRICT").status, "NO_SPEC");
});
