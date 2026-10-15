// Yetimmm v4.23 — UNIFIED DAILY REQUEST BUDGET.
//
// WHY THIS FILE EXISTS
//   v4.21 spread the day's budget over a fixed 6 "planning hours" and reacted only to the measured rate of the last 5 minutes.
//   With the app open that is ~27,000 requests/hour, so the 80,000 budget was gone in ~3 hours, and the counter lived inside ONE Hub
//   (one MT5 account) although the Cloudflare daily limit belongs to the whole ACCOUNT.
//
// WHAT IT DOES (pure functions + one small Durable Object, no Cloudflare API needed to unit-test them)
//   1. LAYERS      limit (real Cloudflare plan) > budget (internal) > normal ceiling (budget - reserve) ; the reserve is never spent by UI refreshes.
//   2. PLAN        a session of PLAN_HOURS (default 12) is planned against what is REALLY left: allowance/hour =
//                  (normal ceiling - used - what the EA still needs when nobody uses the app) / session hours. Re-computed continuously.
//   3. GOVERNOR    proactive and gradual: it starts easing at ~85 % of the allowance (before the wall) once an hour of allowance has been spent, so a short burst is
//                  tolerated and a trend is not; it moves in bounded steps (no cliffs) and releases slowly. Priority classes: p1 trading-critical never slowed, p2 operational slowed gently, p3 cosmetic slowed first.
//   4. UNIFIED     every Hub reports to the shared `Budget` object (one per Cloudflare account); the total, not the per-account number, drives the plan.
//   5. HONEST      an optional Cloudflare GraphQL reconcile compares the internal count with the real analytics; the internal number is only ever
//                  corrected UPWARD (never hides real use) and the UI shows both numbers separately, with their ages.
export const DAY_MS = 86400000, HOUR_MS = 3600000;

export const BUDGET_DEFAULTS = {
  CF_DAILY_LIMIT: 100000,   // the real Cloudflare plan limit (Workers Free = 100,000 requests/day, resets 00:00 UTC). Paid plan: set your real quota. Source: developers.cloudflare.com/workers/platform/limits
  DAILY_REQ_BUDGET: 80000,  // INTERNAL operating budget, always below the limit (clamped to CF_DAILY_LIMIT x 90 % - EXTERNAL_REQ_DAILY). 0 = governor off (paid plan)
  RESERVE_PCT: 12,          // % of the internal budget kept for emergencies: UI refreshes never touch it, only trading-critical traffic can
  PLAN_HOURS: 12,           // length of one continuous session the budget is planned for
  OVERHEAD_PCT: 8,          // requests Cloudflare counts that never reach a Hub counter (CORS preflight, 401/403 at the edge, webhook, news) - added to every reading
  EXTERNAL_REQ_DAILY: 0,    // requests per day of OTHER services sharing this Cloudflare account (they eat the same limit): subtracted from the usable budget
  IDLE_SYNC_SEC: 3,         // EA full-sync interval when nobody looks (requests/hour = 3600 / this) - the baseline the plan must always keep
  CLASS_SHARE: "55,25,20",  // planned share of the normal ceiling for p1 / p2 / p3 (p1 = EA sync + commands + alerts, p2 = state, p3 = price lane + cosmetics)
  SHARED_SYNC_SEC: 90,      // a Hub tells the shared counter at most this often (about 1,000 extra requests/day, counted in the overhead)
};

const nz = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const r1 = (x) => Math.round(x * 10) / 10;

