// Yetimmm bridge v4.7.0 — ONE bot, ONE link, login by MT5 account number + ONE app password.
//   EA  -> POST /api/ea/sync  (headers X-EA-Secret [+ X-EA-Pair while pairing])  body {login, srv, fresh, reset, cv, state, ack}
//   App -> POST /login        body {login, pw, init}                -> {ok, sess}
//   App -> POST /verify       headers X-Login + X-Session, body {init} -> {ok, hard, checks:{session,account,telegram,bot}}
//   App -> GET  /state        headers X-Login + X-Session
//   App -> POST /command      headers X-Login + X-Session
//   App -> POST /logout       headers X-Login + X-Session
// Secrets (wrangler secret put): BOT_TOKEN, APP_PASSWORD, PAIR_CODE (EA <-> account pairing; falls back to APP_PASSWORD)
// Each MT5 account gets its own isolated hub (Durable Object "acc-<login>").
// The EA's MT5 trading password is NEVER requested or stored.

// ═════════════════════════════════════════════════════════════════════════
//  CONFIG — the ONLY place you edit. Every value can also be overridden
//  WITHOUT touching code:  wrangler secret put <NAME>   (or [vars] in wrangler.toml)
//  After you change anything: `wrangler deploy` and everything reacts automatically:
//    • password changed  -> all old sessions die by themselves (each session is bound to a password fingerprint)
//    • SESSION_EPOCH bumped -> everybody is signed out instantly (panic button)
// ═════════════════════════════════════════════════════════════════════════
import { Notify } from "./news.js";
export { Notify };

const CONFIG = {
  PASSWORD: "",              // leave EMPTY and set it as a secret:  wrangler secret put APP_PASSWORD   (login is refused until a password exists)
  LOCK_SECONDS: 120,         // lock duration after too many wrong passwords = 2 minutes
  MAX_ATTEMPTS: 8,           // wrong passwords allowed before the lock
  FAIL_WINDOW_SEC: 600,      // wrong attempts older than this are forgotten
  SESSION_DAYS: 30,          // sliding session lifetime (refreshed on every successful verify)
  EA_STALE_SEC: 20,          // EA counts as offline after this many seconds without a sync
  SESSION_EPOCH: 1,          // bump (1 -> 2) to sign EVERYONE out at once
  ALLOWED_ORIGIN: "",        // v4.6.1: fail-closed. CORS origin of the web app, e.g. "https://you.github.io" (set in wrangler.toml [vars]; env wins). "*" = open, testing only
  REQUIRE_TG: true,          // true = login only from inside the Telegram bot (env REQUIRE_TG="0" allows browsers)
  SESSION_TOUCH_SEC: 600,    // v4.6: any authenticated request slides the session expiry (persisted at most once per this many seconds)
  PAIR_MAX_FAILS: 10,        // v4.6: wrong pairing codes allowed per account before a lock
  PAIR_LOCK_SEC: 300,        // v4.6: pairing lock length
  NEWS_SCOPE: "server",      // v4.6: "server" = one calendar/notification shard per broker server (multi-broker safe) | "global" = legacy single shard
};

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
function cfg(env) {
  return {
    password: String(env.APP_PASSWORD || CONFIG.PASSWORD),
    lockMs: num(env.LOCK_SECONDS, CONFIG.LOCK_SECONDS) * 1000,
    max: Math.max(1, Math.floor(num(env.MAX_ATTEMPTS, CONFIG.MAX_ATTEMPTS))),
    winMs: num(env.FAIL_WINDOW_SEC, CONFIG.FAIL_WINDOW_SEC) * 1000,
    sessMs: num(env.SESSION_DAYS, CONFIG.SESSION_DAYS) * 86400000,
    staleSec: num(env.EA_STALE_SEC, CONFIG.EA_STALE_SEC),
    epoch: String(env.SESSION_EPOCH || CONFIG.SESSION_EPOCH),
    requireTg: String(env.REQUIRE_TG !== undefined ? env.REQUIRE_TG : CONFIG.REQUIRE_TG ? "1" : "0") !== "0",
    salt: String(env.BOT_TOKEN || ""),
    origins: String(env.ALLOWED_ORIGIN || CONFIG.ALLOWED_ORIGIN || "").split(",").map((x) => x.trim().replace(/\/+$/, "")).filter(Boolean),   // comma separated; "*" = open (testing only)
    pairKey: String(env.PAIR_CODE || env.APP_PASSWORD || CONFIG.PASSWORD),
    pairMax: Math.max(1, Math.floor(num(env.PAIR_MAX_FAILS, CONFIG.PAIR_MAX_FAILS))),
    pairLockMs: num(env.PAIR_LOCK_SEC, CONFIG.PAIR_LOCK_SEC) * 1000,
    touchMs: num(env.SESSION_TOUCH_SEC, CONFIG.SESSION_TOUCH_SEC) * 1000,
    newsScope: String(env.NEWS_SCOPE || CONFIG.NEWS_SCOPE).toLowerCase() === "global" ? "global" : "server",
  };
}

// "GMT+3", "GMT-5", "GMT+5:30" from an offset in seconds (the MT5 server time offset reported by the EA)
function gmtLabel(off) { off = Math.round((Number(off) || 0) / 60); const sg = off < 0 ? "-" : "+", m = Math.abs(off), h = Math.floor(m / 60), mm = m % 60; return "GMT" + (off === 0 ? "" : sg + h + (mm ? ":" + String(mm).padStart(2, "0") : "")); }

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const enc = new TextEncoder();
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const rnd = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha = async (s) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(s)))));

