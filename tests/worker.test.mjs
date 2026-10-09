import test from "node:test";
import assert from "node:assert/strict";
import { ns } from "./mock-cf.mjs";

const W = await import("../worker/worker.js");
const BOOT_SECRET = "e".repeat(32);      // what a fresh EA generates locally before the Worker mints the real one
const PAIR = "pair-Code-7788";

// boot() models the REAL EA protocol (v4.6): the first sync of an account presents the pairing code, the Worker mints the secret (es),
// the EA stores it and uses it from then on. `eas` = the secret each simulated EA currently holds, per account.
function boot(extra = {}) {
  const env = { BOT_TOKEN: "123:ABC", APP_PASSWORD: "S3cret-pass", PAIR_CODE: PAIR, REQUIRE_TG: "0", ...extra };
  env.HUB = ns(W.Hub, env);
  env.NOTIFY = ns(W.Notify, env);
  const eas = {};
  const call = async (path, { method = "POST", body, headers = {} } = {}) => {
    const r = await W.default.fetch(new Request("https://w" + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers }), env);
    return { s: r.status, j: await r.json().catch(() => null), h: r.headers };
  };
  const STATE = { price: 2400.5, run: false, state: "STOPPED", hist: [], orders: [], waits: [], tick: 0.01, pt: 0.01, maxDev: 30 };
  const sync = async (login, body = {}, opt = {}) => {
    const headers = { "X-EA-Secret": eas[login] || BOOT_SECRET };
    if (!eas[login] && opt.pair !== false) headers["X-EA-Pair"] = opt.pair || PAIR;
    const r = await call("/api/ea/sync", { body: { login, srv: "Broker-Live", state: { ...STATE, ...(body.state || {}) }, ...body, ...(body.state ? { state: { ...STATE, ...body.state } } : {}) }, headers });
    if (r.j && r.j.es) eas[login] = r.j.es;
    return r;
  };
  const signIn = async (login = "123456", pw = "S3cret-pass") => call("/login", { body: { login, pw } });
  const auth = (login, sess) => ({ "X-Login": login, "X-Session": sess });
  const hubOf = (login) => env.HUB.get("acc-" + login).__o;
  return { env, call, sync, signIn, auth, eas, hubOf };
}

test("root endpoint reports the service", async () => {
  const { call } = boot();
  const r = await call("/", { method: "GET" });
  assert.equal(r.s, 200); assert.equal(r.j.service, "yetimmm-bridge");
});

test("login is refused (fail closed) when no password is configured", async () => {
  const { call } = boot({ APP_PASSWORD: "" });
  const r = await call("/login", { body: { login: "123456", pw: "" } });
  assert.equal(r.s, 503); assert.equal(r.j.error, "not_configured");
});

test("EA offline: correct password is rejected with ea_offline and NEVER counts toward the lock", async () => {
  const { signIn } = boot();
  let r;
  for (let i = 0; i < 12; i++) r = await signIn();
  assert.equal(r.s, 503); assert.equal(r.j.error, "ea_offline");
});

test("full flow: sync -> login -> state -> command -> verify -> logout", async () => {
  const { sync, signIn, call, auth } = boot();
  assert.equal((await sync("123456")).j.ok, true);
  const l = await signIn(); assert.equal(l.s, 200); assert.ok(l.j.sess);
  const h = auth("123456", l.j.sess);
  const st = await call("/state", { method: "GET", headers: h }); assert.equal(st.s, 200); assert.equal(st.j.price, 2400.5); assert.equal(st.j.eaOnline, true);
  const c = await call("/command", { headers: h, body: { cmd: "apply", buy: 2410, sell: 2400, risk: 5, rr: 20 } });
  assert.equal(c.s, 200); assert.ok(c.j.id);
  const q = await sync("123456");
  assert.equal(q.j.commands.length, 1); assert.equal(q.j.commands[0].cmd, "apply"); assert.equal(q.j.commands[0].buy, 2410);
  const q2 = await sync("123456", { ack: [c.j.id] }); assert.equal(q2.j.commands.length, 0);
  const v = await call("/verify", { headers: h, body: {} }); assert.equal(v.j.checks.session, true); assert.equal(v.j.checks.bot, true);
  assert.equal((await call("/logout", { headers: h })).j.ok, true);
  assert.equal((await call("/state", { method: "GET", headers: h })).s, 401);
});

test("wrong password: remaining attempts are reported, 8th failure locks for 120 s", async () => {
  const { sync, signIn } = boot();
  await sync("123456");
  let r;
  for (let i = 1; i <= 8; i++) r = await signIn("123456", "bad" + i);
  assert.equal(r.s, 429); assert.equal(r.j.error, "locked"); assert.ok(r.j.retry > 100 && r.j.retry <= 120);
  const again = await signIn(); assert.equal(again.s, 429);          // even the right password waits for the lock to end
});

