// v4.31.2: Durable Object WRITE reduction. The EA still syncs every second and every sync is still fully processed;
// only writes that stored an UNCHANGED value are gone. These tests pin both halves: the polling behaviour and the stored data.
import test from "node:test";
import assert from "node:assert/strict";
import { ns } from "./mock-cf.mjs";

const W = await import("../worker/worker.js");
const PAIR = "pair-Code-7788";

function rig() {
  let clock = 1_800_000_000_000;
  const env = { BOT_TOKEN: "123:ABC", APP_PASSWORD: "S3cret-pass", PAIR_CODE: PAIR, REQUIRE_TG: "0" };
  env.HUB = ns(W.Hub, env); env.NOTIFY = ns(W.Notify, env);
  const call = async (path, o = {}) => { const r = await W.default.fetch(new Request("https://w" + path, { method: o.method || "POST", body: o.body === undefined ? undefined : JSON.stringify(o.body), headers: o.headers || {} }), env); return { s: r.status, j: await r.json().catch(() => null) }; };
  const STATE = { price: 2400.5, run: false, state: "STOPPED", hist: [], orders: [], waits: [], tick: 0.01, pt: 0.01, maxDev: 30 };
  let secret = null;
  const sync = async (extra = {}, inst = "A-1") => {
    const h = secret ? { "X-EA-Secret": secret } : { "X-EA-Secret": "e".repeat(32), "X-EA-Pair": PAIR };
    const r = await call("/api/ea/sync", { body: { login: "123456", srv: "Broker-Live", inst, state: { ...STATE, ...(extra.state || {}) }, ...(extra.top || {}) }, headers: h });
    if (r.j && r.j.es) secret = r.j.es; return r;
  };
  const hub = () => env.HUB.get("acc-123456").__o;
  const tick = (ms = 1000) => { clock += ms; };
  const realNow = Date.now; Date.now = () => clock;
  const done = () => { Date.now = realNow; };
  const count = () => { const st = hub().ctx.storage, orig = st.put.bind(st), c = { total: 0, by: {} }; st.put = async (k, v) => { const key = typeof k === "object" ? Object.keys(k).join(",") : k; c.by[key] = (c.by[key] || 0) + 1; c.total++; return orig(k, v); }; return c; };
  const login = async () => { const l = await call("/login", { body: { login: "123456", pw: "S3cret-pass" } }); return { "X-Login": "123456", "X-Session": l.j.sess }; };
  const restartHub = () => { const st = hub().ctx.storage; const h = new W.Hub({ storage: st }, env); h.__st = st; env.HUB.inst.set("acc-123456", h); return h; };
  return { env, call, sync, hub, tick, done, count, login, restartHub, clockNow: () => clock };
}

test("v4.31.2 result written by lastCmd AND cmds with different text: stored ONCE, then never rewritten while unchanged", async () => {
  const r = rig();
  try {
    await r.sync(); const H = await r.login();
    const c = await r.call("/command", { headers: H, body: { cmd: "apply", buy: 2410, sell: 2400, risk: 5, rr: 20 } });
    const cnt = r.count();
    const st = { lastCmd: { id: c.j.id, ok: true, text: "Order placed" }, cmds: [{ id: c.j.id, cmd: "apply", ok: true, st: "wait", text: "Waiting for price - pending order set", ts: 1 }] };
    for (let i = 0; i < 60; i++) { r.tick(); await r.sync({ top: i ? { ack: [c.j.id] } : {}, state: st }); }
    assert.ok((cnt.by.cmdst || 0) <= 2, "cmdst writes: " + cnt.by.cmdst);     // 'handed' (first hand-over) + 'delivered/result' only; was ~60
    const led = await r.hub().ctx.storage.get("cmdst");
    assert.equal(led.length, 1); assert.equal(led[0].st, "delivered"); assert.equal(led[0].res, "waiting");     // the detailed cmds entry still wins
    assert.equal(led[0].rtext.includes("Waiting for price"), true);
  } finally { r.done(); }
});

test("v4.31.2 a REAL change of the result is still stored (waiting -> executed -> failed on another command)", async () => {
  const r = rig();
  try {
    await r.sync(); const H = await r.login();
    const c = await r.call("/command", { headers: H, body: { cmd: "apply", buy: 2410, sell: 2400, risk: 5, rr: 20 } });
    r.tick(); await r.sync({ state: { cmds: [{ id: c.j.id, cmd: "apply", ok: true, st: "wait", text: "pending set", ts: 1 }] } });
    let led = await r.hub().ctx.storage.get("cmdst"); assert.equal(led[0].res, "waiting");
    r.tick(); await r.sync({ state: { cmds: [{ id: c.j.id, cmd: "apply", ok: true, st: "ok", text: "filled", ts: 2 }] } });
    led = await r.hub().ctx.storage.get("cmdst"); assert.equal(led[0].res, "executed"); assert.equal(led[0].rtext, "filled");
    const c2 = await r.call("/command", { headers: H, body: { cmd: "stop" } });
    r.tick(); await r.sync({ state: { cmds: [{ id: c2.j.id, cmd: "stop", ok: false, st: "fail", text: "refused by broker", ts: 3 }, { id: c.j.id, cmd: "apply", ok: true, st: "ok", text: "filled", ts: 2 }] } });
    led = await r.hub().ctx.storage.get("cmdst");
    assert.equal(led.find((x) => x.id === c2.j.id).res, "failed");
    assert.equal(led.find((x) => x.id === c.j.id).res, "executed");     // two different commands are never merged into one
  } finally { r.done(); }
});