function safeEq(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function hmacRaw(keyBytes, data) {
  const k = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, typeof data === "string" ? enc.encode(data) : data));
}
// Password fingerprint: changes the moment the password (or SESSION_EPOCH) changes. Never leaves the server.
async function pwVersion(c) { return hex(await hmacRaw(enc.encode("yt-pwv|" + c.epoch + "|" + c.salt), c.password)).slice(0, 16); }
// Constant-time password check that does not leak the password LENGTH (both sides are hashed to the same size first).
async function pwEq(c, given, real) {
  const k = enc.encode("yt-pwc|" + c.salt);
  return safeEq(hex(await hmacRaw(k, String(given || ""))), hex(await hmacRaw(k, String(real || ""))));
}
// v4.6: the economic calendar + notifications live in ONE Notify shard per broker server, so two brokers (different server time / calendar)
// never overwrite each other. NEWS_SCOPE="global" restores the old single shard ("main").
async function nshard(c, srv) {
  if (c.newsScope === "global" || !srv) return "main";
  return "srv-" + (await sha("yt-srv|" + String(srv).toLowerCase())).slice(0, 16);
}
const notifyStub = async (env, c, srv) => env.NOTIFY.get(env.NOTIFY.idFromName(await nshard(c, srv)));
// Verifies Telegram Mini App initData with the bot token. Returns the Telegram user id or null.
async function tgUser(initData, botToken) {
  try {
    if (!initData || !botToken) return null;
    const p = new URLSearchParams(initData);
    const hash = p.get("hash");
    if (!hash) return null;
    p.delete("hash");
    const dcs = [...p.entries()].map(([k, v]) => k + "=" + v).sort().join("\n");
    const secret = await hmacRaw(enc.encode("WebAppData"), botToken);
    if (!safeEq(hex(await hmacRaw(secret, dcs)), hash)) return null;
    if (Date.now() / 1000 - Number(p.get("auth_date") || 0) > 86400) return null;
    const u = JSON.parse(p.get("user") || "{}");
    return u.id ? String(u.id) : null;
  } catch (e) { return null; }
}