test("a correct login resets the failed-attempt counter", async () => {
  const { sync, signIn } = boot();
  await sync("123456");
  for (let i = 0; i < 5; i++) await signIn("123456", "nope");
  assert.equal((await signIn()).s, 200);
  let r; for (let i = 0; i < 7; i++) r = await signIn("123456", "nope");
  assert.equal(r.s, 401);                                              // 7 new failures: still not locked
});

test("changing the password kills old sessions (bound to a password fingerprint)", async () => {
  const b = boot();
  await b.sync("123456");
  const l = await b.signIn(); const h = b.auth("123456", l.j.sess);
  assert.equal((await b.call("/state", { method: "GET", headers: h })).s, 200);
  const hub = [...b.env.HUB.inst.values()].find((o) => o.__st.m.get("acc"));
  hub.c.password = "a-brand-new-password";                             // what a redeploy with a new APP_PASSWORD does
  const r = await b.call("/state", { method: "GET", headers: h });
  assert.equal(r.s, 401); assert.equal(r.j.why, "pw");
});

test("SESSION_EPOCH bump signs everybody out", async () => {
  const b = boot();
  await b.sync("123456");
  const l = await b.signIn(); const h = b.auth("123456", l.j.sess);
  const hub = [...b.env.HUB.inst.values()].find((o) => o.__st.m.get("acc"));
  hub.c.epoch = "2";
  const r = await b.call("/state", { method: "GET", headers: h });
  assert.equal(r.s, 401); assert.equal(r.j.why, "revoked");
});

test("commands are validated", async () => {
  const b = boot();
  await b.sync("123456");
  const h = b.auth("123456", (await b.signIn()).j.sess);
  assert.equal((await b.call("/command", { headers: h, body: { cmd: "format_disk" } })).s, 400);
  assert.equal((await b.call("/command", { headers: h, body: { cmd: "apply", buy: "abc" } })).s, 400);
  assert.equal((await b.call("/command", { headers: h, body: { cmd: "place", side: "SIDEWAYS", price: 1 } })).s, 400);
  assert.equal((await b.call("/command", { headers: h, body: { cmd: "modify", ticket: 5 } })).s, 400);       // price required
  assert.equal((await b.call("/command", { headers: h, body: { cmd: "place", side: "buy", price: 2500 } })).s, 200);
});

test("another EA cannot hijack an account (secret mismatch)", async () => {
  const b = boot();
  await b.sync("123456");
  const r = await b.call("/api/ea/sync", { body: { login: "123456", state: {} }, headers: { "X-EA-Secret": "z".repeat(32) } });
  assert.equal(r.s, 401);
});

test("invalid logins and unknown routes", async () => {
  const b = boot();
  assert.equal((await b.call("/login", { body: { login: "abc", pw: "x" } })).s, 400);
  assert.equal((await b.call("/state", { method: "GET" })).s, 401);
  assert.equal((await b.call("/nope", { method: "GET" })).s, 404);
});

test("oversized bodies are rejected", async () => {
  const b = boot();
  assert.equal((await b.call("/login", { body: { login: "123456", pw: "x".repeat(20000) } })).s, 413);
});

test("CORS: restricted origin is honoured", async () => {
  const b = boot({ ALLOWED_ORIGIN: "https://me.github.io" });
  const r = await b.call("/", { method: "GET", headers: { Origin: "https://evil.example" } });
  assert.equal(r.h.get("Access-Control-Allow-Origin"), "https://me.github.io");
  const ok = await b.call("/", { method: "GET", headers: { Origin: "https://me.github.io" } });
  assert.equal(ok.h.get("Access-Control-Allow-Origin"), "https://me.github.io");
});

test("notifications: dedupe, list, and mark-all-read with more than 128 items", async () => {
  const b = boot({ BOT_TOKEN: "" });
  const n = b.env.NOTIFY.get("main");
  const post = async (p, body) => (await n.fetch("https://n" + p, { method: "POST", body: JSON.stringify(body) })).json();
  assert.equal((await post("/emit", { uid: "a1", title: "x", event_id: "e0", alert_type: "n0" })).ok, true);
  assert.equal((await post("/emit", { uid: "a1", title: "x", event_id: "e0", alert_type: "n0" })).dup, true);   // same trigger twice = once
  for (let i = 1; i < 150; i++) await post("/emit", { uid: "a1", title: "t" + i, event_id: "e" + i, alert_type: "n0" });
  const l = await post("/notifs", { uid: "a1", limit: 100 });
  assert.equal(l.items.length, 100);
  assert.equal((await post("/read", { uid: "a1", all: true })).ok, true);
  assert.equal((await post("/notifs", { uid: "a1", limit: 100 })).unread, 0);
});

