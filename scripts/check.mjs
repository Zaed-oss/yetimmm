// Quick health check of the whole package:  npm run check
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let bad = 0;
const ok = (m) => console.log("  ok   " + m);
const fail = (m) => { bad++; console.log("  FAIL " + m); };
const read = (p) => readFileSync(join(root, p), "utf8");

// 1) JavaScript syntax
for (const f of ["worker/worker.js", "worker/news.js", "news/yt-news.js", "anim/yt-anim.js"]) {
  try { execFileSync(process.execPath, ["--check", join(root, f)], { stdio: "pipe" }); ok(f + " syntax"); } catch (e) { fail(f + " syntax: " + String(e.stderr).split("\n")[0]); }
}
// 2) inline script of index.html
const html = read("index.html");
const inline = [...html.matchAll(/<script(?![^>]*\ssrc)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
inline.forEach((code, i) => { try { new Function(code); ok("index.html inline script #" + (i + 1)); } catch (e) { fail("index.html inline script #" + (i + 1) + ": " + e.message); } });
// 3) every local file referenced by index.html exists
for (const m of html.matchAll(/(?:src|href)="((?!https?:|#|data:)[^"]+)"/g)) {
  try { statSync(join(root, m[1])); ok("index.html -> " + m[1]); } catch (e) { fail("index.html references missing file " + m[1]); }
}
// 4) duplicate element ids
const ids = [...html.slice(0, html.indexOf("<script>")).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
dup.length ? fail("duplicate ids: " + [...new Set(dup)].join(", ")) : ok("no duplicate element ids");
// 5) wrangler.toml essentials
const toml = read("worker/wrangler.toml");
for (const need of ['main = "worker.js"', 'class_name = "Hub"', 'class_name = "Notify"', 'new_sqlite_classes = ["Hub"]', 'new_sqlite_classes = ["Notify"]'])
  toml.includes(need) ? ok("wrangler.toml has " + need) : fail("wrangler.toml missing " + need);
// 6) no default password in code
/PASSWORD:\s*"[^"]+"/.test(read("worker/worker.js")) ? fail("worker.js contains a hard-coded password") : ok("worker.js has no hard-coded password");
// 7) EA structural sanity (MetaEditor is the real compiler: this only catches gross damage)
const stripMq = (src) => {            // tiny tokenizer: removes comments, "strings" and 'c' literals
  let o = "", i = 0; const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const j = src.indexOf("*/", i + 2); i = j < 0 ? n : j + 2; continue; }
    if (c === '"' || c === "'") { let j = i + 1; while (j < n && src[j] !== c) j += src[j] === "\\" ? 2 : 1; o += c + c; i = j + 1; continue; }
    o += c; i++;
  }
  return o;
};
const ea = stripMq(read("ea/Yetimmm.mq5").replace(/^\uFEFF/, ""));
for (const [a, b, n] of [["{", "}", "braces"], ["(", ")", "parentheses"], ["[", "]", "brackets"]])
  ea.split(a).length === ea.split(b).length ? ok("EA " + n + " balanced") : fail("EA " + n + " unbalanced");
