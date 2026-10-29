// Yetimmm — Telegram delivery engine for EA events (Durable Object "Notify").
//   EA event (unique id)  ->  dedupe  ->  delivery journal  ->  Telegram delivery with retry
// Everything runs on the server (DO alarms): closing the browser / app never loses a Telegram message.
// There is no in-app notification center any more: this engine only delivers the EA's own Telegram events (Hub.events -> /emit).

const MIN = 60000;
const fnv = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const esc = (x) => String(x == null ? "" : x).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

export class Notify {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.purged = false; }
  async fetch(req) {
    const p = new URL(req.url).pathname, b = await req.json().catch(() => ({}));
    try {
      if (!this.purged) await this.purgeLegacy();
      if (p === "/emit") return J(await this.emit(b));
    } catch (e) { return J({ ok: false, error: "server" }, 500); }
    return J({ error: "not found" }, 404);
  }

  // One-time cleanup of data written by older releases (removed features): old stored records never linger in the database.
  // purged = 1: features removed before v4.31 (calendar / prefs / old alerts). purged = 2: the notification center + order alerts (bell) removed in v4.31 fix25:
  // their "order" records (and their retry index) are deleted; the EA-event records ("ea") stay: they are the Telegram delivery journal / retry queue.
  async purgeLegacy() {
    const st = this.ctx.storage, v = await st.get("purged");
    if (v !== 2) {
      const del = async (keys) => { for (let i = 0; i < keys.length; i += 100) await st.delete(keys.slice(i, i + 100)); };
      if (!v) {
        await del([...(await st.list({ prefix: "al:" })).keys()]);
        await del([...(await st.list({ prefix: "pref:" })).keys()]);
        await del(["cal", "mt5"]);
      }
      const stale = [];
      for (const [k, r] of await st.list({ prefix: "h:" })) if (r && r.type !== "ea") { stale.push(k); stale.push("rt:" + r.id); }
      await del(stale);
      await st.put("purged", 2);
    }
    this.purged = true;
  }

  /* ── delivery engine: dedupe -> journal -> deliver to Telegram (the journal record is also the retry queue) ── */
  async emit(m) {
    const uid = String(m.uid || ""); if (!uid || !m.title) return { ok: false };
    const dk = "dd:" + fnv(uid + "|" + m.event_id + "|" + m.alert_type);
    if (await this.ctx.storage.get(dk)) return { ok: true, dup: true };       // idempotency: one trigger per (event, user, alert type)
    const now = Date.now(), id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const tg = !!this.env.BOT_TOKEN && (/^\d{5,15}$/.test(uid) || !!m.account_id);   // browser users (uid = account) are delivered to the Telegram chats registered on their MT5 account
    const rec = { id, user_id: uid, account_id: m.account_id || null, type: m.type || "system", event_id: String(m.event_id || ""), alert_type: String(m.alert_type || ""), title: String(m.title).slice(0, 120), body: String(m.body || "").slice(0, 600), status: tg ? "Pending" : "Sent", channel: tg ? "telegram" : "none", tries: 0, created_at: now, updated_at: now };
    await this.ctx.storage.put(dk, now); await this.ctx.storage.put(this.hk(rec), rec);            // both before any network call
    this.prune(uid).catch(() => {});
    if (Math.random() < 0.02) this.sweep().catch(() => {});
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
    if (ts && !ts.length) { st = "Sent"; rec.channel = "none"; }            // nobody to push to: nothing to deliver
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

  /* ── housekeeping + alarm: only delivery retries need an alarm now. Re-armed after every change. ── */
  async sweep() { const old = Date.now() - 14 * 86400000; for (const [k, v] of await this.ctx.storage.list({ prefix: "dd:", limit: 500 })) if (v < old) await this.ctx.storage.delete(k); }
  async schedule() {
    let t = 0;
    for (const k of (await this.ctx.storage.list({ prefix: "rt:", limit: 50 })).keys()) { const hk = await this.ctx.storage.get(k); const rec = hk && await this.ctx.storage.get(hk); if (rec && rec.retry_at) t = t ? Math.min(t, rec.retry_at) : rec.retry_at; }
    if (t) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, t));
  }
  async alarm() {
    try {
      for (const k of (await this.ctx.storage.list({ prefix: "rt:", limit: 50 })).keys()) { const hk = await this.ctx.storage.get(k), rec = hk && await this.ctx.storage.get(hk); if (!rec) { await this.ctx.storage.delete(k); continue; } if (rec.retry_at && Date.now() >= rec.retry_at) await this.deliver(rec); }
    } finally { await this.schedule(); }
  }
}