test("MT5 calendar feed: EA pushes rows, calendar serves them with Actual", async () => {
  const b = boot();
  const soon = Math.floor(Date.now() / 1000) + 3600;
  const rows = [{ t: "Non-Farm Payrolls", c: "USD", s: soon, m: "high", p: "150K", f: "180K", a: "" }];
  const r = await b.sync("123456", { tzo: 10800, calv: "abc123", cal: rows });
  assert.equal(r.j.ok, true);
  await b.sync("123456");
  const sess = (await b.signIn()).j.sess;
  const cal = await b.call("/news/calendar", { headers: b.auth("123456", sess), body: {} });
  assert.equal(cal.s, 200); assert.equal(cal.j.events.length, 1); assert.equal(cal.j.events[0].title, "Non-Farm Payrolls");
  assert.equal(cal.j.market_off, 10800); assert.equal(cal.j.has_actual, true);
});

// ═════════════ v4.6 — audit fixes ═════════════

test("PAIRING: a stranger who syncs first cannot take the account (no code -> 403, wrong code -> 403)", async () => {
  const b = boot();
  const r1 = await b.call("/api/ea/sync", { body: { login: "123456", state: {} }, headers: { "X-EA-Secret": "f".repeat(32) } });
  assert.equal(r1.s, 403); assert.equal(r1.j.error, "pair_required");
  const r2 = await b.call("/api/ea/sync", { body: { login: "123456", state: {} }, headers: { "X-EA-Secret": "f".repeat(32), "X-EA-Pair": "guess" } });
  assert.equal(r2.s, 403); assert.equal(r2.j.error, "pair_bad");
  const real = await b.sync("123456");                              // the genuine EA still gets in afterwards
  assert.equal(real.s, 200); assert.ok(real.j.es && real.j.es.length === 64); assert.equal(real.j.paired, true);
});

test("PAIRING: wrong codes lock the account's pairing after PAIR_MAX_FAILS, a bound EA keeps syncing", async () => {
  const b = boot({ PAIR_MAX_FAILS: "3" });
  await b.sync("123456");                                           // bound with the minted secret
  let r;
  for (let i = 0; i < 3; i++) r = await b.call("/api/ea/sync", { body: { login: "123456", state: {} }, headers: { "X-EA-Secret": "a".repeat(32), "X-EA-Pair": "bad" + i } });
  assert.equal(r.s, 403);
  const locked = await b.call("/api/ea/sync", { body: { login: "123456", state: {} }, headers: { "X-EA-Secret": "a".repeat(32), "X-EA-Pair": PAIR } });
  assert.equal(locked.s, 429); assert.equal(locked.j.error, "pair_locked");   // even the right code waits while locked
  assert.equal((await b.sync("123456")).s, 200);                    // the legitimate EA (valid secret) is never affected by the lock
});

test("PAIRING: the minted secret is stored only as a hash; the old secret dies when the account is re-paired (reinstall recovery)", async () => {
  const b = boot();
  const first = await b.sync("123456"), s1 = first.j.es;
  const raw = JSON.stringify([...b.hubOf("123456").__st.m.values()]);
  assert.ok(!raw.includes(s1), "the raw EA secret must never be persisted");
  assert.equal((await b.sync("123456")).s, 200);                    // normal syncs: secret only, no code, no rotation
  assert.equal((await b.sync("123456")).j.es, undefined);
  // EA reinstalled: its config file is gone, it has a NEW local secret but still knows the code
  const re = await b.call("/api/ea/sync", { body: { login: "123456", state: {} }, headers: { "X-EA-Secret": "9".repeat(32), "X-EA-Pair": PAIR } });
  assert.equal(re.s, 200); assert.ok(re.j.es && re.j.es !== s1);
  b.eas["123456"] = re.j.es;
  const old = await b.call("/api/ea/sync", { body: { login: "123456", state: {} }, headers: { "X-EA-Secret": s1 } });
  assert.equal(old.s, 401);                                         // the previous secret is revoked
});

test("PAIRING: a v4.5 account (raw secret stored) keeps working and is upgraded to a hash + server-minted secret", async () => {
  const b = boot();
  const legacy = "L".repeat(32);
  await b.hubOf("123456").ctx.storage.put("acc", { sessions: [], tg: [], cfgv: 0, eaSecret: legacy });
  const r = await b.call("/api/ea/sync", { body: { login: "123456", state: {} }, headers: { "X-EA-Secret": legacy } });
  assert.equal(r.s, 200);
  const acc = b.hubOf("123456").__st.m.get("acc");
  assert.equal(acc.eaSecret, undefined); assert.ok(acc.eaSecretH);   // raw secret gone after the first good sync
  const up = await b.call("/api/ea/sync", { body: { login: "123456", state: {} }, headers: { "X-EA-Secret": legacy, "X-EA-Pair": PAIR } });
  assert.equal(up.s, 200); assert.ok(up.j.es);                      // presenting the code upgrades it to a CSPRNG secret
});

test("STALE: the server is the single source of the offline timeout (/state and sync both report it)", async () => {
  const b = boot({ EA_STALE_SEC: "25" });
  const s = await b.sync("123456"); assert.equal(s.j.staleSec, 25);
  const h = b.auth("123456", (await b.signIn()).j.sess);
  const st = await b.call("/state", { method: "GET", headers: h });
  assert.equal(st.j.eaStaleSec, 25); assert.equal(st.j.eaOnline, true);
});