const ver = read("ea/Yetimmm.mq5").match(/#property version\s+"([\d.]+)"/);
ver ? ok("EA version " + ver[1]) : fail("EA version not found");

// 8) v4.6 policy lints — the audit findings must never come back silently
const eaSrc = read("ea/Yetimmm.mq5"), wk = read("worker/worker.js");
/input\s+ENUM_YT_BREACH\s+InpBreachPolicy\s*=\s*BREACH_WAIT\b/.test(eaSrc) ? ok("EA default after-SL policy is BREACH_WAIT (v2.23: pending pair re-armed, Market Reversal OFF)") : fail("EA InpBreachPolicy default is not BREACH_WAIT");
/input\s+ENUM_YT_ENTRY\s+InpEntryMode\s*=\s*ENTRY_PENDING\b/.test(eaSrc) ? ok("EA default entry mode is ENTRY_PENDING (real Buy Stop / Sell Stop)") : fail("EA InpEntryMode default is not ENTRY_PENDING");
/input\s+ENUM_YT_RISKPOL\s+InpRiskPolicy\s*=\s*YT_RISK_STRICT\b/.test(eaSrc) ? ok("EA default risk policy is STRICT (never exceeds the requested risk)") : fail("EA InpRiskPolicy default is not STRICT");
/input\s+bool\s+InpTgViaWorker\s*=\s*true/.test(eaSrc) && /input\s+bool\s+InpOrderCheck\s*=\s*true/.test(eaSrc) ? ok("EA defaults: notifications via Worker, OrderCheck ON") : fail("EA defaults InpTgViaWorker / InpOrderCheck must be true");
/price\s*\*\s*0\.001/.test(wk) ? fail("worker.js matches orders with a % of price (0.1%) tolerance") : ok("worker.js has no %-of-price order tolerance");
for (const need of ['\\"tick\\"', '\\"pt\\"', '\\"pid\\"', '\\"mt\\"']) eaSrc.includes(need) ? ok("EA state carries " + need.replace(/\\/g, "")) : fail("EA state is missing " + need.replace(/\\/g, ""));
/X-EA-Pair/.test(eaSrc) && /X-EA-Pair/.test(wk) ? ok("EA and Worker both implement pairing (X-EA-Pair)") : fail("pairing header missing on the EA or the Worker side");
const stW = Number((wk.match(/EA_STALE_SEC:\s*(\d+)/) || [])[1]), stA = Number((html.match(/staleSec:\s*(\d+)/) || [])[1]);
stW && stW === stA && /eaStaleSec/.test(html) && /eaStaleSec/.test(wk) ? ok("offline timeout: one source (server " + stW + " s, app fallback identical)") : fail("offline timeout differs between Worker (" + stW + ") and app (" + stA + ") or the app ignores eaStaleSec");
const eaVer = (eaSrc.match(/#property version\s+"([\d.]+)"/) || [])[1], defVer = (eaSrc.match(/#define\s+YT_VER\s+"([\d.]+)"/) || [])[1];
eaVer && eaVer === defVer ? ok("EA #property version == YT_VER (" + eaVer + ")") : fail("EA #property version " + eaVer + " != #define YT_VER " + defVer);
/"ver\\":\\""\s*\+\s*YT_VER/.test(eaSrc) && !/\\"ver\\":\\"[\d.]+\\"/.test(eaSrc) ? ok("EA reports YT_VER in its state (no hard-coded version string)") : fail("EA state still carries a hard-coded version");
!/v2\.18 loaded/.test(eaSrc) ? ok("EA OnInit prints the real version") : fail("EA OnInit still prints the old v2.18 message");
/^\s*ALLOWED_ORIGIN\s*=\s*"\*"/m.test(toml) ? fail("wrangler.toml opens CORS to *")
  : /^\s*ALLOWED_ORIGIN\s*=\s*"https:\/\/[^\/"]+"/m.test(toml) ? ok("CORS is restricted to your web app (ALLOWED_ORIGIN, domain only)")
  : fail("ALLOWED_ORIGIN is not set (or has a path / is not https) in wrangler.toml [vars] -> production gate");
/ALLOWED_ORIGIN:\s*"\*"/.test(wk) ? fail("worker.js CONFIG default opens CORS to *") : ok("worker.js CORS default is fail-closed");

// 9) v4.6.1 hardening lints
const pkgVer = JSON.parse(read("package.json")).version;
read("CHANGELOG.md").includes("## v" + pkgVer) ? ok("CHANGELOG has an entry for v" + pkgVer) : fail("CHANGELOG has no entry for package version " + pkgVer);
new RegExp("bridge v" + pkgVer.replace(/\./g, "\\.")).test(wk.slice(0, 80)) ? ok("worker.js header version = v" + pkgVer) : fail("worker.js header comment is not v" + pkgVer);
const csp = (html.match(/Content-Security-Policy"\s+content="([^"]+)"/) || [])[1] || "";
const apiHost = (html.match(/baseUrl:\s*"(https:\/\/[^"\/]+)/) || [])[1];
csp && apiHost && csp.includes("connect-src") && csp.split("connect-src")[1].split(";")[0].includes(apiHost) ? ok("index.html CSP allows connect-src only to the Worker (+ Telegram)") : fail("index.html CSP missing or connect-src does not list the Worker URL");
/object-src 'none'/.test(csp) && /base-uri 'none'/.test(csp) ? ok("CSP blocks <object> and <base> injection") : fail("CSP lacks object-src/base-uri 'none'");


// 10) v4.7 public / internal separation lints
/delete o\.cmds/.test(wk) ? ok("Worker removes the EA command log (cmds) from the public /state") : fail("Worker forwards cmds to the Mini App");
/weekWin\(a\.tzo\)/.test(wk) && /hx:/.test(wk) ? ok("public history = current week from the internal archive (hx:<week>)") : fail("weekly history / archive missing in the Worker");
/ctx\.storage\.delete\([^)]*hx/.test(wk) ? fail("Worker deletes archived trades") : ok("Worker never deletes archived trades");
const techOf = (src) => (src.match(/(?:TECH_RE|TECH)\s*=\s*(\/.*\/i)/) || [])[1];
techOf(wk) && techOf(wk) === techOf(html) ? ok("technical-text rule is identical in Worker and Mini App") : fail("technical-text rule differs between Worker and Mini App");
/function logRows\(\)\{[^]*?S\.cmds/.test(html.split("/* lifecycle of a command")[0]) ? fail("Mini App history reads the command log (S.cmds)") : ok("Mini App history shows trades only (no command log)");
/"newcycle"/.test(wk) && /newCycleUI/.test(html) ? ok("guarded cycle reset exists (Worker + Mini App)") : fail("guarded cycle reset missing");
/admin\/diag/.test(html) ? fail("Mini App references the admin diagnostics endpoint") : ok("Mini App never calls /admin/diag");

// 11) v4.8 — one version everywhere + audit regressions (Broker / Risk engine)
const pkgV = JSON.parse(read("package.json")).version, readme = read("README.md"), chg = read("CHANGELOG.md");
const wV = (wk.match(/VERSION\s*=\s*"([\d.]+)"/) || [])[1], wP = (wk.match(/EA_PROTOCOL\s*=\s*"([\d.]+)"/) || [])[1];
wV === pkgV ? ok("worker VERSION == package.json (" + pkgV + ")") : fail("worker VERSION " + wV + " != package.json " + pkgV);
wP && wP === eaVer ? ok("worker EA_PROTOCOL == EA version (" + wP + ")") : fail("worker EA_PROTOCOL " + wP + " != EA version " + eaVer);
new RegExp("^# Yetimmm v" + pkgV.replace(/\./g, "\\.")).test(readme) ? ok("README title = v" + pkgV) : fail("README title is not v" + pkgV);
chg.split("\n").find((l) => l.startsWith("## v")).includes("v" + pkgV) ? ok("CHANGELOG top entry = v" + pkgV) : fail("CHANGELOG top entry is not v" + pkgV);
const tests = (read("tests/worker.test.mjs").match(/^test\(/gm) || []).length;
new RegExp("(^|\\D)" + tests + "\\s+(اختبار|tests)").test(readme) ? ok("README test count matches (" + tests + " Worker tests)") : fail("README test count != " + tests);
const uiNoLive = html.replace(/\/\*RISK-CORE-BEGIN\*\/[\s\S]*?\/\*RISK-CORE-END\*\//, "");
!/\bconst\s+C\s*=\s*100\b|\bSTEP\s*=\s*\.01|\bVMIN\s*=|\bVMAX\s*=/.test(uiNoLive) ? ok("Mini App: no hard-coded contract / step / min / max (BrokerSpec or an explicit simulation profile)") : fail("Mini App still hard-codes C / STEP / VMIN / VMAX");
!/toFixed\(2\)/.test(uiNoLive.slice(uiNoLive.indexOf("function fillMkt"), uiNoLive.indexOf("function applyLevels"))) ? ok("Mini App: level filling is tick-aware (no toFixed(2))") : fail("Mini App fillMkt still uses toFixed(2)");
/S\.bs/.test(html) && /S\.rk/.test(html) ? ok("Mini App reads BrokerSpec (S.bs) and RiskResult (S.rk) from the EA") : fail("Mini App does not use S.bs / S.rk");
for (const need of ["OrderCheck(", "SYMBOL_VOLUME_LIMIT", "SYMBOL_EXPIRATION_MODE", "RiskCompute(", "BsJson()", "EvEmit(", "EvAckFrom(", "PairMinWidth()", "PAIR_NOT_EXECUTABLE", "WAITING_VOLUME", "InpCmdTtlSec", "InpTpResetNetOnly", "RecoveryGuardBlocks(", "InpMaxSeqLosses", "InpMaxRiskPctBal", "PrintRecoveryPlan("]) eaSrc.includes(need) ? ok("EA contains " + need) : fail("EA is missing " + need);
!/return\s*\(\s*from\s*!=\s*0\s*\)/.test(eaSrc) ? ok("EA: Telegram is no longer PUBLIC (TgAuthorized checks registered ids)") : fail("EA TgAuthorized is public again");
!/TgAddId\(chat\)/.test(eaSrc) ? ok("EA never auto-registers unknown Telegram users") : fail("EA auto-registers unknown Telegram users");
!/ORDER_TIME_GTC,0/.test(eaSrc) ? ok("EA: order expiration is chosen from SYMBOL_EXPIRATION_MODE (no fixed GTC)") : fail("EA sends a fixed ORDER_TIME_GTC");
!/MANUAL ACTION/.test(eaSrc.replace(/\/\/.*$/gm, "")) ? ok("EA: no fatal MANUAL ACTION state for solvable conditions") : fail("EA still contains a MANUAL ACTION fatal path");
const eaBraces = (s) => { const t = s.replace(/"(\\.|[^"\\])*"/g, '""').replace(/\/\/.*$/gm, ""); return [(t.match(/\{/g) || []).length, (t.match(/\}/g) || []).length, (t.match(/\(/g) || []).length, (t.match(/\)/g) || []).length]; };
const bb = eaBraces(eaSrc); bb[0] === bb[1] && bb[2] === bb[3] ? ok("EA braces/parentheses are balanced (this is NOT a compile)") : fail("EA braces/parentheses unbalanced " + bb.join("/"));

// 12) v4.11 — Telegram default keyboard is opt-in; /menu and every command stay; logo/robot hooks intact
/input\s+bool\s+InpTgMenu\s*=\s*false/.test(eaSrc) ? ok("EA: InpTgMenu exists and defaults to false (no default keyboard on bot messages)") : fail("EA InpTgMenu missing or not false");
/string\s+MenuMarkup\(\)\s*\{\s*return\s+InpTgMenu\s*\?\s*MenuKeyboard\(\)\s*:\s*""/.test(eaSrc) ? ok("EA: MenuMarkup() is gated by InpTgMenu") : fail("EA MenuMarkup() is not gated");
/cmd==\"\/menu\"[^\n]*MenuKeyboard\(\)/.test(eaSrc) ? ok("EA: /menu still shows the keyboard on demand") : fail("EA /menu no longer shows the keyboard");
for (const c of ["/start", "/stop", "/status", "/history", "/stats", "/settings", "/help"]) eaSrc.includes('cmd=="' + c + '"') ? ok("EA keeps command " + c) : fail("EA lost command " + c);
eaSrc.includes('"CMD:') || eaSrc.includes("CMD:") ? ok("EA keeps the callback handler for older keyboards") : fail("EA lost CMD: callback handling");
const animJs = read("anim/yt-anim.js"), animCss = read("anim/yt-anim.css");
for (const k of ['class="bulb"', 'class="eyes"', 'class="m m-s"', 'class="rg"', 'class="lb1"', 'class="lln"']) animJs.includes(k) ? ok("anim keeps hook " + k) : fail("anim lost hook " + k);
/prefers-reduced-motion/.test(animCss) ? ok("anim honours prefers-reduced-motion") : fail("anim ignores prefers-reduced-motion");

console.log(bad ? "\n" + bad + " problem(s)" : "\nAll checks passed");
console.log("\nNOTE: these checks verify STRUCTURE and known audit regressions only. They do NOT prove that the EA compiles (press F7 in MetaEditor)\nnor that the trading strategy is correct (run the Strategy Tester / a demo account). `npm test` covers the Worker, not the EA.");
process.exit(bad ? 1 : 0);

