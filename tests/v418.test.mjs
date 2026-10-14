// v4.18 acceptance tests for the Worker side of the fix report: sessions / multi-device, no lock, account directory, XSS typing, initData, CORS / GET.
import test from "node:test";
import assert from "node:assert/strict";
import { boot, tgInit, W, TOKEN, PAIR } from "./harness.mjs";

const sesKeys = (hub) => [...hub.__st.m.keys()].filter((k) => k.startsWith("ses:"));

// ───────────── A. sessions: unlimited devices, independent, nothing evicts a valid one ─────────────
test("A1 the same MT5 account can be signed in on 25 devices at once: every session stays valid (no keep-last-N)", async () => {
  const b = boot(); await b.sync("123456");
  const sess = []; for (let i = 0; i < 25; i++) { const r = await b.signIn(); assert.equal(r.s, 200); sess.push(r.j.sess); }
  assert.equal(new Set(sess).size, 25);
  for (const s of sess) assert.equal((await b.state("123456", s)).s, 200);
  assert.equal(sesKeys(b.hubOf("123456")).length, 25);
});

test("A2 signing out one device ends only that session; the others keep working, then a 4th sign-in still works", async () => {
  const b = boot(); await b.sync("123456");
  const [s1, s2, s3] = [(await b.signIn()).j.sess, (await b.signIn()).j.sess, (await b.signIn()).j.sess];
  assert.equal((await b.call("/logout", { headers: b.auth("123456", s2) })).j.ok, true);
  assert.equal((await b.state("123456", s2)).s, 401);
  assert.equal((await b.state("123456", s1)).s, 200); assert.equal((await b.state("123456", s3)).s, 200);
  const s4 = (await b.signIn()).j.sess;
  for (const s of [s1, s3, s4]) assert.equal((await b.state("123456", s)).s, 200);
});

test("A3 reload / reconnect / repeated verify on one device never creates a conflicting record nor drops another session", async () => {
  const b = boot(); await b.sync("123456");
  const s1 = (await b.signIn()).j.sess, s2 = (await b.signIn()).j.sess;
  for (let i = 0; i < 6; i++) { assert.equal((await b.call("/verify", { headers: b.auth("123456", s1), body: {} })).j.checks.session, true); await b.state("123456", s1); }
  assert.equal(sesKeys(b.hubOf("123456")).length, 2);
  assert.equal((await b.state("123456", s2)).s, 200);
});

test("A4 EA restarts / re-syncs / losing the network never sign anybody out; only the explicit reset input does", async () => {
  const b = boot(); await b.sync("123456");
  const s = [(await b.signIn()).j.sess, (await b.signIn()).j.sess, (await b.signIn()).j.sess];
  for (let i = 0; i < 4; i++) await b.sync("123456", { fresh: true });                   // EA restarted: same secret, "fresh" start
  await new Promise((r) => setTimeout(r, 5));
  for (const x of s) assert.equal((await b.state("123456", x)).s, 200);
  await b.sync("123456", { reset: true });                                               // InpBrResetPw = true: the owner asked to sign everyone out
  for (const x of s) assert.equal((await b.state("123456", x)).s, 401);
});

test("A5 overlapping requests (EA sync + sign-ins + polls + verify) can never overwrite each other: all 20 sessions survive", async () => {
  const b = boot(); await b.sync("123456");
  const first = (await b.signIn()).j.sess;
  const jobs = [];
  for (let i = 0; i < 20; i++) { jobs.push(b.signIn()); jobs.push(b.sync("123456", { tzo: 10800, calv: "abc" + (i % 3) })); jobs.push(b.state("123456", first)); jobs.push(b.call("/verify", { headers: b.auth("123456", first), body: {} })); }
  const res = await Promise.all(jobs);
  const mine = res.filter((r) => r.j && r.j.sess).map((r) => r.j.sess);
  assert.equal(mine.length, 20);
  for (const s of [first, ...mine]) assert.equal((await b.state("123456", s)).s, 200);
});

test("A6 Telegram registrations have no cap: 12 different Telegram users on one account all keep verifying", async () => {
  const b = boot({ REQUIRE_TG: "1" }); await b.sync("123456");
  const users = Array.from({ length: 12 }, (_, i) => 900000 + i), sess = {};
  for (const u of users) { const r = await b.signIn("123456", "S3cret-pass", tgInit(TOKEN, u)); assert.equal(r.s, 200); sess[u] = r.j.sess; }
  for (const u of users) { const v = await b.call("/verify", { headers: b.auth("123456", sess[u]), body: { init: tgInit(TOKEN, u) } }); assert.equal(v.j.ok, true, "user " + u); }
});