// ---- configuration (env always wins over the defaults above) -------------------------------------------------------------------------------------------------
export function budgetCfg(env = {}, base = {}) {
  const D = { ...BUDGET_DEFAULTS, ...base };
  const raw = env.DAILY_REQ_BUDGET === undefined ? "" : String(env.DAILY_REQ_BUDGET).trim();
  const limit = Math.floor(nz(env.CF_DAILY_LIMIT, D.CF_DAILY_LIMIT));
  const external = Math.max(0, Math.floor(Number(env.EXTERNAL_REQ_DAILY) || D.EXTERNAL_REQ_DAILY));
  const wanted = raw === "0" ? 0 : Math.floor(nz(env.DAILY_REQ_BUDGET, D.DAILY_REQ_BUDGET));
  const cap = Math.max(1000, Math.floor(limit * 0.9) - external);   // the internal budget can never be set at / above the real limit
  const budget = wanted === 0 ? 0 : Math.min(wanted, cap);
  const sh = String(env.CLASS_SHARE || D.CLASS_SHARE).split(",").map((x) => Number(x));
  const share = sh.length === 3 && sh.every((x) => x > 0) ? sh.map((x) => x / sh.reduce((a, b) => a + b, 0)) : [0.55, 0.25, 0.2];
  const idle = Math.max(1, Math.min(5, Math.round(nz(env.IDLE_SYNC_SEC, D.IDLE_SYNC_SEC))));
  return {
    enabled: budget > 0, limit, external, budget, wanted, clamped: wanted > budget && budget > 0,
    reservePct: clamp(Number(env.RESERVE_PCT === undefined ? D.RESERVE_PCT : env.RESERVE_PCT) || 0, 0, 50),
    planHours: clamp(nz(env.PLAN_HOURS !== undefined ? env.PLAN_HOURS : env.PACE_PLAN_HOURS, D.PLAN_HOURS), 1, 24),   // PACE_PLAN_HOURS (v4.21) still understood
    overheadPct: clamp(Number(env.OVERHEAD_PCT === undefined ? D.OVERHEAD_PCT : env.OVERHEAD_PCT) || 0, 0, 100),
    idleReqH: 3600 / idle, share,
    syncSec: clamp(nz(env.SHARED_SYNC_SEC, D.SHARED_SYNC_SEC), 30, 600),
    shared: String(env.BUDGET_SHARED === undefined ? "1" : env.BUDGET_SHARED) !== "0",
    cf: !!(env.CF_API_TOKEN && env.CF_ACCOUNT_ID),
  };
}

// ---- rolling request rates (per hour over the last 5 / 15 / 60 minutes) ---------------------------------------------------------------------------------------
export class Rates {
  constructor(now = Date.now()) { this.b = []; this.t0 = now; }
  add(now, n = 1) {
    const mi = Math.floor(now / 60000), l = this.b[this.b.length - 1];
    if (l && l[0] === mi) l[1] += n; else { this.b.push([mi, n]); while (this.b.length && this.b[0][0] < mi - 61) this.b.shift(); }
  }
  // a window that is younger than requested is scaled to its REAL length (so the first minute after a start is not read as a tiny rate).
  // trim = ignore the single busiest minute of the window (needs >= 3 busy minutes): the CONTROL signal must not react to a one-minute blip, the DISPLAY keeps every request.
  rate(now, mins, trim = false) {
    const mi = Math.floor(now / 60000), from = mi - mins + 1, w = this.b.filter((x) => x[0] >= from);
    let n = w.reduce((a, x) => a + x[1], 0);
    if (!n) return 0;
    if (trim && w.length >= 3) n -= Math.max(...w.map((x) => x[1]));
    const span = Math.max(1, Math.min(mins, (now - this.t0) / 60000));
    return (n / span) * 60;
  }
  vol(now, mins) { const from = Math.floor(now / 60000) - mins + 1; return this.b.reduce((a, x) => a + (x[0] >= from ? x[1] : 0), 0); }   // requests actually made in the window (never scaled)
  all(now) { const m5 = this.rate(now, 5), m15 = this.rate(now, 15), m60 = this.rate(now, 60); return { m5, m15, m60, t5: this.rate(now, 5, true), t15: this.rate(now, 15, true), v60: this.vol(now, 60), eff: 0.4 * m5 + 0.35 * m15 + 0.25 * m60 }; }
}

// ---- the plan: what may be spent per hour, what the projection says, how worried to be ----------------------------------------------------------------------
// i = { now, used (unified, honest), budget, reservePct, planHours, idleReqH (per hub), hubs (active hubs, default 1), rates:{m5,m15,m60,eff} }
export function plan(i) {
  const B = i.budget, R = Math.round((B * i.reservePct) / 100), Cn = B - R;
  const hLeft = Math.max(0.02, (DAY_MS - (i.now % DAY_MS)) / HOUR_MS);
  const T = Math.max(0.25, Math.min(i.planHours, hLeft));                  // the session cannot outlive the UTC day
  const tail = Math.max(0, hLeft - T);                                     // after the session the EA keeps syncing in idle mode: that cost is reserved up front
  const baseline = i.idleReqH * Math.max(1, i.hubs | 0) * tail;   // every account keeps its own EA syncing after the session
  const left = Math.max(0, Cn - i.used);
  const sessionBudget = Math.max(0, left - baseline);
  const allowH = sessionBudget / T;
  const eff = i.rates.eff;
  const proj = (h) => Math.round(i.used + eff * Math.min(h, hLeft));      // used + current rate x hours (capped at midnight)
  const proj12Day = Math.round(i.used + eff * Math.min(T, hLeft) + baseline);
  const etaH = eff > 1 ? Math.max(0, left) / eff : null;                   // hours until the normal ceiling at the current rate
  return {
    B, R, Cn, used: Math.round(i.used), left: Math.round(left), reserveUsed: Math.max(0, Math.round(i.used - Cn)), hLeft: r1(hLeft), T: r1(T),
    baseline: Math.round(baseline), allowH: Math.round(allowH), eff: Math.round(eff), p3h: [proj(3), proj(6), proj(12)], endDay: proj12Day, etaH: etaH === null ? null : r1(etaH),
    resetAt: Math.floor(i.now / DAY_MS) * DAY_MS + DAY_MS,
  };
}

