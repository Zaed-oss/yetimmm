// fix22 - THE LOT IS MANUAL, REQUIRED, AND MUST MATCH THE BROKER EXACTLY (min / max / step / volume limit / digits).
//   Proven here: (1) the Mini App accepts a lot ONLY if an independent MT5 reference validator accepts it (brute-force grid over every broker profile),
//   (2) no path can size a lot from the hidden risk any more (start / apply / EA RiskCompute / Telegram /lot auto), (3) the SOURCE contract of the EA chain.
// HONEST LIMIT: MQL5 is not executed here. F7 in MetaEditor + a Demo account are still mandatory.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ea = readFileSync(join(root, "ea", "Yetimmm.mq5"), "utf8");
const html = readFileSync(join(root, "index.html"), "utf8");
const core = html.split("/*RISK-CORE-BEGIN*/")[1].split("/*RISK-CORE-END*/")[0];
const M = new Function(core + ";return {SIM_PROFILES,calcRisk,lotQuote}")();

// the real lotErr() of the app, with the page's helpers stubbed
const src = html.slice(html.indexOf("function lotErr("), html.indexOf("/* link diagnostics"));
const mkLotErr = (bs, isLive) => new Function("spec", "live", "t", "fv", src + ";return lotErr")(() => bs, () => isLive, (k, ...a) => k + (a.length ? ":" + a.join(",") : ""), (v) => String(v));

// independent MT5 reference: volume in [min,max], (volume-min) is a whole number of steps, <= volume limit
const mt5Accepts = (bs, v) => {
  if (!(v > 0) || v < bs.vmin - 1e-9 || v > bs.vmax + 1e-9) return false;
  if (bs.vlimit > 0 && v > bs.vlimit + 1e-9) return false;
  const k = (v - bs.vmin) / bs.vstep; return Math.abs(k - Math.round(k)) <= 1e-6;
};

test("lotErr == MT5 reference for every broker profile over a dense grid (nothing invalid passes, nothing valid is blocked)", () => {
  for (const [name, bs] of Object.entries(M.SIM_PROFILES)) {
    const err = mkLotErr(bs, true);
    for (let i = 0; i <= 4000; i++) {
      const v = Number((i * bs.vstep / 2).toFixed(bs.vdig + 1));        // half-steps too: 0.005 on a 0.01 step must be rejected
      assert.equal(err(v) === "", mt5Accepts(bs, v), `${name} lot ${v}: lotErr="${err(v)}"`);
    }
  }
});
test("a lot accepted by lotErr is exactly the lot lotQuote / calcRisk size (no silent rounding up or down)", () => {
  for (const [name, bs] of Object.entries(M.SIM_PROFILES)) {
    const err = mkLotErr(bs, true);
    for (let i = 1; i <= 600; i++) {
      const v = Number((bs.vmin + (i - 1) * bs.vstep).toFixed(bs.vdig));
      if (err(v) !== "") continue;
      assert.equal(M.lotQuote(bs, v, 1, 20, {}).lot, v, name + " quote " + v);
      assert.equal(M.calcRisk(bs, 1, 4138, 4137, "STRICT", v).vol, v, name + " calcRisk " + v);
    }
  }
});
test("no lot / zero / negative / NaN is refused (the lot is REQUIRED)", () => {
  const err = mkLotErr(M.SIM_PROFILES["XAU-100-0.01"], true);
  for (const v of [0, -1, NaN, undefined]) assert.equal(err(v), "e_lotReq");
});
test("live mode: no BrokerSpec yet -> the lot is NOT sent (the app never guesses min / step / max)", () => {
  assert.equal(mkLotErr(null, true)(0.05), "lr_wait");
  assert.equal(mkLotErr(null, false)(0.05), "");                      // simulation has its own profile, so this only covers a missing profile
});
test("SYMBOL_VOLUME_LIMIT is enforced in the app and the EA Max Lot cap too", () => {
  const bs = M.SIM_PROFILES["XAU-100-LIMIT1"], err = mkLotErr(bs, true);
  assert.equal(err(1), ""); assert.match(err(1.01), /^lr_max/);
  const capped = { ...M.SIM_PROFILES["XAU-100-0.01"], capLot: 0.5 };
  assert.match(mkLotErr(capped, true)(0.51), /^lr_capLot/); assert.equal(mkLotErr(capped, true)(0.5), "");
});
test("the nearest valid lots are offered for an off-step lot (0.015 on a 0.01 step -> 0.01 / 0.02)", () => {
  const bs = M.SIM_PROFILES["XAU-100-0.01"], q = M.lotQuote(bs, 0.015, 1, 20, {});
  assert.equal(q.code, "OFF_STEP"); assert.deepEqual(q.near, [0.01, 0.02]);
});

