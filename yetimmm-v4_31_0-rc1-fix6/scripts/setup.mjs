// ONE COMMAND, ZERO TYPING:  npm run setup      (re-run any time: it is idempotent and reuses what already exists)
//   1  installs dependencies                       7  writes Yetimmm.cfg into MT5 (the EA reads URL + pairing code from it)
//   2  Cloudflare login (browser opens once)       8  allows the Worker URL in MT5 (Windows) - no manual Options editing
//   3  asks for the bot token ONCE (hidden)        9  compiles + installs the EA into MT5 (Windows, best effort)
//   4  you press START in the bot -> you are the owner (no password)          10 commits/pushes to GitHub Pages and waits until it is live
//   5  sets Cloudflare ALLOWED_ORIGIN from git     11 bot name/description/commands/menu/webhook
//   6  deploys the Worker, detects its URL, patches index.html
// The only things no tool can do for you: the Cloudflare browser login, the bot token (BotFather owns it) and
// BotFather's /setdescriptionpicture. Flags: --yes (never ask)  --no-push  --no-mt5
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const A = process.argv.slice(2), yes = A.includes("--yes"), noPush = A.includes("--no-push"), noMt5 = A.includes("--no-mt5");
const win = process.platform === "win32", npx = win ? "npx.cmd" : "npx", npm = win ? "npm.cmd" : "npm";
const log = (m) => console.log("\x1b[33m[setup]\x1b[0m " + m), ok = (m) => console.log("\x1b[32m  ✔\x1b[0m " + m), warn = (m) => console.log("\x1b[31m  !\x1b[0m " + m);
const P = (f) => join(root, f), rd = (f) => { try { return readFileSync(P(f), "utf8"); } catch { return ""; } };
const sh = (c, a, o = {}) => spawnSync(c, a, { cwd: root, encoding: "utf8", shell: win, ...o });
const cfgToml = join("worker", "wrangler.toml");