// ---- the governor: ONE smooth factor pf in [1, 8], bounded steps, proactive (before the wall) --------------------------------------------------------------------
export const PF_MAX = 8, PF_UP = 1.25, PF_DOWN = 0.92, EASE_AT = 0.85, RELEASE_AT = 0.6;
export function stepFactor(pf, p, rates, over) {
  if (p.left <= 0 || over) return PF_MAX;                                  // normal ceiling spent: everything cosmetic at the floor (trading-critical still flows)
  const allow = Math.max(1, p.allowH);
  const t5 = rates.t5 === undefined ? rates.m5 : rates.t5, t15 = rates.t15 === undefined ? rates.m15 : rates.t15;
  const up = (0.5 * t5 + 0.5 * t15) / allow, down = rates.eff / allow;     // trimmed windows: a one-minute spike does not move the controller, a trend does
  let n = pf;
  const grace = rates.v60 === undefined || rates.v60 >= allow * 0.7;             // GRACE: easing starts only once the last hour has already spent one hour of allowance, so a short burst of use (a few minutes of taps) is not punished like a trend
  if (up > EASE_AT && grace) n = pf * (1 + Math.min(PF_UP - 1, Math.max(0.03, (up / EASE_AT - 1) * 0.5)));   // easing begins BEFORE the allowance is reached, in bounded steps (3 % .. 25 % per 20 s)
  else if (down > 1) n = pf;                                               // the longer windows still say "too much": hold, never release yet
  else if (down < RELEASE_AT) n = pf * PF_DOWN;                            // genuine room: release a little at a time
  n = clamp(n, 1, PF_MAX);
  return n < pf && n < 1.05 ? 1 : n;                                       // snaps to exactly 1 only when RELEASING (so a 3 % first step is not swallowed)
}

// class factors: p3 (cosmetic: price lane, refresh) is slowed first and hardest, p2 (state) half as much, p1 never (it is not multiplied at all)
export function classFactors(pf, cls, share, Cn) {
  if (pf <= 1) return { f: 1, f2: 1, f3: 1 };
  const over3 = Cn > 0 && cls && cls.p3 > Cn * share[2] * 1.15;            // p3 has already used more than its planned share: slow it a little more
  const f3 = Math.min(10, 1 + (pf - 1) * 1.5 * (over3 ? 1.2 : 1)), f2 = Math.min(6, 1 + (pf - 1) * 0.6);   // continuous from 1: no jump when the factor first leaves 1
  return { f: Math.round(pf * 100) / 100, f2: Math.round(f2 * 100) / 100, f3: Math.round(f3 * 100) / 100 };
}

// state names the UI can translate. lvl 0..5
export function levelOf(pf, used, p) {
  if (used >= p.B) return { lvl: 5, st: "exhausted" };
  if (p.left <= 0) return { lvl: 4, st: "reserve" };
  if (pf >= 5) return { lvl: 4, st: "critical" };
  if (pf >= 2.5) return { lvl: 3, st: "saving" };
  if (pf > 1) return { lvl: 2, st: "easing" };
  if (p.eff > 0 && p.allowH > 0 && p.eff / p.allowH > 0.7) return { lvl: 1, st: "watch" };
  return { lvl: 0, st: "normal" };
}
export const WARN_AT = [50, 70, 85, 95];                                   // % of the internal budget at which a visible warning is raised
export function warnOf(used, B) { const pct = B > 0 ? (used / B) * 100 : 0; let w = 0; for (const t of WARN_AT) if (pct >= t) w++; return w; }

// ---- the honest number: internal counters (all hubs) x overhead x calibration, never below what Cloudflare itself reports ----------------------------------------
export function honestUsed({ own, others = 0, overheadPct = 0, calib = 1, cfReq = 0 }) {
  const internal = (own + others) * (1 + overheadPct / 100) * Math.max(1, calib);
  return Math.max(internal, cfReq || 0);
}
// a hub's share of the allowance: at least an equal share, and everything the other hubs are not using
export function hubAllowance(allowH, activeHubs, othersRateH) {
  const n = Math.max(1, activeHubs | 0);
  return Math.max(allowH / n, allowH - Math.max(0, othersRateH));
}

