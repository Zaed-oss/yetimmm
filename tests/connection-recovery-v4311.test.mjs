// v4.31.1: the "Yetimmm connection-drop" technical audit mapped to code.
// Worker: real behaviour (mock Cloudflare). EA / app: structural checks of the source (MQL5 / the browser are not executed here: compile with F7, then run the field tests of docs/CONNECTION-RECOVERY.md).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ns } from "./mock-cf.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ea = readFileSync(join(root, "ea", "Yetimmm.mq5"), "utf8");
const html = readFileSync(join(root, "index.html"), "utf8");
const W = await import("../worker/worker.js");
const PAIR = "pair-Code-7788";

function boot() {
  const env = { BOT_TOKEN: "123:ABC", APP_PASSWORD: "S3cret-pass", PAIR_CODE: PAIR, REQUIRE_TG: "0" };
  env.HUB = ns(W.Hub, env); env.NOTIFY = ns(W.Notify, env);
  const call = async (path, { method = "POST", body, headers = {} } = {}) => {
    const r = await W.default.fetch(new Request("https://w" + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers }), env);
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  let secret = "e".repeat(32), paired = false;
  const sync = async (extra = {}) => {
    const headers = { "X-EA-Secret": secret };
    if (!paired) headers["X-EA-Pair"] = PAIR;
    const r = await call("/api/ea/sync", { body: { login: "123456", srv: "Broker-Live", state: { price: 2400.5, run: false, state: "STOPPED", hist: [], orders: [], waits: [], tick: 0.01, pt: 0.01, maxDev: 30 }, ...extra }, headers });
    if (r.j && r.j.es) { secret = r.j.es; paired = true; }
    return r;
  };
  const hub = () => env.HUB.get("acc-123456").__o;
  return { call, sync, hub };
}
const login = async (b) => { const l = await b.call("/login", { body: { login: "123456", pw: "S3cret-pass" } }); return { "X-Login": "123456", "X-Session": l.j.sess }; };

// ───────────── Worker: every real disconnection is logged, with what the EA reported ─────────────
test("Worker: a sync gap longer than the stale window is recorded as an outage (start, end, duration, EA error code)", async () => {
  const b = boot();
  assert.equal((await b.sync()).j.ok, true);
  const h = await login(b);
  b.hub().ts = Date.now() - 95_000;                       // the last accepted sync was 95 s ago = a real disconnection
  const r = await b.sync({ net: { fails: 0, err: "", outSec: 94, outFails: 11, st: "CONNECTED" } });
  assert.equal(r.j.ok, true);                             // recovery needs nothing else: the very first sync after the gap is accepted
  const st = await b.call("/state", { method: "GET", headers: h });
  assert.equal(st.j.eaOnline, true);
  assert.equal(st.j.outages.length, 1);
  const o = st.j.outages[0];
  assert.ok(o.sec >= 94 && o.sec <= 97, "duration " + o.sec);
  assert.ok(o.to > o.from);
  assert.equal(o.fails, 11);
  assert.equal(o.ea, true, "EA-side failures reported -> the outage is attributed to the EA / network, not to the Worker");
});

test("Worker: a gap with NO EA-side failures is not blamed on the EA (Worker / platform hiccup)", async () => {
  const b = boot();
  await b.sync(); const h = await login(b);
  b.hub().ts = Date.now() - 70_000;
  await b.sync({ net: { fails: 0, err: "", outSec: 0, outFails: 0, st: "CONNECTED" } });
  const st = await b.call("/state", { method: "GET", headers: h });
  assert.equal(st.j.outages.length, 1); assert.equal(st.j.outages[0].ea, false);
});

test("Worker: normal 1 s syncs never create an outage entry", async () => {
  const b = boot();
  await b.sync(); const h = await login(b);
  for (let i = 0; i < 5; i++) await b.sync({ net: { fails: 0, err: "", outSec: 0, outFails: 0, st: "CONNECTED" } });
  const st = await b.call("/state", { method: "GET", headers: h });
  assert.deepEqual(st.j.outages, []);
});

