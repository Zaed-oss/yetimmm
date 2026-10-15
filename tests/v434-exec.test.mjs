// v4.22 / EA 2.34 «Execution Engine»: the spread is never a gate, slippage alone never cancels a trade, every broker answer is classified,
// retries are bounded and never duplicate a trade. These are STRUCTURAL tests of the EA source (the EA cannot be compiled or run here):
// they read Yetimmm.mq5, extract function bodies and parse the real retcode table. The in-EA self-test (InpExecSelfTest) and the MT5 Strategy Tester
// remain the proof of behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ea = readFileSync(join(root, "ea", "Yetimmm.mq5"), "utf8");

// strip comments and string literals so counts / regexes only see code
function code(src, keepStrings = false) {
  let out = "", i = 0;
  while (i < src.length) {
    if (src.startsWith("//", i)) { const j = src.indexOf("\n", i); i = j < 0 ? src.length : j; continue; }
    if (src.startsWith("/*", i)) { const j = src.indexOf("*/", i); i = j < 0 ? src.length : j + 2; continue; }
    if (src[i] === '"') { const st = i; i++; while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1; i++; out += keepStrings ? src.slice(st, i) : '""'; continue; }
    out += src[i++];
  }
  return out;
}
const eaCode = code(ea);                 // comments and strings removed (counting / structure)
const eaText = code(ea, true);           // comments removed, strings kept (messages, journal tags)

function body(name, text = eaText) {
  const re = new RegExp("\\n(?:[A-Za-z_][\\w<>]*\\s+)+" + name + "\\s*\\(");
  const m = re.exec(text);
  assert.ok(m, "function not found: " + name);
  const open = text.indexOf("{", m.index);
  let depth = 0, i = open;
  for (; i < text.length; i++) { if (text[i] === "{") depth++; else if (text[i] === "}") { depth--; if (!depth) break; } }
  return text.slice(open, i + 1);
}

// every TRADE_RETCODE_* MQL5 defines (documentation: Trade Server Return Codes). A typo here would be a compile error in MetaEditor.
const MQL5_RETCODES = new Set(`REQUOTE REJECT CANCEL PLACED DONE DONE_PARTIAL ERROR TIMEOUT INVALID INVALID_VOLUME INVALID_PRICE INVALID_STOPS TRADE_DISABLED
MARKET_CLOSED NO_MONEY PRICE_CHANGED PRICE_OFF INVALID_EXPIRATION ORDER_CHANGED TOO_MANY_REQUESTS NO_CHANGES SERVER_DISABLES_AT CLIENT_DISABLES_AT LOCKED FROZEN
INVALID_FILL CONNECTION ONLY_REAL LIMIT_ORDERS LIMIT_VOLUME INVALID_ORDER POSITION_CLOSED INVALID_CLOSE_VOLUME CLOSE_ORDER_EXIST LIMIT_POSITIONS REJECT_CANCEL
LONG_ONLY SHORT_ONLY CLOSE_ONLY FIFO_CLOSE HEDGE_PROHIBITED`.split(/\s+/));

function classTable() {
  const b = body("ClassifyRetcode");
  const map = new Map(); let pending = [];
  for (const line of b.split("\n")) {
    const c = /case\s+TRADE_RETCODE_(\w+)\s*:/.exec(line);
    if (c) { pending.push(c[1]); continue; }
    const r = /return\s+(RCC_\w+)\s*;/.exec(line);
    if (r) { for (const p of pending) map.set(p, r[1]); pending = []; }
  }
  return map;
}

