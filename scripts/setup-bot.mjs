// Telegram bot presentation setup - ZERO manual values. Run:  npm run setup:bot
// Everything is detected, you only confirm with Enter:
//   BOT_TOKEN    env BOT_TOKEN -> .env file -> hidden prompt (never written to disk)
//   WORKER_URL   env WORKER_URL -> api.baseUrl inside index.html (the single source of truth the Mini App already uses)
//   MINI_APP_URL env MINI_APP_URL -> GitHub Pages URL built from `git remote origin` -> wrangler.toml ALLOWED_ORIGIN + folder name
// The URLs are verified live (HTTP 200 + banner reachable) before anything is changed. Flags: --yes (no questions), --dry
// The description PICTURE is the only thing the Bot API cannot set: @BotFather -> /setdescriptionpicture -> assets/banner-640.png
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const yes = process.argv.includes("--yes"), dry = process.argv.includes("--dry");
const read = (f) => { try { return readFileSync(join(root, f), "utf8"); } catch { return ""; } };
const say = (m) => console.log("[setup-bot] " + m);

function ask(q, def = "", secret = false) {
  if (yes) return Promise.resolve(def);
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (secret) { rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(s); }; }
    rl.question(q + (def && !secret ? ` [${def}] ` : " "), (a) => { rl.close(); if (secret) console.log(""); res((a || "").trim() || def); });
  });
}