test("Worker: the EA diagnostics are sanitised (numbers and short codes only) and an old EA without them still syncs", async () => {
  const b = boot();
  assert.equal((await b.sync()).j.ok, true);             // EA v4.31.0 sends no "net" at all
  const h = await login(b);
  await b.sync({ net: { fails: "9<script>", err: "wr4014<img onerror=x>", outSec: -5, outFails: 1e12, st: "RETRYING\"x" } });
  const st = await b.call("/state", { method: "GET", headers: h });
  const n = st.j.eaNet;
  assert.equal(n.err, "wr4014imgonerrorx");
  assert.ok(n.fails === 0 && n.outSec === 0 && n.outFails <= 1e6);
  assert.match(n.st, /^[A-Z_]*$/);
});

test("Worker: the stale window is unchanged (30 s) and still reported to the app", async () => {
  const b = boot(); await b.sync(); const h = await login(b);
  const st = await b.call("/state", { method: "GET", headers: h });
  assert.equal(st.j.eaStaleSec, 30);
});

// ───────────── EA: FIX-A (initialisation order) ─────────────
test("EA FIX-A: LoadAutoConfig() runs BEFORE the bridge settings are validated", () => {
  const init = ea.slice(ea.indexOf("int OnInit()"), ea.indexOf("void OnDeinit"));
  const iLoad = init.indexOf("LoadAutoConfig();"), iCheck = init.indexOf("BrConfigProblem()");
  assert.ok(iLoad > 0 && iCheck > 0 && iLoad < iCheck, "LoadAutoConfig must precede the validation");
});

test("EA FIX-A: the misleading 'INACTIVE' message is gone; precise CONFIG_* states replace it", () => {
  assert.ok(!/Mini App bridge: INACTIVE/.test(ea));
  for (const s of ["CONFIG_LOADING", "CONFIG_INVALID", "CONFIG_READY", "CONNECTING", "CONNECTED", "RETRYING", "OFFLINE"]) assert.ok(ea.includes('"' + s + '"'), s);
  assert.match(ea, /Worker URL missing/); assert.match(ea, /must start with https:\/\//);
});

test("EA FIX-A: CONNECTED is declared only after a verified ok:true answer", () => {
  assert.equal((ea.match(/BrSetState\(BR_CONNECTED/g) || []).length, 1, "only BrSuccess() may set CONNECTED via the logger");
  const sync = ea.slice(ea.indexOf("void BridgeSync()"), ea.indexOf("void LoadAutoConfig(const bool quiet)"));
  const iOk = sync.indexOf('StringFind(resp,"\\"ok\\":true")<0'), iSucc = sync.indexOf("BrSuccess();");
  assert.ok(iOk > 0 && iSucc > iOk, "BrSuccess() must come after the ok:true check");
  assert.ok(!/YLog\("Mini App bridge: connected\."\)/.test(sync));
});

test("EA: a config that was invalid at start is re-read by the sync loop (no stuck state)", () => {
  const sync = ea.slice(ea.indexOf("void BridgeSync()"), ea.indexOf("void LoadAutoConfig(const bool quiet)"));
  assert.match(sync, /BR_CONFIG_INVALID[\s\S]{0,600}LoadAutoConfig\(true\)/);
});

// ───────────── EA: FIX-B (recovery) and FIX-C (diagnostics) ─────────────
// reference model of BrRetryDelaySec(): poll interval, x2 per failure, capped at 10 s
const delay = (fails, base = 1) => (fails <= 0 ? base : Math.min(Math.max(base << Math.min(fails, 3), base), 10));
test("EA FIX-B: retry back-off is 1,2,4,8 then capped at 10 s (fast recovery, no flooding)", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9, 50].map((f) => delay(f)), [1, 2, 4, 8, 8, 8, 8]);
  assert.equal(delay(3, 3), 10);
  assert.match(ea, /return MathMin\(MathMax\(d,base\),10\);/);
  assert.match(ea, /int d=base<<MathMin\(g_brFails,3\);/);
});

