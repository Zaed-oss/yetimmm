// v4.23 — unified daily request budget: 12-hour plan, reserve, priority classes, proactive governor, shared counter, honest numbers.
// Three layers of evidence:
//   A) the pure planner (worker/budget.js) on its own,
//   B) 12-hour / 24-hour SIMULATIONS on a VIRTUAL CLOCK (a client model that uses the same intervals as app.js and the Worker's hints; no real waiting),
//   C) the REAL Worker code against the Durable Object mock (classes, shared counter, conditional state, restart, midnight, Cloudflare reconcile).
// They do not replace a measurement on the deployed Worker: compare the app's budget panel with the Cloudflare dashboard (docs/V4.23-BUDGET.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boot } from "./harness.mjs";
import { budgetCfg, Rates, plan, stepFactor, classFactors, levelOf, warnOf, honestUsed, hubAllowance, readCloudflare, PF_MAX, PF_UP, DAY_MS, HOUR_MS } from "../worker/budget.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const wk = readFileSync(new URL("../worker/worker.js", import.meta.url), "utf8");
const LOGIN = "123456";

// ═══ A) pure planner ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test("config: the internal budget can never reach the real limit; 0 switches the governor off; v4.21 names still work; default plan is 12 h", () => {
  const d = budgetCfg({}, {});
  assert.equal(d.limit, 100000); assert.equal(d.budget, 80000); assert.equal(d.planHours, 12); assert.equal(d.reservePct, 12); assert.equal(d.enabled, true);
  const hi = budgetCfg({ DAILY_REQ_BUDGET: "100000" });
  assert.equal(hi.budget, 90000); assert.equal(hi.clamped, true, "asking for the whole limit is clamped to 90 %");
  assert.equal(budgetCfg({ DAILY_REQ_BUDGET: "95000", EXTERNAL_REQ_DAILY: "20000" }).budget, 70000, "other services on the same account shrink the usable budget");
  assert.equal(budgetCfg({ DAILY_REQ_BUDGET: "400000", CF_DAILY_LIMIT: "1000000" }).budget, 400000, "a paid plan with its real limit may use more");
  assert.equal(budgetCfg({ DAILY_REQ_BUDGET: "0" }).enabled, false);
  assert.equal(budgetCfg({ PACE_PLAN_HOURS: "6" }).planHours, 6, "the v4.21 variable name is still understood");
  assert.equal(budgetCfg({ PLAN_HOURS: "99" }).planHours, 24);
  assert.equal(budgetCfg({ CLASS_SHARE: "1,1,1" }).share.length, 3);
  assert.equal(budgetCfg({ RESERVE_PCT: "80" }).reservePct, 50, "the reserve is bounded");
});
test("plan: the allowance is what is REALLY left after the reserve and the EA's idle sync for the rest of the day, spread over the session", () => {
  const day0 = Math.floor(Date.now() / DAY_MS) * DAY_MS, base = { used: 0, budget: 80000, reservePct: 12, planHours: 12, idleReqH: 1200, rates: { m5: 0, m15: 0, m60: 0, eff: 0 } };
  const a = plan({ ...base, now: day0 });                                  // 00:00 UTC
  assert.equal(a.Cn, 70400); assert.equal(a.R, 9600); assert.equal(a.T, 12); assert.equal(a.baseline, 14400);
  assert.equal(a.allowH, Math.round((70400 - 14400) / 12));
  const b = plan({ ...base, now: day0 + 12 * HOUR_MS });                   // noon: 12 h left, session = rest of the day, no idle tail to reserve
  assert.equal(b.baseline, 0); assert.equal(b.allowH, Math.round(70400 / 12));
  const c = plan({ ...base, used: 40000, now: day0 + 12 * HOUR_MS });
  assert.equal(c.left, 30400); assert.equal(c.allowH, Math.round(30400 / 12), "re-planned from what is left, not from the morning's plan");
  const d = plan({ ...base, used: 75000, now: day0 + 6 * HOUR_MS });
  assert.equal(d.left, 0); assert.equal(d.reserveUsed, 4600); assert.equal(d.allowH, 0);
  assert.equal(c.resetAt, day0 + DAY_MS, "reset = next 00:00 UTC");
  const e = plan({ ...base, now: day0 + 23.9 * HOUR_MS });
  assert.ok(e.T >= 0.25 && e.hLeft < 0.2, "the session cannot outlive the UTC day");
});
test("plan: projections at 3 / 6 / 12 h and the time to the ceiling follow the blended rate", () => {
  const day0 = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const p = plan({ now: day0 + 2 * HOUR_MS, used: 10000, budget: 80000, reservePct: 12, planHours: 12, idleReqH: 1200, rates: { m5: 5000, m15: 5000, m60: 5000, eff: 5000 } });
  assert.deepEqual(p.p3h, [25000, 40000, 70000]);
  assert.equal(p.etaH, 12.1);
  const q = plan({ now: day0 + 20 * HOUR_MS, used: 10000, budget: 80000, reservePct: 12, planHours: 12, idleReqH: 1200, rates: { m5: 5000, m15: 5000, m60: 5000, eff: 5000 } });
  assert.deepEqual(q.p3h, [25000, 30000, 30000], "a projection never runs past midnight (4 h left)");
});
test("governor: eases BEFORE the allowance is reached, in bounded steps, holds while the long windows still say too much, releases slowly", () => {
  const p = { left: 50000, allowH: 4000 };
  assert.equal(stepFactor(1, p, { m5: 3000, m15: 3000, eff: 3000 }), 1, "75 % of the allowance: nothing yet");
  const first = stepFactor(1, p, { m5: 3600, m15: 3600, eff: 3600 });      // 90 %: already easing (proactive)
  assert.ok(first > 1 && first <= PF_UP, "eased at 90 % of the allowance, one small step: " + first);
  assert.ok(stepFactor(1, p, { m5: 40000, m15: 40000, eff: 40000 }) <= PF_UP, "even a huge overload moves at most one bounded step per evaluation");
  assert.equal(stepFactor(3, p, { m5: 1000, m15: 1000, eff: 5000 }), 3, "the hour window still shows an overload: hold");
  const rel = stepFactor(3, p, { m5: 1000, m15: 1000, eff: 1500 });
  assert.ok(rel < 3 && rel >= 3 * 0.9, "release is slow (8 % per step): " + rel);
  assert.equal(stepFactor(1.2, p, { m5: 100, m15: 100, eff: 100 }) < 1.2, true);
  assert.equal(stepFactor(1.04, p, { m5: 100, m15: 100, eff: 100 }), 1, "snaps to exactly 1 when almost there");
  assert.equal(stepFactor(2, { left: 0, allowH: 0 }, { m5: 0, m15: 0, eff: 0 }), PF_MAX, "ceiling spent -> floor");
  assert.equal(stepFactor(1, p, { m5: 0, m15: 0, eff: 0 }, true), PF_MAX, "internal budget spent -> floor");
});
test("a one-minute spike does not slow the whole system (no cliff), a sustained overload does", () => {
  const day0 = Math.floor(Date.now() / DAY_MS) * DAY_MS, r = new Rates(day0);
  let pf = 1; const base = 3000;                                            // 3,000 requests/hour = 50/min: below the allowance of ~4,667
  let maxPf = 1;
  for (let m = 0; m < 90; m++) for (const s of [0, 20, 40]) { const t = day0 + m * 60000 + s * 1000; r.add(t, (m === 60 ? 700 : 50) / 3); pf = stepFactor(pf, { left: 60000, allowH: 4667 }, r.all(t), false); maxPf = Math.max(maxPf, pf); }
  assert.ok(maxPf <= 1.05, "a 700-request minute inside a calm hour does not move the factor: " + maxPf);
  let pf2 = 1; const r2 = new Rates(day0);
  for (let m = 0; m < 50; m++) for (const s of [0, 20, 40]) { const t = day0 + m * 60000 + s * 1000; r2.add(t, 50); pf2 = stepFactor(pf2, { left: 60000, allowH: 4667 }, r2.all(t), false); }
  assert.ok(pf2 > 2, "9,000/hour for 50 minutes is a trend: pf " + pf2);
});
test("class factors: cosmetic (p3) is slowed first and hardest, operational (p2) gently, and p1 is not part of the factor set at all", () => {
  const one = classFactors(1, { p3: 0 }, [0.55, 0.25, 0.2], 70000);
  assert.deepEqual(one, { f: 1, f2: 1, f3: 1 });
  const t = classFactors(3, { p1: 0, p2: 0, p3: 0 }, [0.55, 0.25, 0.2], 70000);
  assert.ok(t.f3 > t.f && t.f > t.f2 && t.f2 > 1, JSON.stringify(t));
  const eps = classFactors(1.03, { p3: 0 }, [0.55, 0.25, 0.2], 70000);
  assert.ok(eps.f3 < 1.1 && eps.f2 < 1.05, "continuous: a 3 % pace step is not a 50 % jump " + JSON.stringify(eps));
  assert.ok(!("f1" in t) && !("p1" in t), "no factor exists for trading-critical traffic");
  const over = classFactors(3, { p3: 70000 * 0.2 * 1.2 }, [0.55, 0.25, 0.2], 70000);
  assert.ok(over.f3 > t.f3, "a class that already used more than its planned share is slowed a little more");
  assert.ok(classFactors(8, {}, [0.55, 0.25, 0.2], 1).f3 <= 10 && classFactors(8, {}, [0.55, 0.25, 0.2], 1).f2 <= 6);
});
test("honest numbers: overhead and calibration only ever raise the reading, Cloudflare's own number is a floor, and hubs share fairly", () => {
  assert.equal(honestUsed({ own: 1000, overheadPct: 8 }), 1080);
  assert.equal(honestUsed({ own: 1000, others: 500, overheadPct: 0 }), 1500);
  assert.equal(honestUsed({ own: 1000, overheadPct: 0, calib: 0.5 }), 1000, "calibration below 1 is ignored: a lower number is never invented");
  assert.equal(honestUsed({ own: 1000, overheadPct: 8, cfReq: 5000 }), 5000, "Cloudflare reports more: that wins");
  assert.equal(honestUsed({ own: 1000, overheadPct: 8, cfReq: 200 }), 1080, "Cloudflare (lagging) reports less: the internal estimate is NOT lowered");
  assert.equal(hubAllowance(4000, 1, 0), 4000);
  assert.equal(hubAllowance(4000, 2, 0), 4000, "the other hub is idle: this one may use everything");
  assert.equal(hubAllowance(4000, 2, 3500), 2000, "the other hub uses a lot: at least an equal share is guaranteed");
  assert.equal(hubAllowance(4000, 4, 3900), 1000);
  assert.deepEqual([warnOf(49000, 100000), warnOf(50000, 100000), warnOf(75000, 100000), warnOf(96000, 100000)], [0, 1, 2, 4]);
  assert.equal(levelOf(1, 100, { B: 1000, left: 500, eff: 0, allowH: 100 }).st, "normal");
  assert.equal(levelOf(3, 100, { B: 1000, left: 500, eff: 0, allowH: 100 }).st, "saving");
  assert.equal(levelOf(1, 900, { B: 1000, left: 0, eff: 0, allowH: 0 }).st, "reserve");
  assert.equal(levelOf(8, 1000, { B: 1000, left: 0, eff: 0, allowH: 0 }).st, "exhausted");
});

