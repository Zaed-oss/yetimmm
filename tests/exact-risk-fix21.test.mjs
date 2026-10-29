// fix21 - EXACT RISK READOUT under the lot field (Mini App) + the broker figures the EA publishes for it.
//   * "when I type the lot, show the exact money at risk, exactly as the broker computes it"
// What is proven here: the arithmetic (real RISK-CORE of index.html), the rendering of the readout (real renderLotRisk with stubs) and the SOURCE contract of the EA.
// HONEST LIMIT: MQL5 is not executed here. F7 + a Demo account are still mandatory (see docs/FIX21-EXACT-RISK.md).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ea = readFileSync(join(root, "ea", "Yetimmm.mq5"), "utf8");
const html = readFileSync(join(root, "index.html"), "utf8");
const core = html.split("/*RISK-CORE-BEGIN*/")[1].split("/*RISK-CORE-END*/")[0];
const M = new Function(core + ";return {SIM_PROFILES,perLotLoss,calcRisk,lotQuote}")();
const G = M.SIM_PROFILES["XAU-100-0.01"];
const close = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} != ${b}`);

// ------------------------------------------------------------------ 1) arithmetic
test("loss at SL = lot x SL distance x contract (gold, contract 100, step 0.01)", () => {
  const q = M.lotQuote(G, 0.05, 1, 20, {});
  assert.equal(q.ok, true);
  close(q.loss, 5); close(q.profit, 100); assert.equal(q.lot, 0.05);
  close(M.lotQuote(G, 0.01, 1, 20, {}).loss, 1);          // the fix20 example: 0.01 lot at distance 1.00 = $1
  close(M.lotQuote(G, 0.10, 2.5, 3, {}).loss, 25);
});
test("every lot of the step grid gives exactly lot x d x contract (no float drift)", () => {
  for (let i = 1; i <= 300; i++) {
    const lot = Number((i * 0.01).toFixed(2)), q = M.lotQuote(G, lot, 1.37, 20, {});
    assert.equal(q.ok, true, "lot " + lot); assert.equal(q.lot, lot);
    close(q.loss, lot * 1.37 * 100, 1e-7);
  }
});
test("other broker profiles: 0.001 step / 0.1 step / EUR account", () => {
  const p1 = M.SIM_PROFILES["XAU-1-0.001"], p2 = M.SIM_PROFILES["XAU-100-0.1"], p3 = M.SIM_PROFILES["XAU-100-EUR"];
  close(M.lotQuote(p1, 0.123, 1, 20, {}).loss, 0.123 * 1 * 1);   // contract 1
  assert.equal(M.lotQuote(p2, 0.05, 1, 20, {}).code, "BELOW_MIN");
  assert.deepEqual(M.lotQuote(p2, 0.15, 1, 20, {}).near, [0.1, 0.2]);
  const e = M.lotQuote(p3, 0.05, 1, 20, {});                      // tick value 0.92 EUR per 0.01 move per lot
  close(e.loss, 0.05 * 92);
});
test("the broker's own figure (plu = OrderCalcProfit per lot per 1.00) wins over tick x tick value", () => {
  assert.equal(M.perLotLoss({ ...G, plu: 92.37 }, 1), 92.37);
  assert.equal(M.perLotLoss({ ...G, plu: 92.37 }, 2.5), 92.37 * 2.5);
  assert.equal(M.perLotLoss(G, 1), 100);                          // an older EA publishes no plu -> fallback is unchanged
  const q = M.lotQuote({ ...G, plu: 92.37 }, 0.03, 1, 20, {});
  assert.equal(q.exact, true); close(q.loss, 0.03 * 92.37);
  assert.equal(M.lotQuote(G, 0.03, 1, 20, {}).exact, false);
});

// ------------------------------------------------------------------ 2) validation = exactly what the EA accepts
test("invalid lots return a code and the nearest valid lots, never a wrong number", () => {
  const off = M.lotQuote(G, 0.055, 1, 20, {});
  assert.equal(off.code, "OFF_STEP"); assert.deepEqual(off.near, [0.05, 0.06]); assert.equal(off.loss, 0);
  const lo = M.lotQuote(G, 0.001, 1, 20, {});
  assert.equal(lo.code, "BELOW_MIN"); assert.deepEqual(lo.near, [0.01]);
  assert.equal(M.lotQuote(G, 500, 1, 20, {}).code, "ABOVE_MAX");
  assert.equal(M.lotQuote(G, 0, 1, 20, {}).code, "NO_LOT");
  assert.equal(M.lotQuote(G, 0.05, 0, 20, {}).code, "NO_SPEC");   // no SL distance
  assert.equal(M.lotQuote(null, 0.05, 1, 20, {}).code, "NO_SPEC");
});
test("the EA Max-Lot cap and the broker volume limit are enforced like LotValidate / RiskCompute", () => {
  const c = M.lotQuote({ ...G, capLot: 0.04 }, 0.05, 1, 20, {});
  assert.equal(c.code, "ABOVE_MAX"); assert.equal(c.max, 0.04);
  assert.equal(M.lotQuote({ ...G, capLot: 0.04 }, 0.04, 1, 20, {}).ok, true);
  assert.equal(M.lotQuote({ ...G, vlimit: 1 }, 1.5, 1, 20, {}).code, "ABOVE_LIMIT");
});

// ------------------------------------------------------------------ 3) commission, balance share, margin, safety caps
test("commission, total, net TP, % of balance and margin come from the broker figures", () => {
  const q = M.lotQuote({ ...G, plu: 100, cpl: 7, mpl: 2000 }, 0.05, 1, 20, { bal: 1000, fm: 500 });
  close(q.loss, 5); close(q.comm, 0.35); close(q.total, 5.35); close(q.net, 100 - 0.35);
  close(q.pct, 0.535); close(q.margin, 100);
  assert.deepEqual(q.warns, []);
  const n = M.lotQuote(G, 0.05, 1, 20, {});                       // nothing known -> nothing invented
  assert.equal(n.comm, 0); assert.equal(n.margin, 0); assert.equal(n.pct, 0);
});
test("EA safety caps are surfaced as warnings (they make new orders WAIT) - and a loss equal to the cap is allowed, like the EA's > test", () => {
  const sp = { ...G, plu: 100, capUsd: 3, capPct: 0.2, capDay: 10, dayLoss: 8, mpl: 2000 };
  const w = M.lotQuote(sp, 0.05, 1, 20, { bal: 1000, fm: 50 }).warns.map((x) => x.k).sort();
  assert.deepEqual(w, ["capDay", "capPct", "capUsd", "noMargin"]);
  assert.deepEqual(M.lotQuote({ ...G, capUsd: 5 }, 0.05, 1, 20, {}).warns, []);
  assert.deepEqual(M.lotQuote({ ...G, capPct: 0.5 }, 0.05, 1, 20, { bal: 1000 }).warns, []);   // 5 <= 0.5% of 1000
  assert.equal(M.lotQuote({ ...G, capPct: 0.4 }, 0.05, 1, 20, { bal: 1000 }).warns[0].k, "capPct");
});

// ------------------------------------------------------------------ 4) the readout itself (real renderLotRisk, stubbed environment)
function harness(over = {}) {
  const el = { className: "", innerHTML: "" };
  const f = new Function("return " + html.match(/const f=(\(v,d=2\)=>[^\n]*?\);)/)[1].replace(/;$/, ""))();
  const env = {
    $: () => el, spec: () => ("bs" in over ? over.bs : G), S: over.S ?? {}, t: (k, ...a) => k + (a.length ? "(" + a.join("|") + ")" : ""),
    fv: (v) => f(v, 2), fp: (v) => f(v, 2), f, cs: () => "$", esc: (x) => String(x), live: () => !!over.live, SIMP: "XAU-100-0.01",
  };
  const src = html.slice(html.indexOf("const mny="), html.indexOf("function prevCalc(){"));
  const fn = new Function(...Object.keys(env), "lotQuote", "perLotLoss", src + ";return renderLotRisk")(...Object.values(env), M.lotQuote, M.perLotLoss);
  return { el, run: fn };
}
test("readout: a valid manual lot shows the exact loss, the TP profit and the formula", () => {
  const h = harness();
  h.run(4138, 4137, 20, 0.05, null);
  assert.equal(h.el.className, "lr");
  assert.match(h.el.innerHTML, /\$5\.00/);
  assert.match(h.el.innerHTML, /\+\$100\.00/);
  assert.match(h.el.innerHTML, /<span class="ltr num">0\.05 × 1\.00 × \$100\.00<\/span>/);   // the formula is an LTR island, so it reads the same in Arabic (RTL)
  assert.match(h.el.innerHTML, /lr_loss/);
});
test("readout: commission rows appear only when the commission is known", () => {
  const h = harness({ bs: { ...G, plu: 100, cpl: 7 }, live: true });
  h.run(4138, 4137, 20, 0.05, null);
  assert.match(h.el.innerHTML, /\$0\.35/); assert.match(h.el.innerHTML, /\$5\.35/); assert.match(h.el.innerHTML, /lr_src_ok/);
  const g = harness({ live: true }); g.run(4138, 4137, 20, 0.05, null);
  assert.doesNotMatch(g.el.innerHTML, /lr_comm/); assert.match(g.el.innerHTML, /lr_src_est/);   // an older EA is labelled as an estimate
});
test("readout: an off-step lot is an error with the nearest valid lots and their money", () => {
  const h = harness();
  h.run(4138, 4137, 20, 0.055, null);
  assert.equal(h.el.className, "lr er");
  assert.match(h.el.innerHTML, /e_lotStep/); assert.match(h.el.innerHTML, /0\.05 → \$5\.00/); assert.match(h.el.innerHTML, /0\.06 → \$6\.00/);
});
test("readout: auto mode (lot = 0) shows the effective loss of the lot the Risk field produces", () => {
  const h = harness();
  h.run(4138, 4137, 20, 0, { lot: 0.01 });
  assert.match(h.el.innerHTML, /\$1\.00/); assert.match(h.el.innerHTML, /lr_lossA/);
});
test("readout: no broker spec yet / invalid levels never show a made-up number", () => {
  const w = harness({ bs: null }); w.run(4138, 4137, 20, 0.05, null);
  assert.match(w.el.innerHTML, /lr_wait/); assert.doesNotMatch(w.el.innerHTML, /\$/);
  const l = harness(); l.run(4137, 4138, 20, 0.05, null);            // Buy below Sell
  assert.equal(l.el.innerHTML, "");
});
test("readout: a safety-cap breach is shown as a warning next to the number", () => {
  const h = harness({ bs: { ...G, capUsd: 3 } });
  h.run(4138, 4137, 20, 0.05, null);
  assert.match(h.el.innerHTML, /lr_w_capUsd/); assert.match(h.el.innerHTML, /\$5\.00/);
});

// ------------------------------------------------------------------ 5) wiring in the page
test("page: the readout sits directly under the lot field and refreshes on every input + EA update", () => {
  assert.match(html, /id="in_lot"[^>]*><div class="lr" id="lotRisk" role="status" aria-live="polite"><\/div>/);
  assert.match(html, /\["in_b","in_s","in_lot","in_rr"\]\.forEach\(i=>\{\$\(i\)\.addEventListener\("input",\(\)=>\{Bridge\.dirty=true;prevCalc\(\)\}\)/);
  assert.match(html, /function prevCalc\(\)\{[\s\S]*renderLotRisk\(/);
  assert.match(html, /if\(!this\.dirty\)fillInputs\(\);else prevCalc\(\);/);
});
test("page: every readout text exists in Arabic (the only language)", () => {
  const keys = [...html.matchAll(/\b(lr_[A-Za-z_]+):("[^"]*")/g)].map((m) => m[1]);
  for (const k of ["lr_wait", "lr_nolot", "lr_loss", "lr_lossA", "lr_tp", "lr_comm", "lr_tot", "lr_net", "lr_pct", "lr_mg", "lr_fm", "lr_near", "lr_max", "lr_capLot", "lr_w_capPct", "lr_w_capUsd", "lr_w_capDay", "lr_w_noMargin", "lr_src_ok", "lr_src_est", "lr_src_sim"])
    assert.ok(keys.includes(k), k + " missing");
  for (const m of html.matchAll(/\b(lr_[A-Za-z_]+):("[^"]*")/g)) { assert.ok(m[2].length > 4 && /[\u0600-\u06FF]/.test(m[2]), m[1]); }
});

// ------------------------------------------------------------------ 6) EA source contract
const strip = (t) => { let o = "", i = 0; const n = t.length;
  while (i < n) { const c = t[i], d = t[i + 1];
    if (c === "/" && d === "/") { while (i < n && t[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i += 2; while (i < n && !(t[i] === "*" && t[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"' || c === "'") { const q = c; o += q; i++; while (i < n && t[i] !== q) { if (t[i] === "\\") { i++; } i++; } o += q; i++; continue; }
    o += c; i++; }
  return o; };
const code = strip(ea);
const fnBody = (sig) => { const i = code.indexOf(sig); assert.ok(i > 0, sig + " not found"); const o = code.indexOf("{", i); let d = 0, k = o;
  for (; k < code.length; k++) { if (code[k] === "{") d++; else if (code[k] === "}") { d--; if (d === 0) break; } } return code.slice(o, k + 1); };
test("EA: the three broker figures come from OrderCalcProfit / the commission / OrderCalcMargin", () => {
  const a = fnBody("double LossPerPriceUnitExact("); assert.match(a, /OrderCalcProfit\(ORDER_TYPE_BUY,g_sym,1\.0,px,px-ref,profit\)/); assert.match(a, /AcM\(-profit\)\/ref/); assert.match(a, /g_tick\*1000\.0/);
  const c = fnBody("double CommPerLotShown("); assert.match(c, /InpCommPerLot/); assert.match(c, /g_commLot/); assert.doesNotMatch(c, /InpCostAware/);   // shown even when Cost-Aware sizing is OFF
  const m = fnBody("double MarginPerLotNow("); assert.match(m, /OrderCalcMargin\(ORDER_TYPE_BUY,g_sym,1\.0,ask,m\)/);
});
test("EA: BsJson publishes plu / cpl / mpl, the safety caps and the build tag - and the JSON still closes", () => {
  const b = fnBody("string BsJson(");
  for (const k of ["plu", "cpl", "mpl", "capLot", "capPct", "capUsd", "capDay", "dayLoss", "bld"]) assert.ok(b.includes('\\"' + k + '\\"') || ea.includes('\\"' + k + '\\":'), k);
  assert.match(ea, /\\"bld\\":\\""\+YT_BUILD\+"\\"\}";\s*\n\s*return j;/);
  assert.match(ea, /\\"maxSpr\\":"\+IntegerToString\(InpMaxSpread\);/);   // the old closing brace moved to the end
  assert.match(ea, /#define YT_BUILD "fix21"/);
  assert.match(ea, /Print\("\[Yetimmm\] v"\+YT_VER\+" \("\+YT_BUILD\+"\) loaded/);
  assert.match(ea, /#define YT_VER "2\.46"/);                        // the protocol version is untouched
});
test("EA: /lot and the lot confirmation state the money in the account currency, with commission, and say WHY a cap blocks it", () => {
  const b = fnBody("string LotMoneyText(");
  assert.match(b, /AccCcy\(\)/); assert.match(b, /CommPerLotShown\(\)/); assert.match(b, /r\.text/); assert.doesNotMatch(b, /~\$/);
  assert.match(b, /RiskCompute\(g_initRisk,true,g_buyLevel/);
});
test("EA: the sizing path is unchanged (no martingale, NextRiskForNet still the fixed risk)", () => {
  assert.match(fnBody("double NextRiskForNet("), /return g_initRisk;/);
  assert.match(code, /double PerLotLossSL\(const bool buy,const double entry,const double sl\)/);
});
test("EA: braces and parentheses stay balanced after the edit", () => {
  let b = 0, p = 0; for (const ch of code) { if (ch === "{") b++; else if (ch === "}") b--; else if (ch === "(") p++; else if (ch === ")") p--; }
  assert.equal(b, 0); assert.equal(p, 0);
});

test("dashboard: the risk card carries the same exact money (qRows) for the lot the next orders use", () => {
  assert.match(html, /\$\{rkRows\(k\)\}\$\{qRows\(k,L\)\}<\/div>`;\s*\n\s*setDash\(h\)/);
  const src = html.slice(html.indexOf("function qRows("), html.indexOf("function pairErr("));
  assert.match(src, /lotQuote\(bs,lot,S\.buy-S\.sell,S\.rr/);
  assert.match(src, /if\(!q\.ok\)return""/);
});