function cors(req, c) {
  const o = req.headers.get("Origin");
  if (!o) return {};
  const allow = c.origins.includes("*") ? "*" : (c.origins.includes(o) ? o : (c.origins[0] || "null"));
  return { "Access-Control-Allow-Origin": allow, "Access-Control-Allow-Headers": "Content-Type, X-Login, X-Session, X-EA-Secret", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", Vary: "Origin" };
}

// ═════════════ v4.7 — PUBLIC (Mini App) vs INTERNAL (diagnostics) separation ═════════════
// What the Mini App receives is built here from the EA state: closed TRADES of the current week only, no command log, no technical text.
// Everything else stays in the Hub (internal archive of all trades, EA command log, technical failures) and is readable ONLY through /admin/diag.
const TECH_RE = /retcode|\b100[0-4]\d\b|HTTP\s*\d{3}|exception|TypeError|ReferenceError|SyntaxError|\bJSON\b|stack\s*trace|traceback|parse error|internal error|server error|server rejected|\bundefined\b|\bNaN\b/i;
// 3 levels: "user" (price invalid...) and "ops" (bot offline...) may be shown; "tech" (retcode, HTTP, exceptions...) is NEVER shown: text is dropped and only the category travels.
function classify(raw) {
  const t = String(raw == null ? "" : raw).trim();
  if (!t) return { text: "", cat: "" };
  if (TECH_RE.test(t)) return { text: "", cat: "tech" };
  return { text: t, cat: /offline|not connected|no connection|autotrading|market (is )?closed|trade server/i.test(t) ? "ops" : "user" };
}
const rid = (id) => "r-" + String(id == null ? "" : id).replace(/[^\w-]/g, "").slice(0, 8);
function publicOf(st) {
  const o = { ...st };
  delete o.cmds;                                   // EA command log (Apply / Waiting / Superseded / failed ...) = internal, never a trade
  const m = classify(o.msg); o.msg = m.text; if (m.cat === "tech") o.msgCat = "tech";
  if (o.lastCmd && typeof o.lastCmd === "object") { const c = classify(o.lastCmd.text); o.lastCmd = { id: o.lastCmd.id, ok: !!o.lastCmd.ok, text: c.text, cat: c.cat, rid: c.cat === "tech" ? rid(o.lastCmd.id) : undefined }; }
  for (const k of ["waits", "orders"]) if (Array.isArray(o[k])) o[k] = o[k].map((x) => { if (!x || typeof x !== "object") return x; const y = { ...x }; for (const f of ["why", "note", "text", "msg", "err", "reason"]) if (typeof y[f] === "string") y[f] = classify(y[f]).text; return y; });
  return o;
}
// week = Monday 00:00 .. Sunday 23:59:59 in BROKER SERVER time (trade timestamps are server wall-clock; tzo = server offset in seconds)
const weekMon = (daySrv) => daySrv - ((daySrv + 3) % 7);                       // epoch day 0 was a Thursday
function weekWin(tzo, nowMs) { const day = Math.floor(((nowMs === undefined ? Date.now() : nowMs) / 1000 + (Number(tzo) || 0)) / 86400), mon = weekMon(day); return { key: mon, from: mon * 86400, to: mon * 86400 + 7 * 86400 - 1 }; }
const weekOfTs = (ts) => weekMon(Math.floor(Number(ts) / 86400));
const r2n = (x) => Math.round(x * 100) / 100;
function weekStats(L) {
  const n = L.length, sum = (a) => a.reduce((s, x) => s + x, 0), win = L.filter((x) => x.pnl > 0), los = L.filter((x) => x.pnl < 0), gw = sum(win.map((x) => x.pnl)), gl = -sum(los.map((x) => x.pnl));
  const byTs = [...L].sort((a, b) => b.ts - a.ts); let streak = 0;
  for (const x of byTs) { const sg = x.pnl > 0 ? 1 : x.pnl < 0 ? -1 : 0; if (!sg) break; if (!streak) streak = sg; else if (Math.sign(streak) !== sg) break; streak += sg; }
  return { total: n, wins: win.length, losses: los.length, net: r2n(sum(L.map((x) => x.pnl))), pf: n ? (gl > 0 ? r2n(gw / gl) : gw > 0 ? 99.99 : 0) : null, avgW: win.length ? r2n(gw / win.length) : 0, avgL: los.length ? r2n(gl / los.length) : 0, maxW: win.length ? Math.max(...win.map((x) => x.pnl)) : 0, maxL: los.length ? Math.max(...los.map((x) => -x.pnl)) : 0, buys: L.filter((x) => /^B/i.test(x.side)).length, sells: L.filter((x) => /^S/i.test(x.side)).length, streak, vol: r2n(sum(L.map((x) => x.lot))), comm: 0, swap: 0 };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const c = cfg(env);
    const ch = cors(req, c);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: ch });
    const done = (res) => { const h = new Headers(res.headers); for (const [k, v] of Object.entries(ch)) h.set(k, v); return new Response(res.body, { status: res.status, headers: h }); };
    const P = url.pathname;
    if (P === "/") return done(json({ ok: true, service: "yetimmm-bridge", v: 4.6, corsOpen: c.origins.includes("*"), corsConfigured: c.origins.length > 0 }));
    try {
      let login = "", body = "";
      if (P === "/api/ea/sync" || P === "/login") {
        body = await req.text();
        if (body.length > (P === "/login" ? 8192 : 2000000)) return done(json({ ok: false, error: "too_large" }, 413));
        let b = {}; try { b = JSON.parse(body); } catch (e) {}
        login = String(b.login || "").trim();
      } else if (P === "/admin/diag" || P === "/state" || P === "/command" || P === "/logout" || P === "/verify" || P.startsWith("/news/") || P === "/order-alert") {
        login = (req.headers.get("X-Login") || "").trim();
        if (req.method === "POST") { body = await req.text(); if (body.length > 65536) return done(json({ ok: false, error: "too_large" }, 413)); }
      } else return done(json({ error: "not found" }, 404));
      if (!/^\d{3,12}$/.test(login)) return done(json({ ok: false, error: "login" }, P === "/login" ? 400 : 401));
      const hub = env.HUB.get(env.HUB.idFromName("acc-" + login));
      const call = (path, extra) => hub.fetch("https://hub" + path, { method: "POST", body: JSON.stringify(extra) });
      if (P === "/api/ea/sync") return done(await call("/sync", { secret: (req.headers.get("X-EA-Secret") || "").trim(), pair: (req.headers.get("X-EA-Pair") || "").trim().slice(0, 256), body, tok: env.BOT_TOKEN || "" }));
      if (P === "/login") {
        const b = JSON.parse(body);
        const tg = await tgUser(String(b.init || ""), env.BOT_TOKEN || "");
        const gate = env.HUB.get(env.HUB.idFromName("gate-" + (tg ? "tg" + tg : "ip" + (req.headers.get("CF-Connecting-IP") || "x"))));
        const gcall = async (op) => (await gate.fetch("https://hub/gate", { method: "POST", body: JSON.stringify(op) })).json();
        if (!c.password) return done(json({ ok: false, error: "not_configured" }, 503));   // no APP_PASSWORD set: refuse instead of running with a default password
        const g0 = await gcall({});
        if (!g0.ok) return done(json({ ok: false, error: "locked", retry: g0.retry }, 429));
        if (c.requireTg && !tg) return done(json({ ok: false, error: "tg_only" }, 403));
        if (!(await pwEq(c, b.pw, c.password))) {
          const g = await gcall({ fail: true });
          if (!g.ok) return done(json({ ok: false, error: "locked", retry: g.retry }, 429));
          return done(json({ ok: false, error: "bad_pw", left: g.left }, 401));
        }
        const res = await call("/login", { tg });
        if (res.status === 503) return done(res);                      // bot offline is NOT a wrong password: never count it toward the lock
        if (res.status !== 200) { await gcall({ fail: true }); return done(res); }
        await gcall({ reset: true });
        return done(res);
      }
      if (P === "/admin/diag") {            // internal diagnostics: admin key only (secret ADMIN_KEY); unset = endpoint does not exist
        if (!env.ADMIN_KEY || !safeEq(String(req.headers.get("X-Admin-Key") || ""), String(env.ADMIN_KEY))) return done(json({ error: "not found" }, 404));
        return done(await call("/diag", {}));
      }
      const sess = (req.headers.get("X-Session") || "").trim();
      if (P.startsWith("/news/") || P === "/order-alert") {          // news calendar + unified notifications (news.js) and per-account order alerts (Hub)
        const au = await (await call("/auth", { sess, login })).json();
        if (!au.ok) return done(json({ ok: false, error: "session", why: au.why }, 401));
        let b = {}; try { b = JSON.parse(body || "{}"); } catch (e) {}
        const nt = await notifyStub(env, c, au.srv);
        const nc = (path, o) => nt.fetch("https://n" + path, { method: "POST", body: JSON.stringify({ ...o, uid: au.uid, login }) });
        if (P === "/news/calendar") return done(await nc("/cal", {}));
        if (P === "/news/alert") return done(await nc("/alert", { event_id: b.event_id, offsets: b.offsets, enabled: b.enabled }));
        if (P === "/news/notifs") return done(await nc("/notifs", { limit: b.limit }));
        if (P === "/news/read") return done(await nc("/read", { ids: b.ids, all: b.all }));
        if (P === "/news/pref") return done(await nc("/pref", { tz: b.tz, lang: b.lang }));
        if (P === "/order-alert") return done(await call("/oalert", { sess, login, key: b.key, enabled: b.enabled }));
        return done(json({ error: "not found" }, 404));
      }
      if (P === "/verify") {
        let b = {}; try { b = JSON.parse(body || "{}"); } catch (e) {}
        const tg = await tgUser(String(b.init || ""), env.BOT_TOKEN || "");
        return done(await call("/verify", { sess, tg }));
      }
      if (P === "/state") return done(await call("/state", { sess }));
      if (P === "/command") return done(await call("/command", { sess, body }));
      if (P === "/logout") return done(await call("/logout", { sess }));
    } catch (e) { return done(json({ error: "server" }, 500)); }
    return done(json({ error: "not found" }, 404));
  },
};

