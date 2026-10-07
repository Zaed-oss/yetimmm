// Yetimmm bridge:  Mini App  <->  Cloudflare Worker  <->  MT5 EA
//   EA       -> POST /api/ea/sync   (header X-Bridge-Key)   body {state, ack:[ids]}  -> {ok:true, commands:[...]}
//   Mini App -> GET  /state         (OPEN ACCESS - no login, no Telegram account check)
//   Mini App -> POST /command       (OPEN ACCESS)  body {cmd, ...params} -> {ok:true, id}
// MULTI-CLIENT: one Worker serves many clients. Each client has a personal key "id.sig" (made with make_key.py from MASTER_SECRET).
//   The key travels in the header X-Bridge-Key (EA and Mini App). Each key gets its OWN isolated hub: clients never see each other.
//   No login, no Telegram account: whoever holds the personal link (index.html?k=id.sig) has access, nobody else.
// Secret (wrangler secret put): MASTER_SECRET
// Vars (wrangler.toml): ALLOWED_ORIGIN (optional: "*" or empty = any origin; set a URL to restrict browsers to your page)

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

function safeEq(a, b) {
  if (!a || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

// "id.sig": sig = first 32 hex chars of HMAC-SHA256(MASTER_SECRET, id). Returns the client id or null.
async function clientOf(req, env) {
  const key = (req.headers.get("X-Bridge-Key") || "").trim();
  const i = key.indexOf(".");
  const master = (env.MASTER_SECRET || "").trim();
  if (i < 1 || i > 40 || !master) return null;
  const id = key.slice(0, i);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const enc = new TextEncoder();
  const sig = [...(await hmac(enc.encode(master), enc.encode(id)))].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  return safeEq(sig, key.slice(i + 1)) ? id : null;
}

function corsHeaders(req, env) {
  const origin = req.headers.get("Origin");
  const cfg = (env.ALLOWED_ORIGIN || "").trim();
  if (!origin) return {};
  if (cfg && cfg !== "*" && origin !== cfg) return {};
  return {
    "Access-Control-Allow-Origin": cfg && cfg !== "*" ? origin : "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Bridge-Key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const needs = url.pathname === "/api/ea/sync" || url.pathname === "/state" || url.pathname === "/command";
    const cid = needs ? await clientOf(req, env) : null;
    if (needs && !cid) return new Response(JSON.stringify({ ok: false, error: "key" }), { status: 401, headers: { "Content-Type": "application/json", ...cors } });
    const hub = env.HUB.get(env.HUB.idFromName(cid || "main"));
    let res;
    try {
      if (url.pathname === "/api/ea/sync" && req.method === "POST") {
        res = await hub.fetch("https://hub/sync", { method: "POST", body: await req.text() });
      } else if (url.pathname === "/state" && req.method === "GET") {
        res = await hub.fetch("https://hub/state");
      } else if (url.pathname === "/command" && req.method === "POST") {
        res = await hub.fetch("https://hub/command", { method: "POST", body: await req.text() });
      } else if (url.pathname === "/") {
        res = json({ ok: true, service: "yetimmm-bridge" });
      } else {
        res = json({ error: "not found" }, 404);
      }
    } catch (e) {
      res = json({ error: "server" }, 500);
    }
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  },
};

// One Durable Object holds the latest EA state (in memory) and the pending command queue (storage).
export class Hub {
  constructor(ctx) {
    this.ctx = ctx;
    this.st = null;
    this.ts = 0;
  }

  age() { return this.ts ? (Date.now() - this.ts) / 1000 : null; }

  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/sync") return this.sync(await req.json().catch(() => ({})));
    if (p === "/state") return this.getState();
    if (p === "/command") return this.command(await req.json().catch(() => null));
    return json({ error: "not found" }, 404);
  }

  async sync(body) {
    if (body && typeof body.state === "object" && body.state) { this.st = body.state; this.ts = Date.now(); }
    let q = (await this.ctx.storage.get("cmds")) || [];
    const ack = Array.isArray(body && body.ack) ? body.ack : [];
    const now = Date.now();
    const next = q.filter((x) => !ack.includes(x.c.id) && now - x.t < 120000); // acked or older than 2 min -> dropped
    if (next.length !== q.length) await this.ctx.storage.put("cmds", next);
    return json({ ok: true, commands: next.map((x) => x.c) });
  }

  getState() {
    const a = this.age();
    const st = this.st || { price: 0, run: false, state: "STOPPED", hist: [] };
    return json({ ...st, eaAge: a, eaOnline: a !== null && a < 15 });
  }

  async command(b) {
    const allowed = ["start", "stop", "close", "reset", "apply", "settings", "delete", "cancel", "modify", "place"];
    if (!b || !allowed.includes(String(b.cmd))) return json({ error: "bad command" }, 400);
    const a = this.age();
    if (a === null || a > 20) return json({ error: "ea offline" }, 503);
    const c = { id: crypto.randomUUID().replace(/-/g, "").slice(0, 16), cmd: String(b.cmd) }; // id first: the EA parser relies on it
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
    if ((b.cmd === "delete" || b.cmd === "modify") && !(c.ticket > 0) && !c.side) return json({ error: "ticket or side required" }, 400); // side only = a level that is still waiting for the price
    if ((b.cmd === "modify" || b.cmd === "place") && !(c.price > 0)) return json({ error: "price required" }, 400);
    if (b.cmd === "place" && !c.side) return json({ error: "side required" }, 400);
    const q = (await this.ctx.storage.get("cmds")) || [];
    q.push({ t: Date.now(), c });
    await this.ctx.storage.put("cmds", q.slice(-20));
    return json({ ok: true, id: c.id });
  }
}
