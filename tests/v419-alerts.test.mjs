// v4.19: the chat shows ORDERS and ALERTS only; arming an alert is confirmed in the chat; the fired alert shows the target that was reached.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot } from "./harness.mjs";

const ord = (ticket, side, price) => ({ ticket, side, price, lot: 0.1, sl: side.startsWith("B") ? 4137 : 4138, tp: side.startsWith("B") ? 4158 : 4117 });
const base = { price: 4138, orders: [], waits: [], pos: null, hist: [], tick: 0.01, pt: 0.01, maxDev: 30, sym: "XAUUSD" };

async function rig(extra = {}) {
  const b = boot({ BOT_TOKEN: "", ADMIN_KEY: "adm", ...extra });
  await b.sync("123456", { state: { ...base, orders: [ord(111, "BUY STOP", 4138), ord(112, "SELL STOP", 4137)] } });
  const h = b.auth("123456", (await b.signIn()).j.sess);
  const notifs = async () => (await b.call("/news/notifs", { headers: h, body: { limit: 50 } })).j.items || [];
  return { b, h, notifs };
}
// EA events are delivered under uid "ea<login>": read what the Notify engine recorded (= what was pushed to the chat)
const chatOf = async (b) => { const out = []; for (const o of b.env.NOTIFY.inst.values()) for (const [, v] of await o.__st.list({ prefix: "h:ea123456:" })) out.push(v); return out; };
const ev = (n, t, body = "x") => ({ id: `123456:1:${n}`, k: "ev", t, b: body });

test("arming an order alert posts 'Alert Enabled' to the chat with the order details; pressing it twice does not repeat", async () => {
  const r = await rig();
  assert.equal((await r.b.call("/order-alert", { headers: r.h, body: { key: "t111", enabled: true } })).j.ok, true);
  await r.b.call("/order-alert", { headers: r.h, body: { key: "t111", enabled: true } });
  const n = (await r.notifs()).filter((x) => /Alert Enabled/.test(x.title));
  assert.equal(n.length, 1);
  assert.match(n[0].body, /BUY XAUUSD @ 4138/); assert.match(n[0].body, /SL 4137/); assert.match(n[0].body, /TP 4158/);
});

test("cancelling an armed alert is confirmed; cancelling a non-armed one is silent; re-arming is announced again", async () => {
  const r = await rig();
  const call = (enabled) => r.b.call("/order-alert", { headers: r.h, body: { key: "t111", enabled } });
  await call(false);
  assert.equal((await r.notifs()).length, 0);
  await call(true); await call(false); await call(true);
  const t = (await r.notifs()).map((x) => x.title);
  assert.equal(t.filter((x) => /Alert Enabled/.test(x)).length, 2);
  assert.equal(t.filter((x) => /Alert Cancelled/.test(x)).length, 1);
});

test("the fired alert shows the target that was reached, entry, SL and TP", async () => {
  const r = await rig();
  await r.b.call("/order-alert", { headers: r.h, body: { key: "t111", enabled: true } });
  for (let i = 0; i < 3; i++) await r.b.sync("123456", { state: { ...base, pos: { side: "BUY", entry: 4138.1, sl: 4137, tp: 4158, lot: 0.1, no: 1, pid: 111, profit: 0 }, orders: [] } });
  const n = (await r.notifs()).filter((x) => /Order Activated/.test(x.title));
  assert.equal(n.length, 1);
  assert.match(n[0].body, /Target reached[^\n]*4138\b/); assert.match(n[0].body, /Entry: 4138\.1/); assert.match(n[0].body, /SL: 4137/); assert.match(n[0].body, /TP: 4158/);
});

test("the chat carries order events but NOT technical problems; problems are acknowledged and kept in diagnostics", async () => {
  const r = await rig();
  const list = [
    ev(1, "📌 BUY STOP PLACED", "Ticket: #1"), ev(2, "🟢 BUY ACTIVATED", "Entry 4138"), ev(3, "🔴 STOP LOSS", "x"), ev(4, "🟢 TAKE PROFIT", "x"),
    ev(5, "✏️ SELL MODIFIED", "x"), ev(6, "🔴 EMERGENCY CLOSE (no SL/TP protection)", "x"),
    ev(7, "⚠️ MODIFY FAILED (BUY): retcode 10016"), ev(8, "⚠️ Order rejected (NOT PLACED) (Buy Stop 4138)"), ev(9, "⚠️ Connection Lost: no new orders"),
    ev(10, "⚠️ Market reversal NOT sent (pre-flight): spread"), ev(11, "🔌 CONNECTION RESTORED"), ev(12, "⚙️ SETTINGS UPDATED (panel)"), ev(13, "🚫 UNAUTHORIZED TELEGRAM ACCESS ATTEMPT"),
  ];
  const s = await r.b.sync("123456", { ev: list });
  assert.equal(s.j.evack.length, 13, "every event is acknowledged so the EA never re-sends the muted ones");
  const titles = (await chatOf(r.b)).map((x) => x.title).join("\n");
  for (const ok of ["BUY STOP PLACED", "BUY ACTIVATED", "STOP LOSS", "TAKE PROFIT", "SELL MODIFIED", "EMERGENCY CLOSE"]) assert.match(titles, new RegExp(ok));
  for (const bad of ["MODIFY FAILED", "NOT PLACED", "Connection Lost", "reversal NOT sent", "CONNECTION RESTORED", "SETTINGS UPDATED", "UNAUTHORIZED"]) assert.doesNotMatch(titles, new RegExp(bad, "i"));
  const d = await r.b.call("/admin/diag", { method: "GET", headers: { "X-Login": "123456", "X-Admin-Key": "adm" } });
  assert.ok(d.j.diag.filter((x) => x.src === "ea-notice").length >= 7);
});

test("CHAT_PROBLEMS=1 restores the old behaviour (everything is pushed)", async () => {
  const r = await rig({ CHAT_PROBLEMS: "1" });
  await r.b.sync("123456", { ev: [ev(1, "⚠️ MODIFY FAILED (BUY): retcode 10016")] });
  assert.match((await chatOf(r.b)).map((x) => x.title).join("\n"), /MODIFY FAILED/);
});
