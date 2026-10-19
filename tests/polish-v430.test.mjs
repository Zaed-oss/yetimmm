// v4.30.0 (EA 2.44): final polish. Closes the remaining ledger / recovery / visibility gaps WITHOUT touching the entry philosophy.
//   SOURCE - structure of the EA source (the EA is NOT compiled or run here: compile with F7 in MetaEditor, then Strategy Tester + demo - docs/MT5-TESTING.md).
//   MODEL  - JS transcription of the new booking rules (stop ledger, Netting share, restart, 25+ losses). Proves the RULES, not an MT5 run.
//   WORKER / UI - the real worker.js and the real cmdStrip() from index.html.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ns } from "./mock-cf.mjs";

const ea = readFileSync(new URL("../ea/Yetimmm.mq5", import.meta.url), "utf8");
const app = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const W = await import("../worker/worker.js");
const cpp = ea.indexOf("bool ProcessClosedPosition("), cend = ea.indexOf("void CheckClosures()");
const pcp = ea.slice(cpp, cend), pcpCode = pcp.replace(/\/\/.*$/gm, "");


// ------------------------------------------------------------ problem 1: a result closed while STOPPED is not lost
test("SOURCE 2.44 a result that closes while STOPPED is booked in the ledger (SL / TP / manual), saved with its closing deal, and never re-arms", () => {
  assert.ok(pcpCode.includes("const bool stopLedger=(bookkeeping && !replay && !orphanCyc && (g_state==YT_STOPPED || g_stopCleanup));"));
  const a = pcpCode.indexOf("if(stopLedger)"), b = pcpCode.indexOf("double accAfter=g_accLoss;");
  assert.ok(a > 0 && b > a);
  const blk = pcpCode.slice(a, b);
  assert.ok(blk.includes("CycleBook(net,"), "net goes through the ONE booking rule");
  assert.ok(blk.includes("g_seq++"), "an SL stays a sequence step (the sequence audit counts SL rows)");
  for (const bad of ["g_state=", "g_mode=", "g_buyLevel=", "g_sellLevel=", "ResetRisk", "g_accLoss=0", "g_cycNet=0"]) assert.ok(!blk.includes(bad), "the stopped booking must not touch " + bad);
  assert.ok(pcpCode.includes("if(!bookkeeping || replay || stopBooked)"), "ledger + closing-deal id are saved together BEFORE the log line (no loss, no double count after a crash)");
  assert.ok(pcpCode.includes("(isTP || InpCountManualResults)") || blk.includes("isTP || InpCountManualResults"), "manual results follow InpCountManualResults like everywhere else");
});
test("SOURCE 2.44 replays and older-cycle positions stay bookkeeping-only (no double count, no inherited result)", () => {
  assert.ok(/replay=\(dealOut!=0 && g_lastDeal==dealOut\)/.test(pcpCode));
  assert.ok(pcpCode.includes("!replay && !orphanCyc"));
});
test("SOURCE 2.44 START after STOP closes a cycle whose target was reached while stopped, ONCE, then begins an empty cycle", () => {
  const i = ea.indexOf("string DoStart("), body = ea.slice(i, ea.indexOf("bool CleanupPositions(", i));
  const a = body.indexOf("g_state==YT_STOPPED && g_cycTrades>0 && CycleMet(g_cycNet)"), r = body.indexOf('ImplicitResetGuarded("START after STOP")');
  assert.ok(a > 0 && r > a, "the completion runs before the implicit-reset guard");
  const seg = body.slice(a, r);
  assert.ok(seg.includes("OwnPositions(cp)==0") && seg.includes("CycleFinishLedger(true)") && seg.includes("g_cycState=YC_IDLE"));
});