test("A7 same Telegram user on two devices: logging out of one keeps the chat registered for the other", async () => {
  const b = boot({ REQUIRE_TG: "1" }); await b.sync("123456");
  const init = () => tgInit(TOKEN, 555001);
  const d1 = (await b.signIn("123456", "S3cret-pass", init())).j.sess, d2 = (await b.signIn("123456", "S3cret-pass", init())).j.sess;
  await b.call("/logout", { headers: b.auth("123456", d1) });
  assert.equal((await b.call("/verify", { headers: b.auth("123456", d2), body: { init: init() } })).j.ok, true);
  await b.call("/logout", { headers: b.auth("123456", d2) });
  assert.deepEqual(b.hubOf("123456").__st.m.get("acc").tg, []);                          // last session of that user gone -> unregistered
});

test("A8 already-invalid sessions are cleaned at the next sign-in, valid ones never are", async () => {
  const b = boot(); await b.sync("123456");
  await b.signIn(); const keep = (await b.signIn()).j.sess, hub = b.hubOf("123456");
  const keys = sesKeys(hub);
  hub.__st.m.get(keys[0]).t = Date.now() - 40 * 86400000;                                  // one record is 40 days idle: expired
  const fresh = (await b.signIn()).j.sess;
  assert.ok(!hub.__st.m.has(keys[0]), "the expired record is removed");
  assert.equal(sesKeys(hub).length, 2);
  for (const s of [keep, fresh]) assert.equal((await b.state("123456", s)).s, 200);
});

test("A9 sessions stored by v4.17 (array in acc.sessions) are imported once and keep working", async () => {
  const b = boot(); await b.sync("123456");
  const hub = b.hubOf("123456"), { createHash } = await import("node:crypto");
  const tok = "legacy-token-0123456789abcdef", h = createHash("sha256").update(tok).digest("hex");
  const acc = hub.__st.m.get("acc");
  const pwv = (await (async () => { const l = await b.signIn(); const k = sesKeys(hub)[0]; const v = hub.__st.m.get(k); hub.__st.m.delete(k); return v.pwv; })());
  acc.sessions = [{ h, tg: "", t: Date.now(), pwv, ep: "1", srv: "Broker-Live" }];
  hub.migrated = false;
  assert.equal((await b.state("123456", tok)).s, 200);
  assert.equal(hub.__st.m.get("acc").sessions, undefined);
});

// ───────────── B. no password lock ─────────────
test("B1 no lock anywhere: 60 wrong passwords, with and without Telegram, never produce 429 / locked / left / retry", async () => {
  const b = boot({ REQUIRE_TG: "1" }); await b.sync("123456");
  for (let i = 0; i < 60; i++) {
    const r = await b.signIn("123456", "wrong" + i, tgInit(TOKEN, 700000 + (i % 3)));
    assert.equal(r.s, 401); assert.equal(r.j.error, "bad_pw"); assert.equal(r.j.left, undefined); assert.equal(r.j.retry, undefined);
  }
  assert.equal((await b.signIn("123456", "S3cret-pass", tgInit(TOKEN, 700000))).s, 200);
  assert.ok(![...b.env.HUB.inst.keys()].some((k) => k.startsWith("gate-")), "no gate Durable Object is created any more");
});

// ───────────── C. account directory poisoning ─────────────
const hubStoreSize = (b, name) => (b.env.HUB.inst.has(name) ? b.env.HUB.inst.get(name).__st.m.size : -1);

test("C1 junk / unauthenticated syncs never register an account and never persist anything", async () => {
  const b = boot();
  for (let i = 0; i < 60; i++) {
    const login = String(300000 + i);
    await b.call("/api/ea/sync", { body: { login, state: {} }, headers: { "X-EA-Secret": "z".repeat(32) } });                          // secret of nobody
    await b.call("/api/ea/sync", { body: { login, state: {} }, headers: { "X-EA-Secret": "z".repeat(32), "X-EA-Pair": "guess" + i } }); // wrong code
    await b.call("/api/ea/sync", { body: { login, state: {} } });                                                                       // no credentials at all
  }
  const dir = b.env.HUB.inst.get("dir");
  assert.ok(!dir || !dir.__st.m.has("dir2"), "the directory was never written");
  const accs = [...b.env.HUB.inst.keys()].filter((k) => k.startsWith("acc-"));
  for (const k of accs) assert.equal(b.env.HUB.inst.get(k).__st.m.size, 0, k + " persisted something for an unverified login");
  // a wrong pairing code for an unknown login is stopped at the edge: its account Hub is not even instantiated
  assert.ok(!b.env.HUB.inst.has("acc-300000") || b.env.HUB.inst.get("acc-300000").__st.m.size === 0);
});