export class Hub {
  constructor(ctx, env) { this.ctx = ctx; this.env = env || {}; this.c = cfg(env || {}); this.st = null; this.ts = 0; this.oa = null; this.miss = {}; this.hxSig = ""; this.wkc = null; this.dseen = new Set(); }
  age() { return this.ts ? (Date.now() - this.ts) / 1000 : null; }
  botUp() { const g = this.age(); return g !== null && g < this.c.staleSec; }
  bound(a) { return !!(a.eaSecretH || a.eaSecret); }
  // v4.6: every authenticated request slides the session (persisted at most once per SESSION_TOUCH_SEC so /state polling never hammers storage)
  async touch(a, s) { const now = Date.now(); if (now - s.t > this.c.touchMs) { s.t = now; await this.ctx.storage.put("acc", a); } }
  // v4.6: order-match tolerance comes from the SYMBOL (tick size / point / Max Deviation reported by the EA), never from a % of price.
  // Fallback 0.30 only for an EA older than v2.21 that does not report them yet.
  tolOf(st) { const tick = Number(st.tick) || 0, pt = Number(st.pt) || tick, dev = Number(st.maxDev) || 0, t = Math.max(tick * 3, dev * pt); return t > 0 ? t : 0.3; }
  async fetch(req) {
    const p = new URL(req.url).pathname;
    const b = await req.json().catch(() => ({}));
    if (p === "/gate") return this.gate(b);
    if (p === "/sync") return this.sync(b);
    if (p === "/login") return this.login(b);
    if (p === "/verify") return this.verify(b);
    if (p === "/state") return this.state(b);
    if (p === "/command") return this.command(b);
    if (p === "/logout") return this.logout(b);
    if (p === "/auth") return this.auth(b);
    if (p === "/diag") return this.diag();
    if (p === "/oalert") return this.oalert(b);
    if (p === "/tgs") return json({ ok: true, tg: (await this.S()).tg });   // Telegram chats registered on this MT5 account (delivery target for browser users)
    return json({ error: "not found" }, 404);
  }
  async S() {
    const a = (await this.ctx.storage.get("acc")) || { sessions: [], tg: [], cfgv: 0 };
    a.sessions = (a.sessions || []).filter((x) => x && typeof x === "object");   // v3 string sessions are dropped once
    a.tg = a.tg || [];
    return a;
  }
  // A session is valid only if: it exists (stored hashed), is not expired, belongs to the current SESSION_EPOCH,
  // was created under the CURRENT password, and the MT5 server of the account did not change since.
  async chk(a, sess) {
    if (!sess) return { why: "none" };
    const h = await sha(sess);
    const s = a.sessions.find((x) => safeEq(x.h, h));
    if (!s) return { why: "gone" };
    if (Date.now() - s.t > this.c.sessMs) return { why: "expired" };
    if (s.ep !== this.c.epoch) return { why: "revoked" };
    if (s.pwv !== (await pwVersion(this.c))) return { why: "pw" };
    if (a.srv && s.srv && a.srv !== s.srv) return { why: "acct" };
    return { s };
  }
  deny(why) { return json({ ok: false, error: "session", why }, 401); }