// ═══ B) 12 h / 24 h simulations on a virtual clock ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The client model uses the numbers of app.js (checked against the source below) and the Worker's hints (f3 = lane / px, f2 = state, full sync <= 5 s).
const TIER = { A: { px: 500, st: 1500, lane: 300 }, B: { px: 1500, st: 4000, lane: 800 }, C: { px: 4000, st: 10000, lane: 0 } };
function simulate({ hours = 24, mode = () => null, hubs = 1, shared = true, env = {}, burst = null, startHour = 0 }) {
  const bc = budgetCfg(env), day0 = Math.floor(Date.now() / DAY_MS) * DAY_MS + startHour * HOUR_MS, dt = 10;
  const H = Array.from({ length: hubs }, () => ({ r: new Rates(day0), pf: 1, own: 0, c: { p1: 0, p2: 0, p3: 0 }, fc: { f: 1, f2: 1, f3: 1 } }));
  const out = { hubs: H, maxPf: 0, firstEase: null, series: [], steps: [] };
  for (let t = 0; t < hours * 3600; t += dt) {
    const now = day0 + t * 1000;
    const tot = shared ? H.reduce((a, h) => a + h.own, 0) : null;
    if (t % 20 === 0) for (const h of H) {
      const others = shared ? tot - h.own : 0, used = honestUsed({ own: h.own, others, overheadPct: bc.overheadPct });
      const R = h.r.all(now), p0 = plan({ now, used, budget: bc.budget, reservePct: bc.reservePct, planHours: bc.planHours, idleReqH: bc.idleReqH, hubs: shared ? hubs : 1, rates: R });
      const orate = shared ? H.filter((x) => x !== h).reduce((a, x) => a + x.r.rate(now, 5), 0) : 0;
      const p = { ...p0, allowH: shared ? hubAllowance(p0.allowH, hubs, orate) : p0.allowH };
      const prev = h.pf; h.pf = stepFactor(h.pf, p, R, used >= bc.budget); h.fc = classFactors(h.pf, h.c, bc.share, p.Cn);
      out.steps.push(prev > 0 ? h.pf / prev : 1);
      if (h === H[0]) { out.maxPf = Math.max(out.maxPf, h.pf); if (out.firstEase === null && h.pf > 1.05) out.firstEase = { t, used: h.own }; }
    }
    for (const h of H) {
      const m = mode(t / 3600, h), { f2, f3 } = h.fc, sec = h.pf >= 2 ? Math.min(5, Math.round(h.pf)) : 1;
      let syncSec = sec, lane = 0, px = 0, st = 0;
      if (m === null) syncSec = Math.max(sec, bc.idleReqH ? 3600 / bc.idleReqH : 3);
      else {
        const T = TIER[m]; syncSec = Math.max(sec, m === "A" ? 1 : m === "B" ? 2 : 3);
        px = 1000 / (T.px * f3); st = 1000 / (T.st * f2); if (T.lane && h.pf < 4) lane = 1000 / (T.lane * f3);
      }
      const c1 = dt / syncSec, c2 = dt * st, c3 = dt * (px + lane);
      let n = c1 + c2 + c3;
      if (burst && t >= burst.at * 3600 && t < burst.at * 3600 + 60 && h === H[0]) { const b = burst.n / 6; n += b; h.c.p3 += b; }
      h.own += n; h.c.p1 += c1; h.c.p2 += c2; h.c.p3 += c3; h.r.add(now, n);
    }
    if (t % 3600 === 0) out.series.push(Math.round(H.reduce((a, h) => a + h.own, 0)));
  }
  out.total = H.reduce((a, h) => a + h.own, 0); out.real = out.total * (1 + bc.overheadPct / 100); out.bc = bc;
  return out;
}
const Cn = (o) => o.bc.budget - Math.round(o.bc.budget * o.bc.reservePct / 100);