// ------------------------------------------------------------ problem 4: Netting mixed position
test("SOURCE 2.44 Netting CONSERVATIVE policy: a mixed position books its WHOLE loss, never credits a profit, and never estimates a 'bot share'", () => {
  assert.ok(!pcpCode.includes("double sh=") && !/net\*sh/.test(pcpCode), "no volume-share estimate may enter the ledger");
  assert.ok(/if\(net<0\.0\)\s*\{\s*taintNet=net; taintDo=true;/.test(pcpCode), "net < 0 -> the whole loss");
  assert.ok(pcpCode.includes("NOT credited to the ledger"), "net >= 0 -> nothing credited");
  assert.ok(pcpCode.includes("if(tainted && InpCountManualResults)"), "InpCountManualResults=false restores the old behaviour");
  assert.ok(pcpCode.includes("LEDGER_BOOKED"));
  assert.ok(/StringFind\(f\[35\],"LEDGER_BOOKED"\)/.test(ea), "the sequence audit still reads a booked tainted row");
});
test("SOURCE 2.44 a tainted position is still excluded from the statistics and never counts as an SL step", () => {
  assert.ok(pcpCode.includes("if(!tainted) StatsAdd("));
  const t = pcpCode.slice(pcpCode.indexOf("if(tainted)\n"), pcpCode.indexOf("else if(isSL)"));
  assert.ok(!t.includes("g_seq++"));
});

// model of the rules (same arithmetic as the EA)
const book = (L, net) => { L.net = Math.round((L.net + net) * 1e8) / 1e8; L.trades++; if (net < 0) L.losses += -net; L.acc = L.net < 0 ? -L.net : 0; return L; };
const nextRisk = (L, init, target, rr) => { if (Math.abs(L.net) <= 1e-9) return init; const rem = target - L.net; if (rem <= 1e-9) return init; let r = rem / rr; if (L.net > 0 && r < init) r = init; return r; };
const mixed = (net, count = true) => (!count ? { book: false, v: 0 } : net < 0 ? { book: true, v: net } : { book: false, v: 0 });
test("MODEL Netting mixed position: loss booked in full, profit never credited, option off = old behaviour", () => {
  assert.deepEqual(mixed(-50), { book: true, v: -50 });
  assert.deepEqual(mixed(30), { book: false, v: 0 });
  assert.deepEqual(mixed(0), { book: false, v: 0 });
  assert.deepEqual(mixed(-50, false), { book: false, v: 0 });
  const L = { net: -20, trades: 1, losses: 20, acc: 20 };
  const m = mixed(40); if (m.book) book(L, m.v);
  assert.equal(L.acc, 20, "a mixed profit does not repay the debt");
  const m2 = mixed(-15); if (m2.book) book(L, m2.v);
  assert.equal(L.acc, 35, "a mixed loss is never dropped");
});
test("MODEL stop with a floating loss: the realised loss enters the debt, START continues the SAME cycle, next risk covers it", () => {
  const L = { net: 0, trades: 0, losses: 0, acc: 0 };
  book(L, -20); assert.equal(L.acc, 20);
  book(L, -35.5);                                   // closed by STOP
  assert.equal(L.acc, 55.5);
  assert.equal(nextRisk(L, 20, 20, 20), (55.5 + 20) / 20 * 1 ** 0);
});
test("MODEL target reached while stopped: the cycle is closed by START (recorded once), the next cycle is empty", () => {
  const L = { net: -30, trades: 3, losses: 30, acc: 30 };
  book(L, 55);                                      // STOP closed a winner: 25 >= target 20
  assert.ok(L.net >= 20 - 1e-6);
  const cycleNet = L.net; L.net = 0; L.acc = 0; L.trades = 0; L.losses = 0;       // CycleFinishLedger + ResetRisk
  assert.equal(cycleNet, 25); assert.equal(L.acc, 0);
  assert.equal(nextRisk(L, 20, 20, 20), 20);
});

// ------------------------------------------------------------ problem 2: 20+ losses, restart, limits
test("MODEL 25 consecutive losses, a restart after each of them: the debt is exactly the sum of the losses and never resets", () => {
  let L = { net: 0, trades: 0, losses: 0, acc: 0 }, sum = 0, risk = 20;
  for (let i = 1; i <= 25; i++) {
    const loss = -risk; sum += risk; book(L, loss);
    L = JSON.parse(JSON.stringify(L));              // restart: saved variables are reloaded
    assert.ok(Math.abs(L.acc - sum) < 1e-6, "debt after loss " + i);
    risk = nextRisk(L, 20, 20, 1);          // RR 1: risk = debt + target
  }
  assert.equal(L.trades, 25);
  assert.ok(risk > 20 * 1000, "the risk keeps growing: no loss COUNT stops the cycle");
});
test("SOURCE 2.44 no lot / margin condition clears the debt: the guards only return a WAITING_* code", () => {
  const f = ea.slice(ea.indexOf("void HandleLotError("), ea.indexOf("bool AllNeededPlaced()"));
  assert.ok(!/ResetRisk|g_accLoss\s*=|g_cycNet\s*=|g_seq\s*=/.test(f));
  assert.ok(/RISK_ABOVE_VOLUME_LIMIT[^]*WAITING_VOLUME/.test(ea) && ea.includes('return "WAITING_MARGIN"'));
});
test("SOURCE 2.44 explicit Reset still needs confirm=1 and the implicit paths never clear a debt (unchanged)", () => {
  assert.ok(ea.includes("RESET_REFUSED") && ea.includes("ImplicitResetGuarded"));
});

// ------------------------------------------------------------ problem 3: the user SEES REQUIRED_RECOVERY and the real command state
test("SOURCE 2.44 the EA state JSON carries REQUIRED_RECOVERY (rec.hold / rec.why)", () => {
  assert.ok(/s\+=",\\"rec\\":"\+\(g_recHold\?/.test(ea));
});
test("WORKER REQUIRED_RECOVERY reaches the app state, sanitised; without a hold there is no rec", async () => {
  const b = boot(), h = await session(b);
  await b.sync("123456", { state: { price: 2400.5, run: true, state: "ARMED", hist: [], orders: [], waits: [], tick: 0.01, pt: 0.01, rec: { hold: true, why: "The broker holds 2 pending order(s) that do not match the saved state" } } });
  let st = await b.call("/state", { method: "GET", headers: h });
  assert.equal(st.j.rec.hold, true); assert.match(st.j.rec.why, /do not match the saved state/);
  await b.sync("123456", { state: { price: 2400.5, run: true, state: "ARMED", hist: [], orders: [], waits: [], tick: 0.01, pt: 0.01, rec: null } });
  st = await b.call("/state", { method: "GET", headers: h });
  assert.equal(st.j.rec, undefined);
});
test("UI the app shows a REQUIRED_RECOVERY banner and a per-command status strip", () => {
  assert.ok(app.includes('S.rec&&S.rec.hold') && app.includes('t("rcvT")') && app.includes("cmdStrip()+h"));
});
const stripSrc = app.slice(app.indexOf("function cmdStrip(){"), app.indexOf("function renderDash(){"));
function strip(S) { const ctx = { S, t: (k) => k, trEA: (x) => x, esc: (x) => String(x == null ? "" : x), Date: { now: () => 1000000 }, console }; vm.createContext(ctx); vm.runInContext(stripSrc + "\nthis.out=cmdStrip();", ctx); return ctx.out; }
test("UI command status: queued / received / executed / refused / expired / rejected / unconfirmed are all distinguishable", () => {
  const now = 1000000, row = (id, st, ago = 5000) => ({ id, cmd: "start", st, why: "", t: now - ago, u: now - ago });
  assert.match(strip({ cmdStatus: [row("a", "queued")] }), /cs_queued/);
  assert.match(strip({ cmdStatus: [row("a", "delivered")] }), /cs_delivered/);
  assert.match(strip({ cmdStatus: [row("a", "delivered")], lastCmd: { id: "a", ok: true } }), /cs_done/);
  assert.match(strip({ cmdStatus: [row("a", "delivered")], lastCmd: { id: "a", ok: false } }), /cs_fail/);
  assert.match(strip({ cmdStatus: [row("a", "delivered", 130000)] }), /cs_unk/);
  assert.match(strip({ cmdStatus: [row("a", "expired", 300000)] }), /cs_expired/);
  assert.match(strip({ cmdStatus: [row("a", "rejected", 300000)] }), /cs_rejected/);
  assert.equal(strip({ cmdStatus: [row("a", "delivered", 400000)], lastCmd: { id: "a", ok: true } }), "", "old successful rows disappear");
  assert.equal(strip({}), "");
});
test("UI each command shows ITS OWN result (bound to its id); a later command never changes an earlier one; unconfirmed is not a failure", () => {
  const now = 1000000, row = (id, st, extra = {}, ago = 5000) => ({ id, cmd: "start", st, why: "", t: now - ago, u: now - ago, ...extra });
  const out = strip({ cmdStatus: [row("A", "delivered", { res: "executed" }, 150000), row("B", "delivered", { res: "failed", rtext: "Trading not allowed" }, 20000)], lastCmd: { id: "B", ok: false, text: "x" } });
  assert.match(out, /cs_done/); assert.match(out, /cs_fail · Trading not allowed/);
  assert.equal((out.match(/cs_fail/g) || []).length, 1, "only B failed");
  assert.match(strip({ cmdStatus: [row("A", "delivered", { res: "waiting" })] }), /cs_wait/);
  assert.ok(!/cs_fail/.test(strip({ cmdStatus: [row("A", "delivered", { res: "executed" }, 100000)], lastCmd: { id: "ZZ", ok: false, text: "other" } })), "an unrelated lastCmd never turns an executed command into a failure");
  assert.ok(!/cs_unk/.test(strip({ cmdStatus: [row("A", "delivered", {}, 90000)] })), "under 120 s without a result is still just 'received'");
  assert.match(strip({ cmdStatus: [row("A", "delivered", {}, 130000)] }), /cs_unk/);
});
test("WORKER the execution result of EVERY command is stored by id in the persistent ledger (not only lastCmd), and survives later syncs", async () => {
  const b = boot(), h = await session(b);
  const a = await b.call("/command", { headers: h, body: { cmd: "stop" } }), c = await b.call("/command", { headers: h, body: { cmd: "start" } });
  const base = { price: 2400.5, run: false, state: "STOPPED", hist: [], orders: [], waits: [], tick: 0.01, pt: 0.01 };
  await b.sync("123456", { ack: [a.j.id, c.j.id], state: { ...base, cmds: [{ id: c.j.id, cmd: "start", ok: false, st: "fail", text: "START FAILED Reason: AutoTrading is disabled." }, { id: a.j.id, cmd: "stop", ok: true, st: "ok", text: "STOP EXECUTED" }], lastCmd: { id: c.j.id, ok: false, text: "START FAILED" } } });
  await b.sync("123456", { state: { ...base, cmds: [], lastCmd: { id: "other", ok: true, text: "x" } } });   // a later sync no longer lists them: the ledger keeps the results
  const st = await b.call("/state", { method: "GET", headers: h });
  const ra = st.j.cmdStatus.find((x) => x.id === a.j.id), rc = st.j.cmdStatus.find((x) => x.id === c.j.id);
  assert.equal(ra.res, "executed"); assert.equal(rc.res, "failed"); assert.match(rc.rtext, /AutoTrading/);
  assert.equal(ra.st, "delivered");
});
test("WORKER an EA entry for a command this Worker never issued, or for an expired one, creates / changes nothing", async () => {
  const b = boot(), h = await session(b);
  await b.sync("123456", { state: { price: 2400.5, run: false, state: "STOPPED", hist: [], orders: [], waits: [], tick: 0.01, pt: 0.01, cmds: [{ id: "ghost", cmd: "stop", ok: true, st: "ok", text: "ok" }] } });
  const st = await b.call("/state", { method: "GET", headers: h });
  assert.ok(!(st.j.cmdStatus || []).some((x) => x.id === "ghost"));
});
test("UI an expired / rejected command of this session raises its own toast (not only the 12 s 'unverified' timeout)", () => {
  assert.ok(app.includes('x.st==="expired"||x.st==="rejected"') && app.includes('t(x.st==="expired"?"cmdExp":"q_full")'));
});

// ---- helpers
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