// ── detect ─────────────────────────────────────────────────────────────────────────────
const dotenv = Object.fromEntries(read(".env").split(/\r?\n/).map((l) => /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].trim().replace(/^(["'])(.*)\1\s*(#.*)?$/, "$2").replace(/\s+#.*$/, "").trim()]));
const detWorker = process.env.WORKER_URL || dotenv.WORKER_URL || (/baseUrl:\s*"(https:\/\/[^"]+)"/.exec(read("index.html")) || [])[1] || "";
function detPages() {
  const g = spawnSync("git", ["config", "--get", "remote.origin.url"], { cwd: root, encoding: "utf8" });
  const m = /github\.com[:/]+([^/]+)\/([^/.]+?)(?:\.git)?\s*$/.exec(g.stdout || "");
  if (m) return m[2].toLowerCase() === (m[1] + ".github.io").toLowerCase() ? `https://${m[1]}.github.io/` : `https://${m[1]}.github.io/${m[2]}/`;
  const o = (/^\s*ALLOWED_ORIGIN\s*=\s*"([^",]+)/m.exec(read("worker/wrangler.toml")) || [])[1];
  return o ? o.replace(/\/+$/, "") + "/" + basename(root).replace(/-(main|master)$/i, "") + "/" : "";
}
const detApp = process.env.MINI_APP_URL || dotenv.MINI_APP_URL || detPages();

const norm = (u, slash) => { u = String(u || "").trim(); if (!u) return ""; if (!/^https:\/\//i.test(u)) u = "https://" + u.replace(/^\/+/, ""); return slash ? u.replace(/\/*$/, "/") : u.replace(/\/+$/, ""); };
const up = async (u) => { try { const r = await fetch(u, { method: "GET", redirect: "follow" }); return r.status; } catch { return 0; } };

// ── resolve ────────────────────────────────────────────────────────────────────────────
let token = String(process.env.BOT_TOKEN || dotenv.BOT_TOKEN || "").trim().replace(/^["']|["']$/g, "");
if (!token) token = await ask("Bot token (from @BotFather, hidden):", "", true);
if (!/^\d{6,}:[\w-]{30,}$/.test(token)) { console.error("[setup-bot] BOT_TOKEN is missing or malformed."); process.exit(1); }
let worker = norm(await ask("Worker URL:", detWorker));
let app = norm(await ask("Mini App URL (index.html location):", detApp), true);
if (!worker || !app) { console.error("[setup-bot] Worker URL and Mini App URL are required."); process.exit(1); }

// ── verify live ────────────────────────────────────────────────────────────────────────
const [sw, sa, sb] = await Promise.all([up(worker + "/"), up(app), up(app + "assets/banner.png")]);
say(`worker ${sw === 200 ? "ok" : "HTTP " + sw} · app ${sa === 200 ? "ok" : "HTTP " + sa} · banner ${sb === 200 ? "ok" : "HTTP " + sb + " (push the assets/ folder to Pages)"}`);
if (sw !== 200) { console.error("[setup-bot] Worker is not answering: run `npm run deploy` first."); process.exit(1); }
if (sa !== 200) { const a = (await ask("Mini App URL does not answer 200. Continue anyway? (y/N)", "n")).toLowerCase(); if (a !== "y") process.exit(1); }

// ── apply ──────────────────────────────────────────────────────────────────────────────
const api = async (m, b) => {
  if (dry) { say("(dry) " + m); return { ok: true }; }
  const r = await (await fetch(`https://api.telegram.org/bot${token}/${m}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })).json();
  const limited = !r.ok && (r.error_code === 429 || /too many requests|retry after/i.test(r.description || ""));   // Telegram caps setMyName (~2 changes / 22 h): that is a limit, not a failure
  const wait = limited ? Number((r.parameters && r.parameters.retry_after) || (/retry after (\d+)/i.exec(r.description || "") || [])[1] || 0) : 0;
  say((r.ok ? "ok   " : limited ? "WARN " : "FAIL ") + m + (r.ok ? "" : " - " + r.description) + (limited && wait ? ` (try again in ~${Math.ceil(wait / 3600)} h; everything else was applied)` : ""));
  return r;
};
// read-only GET helper (getMyName etc.): returns {} on any network/parse problem so the caller simply falls back to writing
const apiGet = async (m, b) => {
  if (dry) return {};
  try { return await (await fetch(`https://api.telegram.org/bot${token}/${m}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) })).json(); } catch { return {}; }
};
const me = dry ? { ok: true, result: { username: "?" } } : await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json();
if (!me.ok) { console.error("[setup-bot] Telegram rejected the token."); process.exit(1); }
say("bot: @" + me.result.username);

const secret = createHash("sha256").update("yt-webhook:" + token).digest("hex").slice(0, 48);
const T = { name: "Yetimmm", about: "نظام إدارة مخاطر ذكي لمنصة MT5 · الذهب XAUUSD", desc: "Yetimmm · XAUUSD\nنظام إدارة مخاطر ذكي لمنصة MetaTrader 5.\n\n• أوردرات Buy / Sell Stop بتسلسل مخاطرة محسوب\n• متابعة مباشرة للأوردرات والصفقات والأرباح\n\nاضغط ابدأ لفتح التطبيق.", cmds: [["start", "فتح Yetimmm"], ["app", "فتح التطبيق"]] };   // Arabic only: the same Arabic profile is set as the default (every Telegram language) and for "ar"
for (const l of [{}, { language_code: "ar" }]) {
  const lang = l.language_code || "default";
  const cur = await apiGet("getMyName", l);                                   // v4.31.1: only call setMyName when the name really differs
  if (cur.ok && cur.result && cur.result.name === T.name) say(`skip setMyName (${lang}) - already "${T.name}"`);
  else await api("setMyName", { name: T.name, ...l });
  await api("setMyDescription", { description: T.desc, ...l });
  await api("setMyShortDescription", { short_description: T.about, ...l });
  await api("setMyCommands", { commands: T.cmds.map(([command, description]) => ({ command, description })), ...l });
}
await api("setChatMenuButton", { menu_button: { type: "web_app", text: "Yetimmm", web_app: { url: app } } });   // the Worker reads the button URL from here: no MINI_APP_URL var needed
await api("setWebhook", { url: worker + "/tg/webhook", secret_token: secret, allowed_updates: ["message"], drop_pending_updates: true });
console.log("\n[setup-bot] Done. Last manual step (BotFather): /setdescriptionpicture -> assets/banner-640.png\n[setup-bot] Test: open the bot and send /start");