test("SLIDING SESSION: authenticated activity (state / command / news) extends the session, idle time does not", async () => {
  const b = boot();
  await b.sync("123456");
  const sess = (await b.signIn()).j.sess, h = b.auth("123456", sess), hub = b.hubOf("123456");
  hub.c.sessMs = 30 * 86400000; hub.c.touchMs = 0;                  // touch on every request for the test
  const age = (d) => { const acc = hub.__st.m.get("acc"); acc.sessions[acc.sessions.length - 1].t = Date.now() - d * 86400000; };
  const t0 = () => hub.__st.m.get("acc").sessions.slice(-1)[0].t;
  age(29);                                                          // 29 days old: about to expire
  assert.equal((await b.call("/state", { method: "GET", headers: h })).s, 200);
  assert.ok(Date.now() - t0() < 5000, "/state must slide the session");
  age(29); assert.equal((await b.call("/command", { headers: h, body: { cmd: "stop" } })).s, 200); assert.ok(Date.now() - t0() < 5000, "/command must slide it");
  age(29); assert.equal((await b.call("/news/calendar", { headers: h, body: {} })).s, 200); assert.ok(Date.now() - t0() < 5000, "/news must slide it");
  age(31); assert.equal((await b.call("/state", { method: "GET", headers: h })).s, 401);   // really idle for > 30 days: expired
});

test("SLIDING SESSION: writes are throttled (touch window) so /state polling never hammers storage", async () => {
  const b = boot();
  await b.sync("123456");
  const h = b.auth("123456", (await b.signIn()).j.sess), hub = b.hubOf("123456");
  let puts = 0; const orig = hub.ctx.storage.put.bind(hub.ctx.storage); hub.ctx.storage.put = async (...a) => { if (a[0] === "acc") puts++; return orig(...a); };
  for (let i = 0; i < 20; i++) await b.call("/state", { method: "GET", headers: h });
  assert.equal(puts, 0);
});

test("NEWS SHARDS: two broker servers keep separate calendars / time offsets; NEWS_SCOPE=global restores the single shard", async () => {
  const soon = Math.floor(Date.now() / 1000) + 3600;
  const rowA = [{ t: "Broker A event", c: "USD", s: soon, m: "high", p: "1", f: "2", a: "" }], rowB = [{ t: "Broker B event", c: "USD", s: soon, m: "high", p: "1", f: "2", a: "" }];
  const b = boot();
  await b.sync("111111", { srv: "BrokerA-Live", tzo: 7200, calv: "aaa1", cal: rowA });
  await b.sync("222222", { srv: "BrokerB-Live", tzo: 10800, calv: "bbb1", cal: rowB });
  await b.sync("111111", { srv: "BrokerA-Live" }); await b.sync("222222", { srv: "BrokerB-Live" });
  const la = (await b.signIn("111111")).j.sess, lb = (await b.signIn("222222")).j.sess;
  const ca = await b.call("/news/calendar", { headers: b.auth("111111", la), body: {} });
  const cb = await b.call("/news/calendar", { headers: b.auth("222222", lb), body: {} });
  assert.deepEqual(ca.j.events.map((e) => e.title), ["Broker A event"]); assert.equal(ca.j.market_off, 7200);
  assert.deepEqual(cb.j.events.map((e) => e.title), ["Broker B event"]); assert.equal(cb.j.market_off, 10800);
  const g = boot({ NEWS_SCOPE: "global" });
  await g.sync("111111", { srv: "BrokerA-Live", tzo: 7200, calv: "aaa1", cal: rowA });
  await g.sync("222222", { srv: "BrokerB-Live", tzo: 10800, calv: "bbb1", cal: rowB });
  assert.equal(g.env.NOTIFY.inst.size, 1);                           // legacy behaviour: one shared shard
  assert.ok(b.env.NOTIFY.inst.size >= 2);
});

test("CORS: several origins (comma separated) and a trailing slash are accepted", async () => {
  const b = boot({ ALLOWED_ORIGIN: "https://a.github.io/, https://b.github.io" });
  const a = await b.call("/", { method: "GET", headers: { Origin: "https://a.github.io" } });
  assert.equal(a.h.get("Access-Control-Allow-Origin"), "https://a.github.io");
  const c = await b.call("/", { method: "GET", headers: { Origin: "https://b.github.io" } });
  assert.equal(c.h.get("Access-Control-Allow-Origin"), "https://b.github.io");
  // v4.6.1: fail-closed by default; "*" is an explicit, testing-only opt-in
  const none = await boot().call("/", { method: "GET", headers: { Origin: "https://evil.example" } });
  assert.equal(none.j.corsOpen, false); assert.equal(none.j.corsConfigured, false);
  assert.equal(none.h.get("Access-Control-Allow-Origin"), "null");
  const open = await boot({ ALLOWED_ORIGIN: "*" }).call("/", { method: "GET" }); assert.equal(open.j.corsOpen, true);
});