// ---- Cloudflare analytics (optional; needs CF_API_TOKEN with Account Analytics:Read and CF_ACCOUNT_ID) ----------------------------------------------------------
// Dataset: workersInvocationsAdaptive (sum.requests). Cloudflare's numbers lag by a few minutes; the age is returned and shown, never hidden.
export async function readCloudflare(env, now, fetchFn = fetch) {
  const day0 = Math.floor(now / DAY_MS) * DAY_MS, iso = (t) => new Date(t).toISOString();
  const q = `query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e}){sum{requests}}}}}`;
  const r = await fetchFn("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.CF_API_TOKEN }, body: JSON.stringify({ query: q, variables: { a: String(env.CF_ACCOUNT_ID), s: iso(day0), e: iso(now) } }) });
  if (!r.ok) throw new Error("cf_http_" + r.status);
  const j = await r.json(), rows = j && j.data && j.data.viewer && j.data.viewer.accounts && j.data.viewer.accounts[0] && j.data.viewer.accounts[0].workersInvocationsAdaptive;
  if (!Array.isArray(rows)) throw new Error("cf_shape");
  return { req: rows.reduce((a, x) => a + (Number(x && x.sum && x.sum.requests) || 0), 0), at: now };
}

// ---- shared counter: ONE object for the whole Cloudflare account ----------------------------------------------------------------------------------------------
// Hubs call POST /add {id, d, n, c:{p1,p2,p3}, r}. The answer carries the account total and the other hubs' rate. The day index is UTC.
export class Budget {
  constructor(ctx, env) { this.ctx = ctx; this.env = env || {}; this.s = null; }
  async load(day) {
    if (!this.s) this.s = (await this.ctx.storage.get("bud")) || null;
    if (!this.s || this.s.d !== day) this.s = { d: day, hubs: {}, gone: { n: 0, c: { p1: 0, p2: 0, p3: 0 } }, cf: null, cfAt: 0 };
    return this.s;
  }
  async fetch(req) {
    const now = Date.now(), day = Math.floor(now / DAY_MS), b = await req.json().catch(() => ({}));
    const s = await this.load(day);
    if (new URL(req.url).pathname === "/add" && b && /^[\w.:-]{1,64}$/.test(String(b.id || "")) && b.d === day) {
      const n = Math.max(0, Math.floor(Number(b.n) || 0));
      s.hubs[b.id] = { n: Math.max(n, (s.hubs[b.id] || { n: 0 }).n), t: now, r: Math.max(0, Number(b.r) || 0), c: { p1: Math.floor(Number(b.c && b.c.p1) || 0), p2: Math.floor(Number(b.c && b.c.p2) || 0), p3: Math.floor(Number(b.c && b.c.p3) || 0) } };
      for (const k of Object.keys(s.hubs)) if (now - s.hubs[k].t > 6 * HOUR_MS) { const g = s.hubs[k]; s.gone.n += g.n; for (const c of ["p1", "p2", "p3"]) s.gone.c[c] += g.c[c]; delete s.hubs[k]; }   // a hub silent for 6 h is forgotten, but what it spent today stays in the total
    }
    if (this.env.CF_API_TOKEN && this.env.CF_ACCOUNT_ID && now - s.cfAt > 600000) {
      s.cfAt = now;
      try { const c = await readCloudflare(this.env, now); s.cf = { ...c, internal: this.total(s) }; s.cfErr = ""; } catch (e) { s.cfErr = String((e && e.message) || e).slice(0, 60); }
    }
    await this.ctx.storage.put("bud", s);
    const act = Object.entries(s.hubs).filter(([, h]) => now - h.t < 15 * 60000);
    const mine = String(b && b.id || ""), others = act.filter(([k]) => k !== mine);
    return new Response(JSON.stringify({ ok: true, d: day, total: this.total(s), hubs: act.length, othersRate: others.reduce((a, [, h]) => a + h.r, 0), cls: this.cls(s), cf: s.cf, cfErr: s.cfErr || "", at: now }), { headers: { "Content-Type": "application/json" } });
  }
  total(s) { return s.gone.n + Object.values(s.hubs).reduce((a, h) => a + h.n, 0); }
  cls(s) { return Object.values(s.hubs).reduce((a, h) => ({ p1: a.p1 + h.c.p1, p2: a.p2 + h.c.p2, p3: a.p3 + h.c.p3 }), { ...s.gone.c }); }
}