test("C2 a verified pairing registers the account; a failed pairing and a repeat do not change the directory", async () => {
  const b = boot();
  await b.call("/api/ea/sync", { body: { login: "123456", state: {} }, headers: { "X-EA-Secret": "a".repeat(32), "X-EA-Pair": "wrong" } });
  assert.ok(hubStoreSize(b, "dir") <= 0 && hubStoreSize(b, "acc-123456") <= 0, "a failed pairing wrote nothing");
  assert.equal((await b.sync("123456")).s, 200);
  const d1 = JSON.stringify(b.env.HUB.inst.get("dir").__st.m.get("dir2"));
  for (let i = 0; i < 5; i++) await b.sync("123456");
  assert.deepEqual(Object.keys(b.env.HUB.inst.get("dir").__st.m.get("dir2")), ["123456"]);
  assert.equal(JSON.stringify(b.env.HUB.inst.get("dir").__st.m.get("dir2")), d1, "idempotent: no rewrite within the hour");
});

test("C3 25 genuine accounts are all kept (the old 20-entry cap evicted real ones); a flood of junk cannot push any out", async () => {
  const b = boot();
  for (let i = 0; i < 25; i++) assert.equal((await b.sync(String(500000 + i))).s, 200);
  for (let i = 0; i < 300; i++) await b.call("/api/ea/sync", { body: { login: String(800000 + i), state: {} }, headers: { "X-EA-Secret": "q".repeat(32), "X-EA-Pair": "x" } });
  const m = b.env.HUB.inst.get("dir").__st.m.get("dir2");
  assert.equal(Object.keys(m).length, 25);
  for (let i = 0; i < 25; i++) assert.ok(m[String(500000 + i)]);
});

test("C4 simultaneous first syncs of the same new account (two EA copies / retries) end with one directory entry and a working account", async () => {
  const b = boot();
  const r = await Promise.all([b.sync("424242"), b.sync("424242"), b.sync("424242")]);
  assert.ok(r.every((x) => x.s === 200));
  assert.deepEqual(Object.keys(b.env.HUB.inst.get("dir").__st.m.get("dir2")), ["424242"]);
  assert.equal((await b.sync("424242")).s, 200);
});

test("C5 owner auto-login still finds the single verified account after unverified noise", async () => {
  const b = boot({ REQUIRE_TG: "1", OWNER_TG: "777001", APP_PASSWORD: "" });
  await b.sync("123456");
  for (let i = 0; i < 30; i++) await b.call("/api/ea/sync", { body: { login: String(610000 + i), state: {} }, headers: { "X-EA-Secret": "n".repeat(32), "X-EA-Pair": "x" } });
  const r = await b.call("/login", { body: { init: tgInit(TOKEN, 777001) } });
  assert.equal(r.s, 200); assert.equal(r.j.login, "123456"); assert.ok(r.j.sess);
});

test("C6 unauthenticated and wrong-secret answers are identical for known and unknown accounts (no enumeration)", async () => {
  const b = boot(); await b.sync("123456");
  const known = await b.call("/api/ea/sync", { body: { login: "123456", state: {} }, headers: { "X-EA-Secret": "k".repeat(32) } });
  const unknown = await b.call("/api/ea/sync", { body: { login: "999999", state: {} }, headers: { "X-EA-Secret": "k".repeat(32) } });
  assert.deepEqual([known.s, known.j], [unknown.s, unknown.j]);
});

