// One-command Worker release:  npm run deploy
//   1) npm run check + npm test (stops on failure)
//   2) refuses to deploy if PAIR_CODE sits in wrangler.toml as a plain variable, or if BOT_TOKEN / PAIR_CODE secrets are missing
//      (APP_PASSWORD is required ONLY when no OWNER_TG secret exists: an owner signs in through Telegram, no password needed)
//   3) wrangler deploy
//   4) GET <worker>/ and verifies pairConfigured:true (the cause of HTTP 503 pair_not_configured)
// Needs Cloudflare auth in the terminal: `npx wrangler login` once, or env CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID).
// Flags: --dry (print what would run, change nothing)   --skip-tests
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = join("worker", "wrangler.toml");
const dry = process.argv.includes("--dry"), skipTests = process.argv.includes("--skip-tests");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const log = (m) => console.log("[deploy] " + m);
const die = (m) => { console.error("[deploy] FAILED: " + m); process.exit(1); };

function run(cmd, args, opts = {}) {
  if (dry) { log("(dry) " + cmd + " " + args.join(" ")); return { status: 0, stdout: "", stderr: "" }; }
  return spawnSync(cmd, args, { cwd: root, encoding: "utf8", shell: process.platform === "win32", stdio: opts.capture ? "pipe" : "inherit", input: opts.input });
}

// 1) checks
if (!skipTests) {
  for (const a of [["run", "check"], ["test"]]) {
    log("npm " + a.join(" "));
    const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", a, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    if (r.status !== 0) die("npm " + a.join(" ") + " failed - nothing was deployed");
  }
}

// 2) secrets: PAIR_CODE must be a Cloudflare SECRET, never a plain [vars] entry (wrangler.toml is committed to git and the code can bind any MT5 account)
const toml = readFileSync(join(root, cfg), "utf8");
if (/^\s*PAIR_CODE\s*=/m.test(toml)) die("PAIR_CODE is set as a plain variable in worker/wrangler.toml. Remove that line and store it as a secret: npx wrangler secret put PAIR_CODE (or run npm run setup).");
if (!dry) {
  const ls = run(npx, ["wrangler", "secret", "list", "--config", cfg, "--format", "json"], { capture: true });
  if (ls.status !== 0) die("could not list secrets (not logged in?). Run `npx wrangler login` or set CLOUDFLARE_API_TOKEN.\n" + (ls.stderr || ""));
  let names = null;
  try { names = JSON.parse(ls.stdout.slice(ls.stdout.indexOf("["))).map((x) => x.name); } catch { die("could not parse the secret list - refusing to deploy blind"); }
  // v4.31.1: APP_PASSWORD is only the fallback sign-in. With an OWNER_TG secret (owner-id setup) the Worker never needs it.
  const hasOwner = names.includes("OWNER_TG") || /^\s*OWNER_TG\s*=\s*"?\d{3,15}/m.test(toml);
  const need = ["BOT_TOKEN", "PAIR_CODE", ...(hasOwner ? [] : ["APP_PASSWORD"])];
  const miss = need.filter((k) => !names.includes(k));
  if (miss.length) die("required secret(s) missing: " + miss.join(", ") + " -> npx wrangler secret put <NAME> (PAIR_CODE: 8+ chars, strong, different from APP_PASSWORD; or set OWNER_TG instead of APP_PASSWORD: npm run setup does it)");
  log("auth: " + (hasOwner ? "owner id (Telegram sign-in), APP_PASSWORD not required" : "APP_PASSWORD") + " - secrets OK");
}

// 3) deploy
log("wrangler deploy");
const dep = run(npx, ["wrangler", "deploy", "--config", cfg]);
if (dep.status !== 0) die("wrangler deploy failed (see the message above)");

// 4) verify
const ea = readFileSync(join(root, "ea", "Yetimmm.mq5"), "utf8");
const url = ((/InpBrUrl\s*=\s*"(https:\/\/[^"]+)"/.exec(ea) || [])[1] || "").replace(/\/+$/, "");
if (dry || !url) { log(dry ? "(dry) skipping verification" : "no InpBrUrl found; skipping verification"); process.exit(0); }
try {
  await new Promise((r) => setTimeout(r, 3000));
  const j = await (await fetch(url + "/")).json();
  log("GET / -> " + JSON.stringify({ ok: j.ok, v: j.v, ea_protocol: j.ea_protocol, pairConfigured: j.pairConfigured }));
  if (!j.pairConfigured) die("deployed, but pairConfigured is false: the Worker still has no PAIR_CODE");
  log("OK: Worker " + j.v + " is live with PAIR_CODE configured. EA input InpBrPairCode must equal it (use a strong random value; weak codes such as 123123 are refused by the Worker).");
} catch (e) { die("deployed, but " + url + "/ did not answer: " + e.message + " (wrong InpBrUrl, or workers.dev subdomain differs)"); }