  // ---- user identity + order alerts (account-bound, stored here next to the EA state; delivery goes through the shared Notify engine) ----
  uidOf(s, a) { return s && s.tg ? String(s.tg) : "a" + (a.login || ""); }
  async auth(m) {
    const a = await this.S(); if (m.login && a.login !== m.login) { a.login = String(m.login); await this.ctx.storage.put("acc", a); }
    const r = await this.chk(a, m.sess);
    if (r.s) await this.touch(a, r.s);
    return json(r.s ? { ok: true, uid: this.uidOf(r.s, a), srv: a.srv || "" } : { ok: false, why: r.why });
  }
  async loadOa() { if (!this.oa) { this.oa = {}; for (const [k, v] of await this.ctx.storage.list({ prefix: "oa:" })) this.oa[k] = v; } return this.oa; }
  async oaMine(uid) { const o = await this.loadOa(); return Object.values(o).filter((r) => r.user_id === uid && r.enabled && (r.status === "armed" || (r.status === "fired" && Date.now() - (r.fired_at || 0) < 86400000))).map((r) => ({ key: r.event_id, status: r.status })); }
  hsig(h) { return h.no + "|" + h.entry + "|" + h.exit; }
  async oalert(m) {
    const a = await this.S(), r = await this.chk(a, m.sess); if (!r.s) return this.deny(r.why);
    await this.touch(a, r.s);
    const uid = this.uidOf(r.s, a), key = String(m.key || ""), st = this.st || {}, o = await this.loadOa(), sk = "oa:" + uid + ":" + key, old = o[sk];
    if (m.enabled === false) { if (old && old.enabled) { old.enabled = false; old.status = "off"; old.updated_at = Date.now(); await this.ctx.storage.put(sk, old); } return json({ ok: true }); }
    if (old && old.enabled && old.status === "armed") return json({ ok: true, dup: true });          // pressing Allow twice never creates a second alert
    let src = null;
    if (key[0] === "t") { const q = (st.orders || []).find((x) => String(x.ticket) === key.slice(1)); if (q) src = { side: String(q.side).toUpperCase().startsWith("B") ? "BUY" : "SELL", price: Number(q.price), lot: q.lot, sl: q.sl, tp: q.tp }; }
    else if (key[0] === "w") { const q = (st.waits || []).find((x) => x.side === key.slice(1)); if (q) src = { side: q.side, price: Number(q.level) }; }
    if (!src) return json({ ok: false, error: "order_gone" }, 404);
    const now = Date.now(), rec = old || { id: crypto.randomUUID().replace(/-/g, "").slice(0, 16), user_id: uid, account_id: String(a.login || ""), type: "order", event_id: key, created_at: now };
    Object.assign(rec, src, { enabled: true, kind: "activated", status: "armed", updated_at: now, sym: st.sym || "XAUUSD", hseen: (st.hist || []).slice(0, 8).map((h) => this.hsig(h)), pos0: st.pos ? st.pos.entry + "|" + st.pos.no : "" });
    delete rec.fired_at; o[sk] = rec; this.miss = {}; await this.ctx.storage.put(sk, rec);
    return json({ ok: true });
  }
  // Stateless check against every EA sync: a pending order that vanished AND became a position (or a just-closed trade) = activated.
  async watch(a) {
    const o = await this.loadOa(), st = this.st; const recs = Object.entries(o).filter(([, r]) => r.enabled && r.status === "armed"); if (!recs.length) return;
    const orders = st.orders || [], waits = st.waits || [], hist = st.hist || [], tol = this.tolOf(st);
    for (const [k, r] of recs) {
      const near = (x) => Math.abs(Number(x) - r.price) <= tol;
      let live = null;
      if (r.event_id[0] === "t") live = orders.find((x) => String(x.ticket) === r.event_id.slice(1));
      else { live = waits.find((x) => x.side === r.side); const promoted = !live && orders.find((x) => String(x.side).toUpperCase().startsWith(r.side[0]) && near(x.price)); if (promoted) { r.event_id = "t" + promoted.ticket; live = promoted; r.updated_at = Date.now(); await this.ctx.storage.put(k, r); } }
      if (live) { delete this.miss[k]; const px = Number(live.price != null ? live.price : live.level); if (px > 0 && px !== r.price) { r.price = px; r.updated_at = Date.now(); await this.ctx.storage.put(k, r); } continue; }
      this.miss[k] = (this.miss[k] || 0) + 1; if (this.miss[k] < 3) continue;   // ignore a single incomplete sync
      // a pending order that fills becomes a position whose identifier IS the order ticket: match by identity when the EA reports it, by symbol-tight price otherwise
      const p = st.pos, tk = r.event_id[0] === "t" ? r.event_id.slice(1) : "", byId = !!(p && tk && p.pid !== undefined && p.pid !== null && String(p.pid) !== "" && String(p.pid) !== "0");
      const act = p && String(p.side).toUpperCase().startsWith(r.side[0]) && (byId ? String(p.pid) === tk : near(p.entry)) && (p.entry + "|" + p.no) !== r.pos0;
      const done = !act && hist.find((h) => String(h.side).toUpperCase().startsWith(r.side[0]) && near(h.entry) && !r.hseen.includes(this.hsig(h)));
      if (!act && !done) { r.status = "gone"; r.updated_at = Date.now(); await this.ctx.storage.put(k, r); continue; }   // removed / cancelled: no activation message
      const e = act ? p : done, off = Number(a.tzo) || 0, hh = new Date(Date.now() + off * 1000).toISOString().slice(11, 16) + " " + gmtLabel(off);
      const res = await (await notifyStub(this.env, this.c, a.srv)).fetch("https://n/emit", { method: "POST", body: JSON.stringify({ uid: r.user_id, account_id: r.account_id, type: "order", event_id: r.id, alert_type: "activated", title: "Order Activated · تفعيل أوردر", body: `${r.side} ${r.sym}\nVolume: ${e.lot != null ? e.lot : r.lot}\nEntry: ${e.entry}\nTime: ${hh}` }) });
      if (res.ok) { r.status = "fired"; r.fired_at = Date.now(); r.updated_at = r.fired_at; await this.ctx.storage.put(k, r); }   // if emit failed it stays armed and is retried on the next sync (dedupe makes that safe)
    }
  }