// ───────────── D. XSS: typed state ─────────────
test("D1 hostile pos.no / orders[].ticket / waits / side values reach the app as plain numbers or fixed enums, never markup", async () => {
  const b = boot(); 
  await b.sync("123456", { state: { pos: { pid: "<b>1", side: "<img src=x onerror=alert(1)>", entry: "2400", sl: "x", tp: 1, lot: "0.1", no: "<script>alert(1)</script>", profit: "1e999" }, orders: [{ ticket: "<svg onload=alert(1)>", side: "BUY STOP", price: "2401", lot: 0.1, sl: 1, tp: 2 }], waits: [{ side: "javascript:alert(1)", level: "<x>", trig: 1, now: 2, dist: 3, placing: "yes" }], state: "ARMED<script>", wcode: "A\u0000B" } });
  const s = (await b.state("123456", (await b.signIn()).j.sess)).j;
  assert.equal(s.pos.no, 0); assert.equal(s.pos.pid, 0); assert.equal(s.pos.side, ""); assert.equal(s.pos.profit, 0); assert.equal(s.pos.entry, 2400);
  assert.equal(s.orders[0].ticket, 0); assert.equal(s.orders[0].side, "BUY"); assert.equal(s.orders[0].price, 2401);
  assert.equal(s.waits[0].side, ""); assert.equal(s.waits[0].level, 0); assert.equal(s.waits[0].placing, true);
  assert.ok(!/[<>]/.test(s.state)); assert.ok(!/\u0000/.test(s.wcode));
});

test("D2 normal state is untouched: numbers, sides and order lists pass through exactly", async () => {
  const b = boot();
  await b.sync("123456", { state: { pos: { pid: 99, side: "SELL", entry: 2400.12, sl: 2401.12, tp: 2380.12, lot: 0.07, est: 1.01, risk: 1, no: 12, profit: -0.5 }, orders: [{ ticket: 123456789, side: "BUY", price: 2410.5, lot: 0.05, sl: 2400, tp: 2500 }, { ticket: 5, side: "SELL", price: 2390, lot: 0.05, sl: 2400, tp: 2300 }] } });
  const s = (await b.state("123456", (await b.signIn()).j.sess)).j;
  assert.deepEqual(s.pos, { pid: 99, side: "SELL", entry: 2400.12, sl: 2401.12, tp: 2380.12, lot: 0.07, est: 1.01, risk: 1, no: 12, profit: -0.5 });
  assert.deepEqual(s.orders.map((o) => [o.ticket, o.side, o.price]), [[123456789, "BUY", 2410.5], [5, "SELL", 2390]]);
});

// ───────────── E. Telegram initData ─────────────
test("E1 initData: valid accepted; stale (> max age), future (> skew), missing / non-numeric auth_date, tampered, duplicated keys and bad user id are all refused", async () => {
  const b = boot({ REQUIRE_TG: "1", TG_AUTH_MAX_AGE_SEC: "3600" }); await b.sync("123456");
  const now = Math.floor(Date.now() / 1000);
  const tries = [
    ["valid", tgInit(TOKEN, 1001), 200], ["valid 50 min old", tgInit(TOKEN, 1001, { authDate: now - 3000 }), 200], ["valid 30 s in the future (clock drift)", tgInit(TOKEN, 1001, { authDate: now + 30 }), 200],
    ["2 h old", tgInit(TOKEN, 1001, { authDate: now - 7200 }), 403], ["10 min in the future", tgInit(TOKEN, 1001, { authDate: now + 600 }), 403],
    ["auth_date text", tgInit(TOKEN, 1001, { authDate: "yesterday" }), 403], ["auth_date 0", tgInit(TOKEN, 1001, { authDate: 0 }), 403],
    ["tampered user", tgInit(TOKEN, 1001, { tamper: (s) => s.replace("1001", "1002") }), 403], ["wrong bot token", tgInit("999:OTHER", 1001), 403],
    ["hash removed", tgInit(TOKEN, 1001, { tamper: (s) => s.replace(/&?hash=[0-9a-f]+/, "") }), 403], ["hash garbage", tgInit(TOKEN, 1001, { tamper: (s) => s.replace(/hash=[0-9a-f]+/, "hash=zz") }), 403],
    ["duplicate auth_date", tgInit(TOKEN, 1001) + "&auth_date=1", 403], ["user id as text", tgInit(TOKEN, 1001, { user: { id: "1001" } }), 403], ["user id negative", tgInit(TOKEN, 1001, { user: { id: -5 } }), 403], ["empty", "", 403],
  ];
  for (const [name, init, want] of tries) assert.equal((await b.signIn("123456", "S3cret-pass", init)).s, want, name);
});

test("E2 a refused initData never blocks a later valid sign-in (no lock, no state)", async () => {
  const b = boot({ REQUIRE_TG: "1" }); await b.sync("123456");
  for (let i = 0; i < 20; i++) await b.signIn("123456", "S3cret-pass", "hash=00");
  assert.equal((await b.signIn("123456", "S3cret-pass", tgInit(TOKEN, 1001))).s, 200);
});

