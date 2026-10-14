// Shared Worker test harness (same protocol model as tests/worker.test.mjs boot()): fake Durable Objects + a model of the real EA pairing handshake.
import { createHmac } from "node:crypto";
import { ns } from "./mock-cf.mjs";
export const W = await import("../worker/worker.js");
export const BOOT_SECRET = "e".repeat(32), PAIR = "pair-Code-7788", TOKEN = "123:ABC";

export function boot(extra = {}) {
  const env = { BOT_TOKEN: TOKEN, APP_PASSWORD: "S3cret-pass", PAIR_CODE: PAIR, REQUIRE_TG: "0", ...extra };
  env.HUB = ns(W.Hub, env);
  env.NOTIFY = ns(W.Notify, env);
  const eas = {};
  const call = async (path, { method = "POST", body, headers = {} } = {}) => {
    const r = await W.default.fetch(new Request("https://w" + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers }), env);
    return { s: r.status, j: await r.json().catch(() => null), h: r.headers };
  };
  const STATE = { price: 2400.5, run: false, state: "STOPPED", hist: [], orders: [], waits: [], tick: 0.01, pt: 0.01, maxDev: 30 };
  const sync = async (login, body = {}, opt = {}) => {
    const headers = { "X-EA-Secret": eas[login] || BOOT_SECRET };
    if (!eas[login] && opt.pair !== false) headers[opt.pairHeader || "X-EA-Pair"] = opt.pair || PAIR;
    const r = await call("/api/ea/sync", { body: { login, srv: "Broker-Live", state: { ...STATE, ...(body.state || {}) }, ...body, ...(body.state ? { state: { ...STATE, ...body.state } } : {}) }, headers });
    if (r.j && r.j.es) eas[login] = r.j.es;
    return r;
  };
  const signIn = async (login = "123456", pw = "S3cret-pass", init) => call("/login", { body: { login, pw, init } });
  const auth = (login, sess) => ({ "X-Login": login, "X-Session": sess });
  const hubOf = (login) => env.HUB.get("acc-" + login).__o;
  const state = (login, sess) => call("/state", { method: "GET", headers: auth(login, sess) });
  return { env, call, sync, signIn, auth, eas, hubOf, state };
}
// Telegram Mini App initData signed exactly as Telegram does (sorted by key, HMAC with key = HMAC("WebAppData", bot token)).
export function tgInit(token, id, { authDate, extra = {}, user, tamper } = {}) {
  const p = new URLSearchParams({ auth_date: String(authDate === undefined ? Math.floor(Date.now() / 1000) : authDate), user: JSON.stringify(user === undefined ? { id: Number(id) } : user), ...extra });
  const chk = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => k + "=" + v).join("\n");
  p.set("hash", createHmac("sha256", createHmac("sha256", "WebAppData").update(token).digest()).update(chk).digest("hex"));
  let out = p.toString();
  if (tamper) out = tamper(out);
  return out;
}