  // ---- MT5 as the news source: broker time offset + economic calendar (EA sends a tiny hash every sync, the full table only when it changed) ----
  async feed(body) {
    const a = await this.S(), now = Date.now();
    const tz = Number(body.tzo), okTz = Number.isFinite(tz) && Math.abs(tz) <= 50400, tzo = okTz ? Math.round(tz / 900) * 900 : a.tzo;
    const calv = typeof body.calv === "string" && /^[0-9a-f]{1,16}$/.test(body.calv) ? body.calv : "";
    const rows = Array.isArray(body.cal) && calv ? body.cal.slice(0, 600) : null;
    const tzChanged = okTz && a.tzo !== tzo, beat = !!calv && !rows && calv === a.calv && now - (a.calBeat || 0) > 300000;
    let dirty = false, need = false;
    if (tzChanged) { a.tzo = tzo; dirty = true; }
    if (rows || tzChanged || beat) {
      const res = await (await notifyStub(this.env, this.c, a.srv)).fetch("https://n/mt5", { method: "POST", body: JSON.stringify({ login: a.login || "", srv: a.srv || "", tzo: a.tzo, calv: rows || beat ? calv : undefined, rows }) });
      const j = await res.json().catch(() => ({}));
      if (j && j.ok) {
        if (rows) a.calv = calv;
        if (j.need) { a.calv = ""; need = true; }          // Notify lost the table (restart / data older than the heartbeat): ask the EA again
        a.calBeat = now; dirty = true;
      }
    }
    if (dirty) await this.ctx.storage.put("acc", a);
    return need || (!!calv && !rows && calv !== a.calv);
  }

  // ---- EA side ----
  async sync(m) {
    let body = {}; try { body = JSON.parse(m.body || "{}"); } catch (e) {}
    const a = await this.S();
    const secret = String(m.secret || "");
    if (secret.length < 16) return json({ ok: false, error: "secret" }, 401);
    const sh = await sha("yt-ea|" + secret), now0 = Date.now();
    const matched = a.eaSecretH ? safeEq(a.eaSecretH, sh) : (a.eaSecret ? safeEq(a.eaSecret, secret) : false);
    // v4.6 PAIRING (replaces "first EA wins"): an account is bound only by an EA that proves the pairing code (Worker secret PAIR_CODE, or APP_PASSWORD when unset).
    // A valid code makes the SERVER mint the EA secret (CSPRNG) and hand it over once (es); afterwards the secret alone authenticates. Already-bound v4.5 accounts keep working
    // and are upgraded the first time the EA presents the code. A stranger who syncs first can no longer take the account: without the code he is refused (403).
    let ok = matched, issued = "", paired = false, dirty = false;
    const pair = String(m.pair || "");
    if (pair) {
      const locked = !!(a.pf && a.pf.until && now0 < a.pf.until);
      if (locked && !matched) return json({ ok: false, error: "pair_locked", retry: Math.ceil((a.pf.until - now0) / 1000) }, 429);
      if (!locked && this.c.pairKey && (await pwEq(this.c, pair, this.c.pairKey))) {
        a.pf = { n: 0, until: 0 }; paired = true; ok = true; dirty = true;
        if (!matched || !a.eaIssued) { issued = rnd(32); a.eaSecretH = await sha("yt-ea|" + issued); delete a.eaSecret; a.eaIssued = true; a.pairedAt = now0; }
      } else if (!matched) {
        const n = ((a.pf && a.pf.n) || 0) + 1;
        a.pf = { n, until: n >= this.c.pairMax ? now0 + this.c.pairLockMs : 0 };
        await this.ctx.storage.put("acc", a);
        return json({ ok: false, error: "pair_bad" }, 403);
      }
    }
    if (!ok) return json({ ok: false, error: this.bound(a) ? "secret" : "pair_required" }, this.bound(a) ? 401 : 403);
    if (matched && a.eaSecret) { a.eaSecretH = sh; delete a.eaSecret; dirty = true; }   // v4.5 stored the raw secret: keep only its hash from now on
    // v4: an EA restart NO LONGER signs anybody out. The app re-verifies on open (account + Telegram + bot) and enters by itself.
    // Sessions are revoked only when: the EA asks explicitly (reset), or the MT5 SERVER of this account changed.
    const srv = String(body.srv || "").slice(0, 64);
    if (srv && a.srv !== srv) { if (a.srv && a.sessions.length) a.sessions = []; a.srv = srv; dirty = true; }
    if (body.reset && a.sessions.length) { a.sessions = []; dirty = true; }
    if (!a.seen || now0 - a.seen > 15000) { a.seen = now0; dirty = true; }
    // single shared bot: config v changes when the chat list or the token changes
    const tsig = hex(await hmacRaw(enc.encode("t"), m.tok || "")).slice(0, 8);
    if (a.tsig !== tsig) { a.tsig = tsig; a.cfgv = (a.cfgv || 0) + 1; dirty = true; }
    if (dirty) await this.ctx.storage.put("acc", a);
    if (body.state && typeof body.state === "object") { this.st = body.state; this.ts = Date.now(); try { await this.watch(a); } catch (e) { /* alerts must never break the EA sync */ } try { await this.archive(body.state, a); await this.diagFrom(body.state); } catch (e) { /* the internal archive / diagnostics must never break the EA sync */ } }
    let calNeed = false;
    try { calNeed = await this.feed(body); } catch (e) { /* the news feed must never break the EA sync */ }
    let q = (await this.ctx.storage.get("cmds")) || [];
    const ack = Array.isArray(body.ack) ? body.ack : [];
    const now = Date.now();
    const next = q.filter((x) => !ack.includes(x.c.id) && now - x.t < 120000);
    if (next.length !== q.length) await this.ctx.storage.put("cmds", next);
    const out = { ok: true, commands: next.map((x) => x.c), staleSec: this.c.staleSec };
    if (issued) out.es = issued;
    if (paired) out.paired = true;
    if (calNeed) out.calNeed = true;
    if (String(a.cfgv) !== String(body.cv !== undefined ? body.cv : 0)) out.cfg = { v: String(a.cfgv), tok: m.tok || "", auth: a.tg.join(",") };
    return json(out);
  }

