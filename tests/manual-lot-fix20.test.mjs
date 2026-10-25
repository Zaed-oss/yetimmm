// fix20 - NO MARTINGALE + MANUAL LOT (the request in "__تعديل_.pdf").
//   1. the bot never raises / doubles / lowers a lot by itself (the cycle ledger no longer sizes any trade);
//   2. the lot is a MANUAL field (EA input, Mini App settings, Telegram /lot) that only the user changes, at any time;
//   3. everything else (Stop Buy / Stop Sell orders, strategy, SL, TP, continuous trading, closing by the user) is untouched.
// HONEST LIMIT: MQL5 is not executed here (no MetaEditor / terminal / broker). F7 + Demo are still mandatory. These tests prove the SOURCE contract
// of the real EA / Worker / app and the arithmetic of the Mini App model (the same one the EA's RiskCompute mirrors).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ns } from "./mock-cf.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const raw = readFileSync(join(root, "ea", "Yetimmm.mq5"), "utf8");
const html = readFileSync(join(root, "index.html"), "utf8");
const strip = (t) => { let o = "", i = 0; const n = t.length;
  while (i < n) { const c = t[i], d = t[i + 1];
    if (c === "/" && d === "/") { while (i < n && t[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i += 2; while (i < n && !(t[i] === "*" && t[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"' || c === "'") { const q = c; o += q; i++; while (i < n && t[i] !== q) { o += t[i]; if (t[i] === "\\") { i++; o += t[i]; } i++; } o += q; i++; continue; }
    o += c; i++; }
  return o; };
const code = strip(raw);
const fnBody = (sig) => {
  const i = code.indexOf(sig); assert.ok(i > 0, sig + " not found");
  const o = code.indexOf("{", i); let d = 0, k = o, inS = false;
  for (; k < code.length; k++) {
    const c = code[k];
    if (inS) { if (c === "\\") k++; else if (c === inS) inS = false; continue; }
    if (c === '"' || c === "'") { inS = c; continue; }
    if (c === "{") d++; else if (c === "}") { d--; if (d === 0) break; }
  }
  return code.slice(o, k + 1);
};

// ---------------------------------------------------------------- 1) NO MARTINGALE (EA source)
test("EA: NextRiskForNet is the fixed initial risk - no ledger, target or RR in it", () => {
  const b = fnBody("double NextRiskForNet(");
  assert.match(b, /return g_initRisk;/);
  assert.ok(!/g_target|g_rr|rem|net>0/.test(b.replace(/const double net/, "")));
});
test("EA: every QuantizeLot call passes debt=false (a debt can never round the lot UP)", () => {
  const calls = [...code.matchAll(/QuantizeLot\(([^;]*?)\)\s*;/g)].map((m) => m[1]);
  assert.ok(calls.length >= 2, "RiskCompute + the plan table");
  for (const c of calls) assert.ok(/,false,/.test(c), c);
});
test("EA: no code path multiplies / scales the lot or the risk by a growth factor", () => {
  assert.ok(!/g_curRisk\s*\*=|g_curRisk\s*=\s*g_curRisk\s*\*|lot\s*\*=\s*[^;]*seq|g_manLot\s*\*=|g_manLot\s*\+=|g_manLot\s*=\s*[^;]*(g_cycNet|g_accLoss|g_seq)/i.test(code));   // (MathPow is only the network retry back-off / lot-digit counting)
  // the manual lot is only ever assigned from: the EA input / config file, a validated user command, or the revert of a refused command
  for (const m of code.matchAll(/g_manLot\s*=\s*([^;=]+);/g)) assert.ok(/^(CfgD\("lot",InpManualLot\)|InpManualLot|0\.0|v|lt|oldLot)$/.test(m[1].trim()), m[1]);
  // the only writers of g_curRisk take it from NextRiskForNet / the initial risk
  for (const m of code.matchAll(/g_curRisk\s*=\s*([^;]+);/g)) assert.ok(/NextRiskForNet\(|g_initRisk|InpInitialRisk|^sC$|^wantRisk$|^1\.0$|GV\(/.test(m[1].trim()), m[1]);
});
test("EA: the manual-lot input exists, defaults to a small lot and is explained", () => {
  assert.match(raw, /input double InpManualLot\s*=\s*0\.01;/);
  assert.match(raw, /NEVER raises, doubles or lowers it by itself/);
});

// ---------------------------------------------------------------- 2) MANUAL LOT (EA source)
test("EA: the manual lot is persisted in the config file like Target / RR (the Mini App value survives a restart)", () => {
  assert.match(fnBody("void CfgPutAll("), /CfgSet\("lot",DoubleToString\(g_manLot,8\)\)/);
  assert.match(fnBody("void CfgInit("), /g_manLot=CfgD\("lot",InpManualLot\)/);
  assert.match(fnBody("void CfgInit("), /g_manLot<0\.0/);                      // a corrupted file never produces a negative lot
});
test("EA: RiskCompute uses the manual lot BEFORE any risk-based sizing, floors it to the broker step and never rounds it up", () => {
  const b = fnBody("bool RiskCompute(");
  const iM = b.indexOf("if(g_manLot>0.0)"), iR = b.indexOf("else if(raw<vmin-1e-9)");
  assert.ok(iM > 0 && iR > iM);
  const man = b.slice(iM, iR);
  assert.match(man, /lot=vmin\+MathFloor\(\(g_manLot-vmin\)\/step\+1e-7\)\*step;/);
  assert.match(man, /how="MANUAL"/);
  assert.match(man, /g_manLot<vmin-1e-9/);                                      // below the broker minimum -> WAITING_VOLUME, never silently raised
  assert.ok(!/MathCeil|step;\s*how="ROUND_UP"/.test(man));
  // the broker maximum / Max Lot cap / volume limit / margin checks still apply to the manual lot
  assert.match(b, /if\(lot>vmax\+1e-9\)/);
  assert.match(b, /RISK_NO_MARGIN/);
});
test("EA: LotValidate requires a lot > 0 inside [min,max] on the broker step and under the Max Lot cap", () => {
  const b = fnBody("bool LotValidate(");
  for (const need of ["v<=0.0", "SYMBOL_VOLUME_MIN", "SYMBOL_VOLUME_MAX", "SYMBOL_VOLUME_STEP", "InpMaxLot", "MathRound(k)"]) assert.ok(b.includes(need), need);
});
test("EA: a lot change is committed (cfg + log + LOT_CHANGED + SyncAll) so waiting orders are replaced now; an open position is never touched", () => {
  const b = fnBody("void LotCommit(");
  for (const need of ["CfgSaveFile()", "LogOrder(\"LOT_CHANGED\"", "ResetSyncBackoff()", "SyncAll()", "g_nextPlaceMs=0"]) assert.ok(b.includes(need), need);
  assert.ok(!/ClosePosition|PositionClose|ExecClose|TRADE_ACTION_DEAL/.test(b));
  // the existing reconcile replaces a pending order whose volume differs from the expected lot (MT5 cannot modify a pending volume)
  assert.match(code, /bool volDiff=\(lotOk && MathAbs\(aV-expLot\)>step\/2\.0\)/);
});
test("EA: Telegram /lot shows and sets the lot, rejects non-numbers (never a silent 0) and is listed in /help", () => {
  assert.match(code, /cmd=="\/lot"/);
  assert.match(fnBody("string HelpText("), /\/lot \[LOT\|auto\]/);
  const n = fnBody("bool IsNumTxt(");
  assert.ok(n.includes("digits>0"));
  const t = fnBody("void TgCommand(");
  assert.match(t, /IsNumTxt\(w\)/);
  assert.match(t, /ExecSetLot\(ParseNum\(w\),"Telegram"\)/);
});
test("EA: Mini App apply / settings carry the lot - validated FIRST, applied before the levels, reverted if the levels are refused, allowed with a position open", () => {
  const i = code.indexOf('if(cmd=="apply" || cmd=="settings")\n     {\n      double b,s,r,tg,rr;');
  assert.ok(i > 0, "apply/settings handler");
  const h = code.slice(i, i + 3800);
  assert.ok(h.indexOf('JDbl(seg,"lot",lt)') > 0 && h.indexOf("LotValidate(lt,lerr)") < h.indexOf("ApplyLevels("));
  assert.match(h, /if\(lotChanged\) g_manLot=lt;/);
  assert.match(h, /g_manLot=oldLot;/);
  assert.match(h, /LotCommit\(oldLot,"MiniApp"\)/);
  // the "cannot change while a position is open" rule is only for Target / RR - not for the lot
  assert.match(h, /tradeChanged=\(MathAbs\(nt-g_target\)>1e-9 \|\| MathAbs\(nrr-g_rr\)>1e-9\)/);
});
test("EA: the state sent to the app carries the manual lot and the no-martingale flag; the command log shows the lot", () => {
  assert.match(code, /\\"mlot\\":/);
  assert.match(code, /\\"noMart\\":true/);
  assert.match(fnBody("string BrCmdDetail("), /"Lot "/);
});
test("EA: the plan table / plan log no longer present a growth plan (fixed lot, identical rows)", () => {
  assert.match(fnBody("void PrintRecoveryPlan("), /Lot plan \(fix20, no martingale\)/);
  const w = fnBody("void WritePlanTable(const string why)\n  {");
  assert.match(w, /if\(g_manLot>0\.0\)/);
  assert.ok(!/NET_SHORTFALL/.test(w));
});

// ---------------------------------------------------------------- 3) NOTHING ELSE CHANGED
test("EA: SL / TP / entry rules are untouched (SL = opposite level, TP = SL distance x RR, real Stop orders only)", () => {
  assert.match(code, /YT_REAL_ORDERS_ONLY true/);
  assert.match(fnBody("double TPPrice("), /g_rr/);
  assert.match(code, /input double InpRiskReward\s*=\s*20\.0;/);
  assert.match(code, /input bool   InpPreArmReverse\s*=\s*true;/);
  assert.match(code, /input int    InpMaxSeqLosses\s*=\s*0;/);
});
test("EA: the cycle ledger itself is kept (net / debt / seq for reports and the optional caps)", () => {
  for (const k of ["string CycleBook(", "g_cycNet", "g_accLoss", "g_seq"]) assert.ok(code.includes(k), k);
  assert.ok(fnBody("string CycleBook(").includes("g_curRisk=NextRiskForNet(g_cycNet);"));
});

// ---------------------------------------------------------------- model of the sizing (same arithmetic as the Mini App / RiskCompute)
const core = html.split("/*RISK-CORE-BEGIN*/")[1].split("/*RISK-CORE-END*/")[0];
const { calcRisk, SIM_PROFILES } = new Function(core + "; return { calcRisk, SIM_PROFILES };")();
const P = (n) => ({ ...SIM_PROFILES[n] });
test("model: manual lot is used as typed, whatever the risk is (no risk-derived lot)", () => {
  const bs = P("XAU-100-0.01");
  for (const risk of [0.1, 1, 5, 50, 500]) {
    const r = calcRisk(bs, risk, 4138, 4137, "STRICT", 0.05);
    assert.equal(r.vol, 0.05); assert.equal(r.ok, true);
  }
  assert.equal(calcRisk(bs, 1, 4138, 4137, "STRICT", 0).vol, 0.01);               // 0 = AUTO-FIXED: the old risk-based lot
});
test("model: manual lot is floored to the broker step and below the minimum it WAITS (never raised)", () => {
  const bs = P("XAU-100-0.01");
  assert.equal(calcRisk(bs, 1, 4138, 4137, "STRICT", 0.057).vol, 0.05);
  const lo = calcRisk(bs, 1, 4138, 4137, "STRICT", 0.005);
  assert.equal(lo.status, "BELOW_MIN"); assert.equal(lo.vol, 0);
  const coarse = P("XAU-100-0.1");
  assert.equal(calcRisk(coarse, 1, 4138, 4137, "STRICT", 0.25).vol, 0.2);
  assert.equal(calcRisk(coarse, 1, 4138, 4137, "STRICT", 0.05).status, "BELOW_MIN");
});
test("model: the loss at SL of a manual lot is shown honestly (lot x loss per lot), not forced to $1", () => {
  const bs = P("XAU-100-0.01");
  const r = calcRisk(bs, 1, 4138, 4137, "STRICT", 0.03);
  assert.ok(Math.abs(r.eff - 3) < 1e-9 && Math.abs(r.perLot - 100) < 1e-9);
});
test("model: a losing sequence with the manual lot keeps the SAME lot at every step (the old system grew 5% per loss)", () => {
  const bs = P("XAU-100-0.01"); let net = 0; const lots = [];
  for (let n = 0; n < 12; n++) { lots.push(calcRisk(bs, 1, 4138, 4137, "STRICT", 0.02).vol); net -= 2; }
  assert.deepEqual([...new Set(lots)], [0.02]);
  // AUTO-FIXED (lot 0): the risk passed in is always the initial risk (EA NextRiskForNet), so the lot is constant too
  const auto = []; for (let n = 0; n < 12; n++) auto.push(calcRisk(bs, 1, 4138, 4137, "STRICT", 0).vol);
  assert.deepEqual([...new Set(auto)], [0.01]);
});

// ---------------------------------------------------------------- Mini App (source)
test("app: the settings form has the lot field, wired to input / apply / refresh from the EA state", () => {
  assert.match(html, /id="in_lot"/);
  assert.match(html, /run\("apply",\{buy:b,sell:s,risk:r,target:tg,rr,lot:lt\}\)/);
  assert.match(html, /\["in_b","in_s","in_lot","in_rr"\]\.forEach/);
  assert.match(html, /in_lot:S\.mlot/);
});
test("app: lot is validated against the broker spec before sending (negative / below min / above max / off-step)", () => {
  const f = html.slice(html.indexOf("function lotErr("), html.indexOf("function lotErr(") + 600);
  for (const need of ["e_lotReq", "e_lotMin", "e_lotMax", "e_lotStep"]) assert.ok(f.includes(need), need);
});
test("app: the simulation no longer multiplies the risk after a loss and uses the manual lot", () => {
  assert.match(html, /const nextRisk=L=>S\.risk;/);
  assert.match(html, /lotFor\(S\.cur,entry,sl,S\.mlot\)/);
  assert.ok(!/\(L\+S\.target\)\/S\.rr/.test(html));
});
test("app: the wording no longer promises recovery growth (target note, stop-loss toast)", () => {
  assert.ok(!/Next risk = \(accumulated loss/.test(html.split("Object.assign(D,{\nlotL")[1] || ""));
  assert.ok(!/id="in_r"|id="in_t"/.test(html), "risk / target fields removed");
  assert.match(html, /e_lotReq/);
});

// ---------------------------------------------------------------- Worker: the lot reaches the EA, bad values never do
const W = await import("../worker/worker.js");
function boot() {
  const env = { BOT_TOKEN: "123:ABC", APP_PASSWORD: "S3cret-pass", PAIR_CODE: "pair-Code-7788", REQUIRE_TG: "0" };
  env.HUB = ns(W.Hub, env); env.NOTIFY = ns(W.Notify, env);
  const call = async (path, { method = "POST", body, headers = {} } = {}) => {
    const r = await W.default.fetch(new Request("https://w" + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers }), env);
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  return { call };
}
test("worker: apply / settings with a lot are queued for the EA with the lot; negative or absurd lots are refused", async () => {
  const { call } = boot();
  const ea = {}; let es = "e".repeat(32);
  const sync = (body = {}, extra = {}) => call("/api/ea/sync", { body: { login: "123456", srv: "Broker-Live", state: { price: 2400.5, run: false, state: "STOPPED", hist: [], orders: [], waits: [], tick: 0.01, pt: 0.01, maxDev: 30 }, ...body }, headers: { "X-EA-Secret": es, ...(ea.s ? {} : { "X-EA-Pair": "pair-Code-7788" }), ...extra } });
  const s0 = await sync(); assert.equal(s0.s, 200); if (s0.j.es) { es = s0.j.es; ea.s = 1; }
  const lg = await call("/login", { body: { login: "123456", pw: "S3cret-pass" } });
  const h = { "X-Login": "123456", "X-Session": lg.j.session || lg.j.sess || lg.j.token };
  const ok = await call("/command", { headers: h, body: { cmd: "apply", buy: 2410, sell: 2400, risk: 1, rr: 20, lot: 0.05 } });
  assert.equal(ok.s, 200);
  const q = await sync(); assert.equal(q.s, 200);
  const c = (q.j.commands || [])[0]; assert.ok(c && c.lot === 0.05, JSON.stringify(q.j));
  assert.equal((await call("/command", { headers: h, body: { cmd: "settings", lot: -1 } })).s, 400);
  assert.equal((await call("/command", { headers: h, body: { cmd: "settings", lot: 5000 } })).s, 400);
  assert.equal((await call("/command", { headers: h, body: { cmd: "settings", lot: "abc" } })).s, 400);
  assert.equal((await call("/command", { headers: h, body: { cmd: "settings", lot: 0 } })).s, 200);   // the Worker only relays; the EA refuses lot 0 (a lot is required)
});