test("EA FIX-B: a failed WebRequest never stops the loop, never needs a restart, never changes keys or sessions", () => {
  const sync = ea.slice(ea.indexOf("void BridgeSync()"), ea.indexOf("void LoadAutoConfig(const bool quiet)"));
  const fail = sync.slice(sync.indexOf("if(code==-1)"), sync.indexOf("string resp="));
  assert.match(fail, /BrFail\(/); assert.match(fail, /return;/);
  assert.ok(!/g_brSec\s*=|CfgSet|g_brPairNeed\s*=|g_brFresh\s*=|InpBrResetPw/.test(fail), "a network failure must not touch the secret / pairing / fresh flag");
  assert.match(sync, /TimeLocal\(\)-g_brLast<BrRetryDelaySec\(\)/);
});

test("EA FIX-C: last success / last failure / error code / consecutive failures are tracked and the outage is measured", () => {
  for (const v of ["g_brLastOkAt", "g_brLastFailAt", "g_brLastErr", "g_brLastHttp", "g_brFails", "g_brDownSince"]) assert.ok(ea.includes(v), v);
  assert.match(ea, /recovered automatically after/);
  assert.match(ea, /string BrNetJson\(\)/); assert.match(ea, /\\"net\\":"\+BrNetJson\(\)/);
});

test("EA FIX-C: the first failure of an outage is always logged and the OFFLINE threshold equals the Worker stale window", () => {
  assert.match(ea, /if\(g_brFails==1 \|\| g_brErrLog==0 \|\| now-g_brErrLog>=60\)/);
  assert.match(ea, /const int YT_BR_OFFLINE_SEC=30;/);
  assert.match(readFileSync(join(root, "worker", "worker.js"), "utf8"), /EA_STALE_SEC:\s*30/);
});

test("EA: trading logic is untouched by this change (no trading call inside the new bridge-state code)", () => {
  const blk = ea.slice(ea.indexOf("enum YT_BR_STATE"), ea.indexOf("string JEsc(const string s)\n"));
  assert.ok(!/OrderSend|PositionClose|trade\.|SaveState|g_state\s*=/.test(blk));
});

// ───────────── App: FIX-D (phone experience) ─────────────
test("App FIX-D: a network / server failure never signs the user out (only a real 401 does, in req())", () => {
  const fail = html.slice(html.indexOf("  fail(e){"), html.indexOf("  kick(){"));
  assert.ok(fail.length > 50);
  assert.ok(!/Login\.out|SES\.|localStorage|removeItem/.test(fail.replace(/!SES\.s/, "")), "fail() must not clear the session");
  assert.match(html, /if\(r\.status===401\)\{[\s\S]{0,200}Login\.out\(false/);
});

test("App FIX-D: a short failure shows 'reconnecting', a long one 'server unreachable', the phone being offline is named", () => {
  assert.match(html, /return Date\.now\(\)-\(Bridge\.failSince\|\|Date\.now\(\)\)<20000\?"rec":"srv"/);
  for (const k of ["l_rec", "l_recS", "l_net", "l_netS"]) assert.ok(html.includes(k + ":["), k);
  assert.match(html, /navigator\.onLine===false/);
});

test("App FIX-D: back-off polling and instant recovery on online / visible / focus / pageshow", () => {
  assert.match(html, /Date\.now\(\)>=Bridge\.nextAt/);
  assert.match(html, /Math\.min\(8000,500\*Math\.pow\(2,Math\.min\(this\.fails,4\)\)\)/);
  for (const ev of ["visibilitychange", '"online"', '"focus"', '"pageshow"']) assert.ok(html.includes(ev), ev);
});

test("App FIX-D: the entry check cannot die while the app is in the background", () => {
  assert.match(html, /if\(document\.hidden\)this\.next\(\);else this\.run\(\)/);
});

test("App FIX-D: 'connected' still requires a fresh EA answer (never hidden by the reconnect state)", () => {
  assert.match(html, /if\(S\.eaOnline===false\|\|a===null\|\|a>\(S\.eaStaleSec\|\|CONFIG\.staleSec\|\|30\)\)return"off"/);
  assert.match(html, /\$\("applyB"\)\.disabled=live\(\)&&k!=="ok"/);
});

// ───────────── fix8: the two defects found by the Fix 7 review ─────────────
test("EA fix8: no early `return` on an empty URL / key can precede the config re-read in BridgeSync()", () => {
  const sync = ea.slice(ea.indexOf("void BridgeSync()"), ea.indexOf("void LoadAutoConfig(const bool quiet)"));
  const iReload = sync.indexOf("LoadAutoConfig(true)");
  assert.ok(iReload > 0, "BridgeSync must re-read the settings");
  const before = sync.slice(0, iReload);
  assert.ok(!/StringLen\(g_brUrl\)\s*<\s*12[^;{]*\)\s*return/.test(before), "an empty-URL return before the re-read makes the recovery unreachable");
  assert.ok(!/BrKeyEff\(\)\)\s*<\s*8[^;{]*\)\s*return/.test(before));
  assert.match(before, /g_brState==BR_CONFIG_INVALID \|\| g_brState==BR_CONFIG_LOADING/);   // the gate is the state
  assert.match(before, /TimeLocal\(\)-g_brLast<5\) return;/);                                 // not every tick
});

test("EA fix8: a repaired config goes READY and the first sync starts at once; the re-read is silent and the reason is repeated only once a minute", () => {
  const sync = ea.slice(ea.indexOf("void BridgeSync()"), ea.indexOf("void LoadAutoConfig(const bool quiet)"));
  assert.match(sync, /BrSetState\(BR_CONFIG_READY,g_brUrl\);\s*g_brLast=0;/);
  assert.match(sync, /still CONFIG_INVALID - /); assert.match(sync, /TimeLocal\(\)-g_brErrLog>=60/);
  const la = ea.slice(ea.indexOf("void LoadAutoConfig(const bool quiet)"), ea.indexOf("void PurgeVirtualState()"));
  assert.ok(!/[^!]YLog\(/.test(la.replace(/if\(!quiet[^\n]*YLog\(/g, "")), "every log line of LoadAutoConfig must be guarded by !quiet");
  assert.match(ea, /void LoadAutoConfig\(const bool quiet=false\);/);   // forward prototype: BridgeSync() is defined before the function
});

// link() is EXECUTED here with a controlled clock (not pattern-matched)
function linkFn(now, B) {
  const src = html.slice(html.indexOf("function link(){"), html.indexOf("function renderLink"));
  return new Function("live", "Bridge", "S", "CONFIG", "eaAge", "Date", src + "; return link;")(() => true, B, { eaOnline: true, eaStaleSec: 30 }, { staleSec: 30 }, () => 1, { now: () => now });
}
test("App fix8: the first failure after a LONG quiet period shows 'reconnecting', never 'unreachable'", () => {
  const now = 1_000_000;
  const B = { ok: false, auth: false, okAt: now - 600_000, failSince: now - 1_000, fails: 1 };   // last success 10 min ago, failure started 1 s ago
  assert.equal(linkFn(now, B)(), "rec");
});
test("App fix8: 'unreachable' only after the CURRENT failure chain lasted 20 s", () => {
  const now = 1_000_000;
  assert.equal(linkFn(now, { ok: false, auth: false, okAt: now - 5_000, failSince: now - 19_000 })(), "rec");
  assert.equal(linkFn(now, { ok: false, auth: false, okAt: now - 5_000, failSince: now - 21_000 })(), "srv");
  assert.equal(linkFn(now, { ok: false, auth: true, failSince: now - 99_000 })(), "auth");
});
test("App fix8: a success resets the chain; an offline EA is still reported as offline (not hidden by the reconnect state)", () => {
  const now = 1_000_000;
  const f = (B, S) => new Function("live", "Bridge", "S", "CONFIG", "eaAge", "Date", html.slice(html.indexOf("function link(){"), html.indexOf("function renderLink")) + "; return link;")(() => true, B, S, { staleSec: 30 }, () => 99, { now: () => now })();
  assert.equal(f({ ok: true }, { eaOnline: true, eaStaleSec: 30 }), "off");      // Worker reachable, EA silent for 99 s
  assert.equal(f({ ok: true }, { eaOnline: false, eaStaleSec: 30 }), "off");
  const fresh = new Function("live", "Bridge", "S", "CONFIG", "eaAge", "Date", html.slice(html.indexOf("function link(){"), html.indexOf("function renderLink")) + "; return link;")(() => true, { ok: true }, { eaOnline: true, eaStaleSec: 30 }, { staleSec: 30 }, () => 2, { now: () => now });
  assert.equal(fresh(), "ok");
});