// ───────── order-activation alerts over the REAL cycle (gold 4138 / 4137) ─────────
const ord = (ticket, side, price) => ({ ticket, side, price, lot: 0.1, sl: side.startsWith("B") ? 4137 : 4138, tp: side.startsWith("B") ? 4158 : 4117 });
const base = { price: 4138, orders: [], waits: [], pos: null, hist: [], tick: 0.01, pt: 0.01, maxDev: 30, sym: "XAUUSD" };
async function cycleRig() {
  const b = boot({ BOT_TOKEN: "" });
  await b.sync("123456", { state: { ...base, orders: [ord(111, "BUY STOP", 4138), ord(112, "SELL STOP", 4137)] } });
  const h = b.auth("123456", (await b.signIn()).j.sess);
  const arm = (key) => b.call("/order-alert", { headers: h, body: { key, enabled: true } });
  const push = async (state, n = 3) => { for (let i = 0; i < n; i++) await b.sync("123456", { state: { ...base, ...state } }); };   // the watcher needs 3 consecutive syncs to call an order "gone"
  const notifs = async () => (await b.call("/news/notifs", { headers: h, body: { limit: 50 } })).j.items || [];
  return { b, h, arm, push, notifs };
}

test("ALERT CYCLE: Buy fills (position id = order ticket) -> ONE 'activated'; the deleted opposite Sell Stop alert stays silent", async () => {
  const r = await cycleRig();
  assert.equal((await r.arm("t111")).j.ok, true); assert.equal((await r.arm("t112")).j.ok, true);
  await r.push({ pos: { side: "BUY", entry: 4138.12, sl: 4137, tp: 4158, lot: 0.1, no: 1, pid: 111, profit: 0 }, orders: [] });   // slipped fill + opposite deleted
  const n = (await r.notifs()).filter((x) => /Activated|تفعيل/.test(x.title));
  assert.equal(n.length, 1); assert.match(n[0].body, /BUY/);
  const st = await r.b.call("/state", { method: "GET", headers: r.h });
  const keys = Object.fromEntries(st.j.oalerts.map((o) => [o.key, o.status]));
  assert.equal(keys.t111, "fired"); assert.equal(keys.t112, undefined);   // sell alert is "gone" (cancelled), never "fired"
});

test("ALERT CYCLE: a MANUAL trade near the level (old 0.1% tolerance = 4.1 USD) must NOT fire the alert of a cancelled order", async () => {
  const r = await cycleRig();
  await r.arm("t111");
  await r.push({ pos: { side: "BUY", entry: 4134.0, sl: 4130, tp: 4180, lot: 1, no: 9, pid: 9999, profit: 0 }, orders: [ord(112, "SELL STOP", 4137)] });   // order 111 removed; someone opened a BUY 4 USD lower
  assert.equal((await r.notifs()).filter((x) => /Activated|تفعيل/.test(x.title)).length, 0);
});

test("ALERT CYCLE: without a position id (older EA) the match is symbol-tight: 3 ticks / Max Deviation, not 0.1%", async () => {
  const r = await cycleRig();
  await r.arm("t111");
  await r.push({ pos: { side: "BUY", entry: 4134.0, sl: 4130, tp: 4180, lot: 1, no: 9, profit: 0 }, orders: [] });           // 4 USD away -> not this order
  assert.equal((await r.notifs()).filter((x) => /Activated|تفعيل/.test(x.title)).length, 0);
  const r2 = await cycleRig();
  await r2.arm("t111");
  await r2.push({ pos: { side: "BUY", entry: 4138.25, sl: 4137, tp: 4158, lot: 0.1, no: 1, profit: 0 }, orders: [] });       // 0.25 slippage <= 30 pts * 0.01
  assert.equal((await r2.notifs()).filter((x) => /Activated|تفعيل/.test(x.title)).length, 1);
});

test("ALERT CYCLE: full loop Buy -> SL -> re-armed Sell Stop -> Sell fills -> TP: one alert per armed order, none duplicated across syncs", async () => {
  const r = await cycleRig();
  await r.arm("t111");
  await r.push({ pos: { side: "BUY", entry: 4138, sl: 4137, tp: 4158, lot: 0.1, no: 1, pid: 111, profit: 0 }, orders: [] });
  await r.push({ pos: null, orders: [ord(113, "SELL STOP", 4137)], hist: [{ no: 1, side: "BUY", entry: 4138, exit: 4137, profit: -1 }] });     // SL hit, Sell Stop re-armed
  assert.equal((await r.arm("t113")).j.ok, true);
  await r.push({ pos: { side: "SELL", entry: 4136.9, sl: 4138, tp: 4115, lot: 0.1, no: 2, pid: 113, profit: 0 }, orders: [], hist: [{ no: 1, side: "BUY", entry: 4138, exit: 4137, profit: -1 }] });
  await r.push({ pos: { side: "SELL", entry: 4136.9, sl: 4138, tp: 4115, lot: 0.1, no: 2, pid: 113, profit: 0.5 }, orders: [] }, 5);          // many more syncs: still one message
  const n = (await r.notifs()).filter((x) => /Activated|تفعيل/.test(x.title));
  assert.equal(n.length, 2); assert.ok(/BUY/.test(n[1].body) !== /BUY/.test(n[0].body));
});

