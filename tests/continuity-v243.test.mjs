// v4.29.0 (EA 2.43): cycle continuity (Fix_2). The compensation cycle is never ended by a loss COUNT, a restart or a START;
// a debt is cleared only by the explicit, confirmed Reset / New Cycle; commands never vanish silently.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ns } from "./mock-cf.mjs";

const ea = readFileSync(new URL("../ea/Yetimmm.mq5", import.meta.url), "utf8");
const app = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const W = await import("../worker/worker.js");
const inputLine = (name) => ea.split("\n").find((l) => new RegExp("^\\s*input\\s+\\w+\\s+" + name + "\\s*=").test(l));
const fnBody = (sig) => { const i = ea.indexOf(sig); assert.ok(i >= 0, sig); return ea.slice(i, ea.indexOf("\n  }\n", i) + 5); };

// ------------------------------------------------------------ problem 1: no default stop of the sequence
test("SOURCE 2.43 InpMaxSeqLosses defaults to 0 (OFF): no loss COUNT stops the compensation cycle", () => {
  assert.match(inputLine("InpMaxSeqLosses"), /InpMaxSeqLosses\s*=\s*0\s*;/);
  assert.ok(/InpMaxSeqLosses>0 && g_accLoss>1e-9 && g_seq>=InpMaxSeqLosses/.test(ea), "the optional cap is still available when the user turns it on");
});
test("SOURCE 2.43 every other default cap is OFF too (nothing but real broker limits can pause the cycle)", () => {
  for (const n of ["InpMaxLot", "InpMaxRiskPctBal", "InpMaxAccLoss", "InpMinMarginLevel", "InpMaxRiskUSD", "InpMaxDailyLoss", "InpMaxSpread"]) assert.match(inputLine(n), new RegExp(n + "\\s*=\\s*0(\\.0)?\\s*;"), n);
  assert.match(inputLine("InpOneCyclePerDay"), /=\s*false\s*;/);
});
test("SOURCE 2.43 a cap only PAUSES new orders (WAITING_*): the debt is kept and the text says so", () => {
  const g = fnBody("bool RecoveryGuardBlocks(");
  assert.ok(g.includes("is KEPT (nothing is cleared)"));
  assert.ok(!/ResetRisk|g_accLoss\s*=\s*0|g_cycNet\s*=\s*0/.test(g), "the guard never clears the ledger");
});

