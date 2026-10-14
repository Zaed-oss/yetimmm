// v4.18 deep scan: hostile / malformed payloads against EVERY Worker route. Expectations: never a 5xx, never a crash that kills later requests,
// no prototype pollution, and a genuine sign-in still works afterwards. Seeded PRNG = reproducible.
import test from "node:test";
import assert from "node:assert/strict";
import { boot, W } from "./harness.mjs";

let seed = (Number(process.env.FUZZ_SEED) || 0x9e3779b9) >>> 0;   // FUZZ_SEED=<n> npm test: run another random sequence
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const hv = (x, n) => String(x).replace(/[^\x20-\x7e]/g, "?").slice(0, n);   // headers can only carry printable ASCII: the CLIENT would refuse anything else
const pick = (a) => a[Math.floor(rnd() * a.length)];
const WEIRD = [null, undefined, true, false, 0, -1, 1.5, 1e308, -1e308, NaN, Infinity, "", " ", "0", "1".repeat(300), "<img src=x onerror=alert(1)>", "\u0000\u0001", "__proto__", "constructor", "../../etc/passwd", "ٱلْعَرَبِيَّة", "💥".repeat(50), [], {}, [[]], [{}], { __proto__: { polluted: 1 } }, JSON.parse('{"__proto__":{"polluted":"yes"}}'), JSON.parse('{"constructor":{"prototype":{"polluted":"yes"}}}'), Array(500).fill(1), { a: { b: { c: { d: { e: {} } } } } }];
const val = (d = 0) => (d > 2 || rnd() < 0.55 ? pick(WEIRD) : rnd() < 0.5 ? Array.from({ length: Math.floor(rnd() * 4) }, () => val(d + 1)) : Object.fromEntries(Array.from({ length: Math.floor(rnd() * 4) }, () => [pick(["state", "pos", "orders", "waits", "hist", "cmds", "ev", "sym", "price", "no", "ticket", "side", "key", "ids", "tz", "lang", "offsets", "event_id", "enabled", "cmd", "reset", "srv", "login", "cv", "cal", "calv", "tzo", "__proto__", "x"]), val(d + 1)])));
const stateLike = () => ({ price: pick([2400.5, ...WEIRD]), run: pick([true, false, ...WEIRD]), state: pick(["ARMED", "STOPPED", ...WEIRD]), pos: pick([null, { pid: val(), side: val(), entry: val(), no: val(), sl: val(), tp: val(), lot: val() }, ...WEIRD]), orders: pick([[], [{ ticket: val(), side: val(), price: val(), lot: val() }], ...WEIRD]), waits: pick([[], [{ side: val(), level: val() }], ...WEIRD]), hist: pick([[], [{ no: val(), side: val(), entry: val(), exit: val(), pnl: val(), ts: val(), reason: val() }], ...WEIRD]), cmds: pick([[], [{ id: val(), c: val(), ok: val(), st: val() }], ...WEIRD]), ev: pick([[], [{ id: val(), k: val() }], ...WEIRD]), sym: val(), tick: val(), pt: val(), maxDev: val() });

test("L1 fuzz: authenticated EA sync with hostile state never crashes the Worker nor poisons later answers", async () => {
  const b = boot(); await b.sync("123456");
  const sess = (await b.signIn()).j.sess;
  const bad = [];
  for (let i = 0; i < Number(process.env.FUZZ_N || 300); i++) {
    const body = { login: "123456", srv: pick(["Broker-Live", ...WEIRD]), state: stateLike(), ...(rnd() < 0.3 ? { reset: false } : {}), ...(rnd() < 0.3 ? { cv: val(), cal: val(), calv: pick(["abc", ...WEIRD]), tzo: val() } : {}), ...(rnd() < 0.2 ? { ev: val(), evack: val() } : {}) };
    const r = await b.call("/api/ea/sync", { body, headers: { "X-EA-Secret": b.eas["123456"] } });
    if (r.s >= 500) bad.push(["sync", r.s, JSON.stringify(body).slice(0, 160)]);
    if (i % 25 === 0) { const s = await b.state("123456", sess); if (s.s >= 500) bad.push(["state", s.s]); }
  }
  assert.deepEqual(bad.slice(0, 5), []);
  assert.equal(({}).polluted, undefined); assert.equal(Object.prototype.polluted, undefined);
  await b.sync("123456", { srv: "Broker-Live" });
  assert.ok([200, 401].includes((await b.state("123456", sess)).s));
  assert.equal((await b.signIn()).s, 200);
});

test("L2 fuzz: every app route with hostile bodies / headers returns 4xx (never 5xx) and leaves the service healthy", async () => {
  const b = boot(); await b.sync("123456", { state: { orders: [{ ticket: 777, side: "BUY", price: 2401, lot: 0.1 }], waits: [{ side: "BUY", level: 2400 }] } });
  const sess = (await b.signIn()).j.sess, h = b.auth("123456", sess);
  const routes = ["/login", "/verify", "/command", "/news/calendar", "/news/alert", "/news/notifs", "/news/read", "/news/pref", "/order-alert", "/state", "/api/ea/sync", "/admin/diag", "/tg/webhook", "/", "/nope"];
  const bad = [];
  for (let i = 0; i < Number(process.env.FUZZ_N || 400); i++) {
    const p = pick(routes), method = p === "/state" || p === "/" || p === "/admin/diag" ? "GET" : "POST";
    const headers = { ...(rnd() < 0.7 ? h : {}), ...(rnd() < 0.2 ? { "X-Login": hv(pick(WEIRD), 40) } : {}), ...(rnd() < 0.2 ? { "X-Session": hv(pick(WEIRD), 80) } : {}), ...(rnd() < 0.2 ? { "X-EA-Secret": "z".repeat(32), "X-EA-Pair": hv(pick(WEIRD), 30) } : {}) };
    let body; if (method === "POST") body = val();
    let r; try { r = await b.call(p, { method, headers, body }); } catch (e) { bad.push([p, "THROW " + e.message]); continue; }
    if (r.s >= 500) bad.push([p, r.s, JSON.stringify(body).slice(0, 120), JSON.stringify(Object.keys(headers))]);
  }
  assert.deepEqual(bad.slice(0, 5), []);
  assert.equal(({}).polluted, undefined);
  assert.equal((await b.state("123456", sess)).s, 200);
});

test("L3 raw malformed bodies: invalid JSON, truncated JSON, wrong content, oversized, binary-ish — handled without 5xx", async () => {
  const b = boot(); await b.sync("123456");
  const raws = ["", "{", "[", "null", "123", '"str"', "{\"login\":", "\u0000\u0000", "{".repeat(5000), '{"login":"123456","pw":' + "9".repeat(5000) + "}", "x".repeat(70000), '{"__proto__":{"polluted":1},"login":"123456"}'];
  for (const p of ["/login", "/verify", "/command", "/logout", "/news/alert", "/api/ea/sync"]) for (const raw of raws) {
    const r = await W.default.fetch(new Request("https://w" + p, { method: "POST", body: raw, headers: { "X-Login": "123456", "X-Session": "s".repeat(24), "X-EA-Secret": "k".repeat(32) } }), b.env);
    assert.ok(r.status < 500, p + " " + raw.slice(0, 20) + " -> " + r.status);
  }
  assert.equal(({}).polluted, undefined);
});