// ───────────── v4.7: public Mini App vs internal diagnostics, weekly history, guarded cycle reset ─────────────
const nowS = () => Math.floor(Date.now() / 1000);
const trade = (no, ts, pnl = 4, extra = {}) => ({ no, side: pnl >= 0 ? "BUY" : "SELL", entry: 4138, exit: 4142, lot: 0.01, pnl, reason: pnl >= 0 ? "TP" : "SL", t: "10:00:00", ts, ...extra });
async function up(extra = {}) {
  const b = boot(extra); await b.sync("123456"); const l = await b.signIn();
  return { ...b, h: b.auth("123456", l.j.sess), state: () => b.call("/state", { method: "GET", headers: b.auth("123456", l.j.sess) }) };
}

test("v4.7 public /state: no command log, no technical text, secrets never present", async () => {
  const b = await up({ ADMIN_KEY: "adm" });
  await b.sync("123456", { state: { msg: "Order modification failed retcode 10016", lastCmd: { id: "abc12345def", ok: false, text: "❌ HTTP 503 Server rejected request" }, cmds: [{ id: "c1", cmd: "apply", ok: false, text: "retcode 10016", st: "fail" }, { id: "c2", cmd: "apply", ok: true, text: "waiting for price" }] } });
  const r = await b.state();
  assert.equal(r.j.cmds, undefined);                                   // the EA command log is internal
  assert.equal(r.j.msg, ""); assert.equal(r.j.msgCat, "tech");        // retcode text dropped, only the category travels
  assert.equal(r.j.lastCmd.text, ""); assert.equal(r.j.lastCmd.cat, "tech"); assert.match(r.j.lastCmd.rid, /^r-abc12345/);
  const blob = JSON.stringify(r.j);
  for (const bad of ["retcode", "10016", "HTTP 503", "S3cret-pass", "123:ABC", PAIR]) assert.equal(blob.includes(bad), false, bad);
});

test("v4.7 safe messages: user and operational text pass, technical text does not", async () => {
  const b = await up();
  await b.sync("123456", { state: { msg: "Buy Stop must be above the Ask (4140.00)" } });
  assert.match((await b.state()).j.msg, /Buy Stop must be above/);
  await b.sync("123456", { state: { msg: "Activated: Buy Stop #77 @ 4138.00 at 10:00:01 (452 ms after the price)" } });
  assert.match((await b.state()).j.msg, /Activated/);                  // a 3-digit latency is NOT mistaken for an HTTP code
});

test("v4.7 trade history: current week only, unique ids, survives refresh / restart, old weeks are kept", async () => {
  const b = await up({ ADMIN_KEY: "adm" });
  const cur = nowS(), old = cur - 8 * 86400;
  const hist = [trade(3, cur, -2), trade(2, cur - 5, 4), trade(1, old, 4)];
  await b.sync("123456", { state: { hist } });
  await b.sync("123456", { state: { hist } });                         // refresh / reconnect / MT5 restart: same trades again
  await b.sync("123456", { state: { hist: [...hist, trade(2, cur - 5, 4)] } });
  let r = await b.state();
  assert.deepEqual(r.j.hist.map((x) => x.no), [3, 2]);                 // last week's trade is not shown, nothing is duplicated
  assert.equal(new Set(r.j.hist.map((x) => x.id)).size, 2);
  assert.equal(r.j.stats.total, 2); assert.equal(r.j.stats.wins, 1); assert.equal(r.j.stats.losses, 1); assert.equal(r.j.stats.net, 2);
  assert.ok(r.j.week.from < cur && cur <= r.j.week.to && r.j.week.to - r.j.week.from === 7 * 86400 - 1);
  b.hubOf("123456").st = null; b.hubOf("123456").wkc = null;           // Worker restart: in-memory state gone
  r = await b.state(); assert.deepEqual(r.j.hist.map((x) => x.no), [3, 2]); assert.equal(r.j.orders, undefined);
  const d = await b.call("/admin/diag", { method: "GET", headers: { "X-Login": "123456", "X-Admin-Key": "adm" } });
  assert.equal(d.j.archivedWeeks.reduce((s, w) => s + w.trades, 0), 3);   // the old week is still archived (view = filter, not purge)
});

