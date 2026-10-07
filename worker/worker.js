// Yetimmm bridge:  Mini App  <->  Cloudflare Worker  <->  MT5 EA
//   EA       -> POST /api/ea/sync   (header X-Bridge-Key)   body {state, ack:[ids]}  -> {ok:true, commands:[...]}
//   Mini App -> GET  /state         (header Authorization: tma <initData>)
//   Mini App -> POST /command       (header Authorization: tma <initData>)  body {cmd, ...params} -> {ok:true, id}
// Secrets (wrangler secret put): BRIDGE_KEY, BOT_TOKEN
// Vars (wrangler.toml): ALLOWED_ORIGIN, ALLOWED_USERS

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

// Validates Telegram Mini App initData (HMAC) and checks the user is in ALLOWED_USERS
async function authTma(req, env) {
  const h = req.headers.get("Authorization") || "";
  const botToken = (env.BOT_TOKEN || "").trim();
  if (!h.startsWith("tma ") || !botToken) return null;
  const params = new URLSearchParams(h.slice(4));
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dcs = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const enc = new TextEncoder();
  const secret = await hmac(enc.encode("WebAppData"), enc.encode(botToken));
  const sig = await hmac(secret, enc.encode(dcs));
  const hex = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (!safeEq(hex, hash)) return null;
  const age = Date.now() / 1000 - Number(params.get("auth_date") || 0);
  if (!(age > -300 && age < 3 * 86400)) return null; // initData valid for 3 days
  let user = {};
  try { user = JSON.parse(params.get("user") || "{}"); } catch { return null; }
  const allowed = (env.ALLOWED_USERS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return allowed.includes(String(user.id)) ? user : null;
}

function corsHeaders(req, env) {
  const origin = req.headers.get("Origin");
  if (!origin || origin !== env.ALLOWED_ORIGIN) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const hub = env.HUB.get(env.HUB.idFromName("main"));
    let res;
    try {
      if (url.pathname === "/api/ea/sync" && req.method === "POST") {
        if (!safeEq(req.headers.get("X-Bridge-Key") || "", (env.BRIDGE_KEY || "").trim())) res = json({ ok: false, error: "key" }, 401);
        else res = await hub.fetch("https://hub/sync", { method: "POST", body: await req.text() });
      } else if (url.pathname === "/state" && req.method === "GET") {
        res = (await authTma(req, env)) ? await hub.fetch("https://hub/state") : json({ error: "auth" }, 401);
      } else if (url.pathname === "/command" && req.method === "POST") {
        res = (await authTma(req, env))
          ? await hub.fetch("https://hub/command", { method: "POST", body: await req.text() })
          : json({ error: "auth" }, 401);
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
    if ((b.cmd === "delete" || b.cmd === "modify") && !(c.ticket > 0)) return json({ error: "ticket required" }, 400);
    if ((b.cmd === "modify" || b.cmd === "place") && !(c.price > 0)) return json({ error: "price required" }, 400);
    if (b.cmd === "place" && !c.side) return json({ error: "side required" }, 400);
    const q = (await this.ctx.storage.get("cmds")) || [];
    q.push({ t: Date.now(), c });
    await this.ctx.storage.put("cmds", q.slice(-20));
    return json({ ok: true, id: c.id });
  }
}
