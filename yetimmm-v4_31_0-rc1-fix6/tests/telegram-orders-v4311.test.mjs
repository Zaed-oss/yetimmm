// SOURCE tests for the Telegram order control (EA 2.45.1). They read Yetimmm.mq5 as text: they prove STRUCTURE, not that it compiles (F7 in MetaEditor).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const ea = readFileSync(new URL("../ea/Yetimmm.mq5", import.meta.url), "utf8");
const body = (name) => { const i = ea.indexOf(name); assert.ok(i >= 0, name + " exists"); return ea.slice(i, i + 4500); };

test("OrdersText lists waiting levels with trigger and remaining distance", () => {
  const b = body("string OrdersText()");
  assert.match(b, /WaitLevelNow\(b\)/);
  assert.match(b, /WaitTrigger\(b,lv\)/);
  assert.match(b, /WAITING FOR PRICE/);
  assert.match(b, /Remaining:/);
  assert.match(b, /No Pending Orders/);
});
test("forward declarations precede their first use", () => {
  for (const d of ["double WaitLevelNow(const bool buy);", "string ExecDeleteOrder(const ulong ticket,const string src);", "string ExecDeleteLevel(const bool isBuy,const string src);"]) {
    const decl = ea.indexOf(d); assert.ok(decl > 0, d); assert.ok(decl < ea.indexOf("string OrdersText()"), d + " before OrdersText");
  }
});
test("/del reuses the verified delete paths", () => {
  const b = body('else if(cmd=="/del")');
  assert.match(b, /ExecDeleteLevel\(w=="BUY","Telegram"\)/);
  assert.match(b, /ExecDeleteOrder\(tkd,"Telegram"\)/);
});
test("/mod validates through ApplyLevels and reports the real outcome", () => {
  const m = body("string ExecModifySide");
  assert.match(m, /ApplyLevels\(nb,ns,0\.0,src,er\)/);
  assert.match(m, /SideActual\(isBuy,tk,ap\)/);
  assert.match(m, /WaitLevelNow\(isBuy\)>0\.0/);
  assert.match(m, /g_state!=YT_ARMED/);
});
test("/del and /mod are duplicate-protected and listed in /help", () => {
  assert.match(ea, /cmd=="\/del" \|\| cmd=="\/mod"\);/);
  assert.match(ea, /\/del BUY\|SELL\|TICKET/);
  assert.match(ea, /\/mod BUY\|SELL PRICE/);
});
test("no new EA input and no market order was added", () => {
  const ins = body('else if(cmd=="/mod")');
  assert.doesNotMatch(ins, /OrderSend|trade\.Buy|trade\.Sell/);
});

