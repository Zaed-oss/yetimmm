// v4.31.0 (EA 2.45): command CONFIRMATION path. "No confirmation from the bot" was shown although the EA had executed the command:
// a waiting side silenced the EA's network for up to 20 s (so the ack left 20 s late) while the app gave up after 12 s.
// These tests prove the Worker / app state machines and the EA source rules. They do NOT prove MT5 behaviour (docs/MT5-TESTING.md).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { ns } from "./mock-cf.mjs";

const ea = fs.readFileSync(new URL("../ea/Yetimmm.mq5", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const W = await import("../worker/worker.js");
const PAIR = "pair-Code-7788", BOOT = "e".repeat(32);

function boot(extra = {}) {
  const env = { BOT_TOKEN: "123:ABC", APP_PASSWORD: "S3cret-pass", PAIR_CODE: PAIR, REQUIRE_TG: "0", ...extra };
  env.HUB = ns(W.Hub, env); env.NOTIFY = ns(W.Notify, env);
  const eas = {};
  const call = async (path, { method = "POST", body, headers = {} } = {}) => {
    const r = await W.default.fetch(new Request("https://w" + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers }), env);
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  const STATE = { price: 2400.5, run: true, state: "ARMED", hist: [], orders: [], waits: [], tick: 0.01, pt: 0.01, maxDev: 30 };
  const sync = async (login, body = {}) => {
    const headers = { "X-EA-Secret": eas[login] || BOOT };
    if (!eas[login]) headers["X-EA-Pair"] = PAIR;
    const r = await call("/api/ea/sync", { body: { login, srv: "Broker-Live", ...body, state: { ...STATE, ...(body.state || {}) } }, headers });
    if (r.j && r.j.es) eas[login] = r.j.es;
    return r;
  };
  return { call, sync };
}
async function session(b) {
  assert.equal((await b.sync("123456")).j.ok, true);
  const l = await b.call("/login", { body: { login: "123456", pw: "S3cret-pass" } });
  return { "X-Login": "123456", "X-Session": l.j.sess };
}
const rowOf = async (b, h, id) => (await b.call("/state", { method: "GET", headers: h })).j.cmdStatus.find((x) => x.id === id);
const later = async (ms, fn) => { const real = Date.now; Date.now = () => real() + ms; try { return await fn(); } finally { Date.now = real; } };

// ------------------------------------------------------------------ WORKER
test("WORKER the stages are visible one by one: queued -> handed (sent to the EA) -> delivered", async () => {
  const b = boot(), h = await session(b);
  const c = await b.call("/command", { headers: h, body: { cmd: "apply", buy: 2410, sell: 2400, risk: 5 } });
  assert.equal((await rowOf(b, h, c.j.id)).st, "queued");
  const s1 = await b.sync("123456");
  assert.equal(s1.j.commands.length, 1);
  assert.equal((await rowOf(b, h, c.j.id)).st, "handed", "after the sync response carried it, the app can say 'sent to the bot'");
  await b.sync("123456");                                                    // the EA has not acked yet: it is handed again, the stage does not move backwards
  assert.equal((await rowOf(b, h, c.j.id)).st, "handed");
  await b.sync("123456", { ack: [c.j.id] });
  assert.equal((await rowOf(b, h, c.j.id)).st, "delivered");
});

test("WORKER handed but never confirmed for 120 s = UNKNOWN (may have been executed), NEVER 'expired / not executed'", async () => {
  const b = boot(), h = await session(b);
  const c = await b.call("/command", { headers: h, body: { cmd: "apply", buy: 2410, sell: 2400, risk: 5 } });
  await b.sync("123456");                                                    // handed over, the ack is lost
  await later(130000, () => b.sync("123456"));
  const r = await rowOf(b, h, c.j.id);
  assert.equal(r.st, "unknown"); assert.match(r.why, /UNCONFIRMED/); assert.ok(!/NOT executed/.test(r.why));
});

test("WORKER an unknown command still receives its real result later (the EA command log carries the id)", async () => {
  const b = boot(), h = await session(b);
  const c = await b.call("/command", { headers: h, body: { cmd: "apply", buy: 2410, sell: 2400, risk: 5 } });
  await b.sync("123456");
  await later(130000, () => b.sync("123456"));
  assert.equal((await rowOf(b, h, c.j.id)).st, "unknown");
  await b.sync("123456", { state: { cmds: [{ id: c.j.id, cmd: "apply", ok: true, st: "ok", text: "✅ Levels accepted" }] } });
  const r = await rowOf(b, h, c.j.id);
  assert.equal(r.res, "executed"); assert.equal(r.st, "delivered");
});

test("WORKER a command never taken by the EA (not handed) is still EXPIRED / NOT executed", async () => {
  const b = boot(), h = await session(b);
  const c = await b.call("/command", { headers: h, body: { cmd: "stop" } });
  await later(130000, () => b.sync("123456"));                                // it is purged in the same pass, so it was never handed over
  const r = await rowOf(b, h, c.j.id);
  assert.equal(r.st, "expired"); assert.match(r.why, /NOT executed/);
});

test("WORKER a result that is already known is never overwritten by a late queue purge", async () => {
  const b = boot(), h = await session(b);
  const c = await b.call("/command", { headers: h, body: { cmd: "apply", buy: 2410, sell: 2400, risk: 5 } });
  await b.sync("123456");
  await b.sync("123456", { state: { cmds: [{ id: c.j.id, cmd: "apply", ok: true, st: "ok", text: "✅ done" }] } });   // result arrives, the ack is lost
  await later(130000, () => b.sync("123456"));
  const r = await rowOf(b, h, c.j.id);
  assert.equal(r.res, "executed"); assert.equal(r.st, "delivered");
});

test("WORKER idempotent request id: the SAME rid returns the ORIGINAL command and queues nothing new", async () => {
  const b = boot(), h = await session(b);
  const a1 = await b.call("/command", { headers: h, body: { cmd: "apply", buy: 2410, sell: 2400, risk: 5, rid: "orq1abc23" } });
  const a2 = await b.call("/command", { headers: h, body: { cmd: "apply", buy: 2410, sell: 2400, risk: 5, rid: "orq1abc23" } });
  assert.equal(a2.s, 200); assert.equal(a2.j.id, a1.j.id); assert.equal(a2.j.dup, true);
  assert.equal((await b.sync("123456")).j.commands.length, 1, "one command reaches the EA, not two");
  const a3 = await b.call("/command", { headers: h, body: { cmd: "apply", buy: 2410, sell: 2400, risk: 5, rid: "orq1abc99" } });
  assert.notEqual(a3.j.id, a1.j.id, "a different user action is a different command");
});

test("WORKER a malformed rid is ignored (never trusted), the command is queued normally", async () => {
  const b = boot(), h = await session(b);
  const a = await b.call("/command", { headers: h, body: { cmd: "stop", rid: "x" } });
  const c = await b.call("/command", { headers: h, body: { cmd: "stop", rid: "x" } });
  assert.notEqual(a.j.id, c.j.id);
});

test("WORKER the EA offline limit is 30 s (was 20 s = the EA's own max silence): a quiet-market sync gap no longer flips it offline", async () => {
  const b = boot();
  assert.equal((await b.sync("123456")).j.staleSec, 30);
});

// ------------------------------------------------------------------ APP (Ops state machine, extracted from index.html)
const src = html.slice(html.indexOf("const Ops={"), html.indexOf("const Bridge={"));
function mk(S) {
  const toasts = [];
  const ctx = { S, toasts, toast: (m) => toasts.push(m), t: (k, ...x) => k + (x.length ? ":" + x.join("|") : ""), trEA: (x) => x, console };
  vm.createContext(ctx); vm.runInContext(src + "\nthis.Ops=Ops;", ctx); return ctx;
}
test("APP the 12 s timeout is only a soft notice; the Worker ledger result (by id) settles the command afterwards", () => {
  const c = mk({ orders: [], waits: [], pos: null, cmdStatus: [] }), O = c.Ops;
  const o = O.add("apply", { buy: 1, sell: 2 }); o.id = "k1"; o.at = Date.now() - 13000;
  O.settle();
  assert.ok(c.toasts.includes("⏳ op_wait")); assert.ok(!c.toasts.some((x) => x.startsWith("❌")));
  assert.equal(O.add("apply", { buy: 1, sell: 2 }), null, "Apply cannot be sent twice while the first is unresolved");
  c.S.cmdStatus = [{ id: "k1", cmd: "apply", st: "delivered", res: "executed", rtext: "ok" }];
  O.settle();
  assert.equal(O.active(), false); assert.equal(O.log[0].ev, "verified");
});
test("APP a failed result bound to the command's id ends it as failed (reason kept), not as a timeout", () => {
  const c = mk({ orders: [], waits: [], pos: null, cmdStatus: [{ id: "k2", cmd: "apply", st: "delivered", res: "failed", rtext: "price too close" }] }), O = c.Ops;
  const o = O.add("apply", {}); o.id = "k2"; O.settle();
  assert.equal(O.active(), false); assert.equal(O.log[0].ev, "failed");
});
test("APP an expired / rejected ledger row ends the command so it can be sent again (the Worker said it was NOT executed)", () => {
  const c = mk({ orders: [], waits: [], pos: null, cmdStatus: [{ id: "k3", cmd: "apply", st: "expired" }] }), O = c.Ops;
  const o = O.add("apply", {}); o.id = "k3"; O.settle();
  assert.equal(O.active(), false);
});
test("APP the request carries ONE stable rid and a network loss is retried once with the same rid", () => {
  assert.ok(/rid:o\.rid/.test(html), "the rid of the operation is sent with the command");
  assert.ok(/if\(e0&&e0\.status\)throw e0;await new Promise\(z=>setTimeout\(z,900\)\);r=await send\(\)/.test(html));
  assert.ok(/AbortController\(\),tm=setTimeout\(\(\)=>ac\.abort\(\),path==="\/state"\?15000:10000\)/.test(html), "a hung request ends instead of hanging forever");
});
test("APP the strip shows 'sent to the bot' and an unconfirmed result is never in the failure colour", () => {
  assert.ok(/else if\(x\.st==="handed"\)k="hand"/.test(html));
  assert.ok(/else if\(x\.st==="unknown"\)k="unk"/.test(html));
  assert.ok(!/age>120000\)\{k="unk";bad=true\}/.test(html));
});
test("APP after the app is reopened, commands still in flight are restored from the ledger (no lost follow-up)", () => {
  assert.ok(/if\(!this\.restored\)/.test(html) && /Ops\.note\(o,"restored"\)/.test(html));
});

// ------------------------------------------------------------------ EA (source rules + timing model)
const body = (sig) => { const i = ea.indexOf(sig); assert.ok(i >= 0, sig); return ea.slice(i, ea.indexOf("\n  }\n", i) + 5); };
test("EA 2.45 the network is never silent longer than 5 s (was 20 s)", () => {
  assert.match(ea.split("\n").find((l) => /^\s*input\s+int\s+InpNetMaxDeferSec/.test(l)), /InpNetMaxDeferSec\s*=\s*5\s*;/);
});
test("EA 2.45 a waiting side silences the network only NEAR its trigger, never blanket", () => {
  const h = body("bool NetHot(");
  assert.ok(!/if\(g_trig\[0\]>0\.0 \|\| g_trig\[1\]>0\.0\) return true;/.test(h), "the blanket rule is gone");
  assert.ok(h.includes("const double nearW=3.0*InpHotZone;"));
  assert.ok(h.includes("tw.ask<=g_trig[0]+nearW") && h.includes("tw.bid>=g_trig[1]-nearW"));
  assert.ok(h.includes("now<g_fastUntil") && h.includes("YS_CREATING"), "fast-move and order-creation silence are kept");
  assert.ok(/OwnOrders\(od\)>0/.test(h), "position + opposite order stays hot");
});
test("EA 2.45 a command result (ack) leaves within ~1 s unless the market itself is hot", () => {
  const a = body("bool NetAllowed(");
  assert.ok(a.includes("g_netAckWait && now-g_netPrioMs>=500 && !NetHot(true)"));
  assert.ok(/g_netAckWait=true;/.test(body("void BrAckAdd(")));
  assert.ok(/ArrayResize\(g_brAck,0\);[^\n]*\n\s*g_netAckWait=false;/.test(ea));
  const h = body("bool NetHot(");
  assert.ok(h.includes("if(g_dirty && !prio) return true;"), "a trade-event flag no longer blocks the ack call");
});