test("the model uses the real numbers: tier intervals of app.js and the Worker's EA hints", () => {
  assert.match(app, /pollMs:1500,pxMs:500/);
  assert.match(app, /m==="B"\?4000:10000/); assert.match(app, /m==="B"\?1500:4000/);
  assert.match(app, /paceIn\(p\)\{/);
  assert.ok(wk.includes('CONFIG.PACE_PLAN_HOURS'), "plan hours come from CONFIG");
  assert.match(wk, /PACE_PLAN_HOURS: 12,/); assert.match(wk, /WATCH_SYNC_SEC: 2,/); assert.match(wk, /IDLE_SYNC_SEC: 3,/);
});
test("SIM 1 — app + EA for 12 h (watching with a tap now and then), then 12 h idle: the day ends inside the ceiling with a measurable surplus", () => {
  const o = simulate({ mode: (h) => (h < 12 ? (Math.floor(h * 60) % 20 < 2 ? "A" : "B") : null) });
  assert.ok(o.real < Cn(o), `real ${Math.round(o.real)} < ceiling ${Cn(o)}`);
  const surplus = o.bc.budget - o.real;
  assert.ok(surplus >= o.bc.budget * 0.12, "the surplus (budget - use) covers at least the reserve: " + Math.round(surplus));
  assert.ok(o.bc.limit - o.real >= 20000, "and the real Cloudflare limit keeps a margin of at least 20,000: " + Math.round(o.bc.limit - o.real));
});
test("SIM 2 — 12 h of CONTINUOUS interaction (tier A all the time, the worst realistic case): budget lasts, easing starts early and moves in bounded steps", () => {
  const o = simulate({ mode: (h) => (h < 12 ? "A" : null) });
  assert.ok(o.real < Cn(o), `real ${Math.round(o.real)} < ceiling ${Cn(o)}`);
  assert.ok(o.maxPf > 2, "the governor really engaged: pf " + o.maxPf);
  assert.ok(o.firstEase && o.firstEase.t <= 1500 && o.firstEase.used < Cn(o) * 0.1, "easing began within ~25 minutes, at under 10 % of the ceiling (one hour of allowance is the grace): " + JSON.stringify(o.firstEase));
  assert.ok(Math.max(...o.steps) <= PF_UP + 1e-9 && Math.min(...o.steps) >= 0.85, "no step bigger than +25 % / smaller than -8 % per 20 s: " + Math.max(...o.steps) + " / " + Math.min(...o.steps));
  const hours = o.series.map((x, i, a) => x - (a[i - 1] || 0)).slice(1, 12);
  assert.ok(Math.max(...hours) < 30000, "the first hours are not the 27,000-an-hour of v4.22 forever: " + hours.join(","));
  assert.ok(o.series[3] < Cn(o) * 0.45, "after 3 hours well under half of the ceiling is gone (v4.22: the whole budget): " + o.series[3]);
});
test("SIM 3 — 12 h with the app open and NOBODY touching it (tier C after 5 minutes): the EA's baseline plus a trickle", () => {
  const o = simulate({ mode: (h) => (h < 12 ? (h < 0.1 ? "A" : "C") : null) });
  assert.ok(o.total < 48000, "total " + Math.round(o.total) + " (EA baseline 28,800 + the idle app's trickle)");
  assert.ok(o.maxPf <= 1.05, "no slow-down needed: pf " + o.maxPf);
});
test("SIM 4 — EA only, app closed all day: the full sync every 3 s, ~28,800 a day (it was 86,400)", () => {
  const o = simulate({ mode: () => null });
  assert.ok(Math.abs(o.total - 28800) < 50, "total " + Math.round(o.total));
});
test("SIM 5 — two accounts on the SAME Cloudflare account, both in a 12 h session: the shared total stays inside the ceiling (alone each would assume it owns the budget)", () => {
  const o = simulate({ hubs: 2, mode: (h) => (h < 12 ? "A" : null) });
  assert.ok(o.real < Cn(o) * 1.03 && o.real < o.bc.budget - o.bc.budget * 0.1, `shared real ${Math.round(o.real)}: within 3 % of the ceiling ${Cn(o)} and the reserve stays (>= 10 % of the budget free)`);
  const un = simulate({ hubs: 2, shared: false, mode: (h) => (h < 12 ? "A" : null) });
  assert.ok(un.real > o.real, `control: two hubs governing ALONE spend more (${Math.round(un.real)} vs ${Math.round(o.real)}) - the v4.22 design`);
});
test("SIM 5b — three accounts in a 12 h session is more than the free plan can carry (each EA alone needs 28,800 a day): the real Cloudflare limit is still never crossed", () => {
  const o = simulate({ hubs: 3, mode: (h) => (h < 12 ? "B" : null) });
  assert.ok(o.real < o.bc.limit, `real ${Math.round(o.real)} < limit ${o.bc.limit}`);
});
test("SIM 6 — a sudden burst of 3,000 requests in one minute: recovers on its own and the day still closes inside the ceiling", () => {
  const o = simulate({ burst: { at: 5, n: 3000 }, mode: (h) => (h < 12 ? "B" : null) });
  assert.ok(o.real < Cn(o));
  assert.ok(Math.max(...o.steps) <= PF_UP + 1e-9, "bounded steps even for a burst");
});
test("SIM 7 — the plan adapts when a session starts late: 12 h beginning at 10:00 UTC still fits (the plan is capped by the end of the day)", () => {
  const o = simulate({ hours: 14, startHour: 10, mode: () => "A" });
  assert.ok(o.real < o.bc.budget, "never over the internal budget: " + Math.round(o.real));
  assert.ok(o.real < o.bc.limit - 10000, "never near the real limit");
});
test("SIM 8 — a tiny budget reaches the floor and sits there instead of climbing without limit; the EA's 5 s sync is the only irreducible cost", () => {
  const o = simulate({ env: { DAILY_REQ_BUDGET: "8000" }, mode: () => "A", hours: 3 });
  assert.ok(o.maxPf >= 7.9, "floor reached " + o.maxPf);
  assert.ok(o.real < 8000, "three hours at the floor stay under the whole internal budget: " + Math.round(o.real));
});

// ═══ C) the real Worker ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function setup(extra = {}) {
  const b = boot(extra);
  assert.equal((await b.sync(LOGIN, { state: { price: 2400.5, ask: 2400.7, run: true, state: "ARMED" } })).s, 200);
  const sess = (await b.signIn(LOGIN)).j.sess;
  const lite = (px, more = {}) => b.call("/api/ea/sync", { body: { login: LOGIN, srv: "Broker-Live", lite: true, px, ack: [], ...more }, headers: { "X-EA-Secret": b.eas[LOGIN] } });
  const get = (path) => b.call(path, { method: "GET", headers: b.auth(LOGIN, sess) });
  return { b, sess, lite, get, h: b.hubOf(LOGIN) };
}
test("Worker: every call is counted AND classed - EA full sync / app command = p1, state = p2, price lane / light EA lane = p3, a light call that carries a command is re-classed to p1", async () => {
  const { b, sess, lite, get, h } = await setup();
  const c0 = { ...h.rq.c };
  await get("/state?m=A"); await get("/px?m=A"); await get("/px?m=A");
  assert.equal(h.rq.c.p2 - c0.p2, 1); assert.equal(h.rq.c.p3 - c0.p3, 2);
  const p3 = h.rq.c.p3; await lite({ p: 1, a: 1 }); assert.equal(h.rq.c.p3 - p3, 1, "an empty light call is cosmetic");
  const p1 = h.rq.c.p1; await b.sync(LOGIN, { state: { price: 2401, run: true, state: "ARMED" } }); assert.equal(h.rq.c.p1 - p1, 1, "the full sync is critical");
  const cmd = await b.call("/command", { body: { cmd: "start" }, headers: b.auth(LOGIN, sess) }); assert.equal(cmd.s, 200);
  assert.equal(h.rq.c.p1 - p1, 2, "an app command is critical");
  const q3 = h.rq.c.p3, q1 = h.rq.c.p1; const r = await lite({ p: 2, a: 2 }); assert.equal(r.j.commands.length, 1);
  assert.equal(h.rq.c.p3, q3, "the light call that DELIVERED the command is not cosmetic"); assert.equal(h.rq.c.p1, q1 + 1);
  assert.equal(h.rq.n, h.rq.c.p1 + h.rq.c.p2 + h.rq.c.p3, "classes always add up to the counter");
});
test("Worker: at the floor (pace factor 8) trading still works - commands are accepted and delivered, the full sync stays <= 5 s, only the cosmetic lane stops", async () => {
  const { b, sess, lite, get, h } = await setup({ DAILY_REQ_BUDGET: "1000" });
  await get("/px?m=A");
  h.rq.n = 5000; h.pfAt = 0; await get("/px?m=A");
  assert.equal(h.pf, 8);
  const c = await b.call("/command", { body: { cmd: "start" }, headers: b.auth(LOGIN, sess) });
  assert.equal(c.s, 200, "a user command is never refused by the budget");
  const r = await lite({ p: 1, a: 1 });
  assert.equal(r.j.commands.length, 1, "and is delivered on the next call");
  assert.equal(r.j.fast, false, "no fast lane at the floor"); assert.ok(r.j.sm >= 2 && r.j.sm <= 5, "full sync hint " + r.j.sm);
  const ack = await b.call("/api/ea/sync", { body: { login: LOGIN, srv: "Broker-Live", ack: [r.j.commands[0].id], state: { price: 2400, run: true, state: "ARMED" } }, headers: { "X-EA-Secret": b.eas[LOGIN] } });
  assert.equal(ack.s, 200); assert.equal(ack.j.ok, true, "confirmations still flow");
  const s = await get("/state?m=A"); assert.equal(s.s, 200); assert.equal(s.j.pace.st, "exhausted");
});
test("Worker: tier hints - interacting 1 s, only watching 2 s, idle app or no app 3 s; an armed order alert keeps 1 s in every tier", async () => {
  const { b, sess, lite, get, h } = await setup();
  const sm = async (m) => { if (m) await get("/px?m=" + m); else h.appAt = 0; return (await lite({ p: 1, a: 1 })).j.sm; };
  assert.equal(await sm("A"), undefined); assert.equal(await sm("B"), 2); assert.equal(await sm("C"), 3); assert.equal(await sm(null), 3);
  await b.sync(LOGIN, { state: { price: 2400, run: true, state: "ARMED", orders: [{ ticket: 111, side: "BUY", price: 2390, lot: 0.1, sl: 2380, tp: 2420 }] } });
  assert.equal((await b.call("/order-alert", { headers: b.auth(LOGIN, sess), body: { key: "t111", enabled: true } })).j.ok, true);
  assert.equal(await sm("B"), undefined); assert.equal(await sm("C"), undefined); assert.equal(await sm(null), undefined);
});
test("Worker: the budget block carries everything the dashboard shows, with real counts and estimates apart", async () => {
  const { get } = await setup();
  const p = (await get("/state?m=A")).j.pace;
  for (const k of ["f", "f2", "f3", "n", "b", "h", "a", "en", "lim", "ov", "plan", "c", "cs", "hubs", "u", "R", "Cn", "left", "rs", "hl", "T", "pr", "ed", "r", "lvl", "st", "w", "reset", "base"]) assert.ok(k in p, "pace." + k);
  assert.equal(p.b, 80000); assert.equal(p.lim, 100000); assert.equal(p.plan, 12); assert.equal(p.R, 9600); assert.equal(p.Cn, 70400);
  assert.equal(p.pr.length, 3); assert.ok(p.u >= p.n, "the unified honest estimate is never below the raw counter");
  assert.equal(p.cf, undefined, "no Cloudflare token configured: no 'official' number is invented");
  assert.equal(p.st, "normal");
});
test("Worker: ONE shared counter for the whole Cloudflare account - two hubs report to it and each sees the other's use", async () => {
  const b = boot();
  const A = "111111", B = "222222";
  for (const L of [A, B]) assert.equal((await b.sync(L, { state: { price: 1, run: true, state: "ARMED" } })).s, 200);
  const sa = (await b.signIn(A)).j.sess, sb = (await b.signIn(B)).j.sess;
  const ha = b.hubOf(A), hb = b.hubOf(B);
  for (let i = 0; i < 40; i++) await b.call("/px?m=A", { method: "GET", headers: b.auth(A, sa) });
  for (let i = 0; i < 10; i++) await b.call("/px?m=A", { method: "GET", headers: b.auth(B, sb) });
  ha.gAt = 0; hb.gAt = 0; ha.rqSaved = 0; hb.rqSaved = 0;
  await b.call("/state?m=A", { method: "GET", headers: b.auth(A, sa) }); await b.call("/state?m=A", { method: "GET", headers: b.auth(B, sb) });
  ha.gAt = 0; await b.call("/state?m=A", { method: "GET", headers: b.auth(A, sa) });
  const bud = b.env.BUDGET.get("acct").__o;
  assert.equal(Object.keys(bud.s.hubs).length, 2);
  assert.ok(bud.total(bud.s) >= 50, "total " + bud.total(bud.s));
  const pa = (await b.call("/state?m=A", { method: "GET", headers: b.auth(A, sa) })).j.pace;
  assert.equal(pa.hubs, 2); assert.equal(pa.shared, true);
  assert.ok(pa.u > pa.n * 1.08 - 1, "hub A's reading includes hub B's use: u " + pa.u + " vs own " + pa.n);
});
test("Worker: a hub that was never verified writes nothing and never touches the shared counter (v4.18 rule kept)", async () => {
  const b = boot();
  for (let i = 0; i < 60; i++) await b.call("/state", { method: "GET", headers: { "X-Login": "777777", "X-Session": "x" } });
  assert.equal(b.env.BUDGET.inst.size, 0, "no shared counter was even created");
  assert.equal(b.env.HUB.get("acc-777777").__o.ctx.storage.m.size, 0);
});
test("Worker: a restart keeps the pace factor and the day's counters (no stampede after a restart)", async () => {
  const { b, get, h } = await setup({ DAILY_REQ_BUDGET: "3000" });
  for (let round = 0; round < 10; round++) { for (let i = 0; i < 40; i++) await get("/px?m=A"); h.pfAt = 0; }
  h.rqSaved = 0; await get("/px?m=A");
  const pf = h.pf, n = h.rq.n; assert.ok(pf > 1.5, "pf " + pf);
  const W = await import("../worker/worker.js");
  const fresh = new W.Hub({ storage: h.ctx.storage }, b.env);
  await fresh.tally("p3");
  assert.ok(fresh.pf >= pf * 0.9, `factor restored (at most one release step): ${fresh.pf} vs ${pf}`);
  assert.ok(fresh.rq.n >= n, "counter restored");
  assert.deepEqual(Object.keys(fresh.rq.c).sort(), ["p1", "p2", "p3"]);
});
test("Worker: UTC midnight - the counters, the factor and the windows restart; the reset time is reported", async () => {
  const { get, h } = await setup();
  const real = Date.now, d0 = Math.floor(real() / DAY_MS) * DAY_MS;
  try {
    Date.now = () => d0 + DAY_MS - 20000;                                    // 23:59:40 UTC
    for (let i = 0; i < 200; i++) await get("/px?m=A");
    h.pf = 3; assert.ok(h.rq.n > 150);
    const before = (await get("/state?m=A")).j.pace; assert.equal(before.reset, d0 + DAY_MS);
    Date.now = () => d0 + DAY_MS + 5000;                                     // 00:00:05 the next day
    const s = (await get("/state?m=A")).j.pace;
    assert.equal(s.n, 1, "new day, new counter"); assert.equal(s.f, 1); assert.equal(s.c.p1 + s.c.p2 + s.c.p3, 1); assert.equal(s.reset, d0 + 2 * DAY_MS);
  } finally { Date.now = real; }
});
test("Worker: Cloudflare analytics reconcile - the official number is shown apart, raises the reading when higher, and never lowers it when lower", async () => {
  const realFetch = globalThis.fetch; let asked = 0;
  try {
    globalThis.fetch = async (u, init) => { asked++; assert.match(String(u), /api\.cloudflare\.com\/client\/v4\/graphql/); assert.equal(init.headers.Authorization, "Bearer tok"); return new Response(JSON.stringify({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 41000 } }, { sum: { requests: 1000 } }] }] } } }), { status: 200 }); };
    const { get, h } = await setup({ CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acc1" });
    for (let i = 0; i < 20; i++) await get("/px?m=A");
    h.gAt = 0; h.rqSaved = 0; await get("/state?m=A"); h.gAt = 0; h.pfAt = 0; await get("/state?m=A");
    const p = (await get("/state?m=A")).j.pace;
    assert.ok(asked >= 1 && asked <= 2, "asked Cloudflare " + asked + "x (at most every 10 minutes)");
    assert.equal(p.cf.req, 42000); assert.ok(p.cf.age >= 0);
    assert.ok(p.u >= 42000, "the honest reading is not below Cloudflare's own number: " + p.u);
    assert.ok(p.n < 200, "while the raw hub counter stays a separate, smaller, measured number: " + p.n);
    globalThis.fetch = async () => new Response(JSON.stringify({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 10 } }] }] } } }), { status: 200 });
    const r = await readCloudflare({ CF_API_TOKEN: "t", CF_ACCOUNT_ID: "a" }, Date.now());
    assert.equal(r.req, 10);
    globalThis.fetch = async () => new Response("{}", { status: 403 });
    await assert.rejects(readCloudflare({ CF_API_TOKEN: "t", CF_ACCOUNT_ID: "a" }, Date.now()), /cf_http_403/);
  } finally { globalThis.fetch = realFetch; }
});
test("Worker: conditional state - an unchanged signature costs a ~300-byte answer; any real change (orders, position, history, alerts) gives the full state again", async () => {
  const { b, sess, get } = await setup();
  const full = (await get("/state?m=B")).j; assert.ok(full.sg && full.hist && full.stats && !full.same);
  const same = await get("/state?m=B&sg=" + full.sg);
  assert.equal(same.j.same, true); assert.equal(same.j.sg, full.sg); assert.ok(same.j.price > 0 && same.j.pace && "eaOnline" in same.j);
  assert.ok(!("hist" in same.j) && !("orders" in same.j) && !("stats" in same.j));
  assert.ok(JSON.stringify(same.j).length < 1500 && JSON.stringify(same.j).length < JSON.stringify(full).length, "small: " + JSON.stringify(same.j).length + " vs " + JSON.stringify(full).length);
  await b.sync(LOGIN, { state: { price: 2410, ask: 2410.2, run: true, state: "ARMED" } });          // only the price moved
  assert.equal((await get("/state?m=B&sg=" + full.sg)).j.same, true, "a price tick alone is not a state change");
  await b.sync(LOGIN, { state: { price: 2410, run: true, state: "ARMED", orders: [{ ticket: 5, side: "BUY", price: 2420, lot: 0.1, sl: 2410, tp: 2440 }] } });
  const ch = (await get("/state?m=B&sg=" + full.sg)).j; assert.ok(!ch.same && ch.orders.length === 1 && ch.sg !== full.sg, "an order appeared: full answer");
  assert.equal((await get("/state?m=B&sg=bogus")).j.same, undefined, "a wrong signature is simply a full answer");
  assert.equal((await b.call("/state?sg=%3Cscript%3E", { method: "GET", headers: b.auth(LOGIN, sess) })).s, 200, "the signature is sanitised, never executed");
});
test("Worker: a stopped / missing session never gets the budget block or a conditional answer", async () => {
  const b = boot();
  await b.sync(LOGIN, { state: { price: 1, run: true, state: "ARMED" } });
  const r = await b.call("/state?m=A&sg=abc", { method: "GET", headers: { "X-Login": LOGIN, "X-Session": "nope" } });
  assert.equal(r.s, 401); assert.equal(r.j.pace, undefined);
});

