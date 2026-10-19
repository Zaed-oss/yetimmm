// npm run diagnose  — read-only health check for the "bot not running" symptom (no secrets printed, nothing modified)
//   1) Worker GET /            -> ok, version, ea_protocol, pairConfigured
//   2) Telegram getMe          -> token valid (quotes in .env are stripped first)
//   3) Telegram getWebhookInfo -> url points at the Worker, no pending updates, no last_error
// Exit code 0 = all good, 1 = something to fix. The EA side is NOT visible from here: see docs/FIX5-BOT-NOT-RUNNING.md.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export function parseEnv(text) {
  const out = {};
  for (const l of String(text || "").split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(l); if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1\s*(#.*)?$/, "$2").replace(/\s+#.*$/, "").trim();
  }
  return out;
}
export const cleanToken = (t) => String(t || "").trim().replace(/^["']|["']$/g, "").trim();

export async function diagnose({ env, fetchImpl = fetch, log = console.log } = {}) {
  const res = []; const add = (ok, msg, hint) => { res.push({ ok, msg, hint }); log((ok ? "  ok   " : "  FAIL ") + msg + (!ok && hint ? "\n       -> " + hint : "")); };
  const worker = String(env.WORKER_URL || "").replace(/\/+$/, "");
  const token = cleanToken(env.BOT_TOKEN);
  const getJson = async (u) => { const r = await fetchImpl(u, { redirect: "follow" }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, j }; };

  if (!worker) add(false, "WORKER_URL missing in .env", "add WORKER_URL=https://<name>.workers.dev");
  else {
    try {
      const { status, j } = await getJson(worker + "/");
      if (status !== 200 || !j || j.ok !== true) add(false, `Worker GET / -> HTTP ${status}`, "redeploy: npm run deploy");
      else {
        add(true, `Worker reachable (v${j.v}, ea_protocol ${j.ea_protocol})`);
        add(j.pairConfigured === true, "Worker pairConfigured", "set PAIR_CODE: npx wrangler secret put PAIR_CODE (or npm run setup)");
      }
    } catch (e) { add(false, "Worker unreachable: " + (e && e.message || e), "check WORKER_URL / internet"); }
  }
  if (!/^\d{6,}:[\w-]{30,}$/.test(token)) add(false, "BOT_TOKEN missing or malformed in .env", "paste the token from @BotFather without quotes");
  else {
    try {
      const me = await getJson(`https://api.telegram.org/bot${token}/getMe`);
      if (!me.j || !me.j.ok) add(false, `Telegram getMe -> HTTP ${me.status}`, "token revoked or wrong: re-issue in @BotFather");
      else add(true, "Telegram token valid (@" + me.j.result.username + ")");
      const wh = await getJson(`https://api.telegram.org/bot${token}/getWebhookInfo`);
      const r = wh.j && wh.j.result || {};
      const want = worker ? worker + "/tg" : "";
      add(!!r.url && (!want || r.url.startsWith(want)), "webhook -> " + (r.url ? r.url.replace(/\/tg\/.*/, "/tg/…") : "(none)"), "run: npm run setup:bot");
      add((r.pending_update_count || 0) === 0, "pending_update_count = " + (r.pending_update_count || 0), "Worker not answering Telegram: check wrangler tail");
      add(!r.last_error_message, r.last_error_message ? "last_error_message: " + r.last_error_message : "no last_error_message", "fix the error above, then npm run setup:bot");
    } catch (e) { add(false, "Telegram unreachable: " + (e && e.message || e), "check internet"); }
  }
  return res;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const f = join(root, ".env");
  const env = { ...(existsSync(f) ? parseEnv(readFileSync(f, "utf8")) : {}), ...Object.fromEntries(["BOT_TOKEN", "WORKER_URL"].filter((k) => process.env[k]).map((k) => [k, process.env[k]])) };
  console.log("Yetimmm diagnose (read-only)");
  const r = await diagnose({ env });
  console.log("\nEA side (cannot be seen from here): MT5 Algo Trading green, EA smiling on XAUUSD, Experts tab has no 4014 / HTTP error,\nand `npx wrangler tail --format pretty` shows POST /api/ea/sync every few seconds. Details: docs/FIX5-BOT-NOT-RUNNING.md");
  process.exit(r.every((x) => x.ok) ? 0 : 1);
}
