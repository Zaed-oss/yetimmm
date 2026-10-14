// Yetimmm bridge v4.19.0 — ONE bot, ONE link, login by MT5 account number + ONE app password.
//   EA  -> POST /api/ea/sync  (headers X-EA-Secret [+ X-EA-Pair while pairing])  body {login, srv, fresh, reset, cv, state, ack}
//   App -> POST /login        body {login, pw, init}                -> {ok, sess}
//   App -> POST /verify       headers X-Login + X-Session, body {init} -> {ok, hard, checks:{session,account,telegram,bot}}
//   App -> GET  /state        headers X-Login + X-Session
//   App -> POST /command      headers X-Login + X-Session
//   App -> POST /logout       headers X-Login + X-Session
// Secrets (wrangler secret put): BOT_TOKEN, APP_PASSWORD, PAIR_CODE (EA <-> account pairing; no default value anywhere, no fallback unless ALLOW_PAIR_FALLBACK=1)
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
export const VERSION = "4.19.0", EA_PROTOCOL = "2.31";   // v4.8: the ONE place the release number lives (package.json / README / CHANGELOG / EA must match: npm run check enforces it)
export { Notify };

const CONFIG = {
  PASSWORD: "",              // leave EMPTY and set it as a secret:  wrangler secret put APP_PASSWORD   (login is refused until a password exists)
  // v4.18: the wrong-password lock (LOCK_SECONDS / MAX_ATTEMPTS / FAIL_WINDOW_SEC) was REMOVED by owner decision: unlimited attempts, no ban of any kind.
  TG_AUTH_MAX_AGE_SEC: 86400, // Telegram initData older than this is refused (auth_date). Telegram recommends at most a day.
  OWNER_TG_MAX_AGE_SEC: 3600, // PASSWORD-LESS owner sign-in (OWNER_TG) needs initData no older than this (a captured initData must not open the app for a whole day). Older = reopen the Mini App.
  MAX_SESSIONS: 1000,        // safety ceiling of VALID sessions per MT5 account. It only REFUSES a new sign-in (error too_many_sessions); it never signs anybody out. 0 = unlimited.
  TG_FUTURE_SKEW_SEC: 60,    // an auth_date this far in the FUTURE is tolerated (clock drift); more is refused
  SESSION_DAYS: 30,          // sliding session lifetime (refreshed on every successful verify)
  EA_STALE_SEC: 20,          // EA counts as offline after this many seconds without a sync
  SESSION_EPOCH: 1,          // bump (1 -> 2) to sign EVERYONE out at once
  ALLOWED_ORIGIN: "",        // v4.6.1: fail-closed. CORS origin of the web app, e.g. "https://you.github.io" (set in wrangler.toml [vars]; env wins). "*" = open, testing only
  REQUIRE_TG: true,          // true = login only from inside the Telegram bot (env REQUIRE_TG="0" allows browsers)
  SESSION_TOUCH_SEC: 600,    // v4.6: any authenticated request slides the session expiry (persisted at most once per this many seconds)
  NEWS_SCOPE: "server",      // v4.6: "server" = one calendar/notification shard per broker server (multi-broker safe) | "global" = legacy single shard
};

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
function cfg(env) {
  return {
    password: String(env.APP_PASSWORD || CONFIG.PASSWORD),
    tgMaxAge: num(env.TG_AUTH_MAX_AGE_SEC, CONFIG.TG_AUTH_MAX_AGE_SEC),
    tgSkew: num(env.TG_FUTURE_SKEW_SEC, CONFIG.TG_FUTURE_SKEW_SEC),
    ownerMaxAge: num(env.OWNER_TG_MAX_AGE_SEC, CONFIG.OWNER_TG_MAX_AGE_SEC),
    maxSess: Math.max(0, Math.floor(num(env.MAX_SESSIONS, CONFIG.MAX_SESSIONS))),
    sessMs: num(env.SESSION_DAYS, CONFIG.SESSION_DAYS) * 86400000,
    staleSec: num(env.EA_STALE_SEC, CONFIG.EA_STALE_SEC),
    epoch: String(env.SESSION_EPOCH || CONFIG.SESSION_EPOCH),
    chatProblems: String(env.CHAT_PROBLEMS || "0") === "1",   // v4.19: 1 = also push technical problems to the chat (default: the chat shows ORDERS and ALERTS only)
    requireTg: String(env.REQUIRE_TG !== undefined ? env.REQUIRE_TG : CONFIG.REQUIRE_TG ? "1" : "0") !== "0",
    salt: String(env.BOT_TOKEN || ""),
    owners: String(env.OWNER_TG || "").split(",").map((x) => x.trim()).filter((x) => /^\d{3,15}$/.test(x)),   // v4.14: Telegram ids that sign in WITHOUT a password (identity proven by Telegram initData)
    origins: String(env.ALLOWED_ORIGIN || CONFIG.ALLOWED_ORIGIN || "").split(",").map((x) => x.trim().replace(/\/+$/, "")).filter(Boolean),   // comma separated; "*" = open (testing only)
    // v4.8: PAIR_CODE is MANDATORY and separate from APP_PASSWORD (a leaked app password must not pair a rogue EA). ALLOW_PAIR_FALLBACK="1" restores the old fallback (not recommended).
  pairKey: String(env.PAIR_CODE || (String(env.ALLOW_PAIR_FALLBACK || "") === "1" ? (env.APP_PASSWORD || CONFIG.PASSWORD) : "")),
    touchMs: num(env.SESSION_TOUCH_SEC, CONFIG.SESSION_TOUCH_SEC) * 1000,
    newsScope: String(env.NEWS_SCOPE || CONFIG.NEWS_SCOPE).toLowerCase() === "global" ? "global" : "server",
  };
}