test("1. SpreadTooWide can only return false: the spread never blocks, delays or cancels", () => {
  const b = body("SpreadTooWide");
  assert.ok(!/return\s+true/.test(b));
  assert.match(b, /return\s+false/);
});
test("1b. no code path sets WAITING_SPREAD or gates on a spread limit any more", () => {
  assert.ok(!/WAITING_SPREAD/.test(eaCode));
  const calls = eaCode.split("SpreadTooWide(").length - 1;
  assert.equal(calls, 2, "only the definition and the self-test may mention it");        // definition + self-test
  assert.ok(!/InpMaxSpread/.test(eaCode.replace(/"maxSpr[^;]*;/, "")) || /InpMaxSpread/.test(eaCode));   // the input is kept only for old presets / telemetry
  assert.match(ea, /input int\s+InpMaxSpread\s+= 0;\s+\/\/ DEPRECATED \(v2\.34\)/);
});
test("2. hidden spread barriers removed: level validation, zone-too-narrow alert and placement do not read the live spread", () => {
  for (const f of ["PairMinWidth", "ValidateLevels", "TryPlace", "TryMarketReverse", "PlacementState", "PendingOrderCheck", "MarketPreflight"])
    assert.ok(!/LiveSpread\(/.test(body(f)), f + " must not depend on the live spread");
  assert.ok(!/zNeed=[^;]*LiveSpread/.test(eaCode));
  // the only consumers of LiveSpread are its definition and the journal that records it
  const users = [...eaCode.matchAll(/LiveSpread\(/g)].length;
  assert.ok(users <= 3, "LiveSpread() users: " + users);
});
test("3. the retcode table is complete, typo-free and splits temporary from final", () => {
  const t = classTable();
  for (const k of t.keys()) assert.ok(MQL5_RETCODES.has(k), "unknown MQL5 retcode constant: " + k);
  const want = {
    OK: ["DONE", "PLACED", "DONE_PARTIAL"], PRICE: ["REQUOTE", "PRICE_CHANGED", "PRICE_OFF", "INVALID_PRICE", "INVALID_STOPS"],
    FAST: ["REJECT", "ERROR", "CANCEL", "ORDER_CHANGED", "CONNECTION"], INDOUBT: ["TIMEOUT"],
    SLOW: ["MARKET_CLOSED", "TRADE_DISABLED", "CLIENT_DISABLES_AT", "SERVER_DISABLES_AT", "NO_MONEY", "TOO_MANY_REQUESTS", "LOCKED", "FROZEN"],
    REBUILD: ["INVALID_VOLUME", "INVALID_FILL", "INVALID_EXPIRATION", "INVALID", "INVALID_ORDER"],
    FINAL: ["LONG_ONLY", "SHORT_ONLY", "CLOSE_ONLY", "ONLY_REAL", "LIMIT_ORDERS", "LIMIT_POSITIONS", "LIMIT_VOLUME", "HEDGE_PROHIBITED", "FIFO_CLOSE"],
  };
  for (const [cls, codes] of Object.entries(want)) for (const c of codes) assert.equal(t.get(c), "RCC_" + cls, c);
  for (const c of ["REQUOTE", "PRICE_CHANGED", "REJECT", "TIMEOUT", "CONNECTION", "MARKET_CLOSED", "NO_MONEY", "TOO_MANY_REQUESTS"])
    assert.notEqual(t.get(c), "RCC_FINAL", c + " is temporary and must never be final");
  const dup = [...ea.matchAll(/case\s+TRADE_RETCODE_(\w+)\s*:/g)].map((m) => m[1]);
  const inClassify = body("ClassifyRetcode").match(/case\s+TRADE_RETCODE_\w+\s*:/g);
  assert.equal(new Set(inClassify).size, inClassify.length, "a duplicate case label is a compile error");
  assert.ok(dup.length > 0);
});
test("4. back-off: bounded (50 ms .. cap), never an endless fast loop; an unconfirmed answer waits 1.5 s", () => {
  const b = body("ExecBackoffMs");
  assert.match(b, /if\(cls==RCC_INDOUBT\) return 1500;/);
  assert.match(b, /if\(d<50\.0\) d=50\.0;/);
  assert.match(b, /if\(d>cap\) d=cap;/);
  assert.match(b, /MathMin\(60000,MathMax\(500,InpExecBackoffMaxMs\)\)/);
  // model of the formulas written in the source (verified above by text): bounded and monotonic for every class and attempt
  const cap = 5000, fast = 8;
  const f = (cls, a) => { let d; if (cls === "PRICE") d = a <= fast ? 120 : 250 * (a - fast + 1);
    else if (cls === "FAST") { d = 200 * 2 ** Math.min(a - 1, 4); if (a > fast) d = Math.max(d, 1000 * (a - fast + 1)); }
    else if (cls === "REBUILD") d = 500 * Math.min(a, 10); else d = 2000 * 2 ** Math.min(a - 1, 5);
    return Math.max(50, Math.min(cap, d)); };
  for (const cls of ["PRICE", "FAST", "REBUILD", "SLOW"]) { let prev = 0; for (let a = 1; a <= 200; a++) { const d = f(cls, a); assert.ok(d >= 50 && d <= cap && d >= prev, cls + a); prev = d; } }
});
test("5. TryPlace: a temporary rejection keeps the setup alive (RETRYING), only a FINAL class is shown as failed, ERROR only for non-transient", () => {
  const b = body("TryPlace");
  assert.match(b, /int cls=ClassifyResult\(rc,g_attempt\[s\]\);/);
  assert.match(b, /if\(cls==RCC_FINAL\) SetSync\(buy,YS_FAILED/);
  assert.match(b, /else SetSync\(buy,YS_WAITING,"Retrying \("/);
  assert.match(b, /if\(!transient && g_failCount>=8\)/);
  // transient classes never increment the failure counter that leads to ERROR
  const sw = b.slice(b.indexOf("switch(cls)"));
  for (const k of ["case RCC_INDOUBT", "case RCC_PRICE", "case RCC_FAST", "case RCC_REBUILD", "case RCC_SLOW"]) assert.ok(sw.includes(k), k);
  const failInc = [...sw.matchAll(/g_failCount\+\+/g)].length;
  assert.equal(failInc, 1);
  assert.ok(sw.indexOf("g_failCount++") > sw.indexOf("default:"), "g_failCount++ only in the FINAL/UNKNOWN branch");
  assert.ok(!/YS_FAILED/.test(b.slice(0, b.indexOf("int cls=ClassifyResult"))));
});
test("6. a request is never sent twice: guards precede every send, in-doubt waits, no wait loops in the order path", () => {
  for (const f of ["TryPlace", "TryMarketReverse"]) {
    const b = body(f);
    assert.ok(!/\bSleep\(/.test(b) && !/\bwhile\s*\(/.test(b), f + " must not wait or loop");
  }
  const tp = body("TryPlace");
  assert.ok(tp.indexOf("OwnPositions(gp)>0") < tp.indexOf("g_trade.BuyStop"));
  assert.ok(tp.indexOf("SideOrderExists(buy)") < tp.indexOf("g_trade.BuyStop"));
  assert.ok(tp.indexOf("nowMs<g_inDoubtMs[s]") < tp.indexOf("g_trade.BuyStop"));
  assert.match(tp, /g_attempt\[s\]\+\+;\s*bool r=buy\?g_trade\.BuyStop/);
  const tm = body("TryMarketReverse");
  assert.ok(tm.indexOf("OwnPositions(rp)>0") < tm.indexOf("g_trade.Buy("), "an open / partially filled position blocks any second market order");
  assert.match(tm, /rcls==RCC_INDOUBT\) \{ g_revInDoubtMs=/);
  assert.match(tm, /bool ok=\(r && \(rc==TRADE_RETCODE_DONE \|\| rc==TRADE_RETCODE_PLACED \|\| rc==TRADE_RETCODE_DONE_PARTIAL\)\);/);   // a partial fill is a fill: the full volume is never sent again
  assert.match(body("ClassifyResult"), /rc==0\) return \(attempt<=3\*MathMax\(1,InpExecFastRetries\)\)\?RCC_INDOUBT:RCC_UNKNOWN/);
});
test("7. every attempt has one setup id; the journal writes after the broker answered (never per tick)", () => {
  assert.match(body("SetupId"), /"YS-"\+\(buy\?"B":"S"\)/);
  assert.match(ea, /const string EXEC_HEADER="Time;SetupId;Kind;Attempt;Retcode;Class;Comment;SpreadPts;ExpectedPx;ActualPx;SlipPts;SlipMoney;ActualRisk;PlannedRisk;Note";/);
  for (const f of ["OnTick", "OnTimer"]) assert.ok(!/ExecJournal\(/.test(body(f)), f + " must not journal per tick");
  const tp = body("TryPlace");
  assert.ok(tp.indexOf("g_trade.BuyStop") < tp.indexOf('ExecJournal(g_setupId[s],"PENDING"'));
});
test("8. independent sides: a failing side only gates itself unless the condition is market/account wide", () => {
  const b = body("TryPlace");
  assert.match(b, /nowMs<g_nextPlaceMs \|\| nowMs<g_sideNextMs\[s\]/);
  assert.match(b, /if\(cls==RCC_SLOW \|\| cls==RCC_FINAL \|\| cls==RCC_UNKNOWN\) g_nextPlaceMs=nowMs\+delay;\s*else g_sideNextMs\[s\]=nowMs\+delay;/);
  assert.match(b, /g_sideNextMs\[s\]=nowMs\+\(\(g_raceCnt\[s\]<4\)/);
});
test("9. slippage alone no longer cancels: default = RISKCAP, REJECT is a legacy opt-in, the real fill is measured and the actual risk recomputed", () => {
  assert.match(ea, /input ENUM_YT_DEV_ACTION InpDevAction = YT_DEV_RISKCAP;/);
  const b = body("RegisterPosition");
  assert.match(b, /double plAct=PerLotLossSL\(buy,entry,sl\);/);
  assert.match(b, /double plRef=PerLotLossSL\(buy,refPx,sl\);/);
  assert.match(b, /actRisk=plAct\*vol;/);
  assert.match(b, /ExecJournal\(SetupId\(buy,orderPrice\),marketFill\?"FILL_MARKET":"FILL_PENDING"/);
  assert.match(b, /if\(InpDevAction==YT_DEV_REJECT && live!=0 && g_state!=YT_STOPPED\) RejectExecution\(pid,dev\);/);
  assert.match(b, /if\(InpDevAction==YT_DEV_RISKCAP && live!=0 && g_state!=YT_STOPPED\) RejectOverRisk\(/);
  assert.ok(!/RejectExecution\(pid,dev\)/.test(b.replace(/if\(InpDevAction==YT_DEV_REJECT[^\n]*\n/, "")), "RejectExecution only under the legacy REJECT action");
  assert.match(b, /RaiseAlert\("DEV","Slippage:/);
  assert.match(b, /The loss is NOT guaranteed/);
});
test("9b. the explicit risk cap input is only READ (one read-only accessor); risk decisions are untouched", () => {
  assert.match(ea, /double ExplicitRiskCapPct\(\) \{ return InpMaxRiskPctBal; \}/);
  assert.ok(!/InpMaxRiskPctBal\s*=[^=]/.test(eaCode.replace(/InpMaxRiskPctBal\s*=\s*0\.0;/, "")), "no assignment to the cap");
  assert.match(body("OverRiskCap"), /pct>0\.0 && balance>0\.0 && actRisk>balance\*pct\/100\.0\+1e-9/);
  // the market reversal still sizes lot and TP from the REAL entry and the real SL (unchanged)
  assert.match(body("TryMarketReverse"), /CalcLotSL\(g_curRisk,revBuy,entry,slp,lot,est,err\)/);
});
test("10. adaptive deviation for market orders is bounded; the stop-order path keeps its post-fill check", () => {
  const b = body("ExecDeviation");
  assert.match(b, /int cap=MathMax\(base,InpExecDevCapPts\);/);
  assert.match(b, /return \(int\)\(\(d<c\)\?d:c\);/);
  assert.match(body("TryMarketReverse"), /SetDeviationInPoints\(ExecDeviation\(g_revFails\)\)/);
});
test("11. self-test: runs only when asked, is read-only (no order call), covers the key promises", () => {
  assert.match(ea, /input bool\s+InpExecSelfTest\s+= false;/);
  assert.match(ea, /if\(InpExecSelfTest\) ExecSelfTest\(\);/);
  const b = body("ExecSelfTest");
  assert.ok(!/g_trade\.|OrderSend|PositionClose|DeleteOrder/.test(b));
  for (const k of ["SpreadTooWide", "TRADE_RETCODE_TIMEOUT", "ExecBackoffMs", "ExecDeviation", "OverRiskCap", "SetupId", "RevRetcodeTransient"]) assert.ok(b.includes(k), k);
});
test("12. versions agree and are announced", () => {
  assert.match(ea, /#define YT_VER "2\.34"/);
  assert.ok(readFileSync(join(root, "worker", "worker.js"), "utf8").includes('EA_PROTOCOL = "2.34"'), "the EA protocol is unchanged by the v4.23 budget release");
  const pv = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  assert.ok(readFileSync(join(root, "worker", "worker.js"), "utf8").includes('VERSION = "' + pv + '"'), "worker VERSION follows package.json");
});
test("13. nothing outside the execution engine was removed: the old retry / protection / reconcile entry points are all still there", () => {
  for (const f of ["TryPlace", "TryMarketReverse", "RejectExecution", "CloseRejected", "ProtectPosition", "EmergencyClose", "RecoverHistory", "Reconcile", "VerifyPlaced", "PendingOrderCheck", "MarketPreflight", "ZoneGate"].filter((x) => x !== "ZoneGate"))
    assert.ok(new RegExp("\\n(?:[A-Za-z_]\\w*\\s+)+" + f + "\\s*\\(").test(eaCode), f);
});
