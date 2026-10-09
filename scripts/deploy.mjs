// One-command Worker release:  npm run deploy
//   1) npm run check + npm test (stops on failure)
//   2) if PAIR_CODE is a [vars] entry in wrangler.toml AND a secret with the same name exists in Cloudflare,
//      deletes that secret (a secret and a var with one name conflict and the deploy would fail)
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

// 2) var-vs-secret conflict
const toml = readFileSync(join(root, cfg), "utf8");
const varPair = /^\s*PAIR_CODE\s*=\s*"([^"]+)"/m.exec(toml);
if (varPair) {
  log("PAIR_CODE is set in wrangler.toml [vars]; checking for a conflicting Cloudflare secret...");
  const ls = run(npx, ["wrangler", "secret", "list", "--config", cfg, "--format", "json"], { capture: true });
  if (!dry) {
    if (ls.status !== 0) die("could not list secrets (not logged in?). Run `npx wrangler login` or set CLOUDFLARE_API_TOKEN.\n" + (ls.stderr || ""));
    let names = [];
    try { names = JSON.parse(ls.stdout.slice(ls.stdout.indexOf("["))).map((x) => x.name); } catch { log("could not parse the secret list; continuing"); }
    if (names.includes("PAIR_CODE")) {
      log("a secret named PAIR_CODE exists -> deleting it so the [vars] value (" + varPair[1].length + " chars) takes over");
      const del = run(npx, ["wrangler", "secret", "delete", "PAIR_CODE", "--config", cfg], { capture: true, input: "y\n" });
      if (del.status !== 0) die("could not delete the PAIR_CODE secret:\n" + (del.stderr || del.stdout));
    }
    for (const need of ["BOT_TOKEN", "APP_PASSWORD"]) if (names.length && !names.includes(need)) log("WARNING: required secret " + need + " is missing -> npx wrangler secret put " + need);
  }
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
  log("OK: Worker " + j.v + " is live with PAIR_CODE configured. EA input InpBrPairCode must equal it (default 123123).");
} catch (e) { die("deployed, but " + url + "/ did not answer: " + e.message + " (wrong InpBrUrl, or workers.dev subdomain differs)"); }