test("v4.7 week boundary: Monday 00:00 .. Sunday 23:59 in broker server time", async () => {
  const mon = Date.UTC(2026, 9, 5) / 1000;                              // Mon 2026-10-05 00:00
  const b = await up();
  b.hubOf("123456").ts = Date.now();
  const sunNight = mon + 7 * 86400 - 60, prevSun = mon - 60;            // Sun 23:59 of this week / Sun 23:59 of the previous one
  const real = Date.now; Date.now = () => (mon + 2 * 86400 + 3600) * 1000;   // Wed 01:00
  try {
    await b.sync("123456", { state: { hist: [trade(5, sunNight, 3), trade(4, mon, 3), trade(3, prevSun, 3)] } });
    const r = await b.state();
    assert.deepEqual(r.j.hist.map((x) => x.no), [5, 4]);
    assert.equal(r.j.week.from, mon); assert.equal(r.j.week.to, mon + 7 * 86400 - 1);
  } finally { Date.now = real; }
});

test("v4.7 /admin/diag is invisible without the admin key and returns the raw technical detail with it", async () => {
  const b = await up({ ADMIN_KEY: "adm" });
  await b.sync("123456", { state: { cmds: [{ id: "c1xxxxxxxx", cmd: "apply", ok: false, st: "fail", text: "retcode 10016" }] } });
  const hd = (k) => ({ "X-Login": "123456", ...(k ? { "X-Admin-Key": k } : {}) });
  assert.equal((await b.call("/admin/diag", { method: "GET", headers: hd() })).s, 404);
  assert.equal((await b.call("/admin/diag", { method: "GET", headers: hd("wrong") })).s, 404);
  assert.equal((await boot().call("/admin/diag", { method: "GET", headers: hd("anything") })).s, 404);   // no ADMIN_KEY configured: the endpoint does not exist
  const d = await b.call("/admin/diag", { method: "GET", headers: hd("adm") });
  assert.equal(d.s, 200); assert.equal(d.j.diag[0].raw, "retcode 10016"); assert.equal(d.j.diag[0].cat, "tech"); assert.equal(d.j.commandLog.length, 1);
  const blob = JSON.stringify(d.j);
  for (const bad of ["S3cret-pass", "123:ABC", PAIR, "adm"]) assert.equal(blob.includes(bad), false, "diagnostics leaked " + bad);
});

test("v4.7 guarded cycle reset: blocked on a live trade and while a command is in flight; otherwise stop + reset", async () => {
  const b = await up();
  await b.sync("123456", { state: { state: "BUY_ACTIVE", pos: { side: "BUY", entry: 4138 } } });
  let r = await b.call("/command", { headers: b.h, body: { cmd: "newcycle" } });
  assert.equal(r.s, 409); assert.equal(r.j.why, "position");
  await b.sync("123456", { state: { state: "WAITING_REENTRY", pos: null, orders: [{ ticket: 9, side: "BUY", price: 4138 }] } });
  const first = await b.call("/command", { headers: b.h, body: { cmd: "apply", buy: 4138, sell: 4137, risk: 5 } });
  r = await b.call("/command", { headers: b.h, body: { cmd: "newcycle" } });
  assert.equal(r.s, 409); assert.equal(r.j.why, "pending");
  await b.sync("123456", { ack: [first.j.id], state: { state: "WAITING_REENTRY", pos: null, orders: [{ ticket: 9, side: "BUY", price: 4138 }] } });
  r = await b.call("/command", { headers: b.h, body: { cmd: "newcycle" } });
  assert.equal(r.s, 200); assert.equal(r.j.orders, 1);
  const q = await b.sync("123456");
  assert.deepEqual(q.j.commands.map((c) => c.cmd), ["stop", "reset"]);
});

test("v4.7 recovery is not reset: reopening the app or a Worker restart never queues a command", async () => {
  const b = await up();
  await b.sync("123456", { state: { state: "WAITING_REENTRY", waits: [{ side: "SELL", level: 4113, now: 4120, trig: 4113, dist: 7 }] } });
  await b.state(); await b.state();
  b.hubOf("123456").st = null; await b.state();
  assert.equal((await b.sync("123456")).j.commands.length, 0);
});

// ═════════ v4.8 — notification events, token isolation, mandatory pairing, command age, version ═════════
async function withTelegramMock(fn) {
  const sent = [], real = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    if (String(u).includes("api.telegram.org")) { sent.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }
    return real(u, init);
  };
  try { return await fn(sent); } finally { globalThis.fetch = real; }
}
async function registerChat(ctx, login, chat) {
  const o = ctx.hubOf(login), a = (await o.ctx.storage.get("acc")); a.tg = [chat]; await o.ctx.storage.put("acc", a);
}