test("v4.31.2 every second sync is still answered with the queued command (no delivery delay, no polling change)", async () => {
  const r = rig();
  try {
    await r.sync(); const H = await r.login();
    r.tick(); await r.sync();
    const c = await r.call("/command", { headers: H, body: { cmd: "start" } });
    r.tick(1000);                                      // exactly the next 1 s poll
    const s = await r.sync();
    assert.deepEqual(s.j.commands.map((x) => x.id), [c.j.id]);
    r.tick(); const s2 = await r.sync({ top: { ack: [c.j.id] } });
    assert.deepEqual(s2.j.commands, []);               // acked -> gone, not executed twice
    const st = await r.hub().ctx.storage.get("cmdst"); assert.equal(st[0].st, "delivered");
  } finally { r.done(); }
});

test("v4.31.2 a.seen is no longer written; sessions / pairing / outage detection keep working", async () => {
  const r = rig();
  try {
    await r.sync(); const H = await r.login();
    const cnt = r.count();
    for (let i = 0; i < 90; i++) { r.tick(); await r.sync(); }
    assert.equal(cnt.by.acc || 0, 0);                  // 90 syncs, 0 account writes (was one per 15 s)
    assert.equal(r.hub().botUp(), true);
    r.tick(60000); const s = await r.sync();           // 60 s gap = a real outage
    assert.equal(s.j.ok, true);
    const outs = await r.hub().ctx.storage.get("outages"); assert.equal(outs.length, 1); assert.ok(outs[0].sec >= 60);
    const state = await r.call("/state", { method: "GET", headers: H }); assert.equal(state.s, 200); assert.equal(state.j.eaOnline, true);
  } finally { r.done(); }
});

test("v4.31.2 inst: one EA, second copy refused, owner restart, takeover only after the 20 s window", async () => {
  const r = rig();
  try {
    await r.sync({}, "A-1");
    for (let i = 0; i < 30; i++) { r.tick(); assert.ok(!(await r.sync({}, "A-1")).j.dupInst); }
    r.tick(); assert.equal((await r.sync({}, "B-2")).j.dupInst, true);                 // second copy: refused while the owner is fresh
    // owner EA restarts (new instance id after a terminal restart) -> it is a different id: refused until the old record is older than 20 s
    r.tick(); assert.equal((await r.sync({}, "A-2")).j.dupInst, true);
    r.tick(21000); const t = await r.sync({}, "A-2"); assert.ok(!t.j.dupInst);          // owner silent > 20 s: the new instance takes over (unchanged rule)
    r.tick(); assert.equal((await r.sync({}, "A-1")).j.dupInst, true);
  } finally { r.done(); }
});

test("v4.31.2 inst survives a Worker/Hub restart: the stored record is fresh enough that a stranger still cannot take over, the owner continues", async () => {
  const r = rig();
  try {
    await r.sync({}, "A-1");
    // run for a while so the stored record is at its OLDEST possible age relative to the in-memory one
    for (let s = 0; s < 40; s++) { r.tick(); await r.sync({}, "A-1"); }
    const stored = await r.hub().ctx.storage.get("inst");
    assert.ok(r.clockNow() - stored.t < 20000 - 5000, "stored inst age " + (r.clockNow() - stored.t));   // never close to the 20 s window
    r.restartHub();                                                                     // Durable Object evicted / redeployed: memory lost, storage kept
    r.tick(); assert.equal((await r.sync({}, "B-2")).j.dupInst, true);                  // stranger first after restart: still refused
    r.tick(); assert.ok(!(await r.sync({}, "A-1")).j.dupInst);                          // owner continues without being signed out
    const j = await r.sync({}, "A-1"); assert.equal(j.j.ok, true);
  } finally { r.done(); }
});

test("v4.31.2 unchanged data is not rewritten across 600 one-second syncs (write budget) while every sync is processed", async () => {
  const r = rig();
  try {
    await r.sync(); const H = await r.login();
    const c = await r.call("/command", { headers: H, body: { cmd: "apply", buy: 2410, sell: 2400, risk: 5, rr: 20 } });
    const cnt = r.count(); let ok = 0;
    for (let i = 0; i < 600; i++) {
      r.tick();
      const s = await r.sync({ top: i ? { ack: [c.j.id] } : {}, state: { lastCmd: { id: c.j.id, ok: true, text: "Order placed" }, cmds: [{ id: c.j.id, cmd: "apply", ok: true, st: "wait", text: "Waiting for price", ts: 1 }] } });
      if (s.j.ok) ok++;
    }
    assert.equal(ok, 600);                             // all 600 syncs were accepted
    assert.ok(cnt.total <= 60, "writes: " + cnt.total + " " + JSON.stringify(cnt.by));   // was 741 in v4.31.0 fix23
  } finally { r.done(); }
});