// "GMT+3", "GMT-5", "GMT+5:30" from an offset in seconds (the MT5 server time offset reported by the EA)
// v4.19: the chat carries ORDERS (placed / modified / activated / SL / TP / closed / reversal / start-stop) and the user's ALERTS - never technical problems.
// Problems are kept in the diagnostics ring (/admin/diag). Two items concern an OPEN position and stay visible: critical protection failure and emergency close.
const CHAT_KEEP_ALWAYS = /CRITICAL PROTECTION FAILURE|EMERGENCY CLOSE/i;
const CHAT_ORDER = /PLACED|ACTIVATED|STOP LOSS|TAKE PROFIT|POSITION CLOSED|MODIFIED|ORDER DELETED|MARKET REVERSAL|EXECUTION REJECTED|PROTECTION RESTORED|YETIMMM STARTED|STOP EXECUTED/i;
function chatWorthy(title) {
  const t = String(title || "");
  if (CHAT_KEEP_ALWAYS.test(t)) return true;
  if (/^\s*(\u26A0|\u{1F6AB}\s*UNAUTHORIZED)/u.test(t)) return false;      // warnings (RaiseAlert) and unauthorized-access notices are problems
  return CHAT_ORDER.test(t);
}
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
// v4.18: signature (HMAC over the data-check-string, sorted by KEY as Telegram specifies) + a REQUIRED numeric auth_date that must be neither older
// than TG_AUTH_MAX_AGE_SEC nor further in the future than TG_FUTURE_SKEW_SEC; duplicated keys and a non-numeric / non-positive user id are refused.
async function tgUser(initData, botToken, c) { const r = await tgCheck(initData, botToken, c); return r ? r.id : null; }
async function tgCheck(initData, botToken, c) {      // -> { id, age } (age in seconds) or null
  try {
    if (!initData || !botToken || initData.length > 4096) return null;
    const maxAge = c ? c.tgMaxAge : CONFIG.TG_AUTH_MAX_AGE_SEC, skew = c ? c.tgSkew : CONFIG.TG_FUTURE_SKEW_SEC;
    const p = new URLSearchParams(initData);
    const keys = [...p.keys()];
    if (new Set(keys).size !== keys.length) return null;
    const hash = String(p.get("hash") || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    p.delete("hash");
    const dcs = [...p.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).map(([k, v]) => k + "=" + v).join("\n");
    const secret = await hmacRaw(enc.encode("WebAppData"), botToken);
    if (!safeEq(hex(await hmacRaw(secret, dcs)), hash)) return null;
    const ad = String(p.get("auth_date") || "");
    if (!/^\d{9,11}$/.test(ad)) return null;
    const age = Date.now() / 1000 - Number(ad);
    if (age > maxAge || age < -skew) return null;
    const u = JSON.parse(p.get("user") || "{}");
    return u && Number.isSafeInteger(u.id) && u.id > 0 ? { id: String(u.id), age: Math.max(0, age) } : null;
  } catch (e) { return null; }
}

// v4.18 CORS: only an origin listed in ALLOWED_ORIGIN ("*" = open, local testing only) gets Access-Control-* headers. A browser request from any other origin gets none
// (the old code answered with the FIRST allowed origin). CORS is NOT authentication: every sensitive route still needs a valid session / EA secret / admin key.
// a request body that is not a JSON OBJECT (null, array, number, text, broken JSON) is treated as {} : it can never make a handler throw
const jobj = (x) => { try { const v = JSON.parse(x); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch (e) { return {}; } };
const originAllowed = (o, c) => !o || c.origins.includes("*") || c.origins.includes(o);
function cors(req, c) {
  const o = req.headers.get("Origin");
  if (!o) return {};
  if (!originAllowed(o, c)) return { Vary: "Origin" };
  return { "Access-Control-Allow-Origin": c.origins.includes("*") ? "*" : o, "Access-Control-Allow-Headers": "Content-Type, X-Login, X-Session", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Max-Age": "600", Vary: "Origin" };
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
// v4.18 (XSS defence in depth): whatever reaches the app's HTML is typed here. Numbers are numbers, sides are BUY/SELL or empty, so a hostile or corrupted
// state can never smuggle markup through pos.no / orders[].ticket / price fields. The app ALSO escapes everything it renders (index.html esc()).
const fin = (x) => { const v = Number(x); return Number.isFinite(v) ? v : 0; };
const sideOf = (x) => { const t = String(x == null ? "" : x).toUpperCase(); return t.startsWith("B") ? "BUY" : t.startsWith("S") ? "SELL" : ""; };
const ident = (x, n) => String(x == null ? "" : x).replace(/[^A-Za-z0-9_.:+\/ -]/g, "").slice(0, n || 40);
function typedObj(x, nums, bools) {
  if (!x || typeof x !== "object") return x;
  const y = { ...x };
  for (const k of nums) if (k in y) y[k] = fin(y[k]);
  for (const k of bools || []) if (k in y) y[k] = !!y[k];
  if ("side" in y) y.side = sideOf(y.side);
  return y;
}
function publicOf(st) {
  const o = { ...st };
  delete o.__proto__; delete o.constructor;       // an own "__proto__" key from a hostile EA state must never reach the app
  delete o.cmds;                                   // EA command log (Apply / Waiting / Superseded / failed ...) = internal, never a trade
  if (o.pos && typeof o.pos === "object") o.pos = typedObj(o.pos, ["pid", "entry", "sl", "tp", "lot", "est", "risk", "no", "profit"]);
  if (Array.isArray(o.orders)) o.orders = o.orders.slice(0, 40).map((x) => typedObj(x, ["ticket", "price", "lot", "sl", "tp"]));
  if (Array.isArray(o.waits)) o.waits = o.waits.slice(0, 8).map((x) => typedObj(x, ["level", "trig", "now", "dist"], ["placing"]));
  for (const k of ["state", "mode", "breach", "entry", "wcode", "sym", "ver"]) if (k in o) o[k] = ident(o[k], 40);   // enum-like fields: letters, digits and _ . : + - / space only
  const m = classify(o.msg); o.msg = m.text; if (m.cat === "tech") o.msgCat = "tech";
  if (o.lastCmd && typeof o.lastCmd === "object") { const c = classify(o.lastCmd.text); o.lastCmd = { id: o.lastCmd.id, ok: !!o.lastCmd.ok, text: c.text, cat: c.cat, rid: c.cat === "tech" ? rid(o.lastCmd.id) : undefined }; }
  for (const k of ["waits", "orders"]) if (Array.isArray(o[k])) o[k] = o[k].map((x) => { if (!x || typeof x !== "object") return x; const y = { ...x }; for (const f of ["why", "note", "text", "msg", "err", "reason"]) if (typeof y[f] === "string") y[f] = classify(y[f]).text; return y; });
  return o;
}
// week = Monday 00:00 .. Sunday 23:59:59 in BROKER SERVER time (trade timestamps are server wall-clock; tzo = server offset in seconds)
const weekMon = (daySrv) => daySrv - ((daySrv + 3) % 7);                       // epoch day 0 was a Thursday
function weekWin(tzo, nowMs) { const day = Math.floor(((nowMs === undefined ? Date.now() : nowMs) / 1000 + (Number(tzo) || 0)) / 86400), mon = weekMon(day); return { key: mon, from: mon * 86400, to: mon * 86400 + 7 * 86400 - 1 }; }
const weekOfTs = (ts) => weekMon(Math.floor(Number(ts) / 86400));
const r2n = (x) => Math.round(x * 1e6) / 1e6;   // v4.8: keep the real precision (lots 0.001, 3-decimal currencies); the UI formats for display
function weekStats(L) {
  const n = L.length, sum = (a) => a.reduce((s, x) => s + x, 0), win = L.filter((x) => x.pnl > 0), los = L.filter((x) => x.pnl < 0), gw = sum(win.map((x) => x.pnl)), gl = -sum(los.map((x) => x.pnl));
  const byTs = [...L].sort((a, b) => b.ts - a.ts); let streak = 0;
  for (const x of byTs) { const sg = x.pnl > 0 ? 1 : x.pnl < 0 ? -1 : 0; if (!sg) break; if (!streak) streak = sg; else if (Math.sign(streak) !== sg) break; streak += sg; }
  return { total: n, wins: win.length, losses: los.length, net: r2n(sum(L.map((x) => x.pnl))), pf: n ? (gl > 0 ? r2n(gw / gl) : gw > 0 ? 99.99 : 0) : null, avgW: win.length ? r2n(gw / win.length) : 0, avgL: los.length ? r2n(gl / los.length) : 0, maxW: win.length ? Math.max(...win.map((x) => x.pnl)) : 0, maxL: los.length ? Math.max(...los.map((x) => -x.pnl)) : 0, buys: L.filter((x) => /^B/i.test(x.side)).length, sells: L.filter((x) => /^S/i.test(x.side)).length, streak, vol: r2n(sum(L.map((x) => x.lot))), comm: 0, swap: 0 };
}

// ── Telegram bot chat (v4.14): /start = banner + one centered Mini App button ───────────────────────────────────────────────
// Webhook secret is derived from BOT_TOKEN (no extra secret to manage). scripts/setup-bot.mjs registers it with the same derivation.
const TGW = {
  ar: { cap: "<b>Yetimmm</b> · XAUUSD\nنظام إدارة مخاطر ذكي لمنصة MT5\n\n▫️ أوردرات Buy / Sell Stop بتسلسل مخاطرة محسوب\n▫️ متابعة مباشرة للأوردرات والصفقات والأرباح\n▫️ تنبيهات الأخبار والأوامر\n\nاضغط الزر بالأسفل لفتح التطبيق 👇", btn: "فتح Yetimmm" },
  en: { cap: "<b>Yetimmm</b> · XAUUSD\nSmart risk-sequence manager for MT5\n\n▫️ Buy / Sell Stop cycles with calculated risk\n▫️ Live orders, trades and P/L\n▫️ News and order alerts\n\nTap the button below to open the app 👇", btn: "Open Yetimmm" },
};
export async function tgWebhookSecret(token) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("yt-webhook:" + token));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}
let _menuUrl = { u: "", t: 0 };
async function tgMenuUrl(token) {
  if (_menuUrl.u && Date.now() - _menuUrl.t < 300000) return _menuUrl.u;
  try {
    const r = await (await fetch("https://api.telegram.org/bot" + token + "/getChatMenuButton", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
    const u = r && r.ok && r.result && r.result.web_app && r.result.web_app.url;
    if (u) _menuUrl = { u: String(u), t: Date.now() };
    return u ? String(u) : "";
  } catch { return ""; }
}
async function tgWebhook(req, env) {
  const token = env.BOT_TOKEN || "";
  if (!token) return new Response("no bot", { status: 503 });
  const got = req.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!safeEq(got, await tgWebhookSecret(token))) return new Response("forbidden", { status: 403 });
  let u; try { u = await req.json(); } catch { return new Response("ok"); }
  const m = u && u.message;
  if (!m || !m.chat || m.chat.type !== "private") return new Response("ok");
  const L = String((m.from && m.from.language_code) || "").toLowerCase().startsWith("ar") ? TGW.ar : TGW.en;
  const app = String(env.MINI_APP_URL || "").trim() || await tgMenuUrl(token);   // optional override; otherwise = the Menu-Button URL set by setup-bot (single source of truth)
  const api = (method, body) => fetch("https://api.telegram.org/bot" + token + "/" + method, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const kb = app ? { inline_keyboard: [[{ text: "✦ " + L.btn, web_app: { url: app } }]] } : undefined;
  const banner = String(env.BANNER_URL || (app ? app.replace(/\/?$/, "/") + "assets/banner.png" : "")).trim();
  let ok = false;
  if (banner) { try { const r = await api("sendPhoto", { chat_id: m.chat.id, photo: banner, caption: L.cap, parse_mode: "HTML", reply_markup: kb }); ok = r.ok; } catch { ok = false; } }
  if (!ok) await api("sendMessage", { chat_id: m.chat.id, text: L.cap, parse_mode: "HTML", reply_markup: kb }).catch(() => {});
  return new Response("ok");
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const c = cfg(env);
    const ch = cors(req, c);
    if (req.method === "OPTIONS") return new Response(null, { status: originAllowed(req.headers.get("Origin"), c) ? 204 : 403, headers: ch });
    // v4.18 hardening: every API answer is non-cacheable, non-sniffable, non-frameable and sends no referrer (CORS headers are added below)
    const SEC = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" };
    const done = (res) => { const h = new Headers(res.headers); for (const [k, v] of Object.entries(SEC)) h.set(k, v); for (const [k, v] of Object.entries(ch)) h.set(k, v); return new Response(res.body, { status: res.status, headers: h }); };
    const P = url.pathname;
    if (P === "/") {
      if (req.method !== "GET" && req.method !== "HEAD") return done(json({ error: "method" }, 405));
      // v4.18: the public root says only that the service is up. Configuration facts (pairing configured, CORS state, protocol) are admin-only (X-Admin-Key = secret ADMIN_KEY).
      const o = { ok: true, service: "yetimmm-bridge", v: VERSION };
      if (env.ADMIN_KEY && safeEq(String(req.headers.get("X-Admin-Key") || ""), String(env.ADMIN_KEY))) Object.assign(o, { release: VERSION, ea_protocol: EA_PROTOCOL, pairConfigured: !!c.pairKey, corsOpen: c.origins.includes("*"), corsConfigured: c.origins.length > 0 });
      return done(json(o));
    }
    if (P === "/tg/webhook" && req.method === "POST") return tgWebhook(req, env);   // Telegram -> bot chat (no CORS / no account)
    // browser-facing routes also refuse a request whose Origin is not allowed (the EA never sends an Origin, so /api/ea/sync is not affected)
    if (P !== "/api/ea/sync" && !originAllowed(req.headers.get("Origin"), c)) return done(json({ ok: false, error: "origin" }, 403));
    try {
      let login = "", body = "";
      if (P === "/api/ea/sync" || P === "/login") {
        if (req.method !== "POST") return done(json({ error: "method" }, 405));
        body = await req.text();
        if (body.length > (P === "/login" ? 8192 : 2000000)) return done(json({ ok: false, error: "too_large" }, 413));
        const b = jobj(body);
        login = String((b && b.login) || "").trim();
      } else if (P === "/admin/diag" || P === "/state" || P === "/command" || P === "/logout" || P === "/verify" || P.startsWith("/news/") || P === "/order-alert") {
        if (P === "/state" && req.method !== "GET") return done(json({ error: "method" }, 405));      // GET never changes anything but the caller's own sliding session
        if ((P === "/command" || P === "/logout" || P === "/verify") && req.method !== "POST") return done(json({ error: "method" }, 405));
        login = (req.headers.get("X-Login") || "").trim();
        if (req.method === "POST") { body = await req.text(); if (body.length > 65536) return done(json({ ok: false, error: "too_large" }, 413)); }
      } else return done(json({ error: "not found" }, 404));
      let autoLogin = false;
      if (P === "/login" && !/^\d{3,12}$/.test(login)) {            // owner (Telegram-proven) may omit the account number: the only VERIFIED MT5 account that synced is used
        const b0 = jobj(body);
        const t0 = await tgCheck(String((b0 && b0.init) || ""), env.BOT_TOKEN || "", c), tg0 = t0 && t0.id;
        if (tg0 && c.owners.includes(tg0) && t0.age <= c.ownerMaxAge) {
          const dl = await (await env.HUB.get(env.HUB.idFromName("dir")).fetch("https://hub/dir", { method: "POST", body: JSON.stringify({ op: "list" }) })).json();
          if (dl.logins.length === 1) { login = dl.logins[0]; autoLogin = true; }
          else return done(json({ ok: false, error: dl.logins.length ? "pick_account" : "no_account", accounts: dl.logins }, 404));
        }
      }
      if (!/^\d{3,12}$/.test(login)) return done(json({ ok: false, error: "login" }, P === "/login" ? 400 : 401));
      if (P === "/api/ea/sync") {
        // v4.18 edge pre-checks: nothing below creates, writes or lists anything for a request that cannot possibly be authentic.
        const sec = (req.headers.get("X-EA-Secret") || "").trim(), pair = (req.headers.get("X-EA-Pair") || "").trim().slice(0, 256);
        if (sec.length < 16) return done(json({ ok: false, error: "secret" }, 401));
        if (pair && !(c.pairKey && (await pwEq(c, pair, c.pairKey)))) {
          // a wrong / unconfigured pairing code can only succeed when the EA ALSO holds a valid secret of an already VERIFIED account (listed in the directory): everything else stops here
          const known = await (await env.HUB.get(env.HUB.idFromName("dir")).fetch("https://hub/dir", { method: "POST", body: JSON.stringify({ op: "has", login }) })).json().catch(() => ({}));
          if (!known.has) return done(json(c.pairKey ? { ok: false, error: "pair_bad" } : { ok: false, error: "pair_not_configured" }, c.pairKey ? 403 : 503));
        }
      }
      const hub = env.HUB.get(env.HUB.idFromName("acc-" + login));
      const call = (path, extra) => hub.fetch("https://hub" + path, { method: "POST", body: JSON.stringify(extra) });
      // v4.18: the account is added to the directory ONLY by the Hub, after a sync that proved the pairing code or the EA secret. Receiving a request never registers anything.
      if (P === "/api/ea/sync") return done(await call("/sync", { secret: (req.headers.get("X-EA-Secret") || "").trim(), pair: (req.headers.get("X-EA-Pair") || "").trim().slice(0, 256), body, tok: env.BOT_TOKEN || "", login }));
      if (P === "/login") {
        const b = jobj(body);
        const ti = await tgCheck(String(b.init || ""), env.BOT_TOKEN || "", c), tg = ti ? ti.id : null;
        // a Telegram-proven owner needs NO password, so that proof must be FRESH (OWNER_TG_MAX_AGE_SEC); an older initData of the owner only counts as an ordinary Telegram identity
        const owner = !!(tg && c.owners.includes(tg) && ti.age <= c.ownerMaxAge);
        if (!c.password && !owner && tg && c.owners.includes(tg)) return done(json({ ok: false, error: "tg_stale" }, 401));
        if (!c.password && !owner) return done(json({ ok: false, error: c.owners.length ? "tg_only" : "not_configured" }, c.owners.length ? 403 : 503));   // no APP_PASSWORD set: refuse instead of running with a default password
        if (c.requireTg && !tg) return done(json({ ok: false, error: "tg_only" }, 403));
        // v4.18: NO attempt counter, NO lock, NO delay: a wrong password is simply refused and the user may try again immediately and without limit (owner decision).
        if (!owner && !(await pwEq(c, b.pw, c.password))) return done(json({ ok: false, error: "bad_pw" }, 401));
        const res = await call("/login", { tg });
        if (autoLogin && res.status === 200) { const j = await res.json(); return done(json({ ...j, login })); }
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
        const b = jobj(body);                // v4.18 (found by fuzzing): JSON null / array / scalar bodies used to throw -> HTTP 500
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
        const b = jobj(body);
        const tg = await tgUser(String(b.init || ""), env.BOT_TOKEN || "", c);
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
  constructor(ctx, env) { this.ctx = ctx; this.env = env || {}; this.c = cfg(env || {}); this.st = null; this.ts = 0; this.oa = null; this.miss = {}; this.hxSig = ""; this.wkc = null; this.dseen = new Set(); this.mq = Promise.resolve(); this.migrated = false; this.dirAt = 0; }
  age() { return this.ts ? (Date.now() - this.ts) / 1000 : null; }
  // v4.19: the last EA snapshot survives a Worker restart / eviction. Without it a restart answered "STOPPED, price 0" until the EA synced again,
  // i.e. the app looked like a brand-new session. The saved copy keeps its ORIGINAL timestamp, so age()/botUp() stay truthful (an old snapshot is never "online").
  async restoreSt() {
    if (this.st || this.lstDone) return;
    this.lstDone = true;
    try {
      const l = await this.ctx.storage.get("lst");
      if (l && l.st && typeof l.st === "object" && Number(l.ts) > 0 && !this.st) { this.st = l.st; this.ts = Number(l.ts); }
    } catch (e) { /* a missing snapshot only means a cold start */ }
  }
  async persistSt(st) {
    const t = Date.now();
    if (t - (this.lstT || 0) < 5000) return;      // at most one write per 5 s (the EA syncs every second or two)
    this.lstT = t;
    try { const j = JSON.stringify(st); if (j.length < 120000) await this.ctx.storage.put("lst", { st, ts: this.ts }); } catch (e) { /* persistence must never break the EA sync */ }
  }
  botUp() { const g = this.age(); return g !== null && g < this.c.staleSec; }
  bound(a) { return !!(a.eaSecretH || a.eaSecret); }

  // ═════ v4.18 SESSIONS ═════
  // Every sign-in is its OWN record "ses:<sha256(token)>" = { h, tg, t, c, pwv, ep, srv }. There is NO shared list, NO maximum number of sessions and NO "keep the last N":
  // a new device can never push an older one out, a refresh / reconnect / EA restart never replaces one, and signing out removes only the caller's own record.
  // A session ends only when: it expires (sliding SESSION_DAYS), the user signs out, SESSION_EPOCH is bumped, APP_PASSWORD changes, the EA asks explicitly (InpBrResetPw)
  // or the MT5 SERVER of the account changes. Records that are ALREADY invalid are deleted at the next sign-in (cleanup, never a limit).
  // Account-level fields (EA secret, server, Telegram chats ...) live in the separate "acc" record and are changed ONLY through upd() = fresh read -> synchronous change -> write,
  // serialized by mutex(): two overlapping requests (EA sync + a login + a poll) can no longer overwrite each other's change (the old whole-record rewrites could drop a new session).
  mutex(fn) { const r = this.mq.then(fn); this.mq = r.then(() => {}, () => {}); return r; }
  async upd(fn) {
    return this.mutex(async () => {
      const a = await this.S();
      const r = fn(a);
      if (r !== false) await this.ctx.storage.put("acc", a);
      return a;
    });
  }
  // one-time import of the pre-4.18 array "acc.sessions" into per-session records (idempotent)
  async migrate() {
    if (this.migrated) return;
    await this.mutex(async () => {
      const a = await this.ctx.storage.get("acc");
      if (a && Array.isArray(a.sessions)) {
        const put = {};
        for (const x of a.sessions) if (x && typeof x === "object" && x.h) put["ses:" + x.h] = x;
        const ks = Object.keys(put);
        for (let i = 0; i < ks.length; i += 100) { const part = {}; for (const k of ks.slice(i, i + 100)) part[k] = put[k]; await this.ctx.storage.put(part); }
        delete a.sessions; await this.ctx.storage.put("acc", a);
      }
    });
    this.migrated = true;
  }
  // sliding expiry: persisted at most once per SESSION_TOUCH_SEC so /state polling never hammers storage. Touches ONLY this session's record (and never resurrects a signed-out one).
  async touch(r, force) {
    const now = Date.now();
    if (!force && now - r.s.t <= this.c.touchMs) return;
    await this.mutex(async () => { const cur = await this.ctx.storage.get(r.k); if (cur) { cur.t = now; await this.ctx.storage.put(r.k, cur); } });
  }
  async sessionKeys() { return [...(await this.ctx.storage.list({ prefix: "ses:" })).keys()]; }
  async dropSessions() {     // explicit "sign everybody out" only (EA reset input / MT5 server changed)
    await this.mutex(async () => { const ks = await this.sessionKeys(); for (let i = 0; i < ks.length; i += 100) await this.ctx.storage.delete(ks.slice(i, i + 100)); });
  }
  // deletes sessions that are ALREADY invalid (expired / other epoch / old password) and un-registers Telegram chats that no longer have any session. Never removes a valid session.
  async cleanup(pwv) {
    const now = Date.now(), all = await this.ctx.storage.list({ prefix: "ses:" }), dead = [], alive = new Set();
    for (const [k, x] of all) { if (!x || typeof x !== "object" || now - x.t > this.c.sessMs || x.ep !== this.c.epoch || x.pwv !== pwv) dead.push(k); else if (x.tg) alive.add(x.tg); }
    for (let i = 0; i < dead.length; i += 100) await this.ctx.storage.delete(dead.slice(i, i + 100));
    if (dead.length) { const a = await this.S(), keep = a.tg.filter((g) => alive.has(g)); if (keep.length !== a.tg.length) { a.tg = keep; a.cfgv = (a.cfgv || 0) + 1; await this.ctx.storage.put("acc", a); } }
  }
  // v4.18 account directory (owner auto-login). ONLY accounts whose EA proved the pairing code / secret are ever added (see sync()). Stored as { login: lastSeenMs } under "dir2"
  // (the old "dir" list, which any unverified request could fill, is ignored). A live account is never replaced by a new one: when full, only an entry unseen for 30 days may go.
  async dir(b) {
    return this.mutex(async () => {
      const now = Date.now(), DAY30 = 30 * 86400000, MAX = 200;
      const m = (await this.ctx.storage.get("dir2")) || {};
      const lg = String(b.login || "");
      if (b.op === "has") return json({ ok: true, has: !!(m[lg] && now - m[lg] < DAY30) });
      if (b.op === "add" && /^\d{3,12}$/.test(lg)) {
        if (m[lg] === undefined || now - m[lg] > 3600000) {
          if (m[lg] === undefined && Object.keys(m).length >= MAX) {
            const old = Object.entries(m).filter(([, t]) => now - t > DAY30).sort((x, y) => x[1] - y[1])[0];
            if (!old) return json({ ok: false, full: true, logins: Object.keys(m).filter((k) => now - m[k] < DAY30) });
            delete m[old[0]];
          }
          m[lg] = now; await this.ctx.storage.put("dir2", m);
        }
      }
      return json({ ok: true, logins: Object.keys(m).filter((k) => now - m[k] < DAY30) });
    });
  }
  async dirReg(login) {      // called by sync() AFTER the request proved the pairing code or the EA secret; at most once an hour per Hub
    const now = Date.now();
    if (!/^\d{3,12}$/.test(String(login || "")) || (this.dirAt && now - this.dirAt < 3600000)) return;
    try { const r = await this.env.HUB.get(this.env.HUB.idFromName("dir")).fetch("https://hub/dir", { method: "POST", body: JSON.stringify({ op: "add", login: String(login) }) }); if (r.ok) this.dirAt = now; } catch (e) { /* never blocks the sync */ }
  }
  // v4.6: order-match tolerance comes from the SYMBOL (tick size / point / Max Deviation reported by the EA), never from a % of price.
  // Fallback 0.30 only for an EA older than v2.21 that does not report them yet.
  tolOf(st) { const tick = Number(st.tick) || 0, pt = Number(st.pt) || tick, dev = Number(st.maxDev) || 0, t = Math.max(tick * 3, dev * pt); return t > 0 ? t : 0.3; }
  async fetch(req) {
    const p = new URL(req.url).pathname;
    const b = await req.json().catch(() => ({}));
    if (p === "/dir") return this.dir(b);
    await this.migrate();
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
    const a = (await this.ctx.storage.get("acc")) || { tg: [], cfgv: 0 };
    a.tg = a.tg || [];
    return a;
  }
  // A session is valid only if: its record exists, is not expired, belongs to the current SESSION_EPOCH,
  // was created under the CURRENT password, and the MT5 server of the account did not change since.
  async chk(a, sess) {
    if (!sess) return { why: "none" };
    const k = "ses:" + (await sha(sess)), s = await this.ctx.storage.get(k);
    if (!s || typeof s !== "object") return { why: "gone" };
    if (Date.now() - s.t > this.c.sessMs) return { why: "expired" };
    if (s.ep !== this.c.epoch) return { why: "revoked" };
    if (s.pwv !== (await pwVersion(this.c))) return { why: "pw" };
    if (a.srv && s.srv && a.srv !== s.srv) return { why: "acct" };
    return { s, k };
  }
  deny(why) { return json({ ok: false, error: "session", why }, 401); }

  // ---- user identity + order alerts (account-bound, stored here next to the EA state; delivery goes through the shared Notify engine) ----
  uidOf(s, a) { return s && s.tg ? String(s.tg) : "a" + (a.login || ""); }
  async auth(m) {
    const a = await this.S(), r = await this.chk(a, m.sess);
    if (r.s) await this.touch(r);
    return json(r.s ? { ok: true, uid: this.uidOf(r.s, a), srv: a.srv || "" } : { ok: false, why: r.why });
  }
  async loadOa() { if (!this.oa) { this.oa = {}; for (const [k, v] of await this.ctx.storage.list({ prefix: "oa:" })) this.oa[k] = v; } return this.oa; }
  async oaMine(uid) { const o = await this.loadOa(); return Object.values(o).filter((r) => r.user_id === uid && r.enabled && (r.status === "armed" || (r.status === "fired" && Date.now() - (r.fired_at || 0) < 86400000))).map((r) => ({ key: r.event_id, status: r.status })); }
  // v4.19: one-line confirmations in the chat when an alert is switched on / off (unique id per action, so re-arming later is announced again)
  async chatNote(a, rec, kind, title, body) {
    try { await (await notifyStub(this.env, this.c, a.srv)).fetch("https://n/emit", { method: "POST", body: JSON.stringify({ uid: rec.user_id, account_id: rec.account_id, type: "order", event_id: rec.id, alert_type: kind + Date.now(), title, body }) }); } catch (e) { /* a confirmation must never break the alert itself */ }
  }
  hsig(h) { return h.no + "|" + h.entry + "|" + h.exit; }
  async oalert(m) {
    const a = await this.S(), r = await this.chk(a, m.sess); if (!r.s) return this.deny(r.why);
    await this.touch(r);
    const uid = this.uidOf(r.s, a), key = String(m.key || ""), st = this.st || {}, o = await this.loadOa(), sk = "oa:" + uid + ":" + key, old = o[sk];
    if (m.enabled === false) { if (old && old.enabled) { const was = old.status; old.enabled = false; old.status = "off"; old.updated_at = Date.now(); await this.ctx.storage.put(sk, old); if (was === "armed") await this.chatNote(a, old, "off", "\u{1F515} Alert Cancelled \u00B7 \u062A\u0645 \u0625\u0644\u063A\u0627\u0621 \u0627\u0644\u062A\u0646\u0628\u064A\u0647", `${old.side} ${old.sym || ""} @ ${old.price}`); } return json({ ok: true }); }
    if (old && old.enabled && old.status === "armed") return json({ ok: true, dup: true });          // pressing Allow twice never creates a second alert
    let src = null;
    if (key[0] === "t") { const q = (st.orders || []).find((x) => String(x.ticket) === key.slice(1)); if (q) src = { side: String(q.side).toUpperCase().startsWith("B") ? "BUY" : "SELL", price: Number(q.price), lot: q.lot, sl: q.sl, tp: q.tp }; }
    else if (key[0] === "w") { const q = (st.waits || []).find((x) => x.side === key.slice(1)); if (q) src = { side: q.side, price: Number(q.level) }; }
    if (!src) return json({ ok: false, error: "order_gone" }, 404);
    const now = Date.now(), rec = old || { id: crypto.randomUUID().replace(/-/g, "").slice(0, 16), user_id: uid, account_id: String(a.login || ""), type: "order", event_id: key, created_at: now };
    Object.assign(rec, src, { enabled: true, kind: "activated", status: "armed", updated_at: now, sym: st.sym || "XAUUSD", hseen: (st.hist || []).slice(0, 8).map((h) => this.hsig(h)), pos0: st.pos ? st.pos.entry + "|" + st.pos.no : "" });
    delete rec.fired_at; o[sk] = rec; this.miss = {}; await this.ctx.storage.put(sk, rec);
    const lv = [`${rec.side} ${rec.sym} @ ${rec.price}`]; if (rec.sl || rec.tp) lv.push(`SL ${rec.sl || "-"} \u00B7 TP ${rec.tp || "-"}`);
    await this.chatNote(a, rec, "armed", "\u2705 Alert Enabled \u00B7 \u062A\u0645 \u062A\u0641\u0639\u064A\u0644 \u0627\u0644\u062A\u0646\u0628\u064A\u0647", lv.join("\n") + "\nYou will be notified here when it activates \u00B7 \u0633\u064A\u0635\u0644\u0643 \u0625\u0634\u0639\u0627\u0631 \u0647\u0646\u0627 \u0639\u0646\u062F \u0627\u0644\u062A\u0641\u0639\u064A\u0644");
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
      const res = await (await notifyStub(this.env, this.c, a.srv)).fetch("https://n/emit", { method: "POST", body: JSON.stringify({ uid: r.user_id, account_id: r.account_id, type: "order", event_id: r.id, alert_type: "activated", title: "\u{1F3AF} Order Activated · تفعيل أوردر", body: `${r.side} ${r.sym}\nTarget reached · تم الوصول للمطلوب: ${r.price}\nEntry: ${e.entry}\nVolume: ${e.lot != null ? e.lot : r.lot}${e.sl || r.sl ? `\nSL: ${e.sl || r.sl}` : ""}${e.tp || r.tp ? ` · TP: ${e.tp || r.tp}` : ""}\nTime: ${hh}` }) });
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
    let need = false;
    if (tzChanged) { a.tzo = tzo; await this.upd((x) => { x.tzo = tzo; }); }
    if (rows || tzChanged || beat) {
      const res = await (await notifyStub(this.env, this.c, a.srv)).fetch("https://n/mt5", { method: "POST", body: JSON.stringify({ login: a.login || "", srv: a.srv || "", tzo: a.tzo, calv: rows || beat ? calv : undefined, rows }) });
      const j = await res.json().catch(() => ({}));
      if (j && j.ok) {
        if (rows) a.calv = calv;
        if (j.need) { a.calv = ""; need = true; }          // Notify lost the table (restart / data older than the heartbeat): ask the EA again
        a.calBeat = now;
        // v4.18: only these three fields are written, on top of a FRESH record (the network call above took time; a login / pairing that happened meanwhile must survive)
        await this.upd((x) => { x.calv = a.calv; x.calBeat = a.calBeat; });
      }
    }
    return need || (!!calv && !rows && calv !== a.calv);
  }

  // ---- EA side ----
  async sync(m) {
    const body = jobj(m.body);
    const secret = String(m.secret || "");
    if (secret.length < 16) return json({ ok: false, error: "secret" }, 401);
    const a0 = await this.S(), sh = await sha("yt-ea|" + secret), now0 = Date.now();
    const matched = a0.eaSecretH ? safeEq(a0.eaSecretH, sh) : (a0.eaSecret ? safeEq(a0.eaSecret, secret) : false);
    // v4.6 PAIRING (replaces "first EA wins"): an account is bound only by an EA that proves the pairing code (Worker secret PAIR_CODE).
    // A valid code makes the SERVER mint the EA secret (CSPRNG) and hand it over once (es); afterwards the secret alone authenticates. Already-bound v4.5 accounts keep working
    // and are upgraded the first time the EA presents the code. A stranger who syncs first can no longer take the account: without the code he is refused.
    // v4.18: every refusal below happens BEFORE any write: a failed / incomplete / unauthenticated request changes nothing (no account record, no directory entry, no session).
    let ok = matched, issued = "", paired = false;
    const pair = String(m.pair || "");
    if (pair && !matched && !this.c.pairKey) return json({ ok: false, error: "pair_not_configured" }, 503);   // no PAIR_CODE = pairing refused (never falls back to the app password)
    if (pair) {
      // v4.15.1: pairing lockout REMOVED by owner request - wrong codes are never locked out, unlimited attempts.
      if (this.c.pairKey && (await pwEq(this.c, pair, this.c.pairKey))) {
        paired = true; ok = true;
        if (!matched || !a0.eaIssued) issued = rnd(32);
      } else if (!matched) {
        return json({ ok: false, error: "pair_bad" }, 403);
      }
    }
    // an account that is not bound / a wrong secret is answered identically: the response never tells a stranger whether an account number is known (v4.18)
    if (!ok) return json({ ok: false, error: "secret" }, 401);
    const issuedH = issued ? await sha("yt-ea|" + issued) : "";
    // v4: an EA restart NO LONGER signs anybody out. The app re-verifies on open (account + Telegram + bot) and enters by itself.
    // Sessions are revoked only when: the EA asks explicitly (reset = input InpBrResetPw), or the MT5 SERVER of this account changed.
    const srv = String(body.srv || "").slice(0, 64), login = String(m.login || "");
    const tsig = hex(await hmacRaw(enc.encode("t"), m.tok || "")).slice(0, 8);
    let dropAll = !!body.reset;
    const a = await this.upd((x) => {
      let dirty = false;
      if (issued) { x.eaSecretH = issuedH; delete x.eaSecret; x.eaIssued = true; x.pairedAt = now0; dirty = true; }
      else if (matched && x.eaSecret) { x.eaSecretH = sh; delete x.eaSecret; dirty = true; }   // v4.5 stored the raw secret: keep only its hash from now on
      if (/^\d{3,12}$/.test(login) && x.login !== login) { x.login = login; dirty = true; }
      if (srv && x.srv !== srv) { if (x.srv) dropAll = true; x.srv = srv; dirty = true; }
      if (!x.seen || now0 - x.seen > 15000) { x.seen = now0; dirty = true; }
      // single shared bot: config v changes when the chat list or the token changes
      if (x.tsig !== tsig) { x.tsig = tsig; x.cfgv = (x.cfgv || 0) + 1; dirty = true; }
      return dirty ? undefined : false;
    });
    if (dropAll) await this.dropSessions();
    await this.dirReg(login);                       // verified by now (pairing code or EA secret): the ONLY place an account enters the directory
    // v4.15 SECOND-COPY DETECTION. The MT5 lock only covers copies inside ONE terminal; the Worker sees every EA that syncs this account
    // (another PC, a VPS ...). The first live instance id owns the account; a different id while the owner is fresh (< 20 s) is told dupInst,
    // gets no commands and its state is NOT stored, so two copies can never overwrite each other's view or execute the same command twice.
    const inst = String(body.inst || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    if (inst) {
      const cur = await this.ctx.storage.get("inst"), tn = Date.now();
      if (!cur || cur.id === inst || tn - cur.t > 20000) {
        if (!cur || cur.id !== inst || tn - cur.t > 5000) await this.ctx.storage.put("inst", { id: inst, t: tn });
      } else return json({ ok: true, dupInst: true, commands: [], staleSec: this.c.staleSec });
    }
    if (body.state && typeof body.state === "object") { this.st = body.state; this.ts = Date.now(); this.lstDone = true; await this.persistSt(body.state); try { await this.watch(a); } catch (e) { /* alerts must never break the EA sync */ } try { await this.archive(body.state, a); await this.diagFrom(body.state); } catch (e) { /* the internal archive / diagnostics must never break the EA sync */ } }
    let evack = [];
    if (Array.isArray(body.ev) && body.ev.length) { try { evack = await this.events(body.ev, a, String(m.login || "")); } catch (e) { /* notifications must never break the EA sync */ } }
    let calNeed = false;
    try { calNeed = await this.feed(body); } catch (e) { /* the news feed must never break the EA sync */ }
    let q = (await this.ctx.storage.get("cmds")) || [];
    const ack = Array.isArray(body.ack) ? body.ack : [];
    const now = Date.now();
    const next = q.filter((x) => !ack.includes(x.c.id) && now - x.t < 120000);
    if (next.length !== q.length) await this.ctx.storage.put("cmds", next);
    const out = { ok: true, commands: next.map((x) => ({ ...x.c, age: Math.max(0, Math.round((now - x.t) / 1000)) })), staleSec: this.c.staleSec };   // v4.8: age lets the EA expire stale commands
    if (evack.length) out.evack = evack;
    if (issued) out.es = issued;
    if (paired) out.paired = true;
    if (calNeed) out.calNeed = true;
    const aF = await this.S();                       // fresh: a sign-in that happened while this sync ran is included
    if (String(aF.cfgv) !== String(body.cv !== undefined ? body.cv : 0)) out.cfg = { v: String(aF.cfgv), tok: (body.state && body.state.evp) ? "" : (m.tok || ""), auth: aF.tg.join(",") };   // v4.8: an EA that routes notifications through the Worker never receives the Bot Token
    return json(out);
  }

  // ---- v4.8 EA notification events: ONE engine (Notify.emit) with a unique event id from the EA -> never delivered twice (even after EA / Worker / app restarts) ----
  async events(list, a, login) {
    const ack = [], o = await this.loadOa(), now = Date.now();
    const userAlert = Object.values(o).some((r) => r && r.enabled && (r.status === "armed" || (r.status === "fired" && now - (r.fired_at || 0) < 120000)));
    const nt = await notifyStub(this.env, this.c, a.srv);
    for (const e of list.slice(0, 40)) {
      if (!e || typeof e !== "object") continue;
      const id = String(e.id || "");
      if (!/^\d{3,12}:\d{1,12}:\d{1,12}$/.test(id)) continue;
      const k = e.k === "act" ? "act" : "ev";
      if (k === "act" && userAlert) { ack.push(id); continue; }   // the user's own Order Alert is the single source for the activation message
      const title = String(e.t || "").slice(0, 120), body = String(e.b || "").slice(0, 600);
      if (!title) { ack.push(id); continue; }
      if (!this.c.chatProblems && !chatWorthy(title)) {        // a problem, not an order: acknowledged (the EA stops re-sending) and kept for diagnostics only
        try { const d = (await this.ctx.storage.get("diag")) || []; d.push({ id, rid: rid(id), t: Date.now(), src: "ea-notice", cmd: "", cat: "problem", raw: (title + " " + body).slice(0, 300) }); await this.ctx.storage.put("diag", d.slice(-300)); } catch (x) { /* diagnostics must never block the ack */ }
        ack.push(id); continue;
      }
      const r = await nt.fetch("https://n/emit", { method: "POST", body: JSON.stringify({ uid: "ea" + (login || id.split(":")[0]), account_id: login || id.split(":")[0], type: "ea", event_id: id, alert_type: k, title, body }) });
      if (r.ok) ack.push(id);                                   // not acked on failure -> the EA re-sends the same id (emit is idempotent)
    }
    return ack;
  }
  // ---- App side ----
  async login(m) {
    const a0 = await this.S();
    if (!this.bound(a0) || !this.botUp()) return json({ ok: false, error: "ea_offline" }, 503);   // EA must be running on this account
    const sess = rnd(24), h = await sha(sess), pwv = await pwVersion(this.c), now = Date.now();
    let full = false;
    await this.mutex(async () => {
      await this.cleanup(pwv);
      if (this.c.maxSess > 0 && (await this.sessionKeys()).length >= this.c.maxSess) { full = true; return; }   // refuse the NEW sign-in; nobody is signed out
      const a = await this.S();
      await this.ctx.storage.put("ses:" + h, { h, tg: m.tg || "", t: now, c: now, pwv, ep: this.c.epoch, srv: a.srv || "" });   // a NEW record: no other session is touched
      if (m.tg && !a.tg.includes(m.tg)) { a.tg = [...a.tg, m.tg]; a.cfgv = (a.cfgv || 0) + 1; await this.ctx.storage.put("acc", a); }   // Telegram identity proven by Telegram itself (no cap)
    });
    if (full) return json({ ok: false, error: "too_many_sessions" }, 429);
    return json({ ok: true, sess });
  }
  // Fast connection check used by the app's "verify" popup. Four independent checks, so the UI can tell
  // a HARD failure (must sign in again) from a SOFT one (the bot is simply off right now -> keep waiting, auto-enter when it is back).
  async verify(m) {
    await this.restoreSt();
    const a = await this.S();
    const r = await this.chk(a, m.sess);
    const bot = this.botUp() && this.bound(a);
    if (!r.s) return json({ ok: false, hard: true, why: r.why, checks: { session: false, account: r.why !== "acct", telegram: false, bot } });
    const s = r.s;
    const telegram = m.tg ? s.tg === m.tg && a.tg.includes(m.tg) : !this.c.requireTg && !s.tg;
    const checks = { session: true, account: true, telegram, bot };
    const hard = !telegram;
    if (!hard) await this.touch(r, true);   // sliding expiry (this session's record only)
    return json({ ok: telegram && bot, hard, why: hard ? "tg" : "", checks });
  }
  // v4.18: signing out ends THIS session only. Other devices / browsers of the same account (or the same Telegram user) stay signed in.
  // The Telegram chat is un-registered only when no other session of that Telegram user remains.
  async logout(m) {
    const k = "ses:" + (await sha(m.sess || ""));
    await this.mutex(async () => {
      const mine = await this.ctx.storage.get(k);
      if (!mine) return;
      await this.ctx.storage.delete(k);
      if (mine.tg) {
        const rest = [...(await this.ctx.storage.list({ prefix: "ses:" })).values()];
        if (!rest.some((x) => x && x.tg === mine.tg)) { const a = await this.S(); if (a.tg.includes(mine.tg)) { a.tg = a.tg.filter((x) => x !== mine.tg); a.cfgv = (a.cfgv || 0) + 1; await this.ctx.storage.put("acc", a); } }
      }
    });
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
    await this.restoreSt();
    const a = await this.S();
    const r = await this.chk(a, m.sess);
    if (!r.s) return this.deny(r.why);
    await this.touch(r);
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
    await this.restoreSt();
    const a = await this.S();
    const r = await this.chk(a, m.sess);
    if (!r.s) return this.deny(r.why);
    await this.touch(r);
    let b = null; try { b = JSON.parse(m.body || "null"); } catch (e) {}
    const allowed = ["start", "stop", "close", "reset", "apply", "settings", "delete", "cancel", "delpend", "modify", "place", "newcycle"];
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
      if (k === "ticket" && !(Number.isSafeInteger(n) && n > 0)) return json({ error: "bad ticket" }, 400);   // v4.18: a ticket is a positive integer, nothing else reaches the EA
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