// ═══ the app side ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test("app: source reduction (not just delay), priority-class factors, conditional refresh, instant refresh on return, honest dashboard", () => {
  assert.match(app, /pollMs:1500,pxMs:500/, "A: 500 ms price / 1.5 s state (v4.22: 350 ms / 1 s)");
  assert.match(app, /dState\(\)\{[^}]*m==="B"\?4000:10000[^}]*this\.f2/); assert.match(app, /dPx\(\)\{[^}]*m==="B"\?1500:4000[^}]*this\.f3/);
  assert.match(app, /stSame>=60\?3:this\.stSame>=20\?2:1/, "an unchanged state stretches the poll x2 / x3");
  assert.match(app, /cond=this\.init&&this\.sg&&!Ops\.active\(\)/, "never conditional while an operation is open");
  assert.match(app, /d\.same===true/); assert.match(app, /"\/state\?m="\+this\.mode\(\)\+\(cond\?"&sg="\+this\.sg:""\)/);
  assert.match(app, /visibilitychange[^;]*Bridge\.px\(\);Bridge\.pull\(\)/, "back from the background: the latest price at once");
  assert.match(app, /function budgetRows\(\)/); assert.match(app, /budgetRows\(\)\?`<div class="dg2">/);
  assert.match(app, /bdNote:\["الأرقام المسبوقة بـ ≈/, "estimates are labelled as estimates");
  for (const k of ["bdT", "bdSt", "bdUsed", "bdOwn", "bdLim", "bdPct", "bdRes", "bdRate", "bdAvg", "bdProj", "bdEta", "bdSlow", "bdCls", "bdReset", "bdCf", "bdWarn", "bd_normal", "bd_exhausted", "bd_off"]) assert.ok(new RegExp(k + ':\\["[^"]+","[^"]+"\\]').test(app), "AR + EN text for " + k);
  const tr = app.slice(app.indexOf("function budgetRows()"), app.indexOf("function renderSettings()"));
  assert.ok(!/\$\{pc\.(st|cf|err)\}/.test(tr), "server strings are never printed raw"); assert.match(tr, /replace\(\/\[\^a-z\]\/g/);
});
test("EA protocol and the trading path are untouched by the budget release", () => {
  assert.match(wk, /EA_PROTOCOL = "2\.34"/);
  assert.ok(wk.includes('this.reclass("p3", "p1")'));
  assert.ok(!/throw|return json\(\{ ok: false, error: "budget/i.test(wk.slice(wk.indexOf("async tally("), wk.indexOf("paceInfo()"))), "the governor never rejects a request: it only changes hints");
});