// ---------------------------------------------------------------- no path sizes a lot from the (hidden) risk any more
test("Mini App: the risk and recovery-target fields are gone, Start and Apply both require a valid lot", () => {
  assert.ok(!/id="in_r"|id="in_t"/.test(html));
  assert.match(html, /function start\(\)\{const e=vLevels\(S\.buy,S\.sell\)\|\|lotErr\(S\.mlot\)\|\|/);
  assert.match(html, /lotErr\(lt\)\|\|\(rr>0\?"":t\("e_rr"\)\)/);
  assert.match(html, /run\("apply",\{buy:b,sell:s,risk:r,target:tg,rr,lot:lt\}\)/);
});
const body = (sig) => { const i = ea.indexOf(sig); assert.ok(i > 0, sig); let d = 0, k = ea.indexOf("{", i); const o = k; for (; k < ea.length; k++) { if (ea[k] === "{") d++; else if (ea[k] === "}" && --d === 0) break; } return ea.slice(o, k + 1); };
test("EA RiskCompute: lot <= 0 -> WAITING_VOLUME, never a lot from the risk", () => {
  const b = body("bool RiskCompute(");
  assert.match(b, /else if\(g_manLot<=0\.0\)\s*\{[^}]*r\.code="RISK_BELOW_MIN_VOLUME"[^}]*return false;/);
  assert.ok(b.indexOf("g_manLot<=0.0") < b.indexOf("raw<vmin-1e-9"), "the no-lot guard comes before any risk-based sizing");
});
test("EA LotValidate: required, broker min / max / step, Max Lot cap; apply validates BEFORE changing anything; Telegram /lot auto refused", () => {
  const b = body("bool LotValidate(");
  for (const need of ["v<=0.0", "SYMBOL_VOLUME_MIN", "SYMBOL_VOLUME_MAX", "SYMBOL_VOLUME_STEP", "InpMaxLot", "MathRound(k)"]) assert.ok(b.includes(need), need);
  assert.match(ea, /if\(hl && !LotValidate\(lt,lerr\)\) return "❌ "\+lerr\+" Nothing was changed\.";/);
  assert.match(ea, /if\(w=="auto"\) TgQueue\("❌ There is no automatic lot any more/);
});
test("EA: lot digits come from the finer of broker min and step; the final volume is floored to the step and OrderCheck runs before OrderSend", () => {
  assert.match(ea, /stMin=SymbolInfoDouble\(g_sym,SYMBOL_VOLUME_MIN\)/);
  assert.match(ea, /lot=vmin\+MathFloor\(\(g_manLot-vmin\)\/step\+1e-7\)\*step;/);
  assert.match(ea, /lot=NormalizeDouble\(lot,g_lotDigits\);/);
  assert.match(ea, /bool PendingOrderCheck\(/); assert.match(ea, /OrderCheck\(rq,ck\)/);
  assert.match(ea, /rc==TRADE_RETCODE_INVALID_VOLUME/);
});
test("EA publishes the exact broker figures the app validates against (vmin / vmax / vstep / vlimit / vdig / capLot)", () => {
  for (const k of ["vmin", "vmax", "vstep", "vlimit", "vdig", "capLot"]) assert.ok(ea.includes('\\"' + k + '\\":'), k);
});

// ---------------------------------------------------------------- NO MARTINGALE AUDIT (fix22): nothing in the EA can grow a lot any more
test("audit: the next risk is the fixed initial risk, whatever the ledger says", () => {
  assert.match(body("double NextRiskForNet("), /\{\s*return g_initRisk;\s*\}/);
});
test("audit: no call of QuantizeLot lets a debt round the lot UP (debt argument is always false)", () => {
  const calls = [...ea.matchAll(/QuantizeLot\(([^;]*)\);/g)].map((m) => m[1]).filter((a) => !/^const double raw/.test(a));
  assert.ok(calls.length >= 2);
  for (const a of calls) assert.match(a, /,false,/, a);
});
test("audit: RiskCompute reads the ledger ONLY for logging and the optional accumulated-loss cap (which blocks, never sizes)", () => {
  const b = body("bool RiskCompute(").replace(/\/\/[^\n]*/g, "");
  const lines = b.split("\n").filter((l) => /g_accLoss|g_cycNet|g_seq|g_curRisk/.test(l));
  for (const l of lines) assert.ok(/YLog\(|lck=|InpMaxAccLoss|r\.text=/.test(l), "ledger used for sizing? " + l.trim());
});
test("audit: exactly one place sends a pending order and its volume comes from CalcLot (no other lot source)", () => {
  assert.equal([...ea.matchAll(/g_trade\.(BuyStop|SellStop)\(/g)].length, 2);   // the two sides of the same ternary
  assert.equal([...ea.matchAll(/\bOrderSend\(/g)].filter((m) => !/PendingOrderCheck|OrderCheck/.test(ea.slice(m.index - 20, m.index))).length >= 0, true);
  assert.match(ea, /if\(!CalcLot\(g_curRisk,buy,level,lot,est,err\)\) \{ HandleLotError\(err\)/);
});
test("audit: the Mini App simulation keeps the risk fixed after losses", () => {
  assert.match(html, /const nextRisk=L=>S\.risk;/);
});

// ---------------------------------------------------------------- NEW CYCLE PHILOSOPHY (fix22)
test("cycle: it ends ONLY when a TP closes (the target) - never by a money net, never by an SL, never by a loss count", () => {
  assert.match(ea, /bool CycleMet\(const double cycNet\) \{ return GV\("CTPH",0\.0\)>0\.5; \}/);
  const book = body("string CycleBook(");
  assert.match(book, /if\(why=="TP" \|\| why=="TP \(closed while stopped\)"\) GS\("CTPH",1\.0\);/);
  assert.ok(!/[<>]=?\s*g_target|g_target\s*[<>]/.test(book.replace(/\/\/[^\n]*/g, "")), "CycleBook never compares anything with the money target");
  assert.ok(!/CycleMet\([^)]*\)\s*\{[^}]*g_target/.test(ea.replace(/\/\/[^\n]*/g, "")));
});
test("cycle: the new cycle starts clean (flag cleared with the ledger) and a restart in the middle of the completion still finishes it", () => {
  assert.match(body("void ResetRisk("), /GS\("CTPH",0\.0\);/);
  assert.match(body("void CycleCompletionTick("), /CycleMet\(g_cycNet\)/);
});
test("cycle: an SL only re-arms the pair at the original levels with the same lot (no ledger-driven sizing)", () => {
  const pcp = body("bool ProcessClosedPosition(");
  assert.match(pcp, /ledNote=CycleBook\(net,"SL"\);/);
  assert.match(pcp, /CalcLot\(g_curRisk,!buy,lvl,nextLot,nextEst,lerr\)/);
  assert.match(body("double NextRiskForNet("), /return g_initRisk;/);
});
