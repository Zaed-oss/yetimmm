// v4.10: command lifecycle (Ops) extracted from the real index.html and executed in a sandbox.
// Proves the UI logic only (state machine). It does NOT prove MT5 executed anything: that needs a demo account (docs/MT5-TESTING.md).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const a = html.indexOf("const Ops={"), b = html.indexOf("const Bridge={");
assert.ok(a > 0 && b > a, "Ops block must exist in index.html");
const src = html.slice(a, b);

function make(state) {
  const toasts = [];
  const ctx = { S: state, toasts, toast: (m) => toasts.push(m), t: (k, ...x) => k + (x.length ? ":" + x.join("|") : ""), trEA: (x) => x, console };
  vm.createContext(ctx);
  vm.runInContext(src + "\nthis.Ops=Ops;", ctx);
  return ctx;
}
const mkS = () => ({ orders: [{ ticket: 11, side: "BUY", price: 1 }, { ticket: 12, side: "SELL", price: 0.5 }], waits: [], pos: null });

test("delete: row stays 'in progress' until the ticket really disappears AND the EA acked", () => {
  const c = make(mkS()), O = c.Ops;
  const o = O.add("delete", { ticket: 11, side: "BUY" });
  o.id = "abc";
  assert.equal(O.delTk(11), true);
  O.settle();
  assert.equal(O.delTk(11), true, "no verdict while the order is still reported by MT5");
  O.ack({ id: "abc", ok: true, text: "Deleted" });
  O.settle();
  assert.equal(O.delTk(11), true, "ack alone is not proof: the ticket is still listed");
  c.S.orders = c.S.orders.filter((x) => x.ticket !== 11);
  O.settle();
  assert.equal(O.delTk(11), false);
  assert.ok(c.toasts.includes("op_delOk"));
  assert.equal(O.log[0].ev, "verified");
});

test("delete: EA failure restores the row and shows a reason, no success toast", () => {
  const c = make(mkS()), O = c.Ops;
  const o = O.add("delete", { ticket: 12, side: "SELL" }); o.id = "x1";
  O.ack({ id: "x1", ok: false, text: "Order not found", cat: "user" });
  O.settle();
  assert.equal(O.delTk(12), false);
  assert.ok(c.toasts.some((m) => m.startsWith("❌ op_delFail")));
  assert.ok(!c.toasts.includes("op_delOk"));
});

test("delete: technical error text is never shown (generic message only)", () => {
  const c = make(mkS()), O = c.Ops;
  const o = O.add("delete", { ticket: 12, side: "SELL" }); o.id = "x2";
  O.ack({ id: "x2", ok: false, text: "", cat: "tech" });
  O.settle();
  assert.ok(c.toasts.some((m) => m === "❌ e_generic"));
});

test("delete: no confirmation within the timeout = 'unverified', never a fake success", () => {
  const c = make(mkS()), O = c.Ops;
  const o = O.add("delete", { ticket: 11 }); o.id = "t1"; o.at = Date.now() - 16000;
  O.settle();
  assert.equal(O.delTk(11), false);
  assert.ok(c.toasts.includes("❌ op_unver"));
  assert.ok(!c.toasts.includes("op_delOk"));
  assert.equal(O.log[0].ev, "unverified");
});

test("duplicate taps are rejected while the same delete is in flight", () => {
  const c = make(mkS()), O = c.Ops;
  assert.ok(O.add("delete", { ticket: 11 }));
  assert.equal(O.add("delete", { ticket: 11 }), null);
  assert.ok(O.add("delete", { ticket: 12 }), "a different order is independent");
});

test("a vanished order that became a position is reported as FILLED, not as deleted", () => {
  const c = make(mkS()), O = c.Ops;
  const o = O.add("delete", { ticket: 11 }); o.id = "f1"; o.at = Date.now() - 3000;
  c.S.orders = c.S.orders.filter((x) => x.ticket !== 11);
  c.S.pos = { ticket: 11, side: "BUY" };
  O.settle();
  assert.ok(c.toasts.includes("❌ op_filled"));
  assert.ok(!c.toasts.includes("op_delOk"));
});

test("waiting level (no ticket) is verified when it leaves S.waits", () => {
  const s = mkS(); s.waits = [{ side: "BUY", level: 1 }];
  const c = make(s), O = c.Ops;
  const o = O.add("delete", { side: "BUY" }); o.id = "w1"; o.at = Date.now() - 2000;
  O.settle();
  assert.equal(O.delSd("BUY"), true);
  c.S.waits = [];
  O.ack({ id: "w1", ok: true, text: "" });
  O.settle();
  assert.equal(O.delSd("BUY"), false);
  assert.ok(c.toasts.includes("op_delOk"));
});

test("generic command: EA ack settles it; silence times out as unverified", () => {
  const c = make(mkS()), O = c.Ops;
  const o = O.add("start"); o.id = "s1";
  O.ack({ id: "s1", ok: true, text: "Started" }); O.settle();
  assert.equal(O.active(), false);
  const o2 = O.add("stop"); o2.id = "s2"; o2.at = Date.now() - 13000; O.settle();
  assert.ok(c.toasts.includes("❌ op_unverG"));
});

test("snapshot never contains secrets (only cmd/id/age/ticket/side)", () => {
  const c = make(mkS()), O = c.Ops;
  O.add("apply", { buy: 1, sell: 2, pw: "secret" });
  const j = JSON.stringify(O.snapshot());
  assert.ok(!/secret|X-Session|token/i.test(j));
});

test("index.html wiring: single-flight login, queued pull, stable dash render, bounded logout", () => {
  assert.match(html, /if\(this\.busy\|\|\$\("lgGo"\)\.disabled\)return/);
  assert.match(html, /if\(this\.busy\)\{this\.again=true;return\}/);
  assert.match(html, /function setDash\(h\)\{if\(h===_dashH\)return/);
  assert.match(html, /SES\.clr\(\);\s+\/\* no usable session/);
  assert.match(html, /AbortController\(\),tm=setTimeout\(\(\)=>ac\.abort\(\),2500\)/);
});
