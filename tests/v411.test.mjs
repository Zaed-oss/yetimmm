// v4.11 static/behaviour tests: logout honesty, EA keyboard gate, animation hooks. Not a compile and not an MT5 run.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const rd = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
const html = rd("index.html"), ea = rd("ea/Yetimmm.mq5"), js = rd("anim/yt-anim.js");

// extract Login.out and run it with fakes
const a = html.indexOf("async out(call,msg){"), b = html.indexOf("msg(){let m=");
assert.ok(a > 0 && b > a);
const body = html.slice(a, b).replace(/,\s*$/, "");
function run(call, fetchImpl) {
  const store = {}, cleared = [], notes = [];
  const ctx = {
    Login: null, SES: { l: "123", s: "tok", clr: () => cleared.push(1) }, CONFIG: { api: { baseUrl: "https://x" } },
    sessionStorage: { setItem: (k, v) => (store[k] = v) }, Ops: { note: (...x) => notes.push(x) },
    AbortController, setTimeout, clearTimeout, fetch: fetchImpl, location: { reload: () => (store.reloaded = true) },
  };
  vm.createContext(ctx);
  vm.runInContext("Login={" + body + "}", ctx);
  return ctx.Login.out(call).then(() => ({ store, cleared, notes }));
}

test("logout OK: local session cleared, success message, page reloads", async () => {
  const r = await run(true, async () => ({ ok: true, status: 200 }));
  assert.equal(r.cleared.length, 1); assert.equal(r.store.ytMsg, "out_ok"); assert.equal(r.store.reloaded, true);
});
test("logout: server error -> honest warning, local session still cleared", async () => {
  const r = await run(true, async () => ({ ok: false, status: 500 }));
  assert.equal(r.cleared.length, 1); assert.equal(r.store.ytMsg, "out_warn"); assert.equal(r.notes[0][1], "revoke_unconfirmed");
});
test("logout: network failure -> honest warning, never a fake success", async () => {
  const r = await run(true, async () => { throw new Error("net"); });
  assert.equal(r.cleared.length, 1); assert.equal(r.store.ytMsg, "out_warn");
});
test("logout: 401 (already invalid) counts as success", async () => {
  const r = await run(true, async () => ({ ok: false, status: 401 }));
  assert.equal(r.store.ytMsg, "out_ok");
});
test("forced logout (expired session) keeps its own message and makes no server call", async () => {
  let called = 0; const r = await run(false, async () => { called++; return { ok: true }; });
  assert.equal(called, 0); assert.equal(r.cleared.length, 1);
});
test("both new messages exist in the dictionary (ar/en)", () => {
  assert.match(html, /D\.out_ok=\["[^"]+","[^"]+"\]/); assert.match(html, /D\.out_warn=\["[^"]+","[^"]+"\]/);
});
test("EA: default keyboard is opt-in, /menu and commands remain", () => {
  assert.match(ea, /input\s+bool\s+InpTgMenu\s*=\s*false/);
  assert.match(ea, /string MenuMarkup\(\)\s*\{\s*return InpTgMenu \? MenuKeyboard\(\) : "";/);
  for (const c of ["/start", "/stop", "/cancel", "/status", "/history", "/stats", "/settings", "/menu", "/help"]) assert.ok(ea.includes('cmd=="' + c + '"'), c);
});
test("animation: robot/logo keep every hook the CSS/state machine uses", () => {
  for (const k of ["bulb", "eyes", "ey", "m-s", "m-f", "m-o", "m-d", "rg", "pt", "bd", "bi-ok", "bi-x", "bi-bolt", "bi-z", "lb1", "lb2", "lb3", "lln", "ldot"]) assert.ok(js.includes(k), k);
  assert.ok(rd("anim/yt-anim.css").includes("prefers-reduced-motion"));
});
