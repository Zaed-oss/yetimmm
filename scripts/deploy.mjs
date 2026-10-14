// One-command Worker release:  npm run deploy
//   1) npm run check + npm test (stops on failure)
//   2) preflight: BOT_TOKEN + APP_PASSWORD secrets and PAIR_CODE (secret OR [vars]) must exist; a var+secret duplicate is REPORTED (never deleted silently)
//   3) wrangler deploy
//   4) verifies the Worker answers, runs this package's version, and has PAIR_CODE (probe, the cause of HTTP 503 pair_not_configured)
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

// 2) configuration preflight (v4.18): everything the Worker needs must exist BEFORE we deploy, and nothing is deleted behind your back
//    BOT_TOKEN + APP_PASSWORD = secrets.  PAIR_CODE = secret (created by `npm run setup`) OR an explicit [vars] entry you added yourself.
//    No default / example value for any of them exists in this repository.
const toml = readFileSync(join(root, cfg), "utf8");
const varPair = /^\s*PAIR_CODE\s*=\s*"([^"]+)"/m.exec(toml);
let names = null;
const ls = run(npx, ["wrangler", "secret", "list", "--config", cfg, "--format", "json"], { capture: true });
if (!dry) {
  if (ls.status !== 0) die("could not list the Worker's secrets (not logged in?). Run `npx wrangler login` or set CLOUDFLARE_API_TOKEN.\n" + (ls.stderr || ""));
  try { names = JSON.parse(ls.stdout.slice(ls.stdout.indexOf("["))).map((x) => x.name); } catch { die("could not parse the secret list - nothing was deployed"); }
  const missing = ["BOT_TOKEN", "APP_PASSWORD"].filter((n) => !names.includes(n));
  if (!varPair && !names.includes("PAIR_CODE")) missing.push("PAIR_CODE");
  if (missing.length) die("required configuration is missing: " + missing.join(", ") + "\n  -> first-time setup: `npm run setup`   |   one secret: `npx wrangler secret put <NAME>`   (nothing was deployed)");
  if (varPair && names.includes("PAIR_CODE")) die("PAIR_CODE is defined TWICE: as a [vars] line in worker/wrangler.toml AND as a Cloudflare secret (a var and a secret with one name conflict).\n  Keep ONE: delete the PAIR_CODE line from wrangler.toml (recommended - the secret is stronger), or run `npx wrangler secret delete PAIR_CODE`. Nothing was changed.");
}

// 3) deploy
log("wrangler deploy");
const dep = run(npx, ["wrangler", "deploy", "--config", cfg]);
if (dep.status !== 0) die("wrangler deploy failed (see the message above)");

// 4) verify: the Worker answers, runs THIS release, and PAIR_CODE is configured (harmless probe, see scripts/probe.mjs)
const app = readFileSync(join(root, "app.js"), "utf8");
const url = ((/baseUrl:\s*"(https:\/\/[^"]+)"/.exec(app) || [])[1] || "").replace(/\/+$/, "");
const want = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (dry || !url) { log(dry ? "(dry) skipping verification" : "no api.baseUrl found in app.js; skipping verification"); process.exit(0); }
await new Promise((r) => setTimeout(r, 3000));
const { probeWorker } = await import("./probe.mjs");
const pr = await probeWorker(url);
log("probe -> " + JSON.stringify(pr));
if (!pr.up) die("deployed, but " + url + "/ did not answer (wrong api.baseUrl in app.js, or the workers.dev subdomain differs)");
if (pr.v !== want) die("deployed, but the Worker reports v" + pr.v + " and this package is v" + want + " (an old deployment is still serving)");
if (pr.pair !== "configured") die("deployed, but pairing is not usable: " + (pr.pair === "missing" ? "the Worker has no PAIR_CODE (503 pair_not_configured)" : "unexpected probe answer - " + pr.note));
log("OK: Worker v" + pr.v + " is live and PAIR_CODE is configured (the EA reads the same code from Yetimmm.cfg).");
