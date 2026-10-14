// v4.18: the client-side XSS helpers of app.js, extracted from the REAL file and executed in a sandbox.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const cut = (from, to) => { const a = app.indexOf(from), b = app.indexOf(to, a); assert.ok(a >= 0 && b > a, "marker " + from); return app.slice(a, b); };
const ctx = vm.createContext({ D: { hi: ["أهلاً {0}", "Hi {0}"] }, LG: 1 });
vm.runInContext("var LG=1;" + cut("const _e=x=>", "\nconst esc") .split("\n").slice(0, 2).join("\n").replace(/^const /, "var ") , ctx);
// helpers defined near f(): idn, _n, _sd, cleanState
vm.runInContext(cut("const idn=v=>", "const f=(v,d=2)").replace(/\bconst /g, "var "), ctx);
const run = (c) => vm.runInContext(c, ctx);

test("t(): dictionary text is kept, arguments and unknown keys are HTML-escaped", () => {
  assert.equal(run('t("hi","<img src=x onerror=alert(1)>")'), "Hi &lt;img src=x onerror=alert(1)&gt;");
  assert.equal(run('t("st_<script>alert(1)</script>")'), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(run('t("hi",5)'), "Hi 5");
});
test("idn(): only a non-negative integer is ever printed", () => {
  assert.equal(run('idn("<svg onload=1>")'), "0"); assert.equal(run("idn(-5)"), "0"); assert.equal(run("idn(123456789.9)"), "123456789"); assert.equal(run('idn("42")'), "42");
});
test("cleanState(): hostile pos.no / ticket / side / reason become numbers, enums and bounded text", () => {
  const d = run(`cleanState({pos:{no:"<b>1",pid:"x",side:"<i>",entry:"2400"},orders:[{ticket:"<svg onload=1>",side:"buy stop",price:"2401"},null],waits:[{side:"s<x>",level:"q"}],hist:[{no:"<u>",side:"SELL",reason:"<img src=x>"+"A".repeat(200)}]})`);
  assert.equal(d.pos.no, 0); assert.equal(d.pos.side, ""); assert.equal(d.pos.entry, 2400);
  assert.equal(d.orders.length, 1); assert.equal(d.orders[0].ticket, 0); assert.equal(d.orders[0].side, "BUY"); assert.equal(d.orders[0].price, 2401);
  assert.equal(d.waits[0].side, "SELL"); assert.equal(d.waits[0].level, 0);
  assert.equal(d.hist[0].no, 0); assert.ok(d.hist[0].reason.length <= 60);
});

test("cleanState(): an own __proto__ / constructor key can no longer replace the prototype of the app state", () => {
  const d = vm.runInContext(`cleanState(JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"x":1},"price":1}'))`, ctx);
  const S = Object.assign({}, d);
  assert.equal(S.polluted, undefined); assert.equal(Object.getPrototypeOf(S), Object.prototype);
});
