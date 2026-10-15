// Yetimmm — Economic calendar + unified notification engine (Durable Object "Notify").
//   News Provider Adapter  ->  Normalized events  ->  Alert Engine  ->  Notification Engine (in-app + Telegram)  ->  Persistence
// Everything runs on the server (DO alarms): closing the browser / app never loses an alert.
// Order alerts are detected in Hub (worker.js, where the EA state arrives) and delivered through the same /emit here.

const MIN = 60000;
const OFFSETS = [0, 1, 5, 15, 30];                       // minutes before the event (0 = at event time)
const FOCUS = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD", "CNY"];
const COUNTRY = { USD: "United States", EUR: "Euro Area", GBP: "United Kingdom", JPY: "Japan", AUD: "Australia", CAD: "Canada", CHF: "Switzerland", NZD: "New Zealand", CNY: "China" };
const fnv = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
const nv = (v) => { if (v === undefined || v === null) return null; const s = String(v).trim(); return s === "" || s === "-" || s.toLowerCase() === "null" ? null : s.slice(0, 40); };
const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const esc = (x) => String(x == null ? "" : x).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const validTz = (z) => { try { new Intl.DateTimeFormat("en", { timeZone: z }); return true; } catch (e) { return false; } };

/* ───────── Provider adapters. To add a provider: write fetchX(env) returning rows {title,cur,ts,impact,previous,forecast,actual,source,pid?}. ───────── */
async function getJson(url, ms = 9000) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json", "User-Agent": "yetimmm-bridge/1" } });
    if (r.status === 429) { const e = new Error("rate_limited"); e.rate = true; throw e; }
    if (!r.ok) throw new Error("http_" + r.status);
    return await r.json();
  } finally { clearTimeout(tm); }
}
const PROVIDERS = {
  // fed by the EA of the logged-in MT5 account (MetaTrader 5 built-in calendar): real Actual values, broker time. See Notify.mt5().
  mt5: { name: "MetaTrader 5", hasActual: true, async fetch() { throw new Error("push_only"); } },
  // free, no key. No "Actual" column in this feed -> Actual stays N/A (status shows "passed").
  ff: { name: "ForexFactory · FairEconomy", hasActual: false, async fetch() {
    const a = await getJson("https://nfs.faireconomy.media/ff_calendar_thisweek.json");
    if (!Array.isArray(a)) throw new Error("bad_payload");
    return a.map((x) => ({ title: nv(x.title), cur: nv(x.country), ts: Date.parse(x.date), impact: String(x.impact || "").toLowerCase(), previous: nv(x.previous), forecast: nv(x.forecast), actual: null, source: "ForexFactory" }));
  } },
  // needs secret TE_KEY (wrangler secret put TE_KEY). Provides Actual + live release updates.
  te: { name: "Trading Economics", hasActual: true, async fetch(env) {
    if (!env.TE_KEY) throw new Error("no_key");
    const d = new Date(), mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
    const iso = (x) => x.toISOString().slice(0, 10), from = iso(mon), to = iso(new Date(mon.getTime() + 6 * 86400000));
    const a = await getJson(`https://api.tradingeconomics.com/calendar/country/all/${from}/${to}?c=${encodeURIComponent(env.TE_KEY)}&f=json`);
    if (!Array.isArray(a)) throw new Error("bad_payload");
    return a.map((x) => ({ title: nv(x.Event), cur: nv(x.Currency), ts: Date.parse(/Z|[+-]\d\d:?\d\d$/.test(x.Date) ? x.Date : x.Date + "Z"), impact: ({ 1: "low", 2: "medium", 3: "high" })[x.Importance] || "low", previous: nv(x.Previous), forecast: nv(x.Forecast || x.TEForecast), actual: nv(x.Actual), source: nv(x.Source) || "Trading Economics" }));
  } },
};
function normalize(rows, prov) {
  const seen = {}, out = [];
  rows.filter((r) => r.title && r.cur && Number.isFinite(r.ts) && FOCUS.includes(r.cur.toUpperCase())).sort((a, b) => a.ts - b.ts).forEach((r) => {
    const cur = r.cur.toUpperCase(), base = cur + "|" + r.title.toLowerCase().replace(/\s+/g, " ") + "|" + new Date(r.ts).toISOString().slice(0, 10);
    const n = (seen[base] = (seen[base] || 0) + 1), id = fnv(base) + (n > 1 ? "-" + n : "");
    out.push({ id, title: r.title.slice(0, 120), cur, country: COUNTRY[cur] || cur, ts: r.ts, impact: ["high", "medium", "low", "holiday"].includes(r.impact) ? r.impact : "low", previous: r.previous, forecast: r.forecast, actual: r.actual, source: r.source || prov.name });
  });
  return out;
}