// ───────────── F. GET routes / CORS ─────────────
test("F1 CORS: allowed origin gets headers; foreign origin gets none and is refused on every app route; preflight 403 for foreign", async () => {
  const b = boot({ ALLOWED_ORIGIN: "https://me.github.io" }); await b.sync("123456");
  const sess = (await b.signIn()).j.sess;
  const ok = await b.call("/state", { method: "GET", headers: { ...b.auth("123456", sess), Origin: "https://me.github.io" } });
  assert.equal(ok.s, 200); assert.equal(ok.h.get("Access-Control-Allow-Origin"), "https://me.github.io"); assert.ok(!/X-EA-Secret/i.test(ok.h.get("Access-Control-Allow-Headers") || ""));
  const bad = await b.call("/state", { method: "GET", headers: { ...b.auth("123456", sess), Origin: "https://evil.example" } });
  assert.equal(bad.s, 403); assert.equal(bad.h.get("Access-Control-Allow-Origin"), null);
  const login = await b.call("/login", { body: { login: "123456", pw: "S3cret-pass" }, headers: { Origin: "https://evil.example" } });
  assert.equal(login.s, 403);
  const pre = await W.default.fetch(new Request("https://w/state", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }), b.env); assert.equal(pre.status, 403);
  const pre2 = await W.default.fetch(new Request("https://w/state", { method: "OPTIONS", headers: { Origin: "https://me.github.io" } }), b.env); assert.equal(pre2.status, 204);
  assert.equal((await b.call("/api/ea/sync", { body: { login: "123456", state: {} }, headers: { "X-EA-Secret": b.eas["123456"], Origin: "https://evil.example" } })).s, 200); // the EA is not a browser
});

test("F2 public GET routes cannot change anything: / is minimal, /state accepts only GET, POST-only routes refuse GET", async () => {
  const b = boot(); await b.sync("123456");
  const sess = (await b.signIn()).j.sess;
  assert.equal((await b.call("/state", { method: "POST", headers: b.auth("123456", sess), body: {} })).s, 405);
  for (const p of ["/command", "/logout", "/verify", "/login", "/api/ea/sync"]) assert.equal((await b.call(p, { method: "GET", headers: b.auth("123456", sess) })).s, 405, p);
  assert.equal((await b.state("123456", sess)).s, 200);                                   // the GET did not log the session out
  const root = await b.call("/", { method: "GET" }); assert.deepEqual(Object.keys(root.j).sort(), ["ok", "service", "v"]);
});

test("F3 unauthenticated app calls write nothing (no account record is created by /state, /verify, /news, /command)", async () => {
  const b = boot();
  for (const p of ["/state", "/verify", "/command", "/news/calendar", "/news/notifs", "/order-alert"]) await b.call(p, { method: p === "/state" ? "GET" : "POST", headers: b.auth("654321", "nope-nope-nope"), body: p === "/state" ? undefined : {} });
  assert.ok(hubStoreSize(b, "acc-654321") <= 0);
});

// ───────────── G. password change / epoch still revoke ─────────────
test("G1 password change and SESSION_EPOCH still end sessions (unchanged security behavior)", async () => {
  const b = boot(); await b.sync("123456");
  const s = (await b.signIn()).j.sess;
  b.hubOf("123456").c.password = "another-password";
  const r = await b.state("123456", s); assert.equal(r.s, 401); assert.equal(r.j.why, "pw");
  const b2 = boot(); await b2.sync("123456"); const s2 = (await b2.signIn()).j.sess;
  b2.hubOf("123456").c.epoch = "2"; assert.equal((await b2.state("123456", s2)).j.why, "revoked");
});

test("H1 command tickets must be positive integers: fractions, negatives, text and huge values never reach the EA", async () => {
  const b = boot(); await b.sync("123456", { state: { run: true, state: "ARMED", mode: "BOTH" } });
  const sess = (await b.signIn()).j.sess, h = b.auth("123456", sess);
  for (const bad of [1.5, -3, 0, "abc", 1e20]) { const r = await b.call("/command", { headers: h, body: { cmd: "delete", ticket: bad } }); assert.ok(r.s === 400, String(bad) + " -> " + r.s); }
  const ok = await b.call("/command", { headers: h, body: { cmd: "delete", ticket: 123456789 } }); assert.notEqual(ok.s, 400);
});