  // ---- App side ----
  async login(m) {
    const a = await this.S();
    if (!this.bound(a) || !this.botUp()) return json({ ok: false, error: "ea_offline" }, 503);   // EA must be running on this account
    const sess = rnd(24);
    const entry = { h: await sha(sess), tg: m.tg || "", t: Date.now(), pwv: await pwVersion(this.c), ep: this.c.epoch, srv: a.srv || "" };
    a.sessions = [...a.sessions, entry].slice(-10);
    if (m.tg && !a.tg.includes(m.tg)) { a.tg = [...a.tg, m.tg].slice(-5); a.cfgv = (a.cfgv || 0) + 1; }   // Telegram identity proven by Telegram itself
    await this.ctx.storage.put("acc", a);
    return json({ ok: true, sess });
  }
  // Fast connection check used by the app's "verify" popup. Four independent checks, so the UI can tell
  // a HARD failure (must sign in again) from a SOFT one (the bot is simply off right now -> keep waiting, auto-enter when it is back).
  async verify(m) {
    const a = await this.S();
    const r = await this.chk(a, m.sess);
    const bot = this.botUp() && this.bound(a);
    if (!r.s) return json({ ok: false, hard: true, why: r.why, checks: { session: false, account: r.why !== "acct", telegram: false, bot } });
    const s = r.s;
    const telegram = m.tg ? s.tg === m.tg && a.tg.includes(m.tg) : !this.c.requireTg && !s.tg;
    const checks = { session: true, account: true, telegram, bot };
    const hard = !telegram;
    if (!hard) { s.t = Date.now(); await this.ctx.storage.put("acc", a); }   // sliding expiry
    return json({ ok: telegram && bot, hard, why: hard ? "tg" : "", checks });
  }
  // brute-force guard per Telegram user / IP (the password is shared, so the limit is NOT per account: that would let a stranger lock the owner out)
  // v4: a real lock — after MAX_ATTEMPTS failures the key is locked for LOCK_SECONDS (2 min) and the exact remaining time is returned.
  async gate(m) {
    const now = Date.now(), c = this.c;
    let g = (await this.ctx.storage.get("g")) || { n: 0, t: now, until: 0 };
    if (g.until && now >= g.until) g = { n: 0, t: now, until: 0 };
    if (!g.until && now - g.t > c.winMs) g = { n: 0, t: now, until: 0 };
    if (m.reset) g = { n: 0, t: now, until: 0 };
    else if (m.fail && !(g.until && now < g.until)) { g.n++; if (g.n >= c.max) g.until = now + c.lockMs; }
    const locked = !!(g.until && now < g.until);
    await this.ctx.storage.put("g", g);
    return json({ ok: !locked, retry: locked ? Math.ceil((g.until - now) / 1000) : 0, left: Math.max(0, c.max - g.n) });
  }
  async logout(m) {
    const a = await this.S();
    const h = await sha(m.sess || "");
    const mine = a.sessions.find((x) => safeEq(x.h, h));
    a.sessions = a.sessions.filter((x) => !safeEq(x.h, h));
    // signing out also removes this Telegram user's registration on the account when no other session of theirs remains
    if (mine && mine.tg && !a.sessions.some((x) => x.tg === mine.tg) && a.tg.includes(mine.tg)) { a.tg = a.tg.filter((x) => x !== mine.tg); a.cfgv = (a.cfgv || 0) + 1; }
    await this.ctx.storage.put("acc", a);
    return json({ ok: true });
  }
  // ---- v4.7 internal archive (all closed trades, kept forever, one key per week) + diagnostics ring ----
  async weekList(key) {
    if (this.wkc && this.wkc.key === key) return this.wkc.list;
    const list = (await this.ctx.storage.get("hx:" + key)) || [];
    this.wkc = { key, list }; return list;
  }
  async archive(st, a) {
    const h = Array.isArray(st && st.hist) ? st.hist : [];
    const sig = h.map((x) => x.no + "-" + x.ts).join(",");
    if (!h.length || sig === this.hxSig) return;
    const by = {};
    for (const x of h) { const ts = Number(x.ts); if (!(ts > 0)) continue; (by[weekOfTs(ts)] = by[weekOfTs(ts)] || []).push(x); }
    for (const k of Object.keys(by)) {
      const cur = await this.weekList(Number(k)).catch(() => []), ids = new Set(cur.map((r) => r.id));
      let add = 0;
      for (const x of by[k]) {
        const id = String(x.no) + "-" + Number(x.ts); if (ids.has(id)) continue; ids.add(id);   // unique trade id: a trade can never be listed twice
        cur.push({ id, no: Number(x.no) || 0, side: String(x.side || "").slice(0, 8), entry: Number(x.entry) || 0, exit: Number(x.exit) || 0, lot: Number(x.lot) || 0, pnl: Number(x.pnl) || 0, reason: String(x.reason || "").slice(0, 40), t: String(x.t || "").slice(0, 12), ts: Number(x.ts) });
        add++;
      }
      if (add) { await this.ctx.storage.put("hx:" + k, cur); this.wkc = { key: Number(k), list: cur }; }   // NEVER trimmed or deleted: the week view is a filter, not a purge
    }
    this.hxSig = sig;
  }
  async diagFrom(st) {
    const src = (Array.isArray(st && st.cmds) ? st.cmds : []).concat(st && st.lastCmd ? [st.lastCmd] : []), bad = [];
    for (const x of src) { if (!x || x.id == null) continue; const bst = x.st === "fail" || x.ok === false; if (bst && !this.dseen.has(String(x.id))) bad.push(x); }
    if (!bad.length) return;
    if (this.dseen.size > 500) this.dseen.clear();
    const d = (await this.ctx.storage.get("diag")) || [], ids = new Set(d.map((r) => r.id));
    for (const x of bad) { const id = String(x.id); this.dseen.add(id); if (ids.has(id)) continue; d.push({ id, rid: rid(id), t: Date.now(), src: "ea", cmd: String(x.cmd || "").slice(0, 16), cat: classify(x.text).cat || "user", raw: String(x.text || "").slice(0, 300) }); }
    await this.ctx.storage.put("diag", d.slice(-300));   // diagnostics ring only (NOT trades)
  }
  async diag() {
    const a = await this.S(), weeks = [...(await this.ctx.storage.list({ prefix: "hx:" })).entries()].map(([k, v]) => ({ weekDay: Number(k.slice(3)), trades: v.length }));
    return json({ ok: true, now: Date.now(), tzo: a.tzo || 0, eaAge: this.age(), diag: (await this.ctx.storage.get("diag")) || [], commandLog: (this.st && this.st.cmds) || [], lastCmdRaw: (this.st && this.st.lastCmd) || null, archivedWeeks: weeks });
  }
  async state(m) {
    const a = await this.S();
    const r = await this.chk(a, m.sess);
    if (!r.s) return this.deny(r.why);
    await this.touch(a, r.s);
    const ag = this.age();
    const pub = publicOf(this.st || { price: 0, run: false, state: "STOPPED" });
    const oal = await this.oaMine(this.uidOf(r.s, a));
    // v4.7: the Mini App sees the CURRENT WEEK's closed trades only (from the internal archive: unique ids, survives refresh / Worker restart);
    // the EA's own all-time stats and last-40 list are not forwarded. Older weeks stay in the archive untouched.
    const win = weekWin(a.tzo), wk = await this.weekList(win.key);
    pub.hist = [...wk].sort((x, y) => y.ts - x.ts);
    pub.stats = weekStats(wk);
    pub.week = { from: win.from, to: win.to, tzo: Number(a.tzo) || 0 };
    return json({ ...pub, eaAge: ag, eaOnline: this.botUp(), eaStaleSec: this.c.staleSec, oalerts: oal });
  }
  async command(m) {
    const a = await this.S();
    const r = await this.chk(a, m.sess);
    if (!r.s) return this.deny(r.why);
    await this.touch(a, r.s);
    let b = null; try { b = JSON.parse(m.body || "null"); } catch (e) {}
    const allowed = ["start", "stop", "close", "reset", "apply", "settings", "delete", "cancel", "modify", "place", "newcycle"];
    if (!b || !allowed.includes(String(b.cmd))) return json({ error: "bad command" }, 400);
    if (!this.botUp()) return json({ error: "ea offline" }, 503);
    if (b.cmd === "newcycle") {            // v4.7: explicit, GUARDED cycle reset = EA "stop" + EA "reset". Never on a live trade, never while another command is in flight.
      const st0 = this.st || {}, now1 = Date.now(), q1 = ((await this.ctx.storage.get("cmds")) || []).filter((x) => now1 - x.t < 120000);
      if (st0.pos || /^(BUY|SELL)_ACTIVE$/.test(String(st0.state || ""))) return json({ error: "busy", why: "position" }, 409);
      if (q1.length) return json({ error: "busy", why: "pending" }, 409);
      const id1 = crypto.randomUUID().replace(/-/g, "").slice(0, 16), id2 = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      await this.ctx.storage.put("cmds", [{ t: now1, c: { id: id1, cmd: "stop" } }, { t: now1, c: { id: id2, cmd: "reset" } }]);
      return json({ ok: true, id: id2, orders: Array.isArray(st0.orders) ? st0.orders.length : 0 });
    }
    const c = { id: crypto.randomUUID().replace(/-/g, "").slice(0, 16), cmd: String(b.cmd) };   // id first: the EA parser relies on it
    for (const k of ["buy", "sell", "risk", "target", "rr", "ticket", "price"]) {
      if (b[k] === undefined || b[k] === null || b[k] === "") continue;
      const n = Number(b[k]);
      if (!Number.isFinite(n)) return json({ error: "bad number: " + k }, 400);
      c[k] = n;
    }
    if (b.side !== undefined && b.side !== null && b.side !== "") {
      const sd = String(b.side).toUpperCase();
      if (sd !== "BUY" && sd !== "SELL") return json({ error: "bad side" }, 400);
      c.side = sd;
    }
    if ((b.cmd === "delete" || b.cmd === "modify") && !(c.ticket > 0) && !c.side) return json({ error: "ticket or side required" }, 400);
    if ((b.cmd === "modify" || b.cmd === "place") && !(c.price > 0)) return json({ error: "price required" }, 400);
    if (b.cmd === "place" && !c.side) return json({ error: "side required" }, 400);
    const q = (await this.ctx.storage.get("cmds")) || [];
    q.push({ t: Date.now(), c });
    await this.ctx.storage.put("cmds", q.slice(-20));
    return json({ ok: true, id: c.id });
  }
}