export class Notify {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.al = null; this.cal = null; this.m5 = null; this.fetching = null; }
  async fetch(req) {
    const p = new URL(req.url).pathname, b = await req.json().catch(() => ({}));
    try {
      if (p === "/cal") return J(await this.calendar(b));
      if (p === "/alert") return await this.setAlert(b);
      if (p === "/notifs") return J(await this.notifs(b));
      if (p === "/read") return J(await this.read(b));
      if (p === "/pref") return await this.pref(b);
      if (p === "/emit") return J(await this.emit(b));
      if (p === "/mt5") return J(await this.mt5(b));
    } catch (e) { return J({ ok: false, error: "server" }, 500); }
    return J({ error: "not found" }, 404);
  }
  /* ── storage helpers ── */
  async loadAl() { if (!this.al) { this.al = {}; for (const [k, v] of await this.ctx.storage.list({ prefix: "al:" })) this.al[k] = v; } return this.al; }
  async loadCal() { if (!this.cal) this.cal = (await this.ctx.storage.get("cal")) || { events: [], at: 0, ok: 0, err: "", fails: 0, next: 0, prov: "" }; return this.cal; }
  providers() { const o = String(this.env.NEWS_PROVIDER || "auto"), ext = o === "auto" ? (this.env.TE_KEY ? ["te", "ff"] : ["ff"]) : [o, ...Object.keys(PROVIDERS).filter((k) => k !== o)].filter((k) => PROVIDERS[k]); return [...new Set(String(this.env.MT5_FEED) === "0" || o === "ff" || o === "te" ? ext : ["mt5", ...ext])]; }   // the logged-in MT5 account is the primary source; external feeds are the automatic fallback

  /* ── calendar: cached, single-flight, exponential backoff, stale-while-error ── */
  async refresh(force) {
    const c = await this.loadCal(), now = Date.now();
    if (!force && c.next && now < c.next) return c;
    if (this.fetching) { await this.fetching; return this.cal; }
    this.fetching = (async () => {
      let ok = false, err = "";
      for (const k of this.providers()) {
        try { const rows = k === "mt5" ? await this.mt5Rows() : await PROVIDERS[k].fetch(this.env), ev = normalize(rows, PROVIDERS[k]); if (!ev.length) throw new Error("empty"); c.events = ev; c.prov = k; c.ok = Date.now(); c.fails = 0; ok = true; break; }
        catch (e) { err = String(e.message || e).slice(0, 60); }
      }
      c.at = Date.now();
      if (ok) { c.err = ""; const hot = c.events.some((e) => e.ts > c.at - 30 * MIN && e.ts < c.at + 15 * MIN); c.next = c.at + (hot ? 90000 : 15 * MIN); await this.reconcile(c.events); }
      else { c.fails++; c.err = err; c.next = c.at + Math.min(15 * MIN, 30000 * 2 ** Math.min(c.fails, 5)); }
      await this.ctx.storage.put("cal", c); this.cal = c;
    })();
    try { await this.fetching; } finally { this.fetching = null; }
    await this.schedule(); return this.cal;
  }
  async calendar(b) {
    const c = await this.refresh(false), now = Date.now(), uid = String(b.uid || "");
    const al = await this.loadAl(), mine = {};
    for (const [k, r] of Object.entries(al)) if (r.user_id === uid && r.enabled) mine[r.event_id] = { offsets: r.offsets, status: r.status, fired: Object.keys(r.fired || {}).map(Number) };
    const pr = (await this.ctx.storage.get("pref:" + uid)) || {};
    const prov = PROVIDERS[c.prov], m5 = await this.loadM5(), tzOk = m5.tzo !== null && m5.tzo !== undefined && now - m5.tzAt < 3 * 86400000;
    const src = c.prov === "mt5" ? "MetaTrader 5" + (m5.srv ? " · " + m5.srv : "") : prov ? prov.name : "";
    return { ok: true, now, events: c.events, source: src, has_actual: !!(prov && prov.hasActual), market_off: tzOk ? m5.tzo : null, market_srv: tzOk ? m5.srv : "", mt5_live: now - m5.alive < 20 * MIN, updated: c.ok, checked: c.at, stale: !c.events.length || !!c.err, error: c.err, rev: fnv(JSON.stringify(c.events) + c.ok), alerts: mine, pref: pr, market_tz: String(this.env.MARKET_TZ || "UTC") };
  }
  // an event moved / got renamed by the provider: keep the user's alert pointing at it
  async reconcile(events) {
    const al = await this.loadAl(), byId = Object.fromEntries(events.map((e) => [e.id, e]));
    for (const [k, r] of Object.entries(al)) {
      if (!r.enabled) continue;
      let e = byId[r.event_id];
      if (!e) { const c = events.filter((x) => x.cur === r.ev.cur && x.title === r.ev.title && Math.abs(x.ts - r.ev.ts) < 3 * 86400000 && !al["al:" + r.user_id + ":" + x.id]); if (c.length === 1) { e = c[0]; await this.ctx.storage.delete(k); delete al[k]; r.event_id = e.id; r.k2 = "al:" + r.user_id + ":" + e.id; } }
      if (!e) continue;
      if (e.ts !== r.ev.ts || e.impact !== r.ev.impact) { r.ev = { title: e.title, cur: e.cur, ts: e.ts, impact: e.impact }; r.updated_at = Date.now(); this.trig(r); }
      const key = r.k2 || k; delete r.k2; al[key] = r; await this.ctx.storage.put(key, r);
    }
  }

  /* ── MT5 feed: the EA pushes the broker's own calendar (via Hub). Fresh = the EA confirmed it within 20 min. ── */
  async loadM5() { if (!this.m5) this.m5 = (await this.ctx.storage.get("mt5")) || { rows: [], h: "", calAt: 0, alive: 0, tzo: null, srv: "", login: "", tzAt: 0 }; return this.m5; }
  async mt5Rows() { const m = await this.loadM5(); if (!m.rows.length || Date.now() - m.alive > 20 * MIN) throw new Error("mt5_stale"); return m.rows; }
  cleanRows(rows) {
    const out = [], now = Date.now();
    for (const x of (Array.isArray(rows) ? rows : []).slice(0, 600)) {
      if (!x || typeof x !== "object") continue;
      const ts = Number(x.s) * 1000, imp = String(x.m || "");
      if (!Number.isFinite(ts) || Math.abs(ts - now) > 21 * 86400000 || !["high", "medium", "low", "holiday"].includes(imp)) continue;
      out.push({ title: nv(x.t), cur: nv(x.c), ts, impact: imp, previous: nv(x.p), forecast: nv(x.f), actual: nv(x.a), source: "MetaTrader 5" });
    }
    return out;
  }
  async mt5(b) {
    const m = await this.loadM5(), now = Date.now(); let need = false, apply = false;
    const tzo = Number(b.tzo);
    if (b.tzo !== undefined && b.tzo !== null && Number.isFinite(tzo) && Math.abs(tzo) <= 50400) { m.tzo = tzo; m.srv = String(b.srv || m.srv || "").slice(0, 64); m.login = String(b.login || m.login || ""); m.tzAt = now; }
    const calv = typeof b.calv === "string" ? b.calv.slice(0, 16) : "";
    if (Array.isArray(b.rows) && calv) {
      const rows = this.cleanRows(b.rows);
      if (rows.length) { m.alive = now; if (calv !== m.h || !m.rows.length) { m.rows = rows; m.h = calv; m.calAt = now; apply = true; } }
    } else if (calv) {
      if (calv === m.h) m.alive = now;
      else if (!m.rows.length || now - m.alive > 10 * MIN) need = true;      // otherwise another account is feeding the same (global) calendar: nothing to do
    }
    this.m5 = m; await this.ctx.storage.put("mt5", m);
    if (apply) await this.applyMt5();
    return { ok: true, need };
  }
  // new MT5 table: replace the calendar at once, keep alerts pointing at their events, and tell users who armed an alert when the RESULT lands
  async applyMt5() {
    const c = await this.loadCal(), m = await this.loadM5(), now = Date.now(), old = Object.fromEntries((c.events || []).map((e) => [e.id, e]));
    const ev = normalize(m.rows, PROVIDERS.mt5); if (!ev.length) return;
    c.events = ev; c.prov = "mt5"; c.ok = now; c.at = now; c.err = ""; c.fails = 0;
    const hot = ev.some((e) => e.ts > now - 30 * MIN && e.ts < now + 15 * MIN); c.next = now + (hot ? 90000 : 15 * MIN);
    await this.ctx.storage.put("cal", c); this.cal = c;
    await this.reconcile(ev);
    try { await this.releases(old, ev); } catch (e) { /* a failed result notice must not block the calendar */ }
    await this.schedule();
  }
  async releases(old, ev) {
    const al = await this.loadAl(), now = Date.now(), num = (x) => parseFloat(String(x).replace(/[^0-9.\-]/g, ""));
    for (const e of ev) {
      const o = old[e.id]; if (e.actual == null || !o || o.actual != null || e.ts < now - 3 * 3600000) continue;
      const diff = num(e.actual) - num(e.forecast), dir = e.forecast == null || !Number.isFinite(diff) ? "" : diff > 0 ? "\nHigher than forecast · أعلى من المتوقع" : diff < 0 ? "\nLower than forecast · أقل من المتوقع" : "\nIn line with forecast · مطابق للمتوقع";
      for (const r of Object.values(al)) {
        if (r.event_id !== e.id || !r.enabled) continue;
        await this.emit({ uid: r.user_id, type: "news", event_id: e.id, alert_type: "rel", account_id: r.account_id || null, title: `${e.cur} · ${e.title}`, body: `Released · صدر\nActual ${e.actual} · Forecast ${e.forecast == null ? "N/A" : e.forecast} · Previous ${e.previous == null ? "N/A" : e.previous}${dir}` });
      }
    }
  }

  /* ── alert configuration (per user, per event). Idempotent: same request twice = same stored state. ── */
  trig(r) {
    const now = Date.now(), due = r.offsets.filter((o) => !(r.fired || {})[o] && (o > 0 ? now < r.ev.ts : now <= r.ev.ts + 10 * MIN)).map((o) => r.ev.ts - o * MIN);
    r.trigger_time = due.length ? Math.min(...due) : null; r.status = !r.enabled ? "off" : due.length ? "active" : "done";
  }
  async setAlert(b) {
    const uid = String(b.uid || ""), id = String(b.event_id || ""); if (!uid || !id) return J({ ok: false, error: "bad" }, 400);
    const c = await this.loadCal(), e = c.events.find((x) => x.id === id), al = await this.loadAl(), key = "al:" + uid + ":" + id, old = al[key];
    const offs = [...new Set((Array.isArray(b.offsets) ? b.offsets : []).map(Number).filter((o) => OFFSETS.includes(o)))].sort((x, y) => x - y);
    if (b.enabled === false || !offs.length) {                       // cancel = update the same record (no new row)
      if (old && old.enabled) { old.enabled = false; old.status = "off"; old.trigger_time = null; old.updated_at = Date.now(); await this.ctx.storage.put(key, old); }
      return J({ ok: true, alert: old ? { offsets: [], status: "off" } : null });
    }
    if (!e && !old) return J({ ok: false, error: "no_event" }, 404);
    const ev = e || old.ev; if (Date.now() > ev.ts + 10 * MIN) return J({ ok: false, error: "ended" }, 409);
    const now = Date.now(), acct = /^\d{3,12}$/.test(String(b.login || "")) ? String(b.login) : null, r = old || { id: crypto.randomUUID().replace(/-/g, "").slice(0, 16), user_id: uid, account_id: acct, type: "news", event_id: id, created_at: now, fired: {} };
    const same = old && old.enabled && JSON.stringify(old.offsets) === JSON.stringify(offs) && old.ev.ts === ev.ts;
    r.enabled = true; r.account_id = acct || r.account_id || null; r.offsets = offs; r.ev = { title: ev.title, cur: ev.cur, ts: ev.ts, impact: ev.impact };
    if (!same) { r.updated_at = now; if (old && !old.enabled) r.fired = {}; }
    this.trig(r); al[key] = r; await this.ctx.storage.put(key, r); await this.schedule();
    return J({ ok: true, alert: { offsets: r.offsets, status: r.status } });
  }

  /* ── notification engine: dedupe -> store -> deliver (in-app is the record itself, Telegram is the push channel) ── */
  async emit(m) {
    const uid = String(m.uid || ""); if (!uid || !m.title) return { ok: false };
    const dk = "dd:" + fnv(uid + "|" + m.event_id + "|" + m.alert_type);
    if (await this.ctx.storage.get(dk)) return { ok: true, dup: true };       // idempotency: one trigger per (event, user, alert type)
    const now = Date.now(), id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const tg = !!this.env.BOT_TOKEN && (/^\d{5,15}$/.test(uid) || !!m.account_id);   // browser users (uid = account) are delivered to the Telegram chats registered on their MT5 account
    const rec = { id, user_id: uid, account_id: m.account_id || null, type: m.type || "system", event_id: String(m.event_id || ""), alert_type: String(m.alert_type || ""), title: String(m.title).slice(0, 120), body: String(m.body || "").slice(0, 600), enabled: true, trigger_time: now, status: tg ? "Pending" : "Sent", channel: tg ? "telegram" : "in-app", tries: 0, read: false, created_at: now, updated_at: now };
    await this.ctx.storage.put(dk, now); await this.ctx.storage.put(this.hk(rec), rec);            // both before any network call
    this.prune(uid).catch(() => {});
    if (tg) await this.deliver(rec);
    return { ok: true, id };
  }
  hk(r) { return "h:" + r.user_id + ":" + String(1e13 - r.created_at).padStart(14, "0") + ":" + r.id; }
  // delivery targets: the user's own Telegram id, or (browser users) the Telegram chats registered on the MT5 account. null = lookup failed -> retry.
  async targets(rec) {
    if (/^\d{5,15}$/.test(rec.user_id)) return [rec.user_id];
    if (!rec.account_id || !this.env.HUB) return [];
    try { const r = await this.env.HUB.get(this.env.HUB.idFromName("acc-" + rec.account_id)).fetch("https://hub/tgs", { method: "POST", body: "{}" }), j = await r.json(); return (j.tg || []).map(String).filter((x) => /^\d{5,15}$/.test(x)); }
    catch (e) { return null; }
  }
  async deliver(rec) {
    const ts = rec.left || await this.targets(rec);
    let st = "Retrying", wait = 0;
    if (ts && !ts.length) { st = "Sent"; rec.channel = "in-app"; }          // nobody to push to: the in-app record is the notification
    else if (ts) {
      const text = `<b>${esc(rec.title)}</b>\n${esc(rec.body)}`, left = []; let sent = rec.sent || 0;
      for (const chat of ts) {
        try {
          const r = await fetch(`https://api.telegram.org/bot${this.env.BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }) });
          if (r.ok) sent++;
          else if (r.status === 429) { const j = await r.json().catch(() => ({})); wait = Math.max(wait, ((j.parameters && j.parameters.retry_after) || 5) * 1000); left.push(chat); }
          else if (!(r.status >= 400 && r.status < 500)) left.push(chat);   // 4xx (blocked bot / bad chat): retrying will not help
        } catch (e) { left.push(chat); }                                     // network: retry only this chat, never re-send to the ones already delivered
      }
      rec.sent = sent;
      if (left.length) rec.left = left; else { delete rec.left; st = sent ? "Sent" : "Failed"; }
    }
    rec.tries++; if (st === "Retrying" && rec.tries >= 5) { st = rec.sent ? "Sent" : "Failed"; delete rec.left; }
    rec.status = st; rec.updated_at = Date.now();
    if (st === "Retrying") { rec.retry_at = Date.now() + (wait || Math.min(10 * MIN, 30000 * 2 ** rec.tries)); await this.ctx.storage.put("rt:" + rec.id, this.hk(rec)); } else { delete rec.retry_at; await this.ctx.storage.delete("rt:" + rec.id); }
    await this.ctx.storage.put(this.hk(rec), rec); if (st === "Retrying") await this.schedule();
  }
  async prune(uid) { const ks = [...(await this.ctx.storage.list({ prefix: "h:" + uid + ":", limit: 260 })).keys()]; if (ks.length > 200) await this.ctx.storage.delete(ks.slice(200)); }
  async notifs(b) {
    const uid = String(b.uid || ""), m = await this.ctx.storage.list({ prefix: "h:" + uid + ":", limit: Math.min(100, Number(b.limit) || 60) });
    const items = [...m.values()].map((r) => ({ id: r.id, type: r.type, title: r.title, body: r.body, status: r.status, channel: r.channel, read: r.read, at: r.created_at, account: r.account_id, event_id: r.event_id }));
    return { ok: true, items, unread: items.filter((x) => !x.read).length };
  }
  async read(b) {
    const uid = String(b.uid || ""), ids = Array.isArray(b.ids) ? b.ids.map(String) : null, m = await this.ctx.storage.list({ prefix: "h:" + uid + ":", limit: 200 }), w = {};
    for (const [k, r] of m) if (!r.read && (b.all || (ids && ids.includes(r.id)))) { r.read = true; w[k] = r; }
    const wk = Object.keys(w);
    for (let i = 0; i < wk.length; i += 100) { const part = {}; for (const k of wk.slice(i, i + 100)) part[k] = w[k]; await this.ctx.storage.put(part); }   // Durable Object put() accepts at most 128 keys per call
    return { ok: true };
  }
  async pref(b) {
    const uid = String(b.uid || ""), p = (await this.ctx.storage.get("pref:" + uid)) || {};
    if (b.tz !== undefined) { if (!validTz(String(b.tz))) return J({ ok: false, error: "tz" }, 400); p.tz = String(b.tz); }
    if (b.lang !== undefined) p.lang = b.lang ? 1 : 0;
    p.updated_at = Date.now(); await this.ctx.storage.put("pref:" + uid, p); return J({ ok: true, pref: p });
  }

  /* ── alarm: fires due news alerts, retries deliveries, refreshes the calendar. Re-armed after every change. ── */
  async schedule() {
    const al = await this.loadAl(), c = await this.loadCal(); let t = c.next || Date.now() + 60000;
    for (const r of Object.values(al)) if (r.enabled && r.trigger_time) t = Math.min(t, r.trigger_time);
    for (const k of (await this.ctx.storage.list({ prefix: "rt:", limit: 50 })).keys()) { const hk = await this.ctx.storage.get(k); const rec = hk && await this.ctx.storage.get(hk); if (rec && rec.retry_at) t = Math.min(t, rec.retry_at); }
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, t));
  }
  async alarm() {
    try {
      await this.refresh(false);
      const al = await this.loadAl(), now = Date.now();
      for (const [k, r] of Object.entries(al)) {
        if (!r.enabled || !r.trigger_time || now < r.trigger_time) continue;
        for (const o of r.offsets) {
          if ((r.fired || {})[o]) continue;
          const due = r.ev.ts - o * MIN; if (now < due) continue;
          r.fired = r.fired || {}; r.fired[o] = now;
          const late = o > 0 ? now >= r.ev.ts : now > r.ev.ts + 10 * MIN;      // do not announce "in 15 min" after it happened
          if (!late) {
            const ar = o === 0;
            await this.emit({ uid: r.user_id, type: "news", event_id: r.event_id, alert_type: "n" + o, title: `${r.ev.cur} · ${r.ev.title}`, body: ar ? `Now · ${r.ev.impact.toUpperCase()} impact · الآن` : `${o} min · ${r.ev.impact.toUpperCase()} impact · بعد ${o} د`, account_id: r.account_id || null });
          }
        }
        r.updated_at = now; this.trig(r); await this.ctx.storage.put(k, r);
      }
      for (const k of (await this.ctx.storage.list({ prefix: "rt:", limit: 50 })).keys()) { const hk = await this.ctx.storage.get(k), rec = hk && await this.ctx.storage.get(hk); if (!rec) { await this.ctx.storage.delete(k); continue; } if (rec.retry_at && Date.now() >= rec.retry_at) await this.deliver(rec); }
      if (Math.random() < 0.02) { const old = Date.now() - 14 * 86400000; for (const [k, v] of await this.ctx.storage.list({ prefix: "dd:", limit: 500 })) if (v < old) await this.ctx.storage.delete(k); }
    } finally { await this.schedule(); }
  }
}