// ------------------------------------------------------------ problem 2: no silent zeroing of the debt
test("SOURCE 2.43 InpResetRiskOnStart defaults to false", () => {
  assert.match(inputLine("InpResetRiskOnStart"), /InpResetRiskOnStart\s*=\s*false\s*;/);
});
test("SOURCE 2.43 START / levels after STOP go through ImplicitResetGuarded, which never touches a debt (even with the input ON)", () => {
  assert.ok(!/if\(InpResetRiskOnStart\) ResetRiskLogged/.test(ea) && !/YT_STOPPED && InpResetRiskOnStart/.test(ea));
  assert.equal((ea.match(/ImplicitResetGuarded\("/g) || []).length, 2);
  const g = fnBody("void ImplicitResetGuarded(");
  assert.ok(/g_accLoss>1e-9 \|\| MathAbs\(g_cycNet\)>1e-9 \|\| g_seq>0/.test(g) && g.includes("DEBT_KEPT") && g.includes("return;"));
  assert.ok(g.indexOf("DEBT_KEPT") < g.indexOf("ResetRiskLogged(src)"), "the keep-branch returns before any reset");
});
test("SOURCE 2.43 the only remaining ResetRisk callers: confirmed command, guarded implicit reset, a COMPLETED cycle (net >= target) and a full user cancel (fix13)", () => {
  const callers = [...ea.matchAll(/ResetRisk(Logged)?\(/g)].map((m) => ea.slice(0, m.index).split("\n").length);
  assert.equal(callers.length, 7, "definition x2 + completion + guarded + confirmed reset + 1 log call + fix13 user cancel (CycleEndByUser)");
  assert.ok(ea.includes('ResetRiskLogged("Mini App RESET (confirmed)")'));
});
test("SOURCE 2.43 a reset command over a debt needs confirm=1; the worker and the app send it, a bare reset is refused", () => {
  assert.ok(/hasDebt && !\(JDbl\(seg,"confirm",cfm\) && cfm>0\.5\)/.test(ea) && ea.includes("RESET REFUSED"));
  assert.ok(app.includes('run("reset",{confirm:1})'));
  assert.ok(/cmd: "reset", confirm: 1/.test(readFileSync(new URL("../worker/worker.js", import.meta.url), "utf8")));
});
test("SOURCE 2.43 the app text no longer claims that START after STOP clears the loss", () => {
  assert.ok(!app.includes("يصفّر الخسائر المتراكمة حسب إعداد الـ EA") && !app.includes("starting again after a stop clears the accumulated loss (EA setting)"));
});
// model of the guarded reset
const implicit = (inputOn, s) => (!inputOn ? "NOOP" : (s.acc > 1e-9 || Math.abs(s.net) > 1e-9 || s.seq > 0) ? "KEPT" : "RESET");
test("MODEL implicit reset: never with a debt, whatever the input says", () => {
  for (const on of [true, false]) for (const s of [{ acc: 30, net: -30, seq: 3 }, { acc: 0, net: 4, seq: 0 }, { acc: 0, net: 0, seq: 2 }]) assert.notEqual(implicit(on, s), "RESET");
  assert.equal(implicit(true, { acc: 0, net: 0, seq: 0 }), "RESET");
});

// ------------------------------------------------------------ problem 4: restart with a debt
test("SOURCE 2.43 restart with a debt: the cycle continues with the saved levels, or keeps the debt waiting for levels - never IDLE", () => {
  const i = ea.indexOf("void RecoveryStateSafe()");
  const body = ea.slice(i, ea.indexOf('LogOrder("RECOVERY"', i));
  const cont = body.indexOf('code="RCV_CONTINUE_CYCLE"'), nolv = body.indexOf('code="RCV_DEBT_NO_LEVELS"'), wait = body.indexOf('code="RCV_WAIT_USER"');
  assert.ok(cont > 0 && nolv > cont && wait > nolv, "debt branches come BEFORE the wait-for-user branch");
  const debtPart = body.slice(cont, wait);
  assert.ok(!/g_state=YT_IDLE|g_accLoss\s*=|g_seq\s*=|g_cycNet\s*=|ResetRisk/.test(debtPart), "no IDLE / no ledger change in the debt branches");
});

// ------------------------------------------------------------ problem 5: commands never vanish silently
function boot() {
  const env = { BOT_TOKEN: "123:ABC", APP_PASSWORD: "S3cret-pass", PAIR_CODE: "pair-Code-7788", REQUIRE_TG: "0" };
  env.HUB = ns(W.Hub, env); env.NOTIFY = ns(W.Notify, env);
  const eas = {};
  const call = async (path, { method = "POST", body, headers = {} } = {}) => {
    const r = await W.default.fetch(new Request("https://w" + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers }), env);
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  const sync = async (login, body = {}) => {
    const headers = { "X-EA-Secret": eas[login] || "e".repeat(32) };
    if (!eas[login]) headers["X-EA-Pair"] = "pair-Code-7788";
    const r = await call("/api/ea/sync", { body: { login, srv: "Broker-Live", state: { price: 2400.5, run: false, state: "STOPPED", hist: [], orders: [], waits: [], tick: 0.01, pt: 0.01, maxDev: 30 }, ...body }, headers });
    if (r.j && r.j.es) eas[login] = r.j.es;
    return r;
  };
  return { call, sync, env };
}
async function session(b) {
  assert.equal((await b.sync("123456")).j.ok, true);
  const l = await b.call("/login", { body: { login: "123456", pw: "S3cret-pass" } });
  return { "X-Login": "123456", "X-Session": l.j.sess };
}
test("WORKER a full command queue REFUSES the new command (429 queue_full) and keeps every older one", async () => {
  const b = boot(), h = await session(b);
  const ids = [];
  for (let i = 0; i < 20; i++) { const r = await b.call("/command", { headers: h, body: { cmd: "stop" } }); assert.equal(r.s, 200); ids.push(r.j.id); }
  const over = await b.call("/command", { headers: h, body: { cmd: "stop" } });
  assert.equal(over.s, 429); assert.equal(over.j.error, "queue_full");
  const s = await b.sync("123456");
  assert.deepEqual(s.j.commands.map((c) => c.id), ids, "all 20 older commands are still delivered, none was dropped");
});
test("WORKER the status ledger shows queued -> delivered, and the app state exposes it", async () => {
  const b = boot(), h = await session(b);
  const c = await b.call("/command", { headers: h, body: { cmd: "stop" } });
  let st = await b.call("/state", { method: "GET", headers: h });
  assert.equal(st.j.cmdStatus.find((x) => x.id === c.j.id).st, "queued");
  await b.sync("123456", { ack: [c.j.id] });
  st = await b.call("/state", { method: "GET", headers: h });
  assert.equal(st.j.cmdStatus.find((x) => x.id === c.j.id).st, "delivered");
});
test("WORKER a command the EA never took within 120 s is recorded as EXPIRED (not executed), never just forgotten", async () => {
  const b = boot(), h = await session(b);
  const c = await b.call("/command", { headers: h, body: { cmd: "stop" } });
  const real = Date.now; Date.now = () => real() + 130000;
  try { await b.sync("123456"); } finally { Date.now = real; }
  const st = await b.call("/state", { method: "GET", headers: h });
  const row = st.j.cmdStatus.find((x) => x.id === c.j.id);
  assert.equal(row.st, "expired"); assert.match(row.why, /NOT executed/);
});
test("WORKER newcycle sends a CONFIRMED reset to the EA", async () => {
  const b = boot(), h = await session(b);
  const r = await b.call("/command", { headers: h, body: { cmd: "newcycle" } });
  assert.equal(r.s, 200);
  const s = await b.sync("123456");
  const reset = s.j.commands.find((c) => c.cmd === "reset");
  assert.ok(reset && reset.confirm === 1);
});
