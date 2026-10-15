// v4.21 / EA 2.33: (1) fast-lane governor, (2) measurement, (3) Cloudflare request budget.
// EA checks read the source (they do NOT prove it compiles - F7 in MetaEditor - or behaves - demo account first). Worker checks run the real Worker code against the DO mock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boot } from "./harness.mjs";

const ea = readFileSync(new URL("../ea/Yetimmm.mq5", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const LOGIN = "123456";

async function setup(extra = {}) {
  const b = boot(extra);
  assert.equal((await b.sync(LOGIN, { state: { price: 2400.5, ask: 2400.7, run: true, state: "ARMED" } })).s, 200);
  const sess = (await b.signIn(LOGIN)).j.sess;
  const lite = (px, more = {}) => b.call("/api/ea/sync", { body: { login: LOGIN, srv: "Broker-Live", lite: true, px, ack: [], ...more }, headers: { "X-EA-Secret": b.eas[LOGIN] } });
  const px = (m) => b.call("/px" + (m ? "?m=" + m : ""), { method: "GET", headers: b.auth(LOGIN, sess) });
  const state = (m) => b.call("/state" + (m ? "?m=" + m : ""), { method: "GET", headers: b.auth(LOGIN, sess) });
  return { b, sess, lite, px, state };
}

// ── (1) the lane no longer blocks the trading thread more than a bounded share ─────────────────────────────────────────────────────────────────────────────────
test("EA: duty rule by market zone, adaptive timeout and circuit breaker replace the fixed 1/3 rule", () => {
  const f = ea.slice(ea.indexOf("void BridgeLite()"), ea.indexOf("int g_timerCount=0;"));
  assert.ok(f.includes("100.0*(double)g_brRtt/duty"), "interval >= rtt x 100 / duty%");
  assert.ok(!/g_brRtt\*3/.test(f), "the old 33 % rule is gone");
  assert.match(f, /double duty=\(zone==0\)\?cool:\(\(zone==1\)\?MathMax\(3\.0,cool\/3\.0\):3\.0\)/);
  assert.ok(f.includes("if(DutyPct()>duty) return;"), "measured rolling share is enforced too");
  assert.match(f, /int to=\(g_brRtt==0\)\?800:MathMax\(350,MathMin\(cap,rr\*2\+200\)\)/);
  assert.match(f, /cap=\(zone==2\)\?600:1000/);
  assert.match(f, /el>\(ulong\)MathMax\(300,InpBrLaneMaxMs\)[\s\S]*g_laneOffUntil=/);
  assert.ok(f.includes("now<g_laneOffUntil"), "a tripped breaker blocks the lane");
});
test("EA: zones - hot (trigger / momentum / order being placed), warm (3x near distance), cool", () => {
  const z = ea.slice(ea.indexOf("int LaneZone()"), ea.indexOf("void BridgeLite()"));
  assert.ok(z.includes("NetHotNow()") && z.includes("g_sync[0]==YS_CREATING || g_sync[1]==YS_CREATING"));
  assert.match(z, /3\.0\*\(double\)MathMax\(1,InpTurboNearPts\)\*g_point/);
  assert.match(z, /return 2;[\s\S]*return 1;[\s\S]*return 0;/);
});
test("EA: lane protections of v2.32 are all still there (first sync, pairing, second copy, https only, backoff)", () => {
  const f = ea.slice(ea.indexOf("void BridgeLite()"), ea.indexOf("int g_timerCount=0;"));
  assert.ok(f.includes("!g_brOk || g_brFirst || g_brPairNeed || g_dupSince>0 || g_halt"));
  assert.ok(f.includes('StringFind(lo,"https://")!=0'));
  assert.ok(f.includes("now<g_brNetBackoffUntil"));
  assert.match(f, /BrRttNote\(el\);\s*DutyNote\(el\);/);
});
test("EA: new inputs exist with safe defaults, version bumped", () => {
  assert.match(ea, /input int\s+InpBrMaxDutyPct\s*=\s*25;/);
  assert.match(ea, /input int\s+InpBrLaneMaxMs\s*=\s*900;/);
  assert.match(ea, /input int\s+InpBrLaneSuspendSec\s*=\s*20;/);
  assert.match(ea, /input int\s+InpBrFastMs\s*=\s*300/);
});
test("EA: duty accounting helpers are declared before first use", () => {
  const pos = (x) => ea.indexOf(x);
  assert.ok(pos("void DutyNote(const ulong ms)") > 0 && pos("void DutyNote(const ulong ms)") < pos("void BridgeLite()"));
  assert.ok(pos("void PfAdd(double &ring[]") < pos("PfAdd(g_pfTrig,g_pfTrign"), "trigger->send sample is recorded after PfAdd is declared");
  assert.ok(pos("void BrHints(const string resp)") < pos("BrHints(resp);"));
  assert.ok(pos("string PerfJson()") < pos("string BrStateJson()"));
});

// ── (2) measurement: the improvement is measured, not claimed ──────────────────────────────────────────────────────────────────────────────────────────────────
test("EA: measures command latency (lane vs full sync), execution time, trigger->send and round trip, and publishes them", () => {
  assert.match(ea, /if\(JDbl\(seg,"ams",ams\)\)[\s\S]*viaLane\) PfAdd\(g_pfCmdL,g_pfCmdLn,lat\); else PfAdd\(g_pfCmdF,g_pfCmdFn,lat\)/);
  assert.ok(ea.includes("PfAdd(g_pfExec,g_pfExecn,(double)(GetTickCount64()-ex0))"));
  assert.ok(ea.includes("PfAdd(g_pfTrig,g_pfTrign,(double)latMs)"));
  assert.ok(ea.includes('s+=",\\"perf\\":"+PerfJson();'));
  for (const k of ["cmdL", "cmdF", "exec", "trig", "rttS", "duty", "blk", "susp"]) assert.ok(ea.includes('\\"' + k + '\\":'), k);
});
test("Worker: every command carries its queue time in ms (ams) so the EA can measure arrival latency", async () => {
  const { b, sess, lite } = await setup();
  const c = await b.call("/command", { body: { cmd: "start" }, headers: b.auth(LOGIN, sess) });
  assert.equal(c.s, 200);
  await new Promise((r) => setTimeout(r, 30));
  const r = await lite({ p: 2400.6, a: 2400.8 });
  assert.equal(r.j.commands.length, 1);
  assert.ok(r.j.commands[0].ams >= 25 && r.j.commands[0].ams < 5000, "ams = " + r.j.commands[0].ams);
  assert.equal(typeof r.j.commands[0].age, "number");
});
test("Worker: the EA's perf block reaches the app as plain numbers only (no markup, no unknown keys)", async () => {
  const b = boot();
  await b.sync(LOGIN, { state: { price: 1, run: true, state: "ARMED", perf: { fast: 1, on: 1, rtt: 120, duty: "9.5", blk: 300, evil: "<img onerror=x>", cmdL: { n: 5, p50: 180, p95: "<script>" }, trig: { n: 2, p50: 40, p95: 90 } } } });
  const s = (await b.signIn(LOGIN)).j.sess;
  const st = (await b.state(LOGIN, s)).j;
  assert.equal(st.perf.rtt, 120);
  assert.equal(st.perf.duty, 9.5);
  assert.equal(st.perf.evil, undefined);
  assert.equal(st.perf.cmdL.p95, 0, "non numeric -> 0");
  assert.equal(st.perf.cmdL.p50, 180);
  assert.ok(!JSON.stringify(st.perf).includes("<"));
});

// ── (3) Cloudflare budget ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("Worker: the lane runs full speed only while the user interacts; watching = slower hint; idle = lane off", async () => {
  const { lite, px } = await setup();
  await px("A");
  let r = await lite({ p: 1, a: 1 });
  assert.equal(r.j.fast, true); assert.equal(r.j.fm, 300); assert.equal(r.j.ia, true);
  await px("B");
  r = await lite({ p: 1, a: 1 });
  assert.equal(r.j.fast, true); assert.equal(r.j.fm, 800); assert.equal(r.j.ia, false);
  await px("C");
  r = await lite({ p: 1, a: 1 });
  assert.equal(r.j.fast, false, "idle app: no fast lane");
  await px();                                            // an older app sends no ?m= and keeps the 4.20 behaviour
  r = await lite({ p: 1, a: 1 });
  assert.equal(r.j.fast, true); assert.equal(r.j.fm, 300);
});
test("Worker: with the budget disabled (paid plan, DAILY_REQ_BUDGET=0) the pace factor stays 1 under any load", async () => {
  const { b, lite } = await setup({ DAILY_REQ_BUDGET: "0" });
  const h = b.hubOf(LOGIN);
  for (let i = 0; i < 400; i++) await lite({ p: 1 + i, a: 2 + i });
  h.pfAt = 0; await lite({ p: 1, a: 1 });
  assert.equal(h.pf, 1);
});
test("Worker: a tight budget slows everything smoothly (factor grows, lane off at 4x, full sync hint <= 5 s) and relaxes when the load drops", async () => {
  const { b, lite, px, state } = await setup({ DAILY_REQ_BUDGET: "3000", PACE_PLAN_HOURS: "6" });
  const h = b.hubOf(LOGIN);
  await px("A");
  for (let round = 0; round < 8; round++) {              // 8 x 60 calls inside the 5-minute window = a rate far above the allowance
    for (let i = 0; i < 60; i++) await lite({ p: 2400 + i, a: 2400.2 + i });
    h.pfAt = 0;                                          // let the governor evaluate (it runs every 20 s)
  }
  assert.ok(h.pf > 2, "pf " + h.pf);
  const r = await lite({ p: 1, a: 1 });
  assert.ok(r.j.fm >= 600, "lane hint follows the factor: " + r.j.fm);
  if (h.pf >= 4) assert.equal(r.j.fast, false);
  if (h.pf >= 2) assert.ok(r.j.sm >= 2 && r.j.sm <= 5, "sm " + r.j.sm);
  const g = await px("A");
  assert.ok(g.j.f >= 2 && g.j.f <= 8, "the app is told the factor: " + g.j.f);
  const s = await state("A");
  assert.ok(s.j.pace.f >= 2 && s.j.pace.n > 400 && s.j.pace.b === 3000);
  // load stops -> the factor decays on later evaluations (v4.23: shown with a budget that leaves a positive allowance; with a ~zero allowance every request re-eases, which is correct)
  const q = await setup({ DAILY_REQ_BUDGET: "60000" }), hq = q.b.hubOf(LOGIN);
  hq.pf = 6; hq.pfc = { f: 6, f2: 4, f3: 8 };
  const before = hq.pf;
  for (let i = 0; i < 6; i++) { hq.pfAt = 0; await q.state("A"); }
  assert.ok(hq.pf < before, "relaxed " + before + " -> " + hq.pf);
});
test("Worker: the daily counter restarts at the UTC day change and a spent budget pins the factor at 8", async () => {
  const { b, state } = await setup({ DAILY_REQ_BUDGET: "100000" });
  const h = b.hubOf(LOGIN);
  h.rq.n = 99999; h.pfAt = 0; await state("A");
  assert.equal(h.pf, 8);
  h.rq.d -= 1; h.pfAt = 0; await state("A");              // yesterday's counter
  assert.equal(h.rq.n, 1);
  assert.equal(h.pf, 1);
});
test("Worker: counting requests never writes for an account that was never verified (v4.18 rule kept)", async () => {
  const b = boot();
  for (let i = 0; i < 80; i++) await b.call("/state", { method: "GET", headers: { "X-Login": "777777", "X-Session": "x" } });
  const o = b.env.HUB.get("acc-777777").__o;
  assert.equal(o.__st ? o.__st.m.size : (o.ctx.storage.m.size), 0);
});
test("app: activity tiers, pace factor, no fixed intervals left, performance card typed", () => {
  assert.match(app, /mode\(\)\{const ia=Date\.now\(\)-this\.tAt;return\(Ops\.active\(\)\|\|ia<45000\)\?"A":ia>300000\?"C":"B"\}/);
  assert.match(app, /\/state\?m="\+this\.mode\(\)/);
  assert.match(app, /\/px\?m="\+this\.mode\(\)/);
  assert.ok(!/setInterval\(\(\)=>\{if\(!document\.hidden&&Login\.has\(\)&&Verify\.ok\)Bridge\.(pull|px)/.test(app), "no fixed pull/px interval");
  assert.match(app, /Bridge\.loop\(Bridge\.pull,Bridge\.dState\);Bridge\.loop\(Bridge\.px,Bridge\.dPx\)/);
  assert.match(app, /if\(!document\.hidden&&Login\.has\(\)&&Verify\.ok\)await fn\.call\(this\)/);
  assert.match(app, /function perfRows\(\)/);
  assert.ok(app.includes('row("pfReq"'));
});

// ── (3b) the EA's own 1 s full sync is 86,400 requests/day even with the app closed ───────────────────────────────────────────────────────────────────────────
test("Worker: nobody looking -> the EA is asked for a slower full sync; an open app, an armed order alert or IDLE_SYNC_SEC=1 keep 1 s", async () => {
  const { b, sess, lite, px } = await setup();
  const h = b.hubOf(LOGIN);
  h.appAt = 0;
  let r = await lite({ p: 1, a: 1 });
  assert.equal(r.j.sm, 3, "default idle full sync = 3 s");
  assert.equal(r.j.fast, false);
  await px("A");
  r = await lite({ p: 1, a: 1 });
  assert.equal(r.j.sm, undefined, "an app is looking: back to 1 s");
  // an armed order alert needs the 1 s granularity (its miss counter is counted in syncs)
  await b.sync(LOGIN, { state: { price: 2400, run: true, state: "ARMED", orders: [{ ticket: 111, side: "BUY", price: 2390, lot: 0.1, sl: 2380, tp: 2420 }] } });
  const al = await b.call("/order-alert", { headers: b.auth(LOGIN, sess), body: { key: "t111", enabled: true } });
  assert.equal(al.j.ok, true);
  h.appAt = 0;
  r = await lite({ p: 1, a: 1 });
  assert.equal(r.j.sm, undefined, "armed alert keeps the 1 s sync");
  // idle slow-down switched off
  const o = await setup({ IDLE_SYNC_SEC: "1" });
  o.b.hubOf(LOGIN).appAt = 0;
  assert.equal((await o.lite({ p: 1, a: 1 })).j.sm, undefined);
});
test("EA: a waiting notification bypasses the Worker's slow-down hint (no delayed SL / TP messages)", () => {
  assert.ok(ea.includes("int syncGap=g_evNow?MathMax(1,InpBrPollSec):MathMax(MathMax(1,InpBrPollSec),g_brHintSyncSec);"));
  assert.ok(ea.includes("g_evNow=true;"));
  assert.ok(ea.indexOf("bool     g_evNow=false;") < ea.indexOf("g_evNow=true;"), "declared before EvEmit uses it");
});