function ask(q, def = "", secret = false) {
  if (yes) return Promise.resolve(def);
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (secret) rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(s); };
    rl.question(q + " ", (a) => { rl.close(); if (secret) console.log(""); res((a || "").trim() || def); });
  });
}
// local, git-ignored state: generated secrets + bot token (so re-runs are silent)
const stateFile = P(".env");
const env = Object.fromEntries(rd(".env").split(/\r?\n/).map((l) => /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].trim().replace(/^["']|["']$/g, "")]));
const save = () => writeFileSync(stateFile, Object.entries(env).map(([k, v]) => `${k}=${String(v).replace(/[\r\n]/g, "")}`).join("\n") + "\n");
const rnd = (n) => randomBytes(n).toString("base64url").replace(/[-_]/g, "x").slice(0, n);
const digits = (n) => Array.from(randomBytes(n), (b) => b % 10).join("");

// 1 ─ dependencies
log("1/11 dependencies");
if (!existsSync(P("node_modules/.bin/wrangler")) && !existsSync(P("node_modules/.bin/wrangler.cmd"))) { const r = sh(npm, ["install", "--no-audit", "--no-fund"], { stdio: "inherit" }); if (r.status) { warn("npm install failed"); process.exit(1); } }
ok("ready");

// 2 ─ Cloudflare
log("2/11 Cloudflare");
if (!process.env.CLOUDFLARE_API_TOKEN) {
  let w = sh(npx, ["wrangler", "whoami"]);
  if (w.status !== 0 || /not authenticated/i.test((w.stdout || "") + (w.stderr || ""))) { log("opening the browser for Cloudflare login (once)..."); const r = sh(npx, ["wrangler", "login"], { stdio: "inherit" }); if (r.status) { warn("Cloudflare login failed"); process.exit(1); } }
}
ok("logged in");

// 3 ─ bot token
log("3/11 bot token");
let token = process.env.BOT_TOKEN || env.BOT_TOKEN || "";
if (!token) token = await ask("Paste the bot token from @BotFather (hidden, asked once):", "", true);
let me = {};
try { me = await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json(); } catch {}
if (!me.ok) { warn("Telegram rejected the token."); process.exit(1); }
ok("@" + me.result.username); env.BOT_TOKEN = token;

// 4 ─ owner (you, recognised by Telegram itself) + internal pairing code. No password for you to invent or remember.
log("4/11 owner + secrets");
env.PAIR_CODE = env.PAIR_CODE || randomBytes(12).toString("hex");   // v4.22: 96-bit random (was 8 digits = brute-forceable)   // internal EA<->Worker pairing: written to Yetimmm.cfg, you never see or type it
if (!env.OWNER_TG) {
  await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
  console.log(`  \x1b[36m→ Open https://t.me/${me.result.username} on Telegram and press START (waiting up to 2 minutes)\x1b[0m`);
  let off = 0; const t0 = Date.now();
  while (!env.OWNER_TG && Date.now() - t0 < 120000) {
    try {
      const u = await (await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=10&offset=${off}&allowed_updates=%5B%22message%22%5D`)).json();
      for (const x of u.result || []) { off = x.update_id + 1; const m = x.message; if (m && m.chat && m.chat.type === "private" && m.from && !m.from.is_bot) { env.OWNER_TG = String(m.from.id); break; } }
    } catch { await new Promise((r) => setTimeout(r, 2000)); }
  }
}
if (env.OWNER_TG) ok("owner recognised: Telegram id " + env.OWNER_TG);
else { env.APP_PASSWORD = env.APP_PASSWORD || rnd(10); warn("no Start received - fallback: a sign-in password was generated (saved in .env). Re-run `npm run setup` after pressing Start to remove it."); }
save();
const put = (name, val) => { const r = sh(npx, ["wrangler", "secret", "put", name, "--config", cfgToml], { input: val, stdio: ["pipe", "pipe", "pipe"] }); if (r.status) { warn("secret " + name + " failed: " + (r.stderr || r.stdout)); process.exit(1); } };
for (const k of ["BOT_TOKEN", "PAIR_CODE", "OWNER_TG", "APP_PASSWORD"]) if (env[k]) put(k, env[k]);
ok("stored securely in Cloudflare");

// 5 ─ toml: drop the plain PAIR_CODE var (a secret replaces it) + ALLOWED_ORIGIN from git
log("5/11 Cloudflare settings");
let toml = rd(cfgToml);
toml = toml.replace(/^PAIR_CODE\s*=.*\r?\n/m, "");
const git = sh("git", ["config", "--get", "remote.origin.url"]);
const gm = /github\.com[:/]+([^/]+)\/([^/.]+?)(?:\.git)?\s*$/.exec(git.stdout || "");
let appUrl = env.MINI_APP_URL || "";
if (gm) {
  const origin = `https://${gm[1].toLowerCase()}.github.io`;
  appUrl = gm[2].toLowerCase() === (gm[1] + ".github.io").toLowerCase() ? origin + "/" : `${origin}/${gm[2]}/`;
  toml = toml.replace(/^ALLOWED_ORIGIN\s*=.*$/m, `ALLOWED_ORIGIN = "${origin}"`);
}
if (!appUrl) {   // zip download (no .git): reuse ALLOWED_ORIGIN from wrangler.toml + the folder name (yetimmm-main -> yetimmm), same rule as setup-bot.mjs
  const o = (/^\s*ALLOWED_ORIGIN\s*=\s*"([^",]+)/m.exec(toml) || [])[1];
  if (o && !/YOUR-/i.test(o)) { appUrl = o.replace(/\/+$/, "") + "/" + basename(root).replace(/-(main|master)$/i, "") + "/"; log("no git remote - Mini App URL derived: " + appUrl); }
}
if (!appUrl) appUrl = (await ask("No GitHub remote found. Mini App URL (https://user.github.io/repo/):")).replace(/\/*$/, "/");
env.MINI_APP_URL = appUrl; save();
writeFileSync(P(cfgToml), toml);
ok("Mini App URL: " + appUrl);

// 6 ─ deploy + detect URL + patch index.html
log("6/11 deploying the Worker");
const dep = sh(npx, ["wrangler", "deploy", "--config", cfgToml]);
const out = (dep.stdout || "") + (dep.stderr || "");
process.stdout.write(out.split("\n").slice(-12).join("\n") + "\n");
if (dep.status) { warn("wrangler deploy failed"); process.exit(1); }
let worker = (/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/i.exec(out) || [])[0] || env.WORKER_URL || "";
if (!worker) worker = (await ask("Worker URL not detected. Paste it:")).replace(/\/+$/, "");
env.WORKER_URL = worker; save();
let html = rd("index.html");
const nh = html.replace(/(baseUrl:\s*")https:\/\/[^"]+(")/, `$1${worker}$2`);
if (nh !== html) writeFileSync(P("index.html"), nh);
let chk = {}; try { chk = await (await fetch(worker + "/")).json(); } catch {}
ok(`Worker ${worker} · pairConfigured=${chk.pairConfigured} · cors=${chk.corsConfigured}`);

// 7-9 ─ MT5 (Windows)
const cfgText = `url=${worker}\npair=${env.PAIR_CODE}\n`;
writeFileSync(P("ea/Yetimmm.cfg"), cfgText);
if (win && !noMt5) {
  log("7/11 MetaTrader 5");
  const base = join(process.env.APPDATA || "", "MetaQuotes");
  try {
    const cf = join(base, "Terminal", "Common", "Files"); mkdirSync(cf, { recursive: true }); writeFileSync(join(cf, "Yetimmm.cfg"), cfgText); ok("Yetimmm.cfg written -> " + cf);
  } catch (e) { warn("could not write Yetimmm.cfg (copy ea\\Yetimmm.cfg to MT5 File > Open Data Folder > ..\\Common\\Files)"); }
  log("8/11 Allowed URLs");
  const al = sh("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", P("tools/allow-urls.ps1"), "-Url", worker, "-CloseMt5", "-Restart"], { stdio: "inherit" });
  al.status ? warn("allow-urls failed: close MT5 and run tools\\allow-urls.bat") : ok("Worker + api.telegram.org allowed (MT5 restarted)");
  log("9/11 compile + install the EA");
  try {
    const dirs = readdirSync(join(base, "Terminal")).filter((d) => /^[0-9A-F]{32}$/i.test(d)).map((d) => join(base, "Terminal", d)).filter((d) => existsSync(join(d, "MQL5", "Experts")));
    const pf = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"], process.env["ProgramW6432"]].filter(Boolean);
    const stdEditors = pf.flatMap((p) => { try { return readdirSync(p).filter((n) => /metatrader|mt5/i.test(n)).map((n) => join(p, n, "MetaEditor64.exe")); } catch { return []; } });
    for (const d of dirs) {
      const dst = join(d, "MQL5", "Experts", "Yetimmm.mq5"); copyFileSync(P("ea/Yetimmm.mq5"), dst); ok("EA copied -> " + dst);
      // origin.txt in every data folder holds the real install path of THAT terminal (works for any broker build / custom folder)
      let inst = ""; try { inst = readFileSync(join(d, "origin.txt")).toString("utf16le").replace(/^\uFEFF/, "").trim() || readFileSync(join(d, "origin.txt"), "utf8").trim(); } catch {}
      const editor = [inst && join(inst, "MetaEditor64.exe"), ...stdEditors].filter(Boolean).find(existsSync);
      if (!editor) { warn("MetaEditor not found for this terminal: open the EA in MetaEditor and press F7 once"); continue; }
      sh(`"${editor}"`, [`/compile:"${dst}"`, "/log"]);
      existsSync(join(d, "MQL5", "Experts", "Yetimmm.ex5")) ? ok("compiled -> Yetimmm.ex5") : warn("compile produced no .ex5 - open " + dst + " in MetaEditor, press F7 and read the Errors tab");
    }
    if (!dirs.length) warn("no MT5 data folder found: copy ea\\Yetimmm.mq5 to MQL5\\Experts and press F7");
  } catch (e) { warn("MT5 auto-install skipped: " + e.message); }
} else if (!win) { log("7-9/11 MT5: not Windows. Copy ea/Yetimmm.cfg to MetaTrader's Common/Files, copy ea/Yetimmm.mq5 to MQL5/Experts, press F7."); }

// 10 ─ publish the Mini App
log("10/11 GitHub Pages");
// v4.31.1: check GitHub credentials BEFORE committing (non-interactive: never hangs on a prompt). One-time fix: `gh auth login` (or Git Credential Manager), then every update just works.
const gitAuthOk = () => gm && sh("git", ["push", "--dry-run", "--quiet"], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: "pipe" }).status === 0;   // push (not ls-remote): a public repo can be READ without credentials but not written
if (gm && !noPush && !gitAuthOk()) {
  warn("GitHub is not authenticated on this machine - skipping the push (nothing is lost).");
  console.log("    One-time fix:  gh auth login   (choose GitHub.com > HTTPS > browser)   - or sign in once via Git Credential Manager.");
  console.log("    Then re-run:   npm run setup   (or  powershell -File tools/repo-update.ps1  for code-only updates)");
} else if (gm && !noPush) {
  sh("git", ["add", "-A"]); sh("git", ["commit", "-m", "setup: configure worker url + assets", "--quiet"]);
  const ps = sh("git", ["push"], { stdio: "inherit" });
  if (ps.status) warn("git push failed - push manually, then re-run `npm run setup`");
  const up = async (u) => { try { return (await fetch(u + "?t=" + Date.now())).status; } catch { return 0; } };
  process.stdout.write("  waiting for Pages");
  for (let i = 0; i < 36; i++) { if ((await up(appUrl)) === 200 && (await up(appUrl + "assets/banner.png")) === 200) break; process.stdout.write("."); await new Promise((r) => setTimeout(r, 5000)); }
  console.log("");
}

// 11 ─ bot
log("11/11 Telegram bot");
const sb = sh("node", [P("scripts/setup-bot.mjs"), "--yes"], { env: { ...process.env, BOT_TOKEN: token, WORKER_URL: worker, MINI_APP_URL: appUrl }, stdio: "inherit" });
if (sb.status) warn("bot setup reported a problem (see above)");

console.log(`
\x1b[32m══════════ DONE ══════════\x1b[0m
 Bot            https://t.me/${me.result.username}
 Mini App       ${appUrl}
 Sign-in        automatic (Telegram recognises you)${env.APP_PASSWORD ? "\n App password   " + env.APP_PASSWORD + "   (fallback, saved in .env)" : ""}
 Remaining      1) MT5: restart it, attach the EA to XAUUSD (nothing to type - it reads Yetimmm.cfg)
                2) BotFather: /setdescriptionpicture -> assets/banner-640.png
`);
