// v4.31.1 (EA 2.45.1): TP = the pair is finished -> the opposite pending order is deleted at once.
//   SOURCE - structure of Yetimmm.mq5 (NOT compiled or run here).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const ea = readFileSync(new URL("../ea/Yetimmm.mq5", import.meta.url), "utf8");
const fn = (head, next) => { const i = ea.indexOf(head); assert.ok(i > 0, head + " missing"); const j = ea.indexOf(next, i + head.length); assert.ok(j > i, next + " missing"); return ea.slice(i, j); };
const sweep = fn("void TpOppositeSweep(", "void OnTradeTransaction(");
const ots = fn("void OnTradeTransaction(", "int g_timerCount=0;");
const pcp = fn("bool ProcessClosedPosition(", "void CheckClosures()");

test("SOURCE TP sweep: runs from the closing-deal event for DEAL_REASON_TP of this EA's magic, before SyncAll", () => {
  const i = ots.indexOf("TpOppositeSweep(trans.deal)");
  assert.ok(i > 0);
  assert.ok(ots.slice(Math.max(0, i - 200), i).includes("DEAL_REASON)==DEAL_REASON_TP"));
  assert.ok(i < ots.indexOf("SyncAll();"), "the delete is not delayed by the synchronisation");
  assert.equal((ea.match(/TpOppositeSweep\(trans\.deal\)/g) || []).length, 1);
});

test("SOURCE TP sweep: never touches anything while an own position is open or REQUIRED_RECOVERY holds", () => {
  assert.ok(sweep.includes("g_recHold"));
  const pos = sweep.indexOf("OwnPositions(rp)>0");
  assert.ok(pos > 0 && pos < sweep.indexOf("DeleteOrder("), "open-position check comes first");
  assert.ok(sweep.includes("DeleteOrder(od[i]"), "uses the verified delete path (no new delete mechanism)");
  assert.ok(!/PositionClose|OrderSend|OrderOpen|BuyStop|SellStop/.test(sweep), "no order is created and no position is closed");
});

test("SOURCE TP booking path: leftover pending order is removed even if the event was missed (restart), before the cycle decision", () => {
  const i = pcp.indexOf('CleanupOrders("TP hit: the pair is finished');
  assert.ok(i > 0);
  assert.ok(/else if\(isTP\)/.test(pcp.slice(0, i)));
  assert.ok(i < pcp.indexOf("CycleMet(g_cycNet) && others==0"));
  assert.ok(pcp.slice(Math.max(0, i - 60), i).includes("if(others==0)"));
});

test("SOURCE cycle completion still cancels pending orders and waits for the user (unchanged)", () => {
  const c = fn("bool CycleTryComplete(", "void CycleCompletionTick()");
  assert.ok(c.includes("CleanupOrders("));
  assert.ok(ea.includes("g_state=YT_TP_RESET;"));
});
