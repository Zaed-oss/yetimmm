// v4.25.0 (EA 2.39): order-error handling (report "تطوير وإصلاح نظام Stop Buy / Stop Sell", sections 5.4, 5.6, 7, 9-D/F/H).
// The EA cannot be compiled or run here, so these tests check the SOURCE for the structure the report requires. They do NOT replace F7 + Strategy Tester + Demo.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const ea = readFileSync(new URL("../ea/Yetimmm.mq5", import.meta.url), "utf8");
const body = (name) => { const i = ea.indexOf(name); assert.ok(i > 0, name + " missing"); return ea.slice(i, i + 20000); };

test("2.39 five retcode classes exist and every class is reachable", () => {
  for (const c of ["YR_RETRY", "YR_ADJUST", "YR_BROKER", "YR_PERM", "YR_UNCERT"]) assert.ok(new RegExp("#define " + c + "\\s+\\d").test(ea), c);
  const f = ea.slice(ea.indexOf("int ClassifyRetcode("), ea.indexOf("string RetClassName("));
  for (const rc of ["TIMEOUT", "CONNECTION", "ERROR"]) assert.ok(new RegExp("TRADE_RETCODE_" + rc + ":").test(f.split("return YR_RETRY")[0]), rc + " must be UNCERTAIN");
  for (const rc of ["REQUOTE", "PRICE_CHANGED", "INVALID_STOPS", "TOO_MANY_REQUESTS"]) assert.ok(f.includes("TRADE_RETCODE_" + rc + ":"));
  for (const rc of ["INVALID_VOLUME", "INVALID_EXPIRATION", "INVALID_FILL"]) assert.ok(f.includes("TRADE_RETCODE_" + rc + ":"));
  for (const rc of ["NO_MONEY", "MARKET_CLOSED", "TRADE_DISABLED"]) assert.ok(f.includes("TRADE_RETCODE_" + rc + ":"));
  assert.ok(f.includes("if(rc==0) return callOk?YR_PERM:YR_UNCERT;"));
  // no retcode appears in two classes (a duplicated case label would not compile)
  const labels = [...f.matchAll(/case (TRADE_RETCODE_\w+):/g)].map((m) => m[1]);
  assert.equal(new Set(labels).size, labels.length);
});

test("2.39/2.40 an UNCERTAIN result opens a ledger record: no failure, no step, no ERROR state and no immediate resend", () => {
  const t = body("bool TryPlace(");
  const u = t.slice(t.indexOf("if(cls==YR_UNCERT)"), t.indexOf('LogOrder("REJECTED"'));
  assert.ok(u.includes("SideOrderExists(buy)"));
  assert.ok(u.includes("UncOpen(buy,level,lot,"));                                // v2.40: the request is recorded (and saved) instead of a 3 s timer
  assert.ok(!u.includes("g_failCount++") && !u.includes("YT_ERROR") && !u.includes("YS_FAILED"));
  assert.ok(!/g_seq\+\+|g_seq=/.test(u));                                         // a failed or unknown send never touches the sequence
  assert.ok(t.indexOf("if(SideOrderExists(buy)) return false;") > 0 && t.indexOf("if(SideOrderExists(buy)) return false;") < t.indexOf("g_trade.BuyStop("));
  assert.ok(t.indexOf("if(UncBlocks(buy)) return false;") > 0 && t.indexOf("if(UncBlocks(buy)) return false;") < t.indexOf("g_trade.BuyStop("));
});

test("2.39 only ADJUST / PERMANENT failures can reach ERROR; RETRY and BROKER are transient", () => {
  const t = body("bool TryPlace(");
  const sw = t.slice(t.indexOf("switch(cls)"), t.indexOf("g_nextPlaceMs=nowMs+delay;"));
  assert.match(sw, /case YR_BROKER:[\s\S]*transient=true;/);
  assert.match(sw, /case YR_RETRY:[\s\S]*transient=true;/);
  assert.ok(/default:[\s\S]*g_failCount\+\+;/.test(sw) && !/default:[\s\S]*transient=true/.test(sw));
  assert.ok(t.includes("if(!transient && g_failCount>=8 && !g_revCtx)"));
});

test("2.39 the rejection log carries class, account type, cycle, step, ledger state, prices and server round trip", () => {
  const t = body("bool TryPlace(");
  for (const k of ["RetClassName(cls)", '"Netting":"Hedging"', "g_cycId", "g_seq+1", "g_accLoss", "g_curRisk", "tk.bid", "tk.ask", "send RTT"]) assert.ok(t.includes(k), k);
  assert.ok(t.includes("GetMicrosecondCount()"));
});

test("2.39 order-level trade events only raise a flag (nothing is sent from the event handler)", () => {
  const h = ea.slice(ea.indexOf("void OnTradeTransaction("), ea.indexOf("int g_timerCount"));
  assert.match(h, /TRADE_TRANSACTION_ORDER_ADD[\s\S]*TRADE_TRANSACTION_ORDER_DELETE[\s\S]*TRADE_TRANSACTION_ORDER_UPDATE/);
  const o = h.slice(h.indexOf("TRADE_TRANSACTION_ORDER_ADD"), h.indexOf("TRADE_TRANSACTION_DEAL_ADD"));
  assert.ok(o.includes("g_dirty=true;") && !/SyncAll\(|TryPlace\(|OrderDelete|PositionClose/.test(o));
});

test("2.39 the strategy rules of the report are untouched: no market order from the bot, one position, a failed send is not a trade", () => {
  assert.ok(ea.includes("YT_REAL_ORDERS_ONLY"));
  assert.ok(/#define YT_REAL_ORDERS_ONLY\s+true|const bool YT_REAL_ORDERS_ONLY\s*=\s*true/.test(ea) || /YT_REAL_ORDERS_ONLY[^\n]*true/.test(ea));
  assert.ok(ea.includes("void EnforceSinglePosition("));
  assert.ok(ea.includes("double NextRiskForNet("));
  assert.match(ea, /#property version\s+"2\.44"/);
});
