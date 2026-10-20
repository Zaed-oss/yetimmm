// fix18 - the reverse (opposite) Stop order must ALWAYS carry the lot that repays the loss of the trade that is currently open.
//  (A) executable model of the chain: every trade's TP profit >= target - net after the previous SL (the user's rule, 200-point TP, +5% per loss),
//  (B) race model of the real log (20/10 09:30:16-18, cycle #1 trade #9): old cooldown vs fix18,
//  (C) SOURCE checks that the EA contains the three fixes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ea = readFileSync(new URL("../ea/Yetimmm.mq5", import.meta.url), "utf8");
function fnBody(sig) {
  const i = ea.indexOf(sig);
  assert.ok(i >= 0, "missing " + sig);
  let d = 0, started = false;
  for (let k = ea.indexOf("{", i); k < ea.length; k++) {
    if (ea[k] === "{") { d++; started = true; } else if (ea[k] === "}") { d--; if (started && d === 0) return ea.slice(i, k + 1); }
  }
  throw new Error("unbalanced " + sig);
}

// ---------- (A) chain model: perLot = 10 $ per 1.00 lot*100pt... (0.10 lot = 1.00 $ risk), TP = 200 pts = 20 x risk ----------
const TARGET = 20, RR = 20, PER_LOT = 10, STEP = 0.01;
const roundUpLot = (risk) => Math.ceil(risk / PER_LOT / STEP - 1e-7) * STEP;        // ROUND_UP: never below the needed risk
const lotFor = (net) => roundUpLot(Math.max(1, (TARGET - net) / RR));                // required risk = (target - net) / RR, never below the initial 1.00
const tpProfit = (lot) => lot * PER_LOT * RR;
const slLoss = (lot) => lot * PER_LOT;

test("A: every trade of a pure-SL chain covers (target + all previous losses) at its TP - 40 consecutive stop-outs", () => {
  let net = 0;
  for (let n = 1; n <= 40; n++) {
    const lot = lotFor(net);
    assert.ok(tpProfit(lot) >= TARGET - net - 1e-9, `trade ${n}: lot ${lot.toFixed(2)} TP ${tpProfit(lot)} < needed ${TARGET - net}`);
    net -= slLoss(lot);
  }
});

test("A: the user's example - loss $1.00 -> next TP must repay 21.00 on the same 200-point target (lot 0.11 after round-up)", () => {
  const l1 = lotFor(0), l2 = lotFor(-slLoss(l1));
  assert.equal(l1.toFixed(2), "0.10");
  assert.equal(l2.toFixed(2), "0.11");
  assert.ok(tpProfit(l2) >= 21);
});

test("A: the OPPOSITE order is planned as if the open trade had already hit its SL (predicted net, not current net)", () => {
  // trade #8 of the real log: BUY 0.14 open, ledger net -7.03. The SELL stop must repay 20 + 7.03 + 1.40 = 28.43 -> lot 0.15
  const open = 0.14, net = -7.03;
  const predNet = net - slLoss(open);
  const lot = lotFor(predNet);
  assert.equal(lot.toFixed(2), "0.15");
  assert.ok(tpProfit(lot) >= 28.43 - 1e-9);
  assert.ok(tpProfit(0.14) < 28.43, "the OLD lot 0.14 (what really fired) was short by " + (28.43 - tpProfit(0.14)).toFixed(2));
});

// ---------- (B) race model ----------
// Timeline (ms) of 09:30:16 - 09:30:18 : the stop-out of the previous trade leaves a transient closing order in the active-order list.
function race({ fixed }) {
  const events = [];
  let nextDelMs = 0, revCleanMs = 0;
  const orders = [{ t: "SELL_STOP", lot: 0.14, ticket: 1 }, { t: "SELL" /* transient SL-execution order */, lot: 0.13, ticket: 2 }];
  const ownOrders = () => orders.filter((o) => (fixed ? o.t.endsWith("STOP") : true));
  let now = 0;
  // pass at t=0: clean-up loop
  for (const o of ownOrders()) {
    if (o.ticket === 1) continue;                                   // keepT
    const deleted = false;                                          // retcode 10013 on a market-type order
    if (!deleted) { if (fixed) revCleanMs = now + 1000; else nextDelMs = now + 2000; }
  }
  // pass at t=300 ms: the resize needs delete+place of the 0.14 order
  now = 300;
  const blocked = fixed ? false : now < nextDelMs;
  if (!blocked) { orders[0].lot = 0.15; events.push("replaced@" + now); }
  // price touches the SELL level at t=2000 ms
  now = 2000;
  events.push("fired lot " + orders[0].lot.toFixed(2));
  return { lotAtFire: orders[0].lot, events };
}

test("B: OLD behaviour reproduces the real defect (SELL fired with 0.14 although 0.15 was planned)", () => {
  assert.equal(race({ fixed: false }).lotAtFire.toFixed(2), "0.14");
});
test("B: fix18 - the same sequence fires with the planned 0.15", () => {
  assert.equal(race({ fixed: true }).lotAtFire.toFixed(2), "0.15");
});

// ---------- (C) source checks ----------
test("C1: OwnOrders ignores the transient market-type closing order", () => {
  const b = fnBody("int OwnOrders(ulong &tk[])");
  assert.match(b, /ORDER_TYPE_BUY\s*\|\|\s*ot==ORDER_TYPE_SELL\)\s*continue/);
});
test("C2: the reverse clean-up uses its own cooldown and never touches g_nextDelMs", () => {
  const b = fnBody("void ReverseArmPass(");
  assert.match(b, /g_revCleanMs/);
  const cleanup = b.slice(b.indexOf("only ONE opposite Stop order is kept") - 200, b.indexOf("only ONE opposite Stop order is kept") + 250);
  assert.ok(!/g_nextDelMs\s*=/.test(cleanup), "clean-up must not set g_nextDelMs");
});
test("C3: ReconcileSide - the generic delete cooldown does not block a REVERSE replacement and a failed one retries within 250 ms", () => {
  const b = fnBody("void ReconcileSide(");
  assert.match(b, /if\(!g_revCtx && GetTickCount64\(\)<g_nextDelMs\) return;/);
  assert.match(b, /g_nextDelMs=GetTickCount64\(\)\+\(g_revCtx\?250:2000\)/);
});
test("C4: a KEPT reverse order (lot unchanged) still stores its plan so its fill is booked as REVERSE_PREARM with the right risk / debt", () => {
  const b = fnBody("void ReverseArmPass(");
  const i = b.indexOf("ReconcileSide(revBuy,level,lot,true,keepT);");
  assert.ok(i > 0);
  const after = b.slice(i, i + 900);
  for (const k of ['GS("PAO"', 'GS("PAR"', 'GS("PAA"', 'GS("PCY"', 'GS("PLV"']) assert.ok(after.includes(k), k);
});