test("I1 deploy / setup probe: reports 'configured' with a PAIR_CODE and 'missing' without one, and never writes anything", async () => {
  const { probeWorker } = await import("../scripts/probe.mjs");
  for (const [extra, want] of [[{}, "configured"], [{ PAIR_CODE: "" }, "missing"]]) {
    const b = boot(extra), real = globalThis.fetch;
    globalThis.fetch = (u, init) => W.default.fetch(new Request(u, init), b.env);
    try { const r = await probeWorker("https://w"); assert.equal(r.up, true); assert.equal(r.pair, want); assert.equal(r.v, W.VERSION); } finally { globalThis.fetch = real; }
    for (const k of b.env.HUB.inst.keys()) assert.equal(b.env.HUB.inst.get(k).__st.m.size, 0, "probe persisted something in " + k);
  }
});

test("J1 a changed MT5 SERVER ends that account's sessions (a different account); the same server never does", async () => {
  const b = boot(); await b.sync("123456");
  const s = (await b.signIn()).j.sess;
  await b.sync("123456"); assert.equal((await b.state("123456", s)).s, 200);
  await b.sync("123456", { srv: "Other-Server" });
  assert.equal((await b.state("123456", s)).s, 401);
});

// ───────────── K. second-pass audit findings ─────────────
test("K1 password-less OWNER sign-in needs a FRESH initData: a captured, older one is refused (no password configured) or only counts as an ordinary identity", async () => {
  const b = boot({ REQUIRE_TG: "1", OWNER_TG: "777001", APP_PASSWORD: "", OWNER_TG_MAX_AGE_SEC: "600" }); await b.sync("123456");
  const now = Math.floor(Date.now() / 1000);
  const fresh = await b.call("/login", { body: { login: "123456", init: tgInit(TOKEN, 777001, { authDate: now - 60 }) } });
  assert.equal(fresh.s, 200);
  const stale = await b.call("/login", { body: { login: "123456", init: tgInit(TOKEN, 777001, { authDate: now - 3000 }) } });     // 50 min old: valid for a normal user, NOT enough to skip the password
  assert.equal(stale.s, 401); assert.equal(stale.j.error, "tg_stale");
  const auto = await b.call("/login", { body: { init: tgInit(TOKEN, 777001, { authDate: now - 3000 }) } });                       // auto-login without an account number follows the same rule
  assert.notEqual(auto.s, 200);
  const withPw = boot({ REQUIRE_TG: "1", OWNER_TG: "777001", OWNER_TG_MAX_AGE_SEC: "600" }); await withPw.sync("123456");
  const old = tgInit(TOKEN, 777001, { authDate: now - 3000 });
  assert.equal((await withPw.call("/login", { body: { login: "123456", init: old } })).s, 401);                                  // stale owner proof + no password = refused
  assert.equal((await withPw.call("/login", { body: { login: "123456", pw: "S3cret-pass", init: old } })).s, 200);               // ... but the normal password path still works
});

test("K2 every API answer carries the hardening headers (no-store, nosniff, frame-deny, no-referrer, CSP default-src none)", async () => {
  const b = boot(); await b.sync("123456");
  for (const r of [await b.call("/", { method: "GET" }), await b.signIn("123456", "wrong"), await b.call("/nope", { method: "GET" })]) {
    assert.equal(r.h.get("X-Frame-Options"), "DENY"); assert.equal(r.h.get("Referrer-Policy"), "no-referrer");
    assert.equal(r.h.get("X-Content-Type-Options"), "nosniff"); assert.match(r.h.get("Content-Security-Policy"), /default-src 'none'/); assert.equal(r.h.get("Cache-Control"), "no-store");
  }
});

test("K3 session ceiling only REFUSES a new sign-in (429 too_many_sessions); nobody already signed in is affected; 0 = unlimited", async () => {
  const b = boot({ MAX_SESSIONS: "3" }); await b.sync("123456");
  const s = []; for (let i = 0; i < 3; i++) s.push((await b.signIn()).j.sess);
  const over = await b.signIn(); assert.equal(over.s, 429); assert.equal(over.j.error, "too_many_sessions");
  for (const x of s) assert.equal((await b.state("123456", x)).s, 200);
  await b.call("/logout", { headers: b.auth("123456", s[0]) });
  assert.equal((await b.signIn()).s, 200);                                                   // a slot was freed by the user's own sign-out
  const u = boot({ MAX_SESSIONS: "0" }); await u.sync("123456");
  for (let i = 0; i < 40; i++) assert.equal((await u.signIn()).s, 200);
});