test("v4.8 EA event: delivered ONCE, de-duplicated by event id, acked; a re-send of the same id never reaches Telegram twice", async () => {
  await withTelegramMock(async (sent) => {
    const t = boot();
    await t.sync("123456", { state: { evp: 1 } });
    await registerChat(t, "123456", "55501234");
    const ev = { id: "123456:20260101:1", k: "ev", t: "🔴 STOP LOSS", b: "Trade #7\nLoss: -1.45" };
    const r1 = await t.sync("123456", { state: { evp: 1 }, ev: [ev] });
    assert.deepEqual(r1.j.evack, [ev.id]);
    const r2 = await t.sync("123456", { state: { evp: 1 }, ev: [ev] });            // the EA did not see the ack yet and re-sends
    assert.deepEqual(r2.j.evack, [ev.id]);
    assert.equal(sent.length, 1, "exactly one Telegram message for one event id");
    assert.equal(sent[0].chat_id, "55501234");
  });
});

test("v4.8 malformed event ids are ignored (never delivered, never acked)", async () => {
  await withTelegramMock(async (sent) => {
    const t = boot();
    await t.sync("123456", { state: { evp: 1 } });
    await registerChat(t, "123456", "55501234");
    const r = await t.sync("123456", { state: { evp: 1 }, ev: [{ id: "x<script>", k: "ev", t: "bad", b: "" }, { id: "123456:2:3", k: "ev", t: "", b: "no title" }] });
    assert.deepEqual(r.j.evack || [], ["123456:2:3"]);       // empty title is acked (nothing to send), the malicious id is dropped
    assert.equal(sent.length, 0);
  });
});

test("v4.8 an EA that routes notifications through the Worker never receives the Bot Token; a legacy EA still does", async () => {
  const t = boot();
  const r = await t.sync("123456", { state: { evp: 1 }, cv: 0 });
  assert.ok(r.j.cfg, "cfg is sent on the first sync");
  assert.equal(r.j.cfg.tok, "");
  const t2 = boot();
  const r2 = await t2.sync("123456", { cv: 0 });
  assert.equal(r2.j.cfg.tok, "123:ABC");
});

test("v4.8 pairing needs a dedicated PAIR_CODE: without it the account cannot be bound (no fallback to the app password)", async () => {
  const t = boot({ PAIR_CODE: "" });
  const r = await t.sync("123456", {}, { pair: "S3cret-pass" });
  assert.equal(r.s, 503); assert.equal(r.j.error, "pair_not_configured");
  const t2 = boot({ PAIR_CODE: "", ALLOW_PAIR_FALLBACK: "1" });
  assert.equal((await t2.sync("123456", {}, { pair: "S3cret-pass" })).j.ok, true);
});

test("v4.8 commands reach the EA with their age so the EA can expire stale ones", async () => {
  const t = boot();
  await t.sync("123456");
  const l = await t.signIn(); const h = t.auth("123456", l.j.sess);
  await t.call("/command", { headers: h, body: { cmd: "stop" } });
  const q = await t.sync("123456");
  assert.equal(q.j.commands.length, 1);
  assert.ok(Number.isFinite(q.j.commands[0].age) && q.j.commands[0].age >= 0);
});

test("v4.8 root endpoint reports ONE release + EA protocol and whether pairing is configured", async () => {
  const t = boot();
  const r = await t.call("/", { method: "GET" });
  assert.equal(r.j.release, W.VERSION); assert.equal(r.j.v, W.VERSION); assert.equal(r.j.ea_protocol, W.EA_PROTOCOL); assert.equal(r.j.pairConfigured, true);
});

test("v4.8 login brute-force lock is per Telegram user / IP (one stranger cannot lock the owner out)", async () => {
  const t = boot();
  await t.sync("123456");
  for (let i = 0; i < 9; i++) await t.call("/login", { body: { login: "123456", pw: "wrong" }, headers: { "CF-Connecting-IP": "9.9.9.9" } });
  const locked = await t.call("/login", { body: { login: "123456", pw: "S3cret-pass" }, headers: { "CF-Connecting-IP": "9.9.9.9" } });
  assert.equal(locked.s, 429);
  const owner = await t.call("/login", { body: { login: "123456", pw: "S3cret-pass" }, headers: { "CF-Connecting-IP": "1.2.3.4" } });
  assert.equal(owner.s, 200);
});

test("v4.8 the public state forwards the BrokerSpec / RiskResult / waiting code untouched and keeps real numeric precision", async () => {
  const t = boot();
  const bs = { vmin: 0.001, vstep: 0.001, vmax: 50, vdig: 3, contract: 100, tick: 0.01, ccy: "EUR" };
  const rk = { req: 1, raw: 0.00689, vol: 0.01, eff: 1.45, minRisk: 1.45, status: "CLAMPED", policy: "CLAMP_TO_MIN" };
  await t.sync("123456", { state: { bs, rk, wcode: "WAITING_VOLUME" } });
  const l = await t.signIn(); const h = t.auth("123456", l.j.sess);
  const st = await t.call("/state", { method: "GET", headers: h });
  assert.deepEqual(st.j.bs, bs); assert.deepEqual(st.j.rk, rk); assert.equal(st.j.wcode, "WAITING_VOLUME");
});
