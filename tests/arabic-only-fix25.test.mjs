// fix25: Arabic-only UI, no language switch, no bell / notification center. Static + behaviour tests (an MT5 run is not covered).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
const rd = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
const html = rd("index.html"), anim = rd("anim/yt-anim.js"), wk = rd("worker/worker.js"), nt = rd("worker/notify.js"), ea = rd("ea/Yetimmm.mq5");
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])[0];

test("language: no EN button, no language state / storage / phone-language detection - the system is deleted, not hidden", () => {
  assert.match(html, /<html lang="ar" dir="rtl"/);
  for (const re of [/id="lgB"/, /\bLG\b/, /setLang/, /phoneLang/, /lgManual\s*=/, /UI\.lg\b(?!Manual)(?!\s*\))/]) assert.doesNotMatch(html.replace(/delete UI\.lg;delete UI\.lgManual/, ""), re, String(re));
  assert.doesNotMatch(anim, /\bLG\b/);
  assert.doesNotMatch(html, /\.lgb\{[^}]*display:none/);   // the login box class .lgb is unrelated to the old button
});
test("language: every dictionary entry is a plain Arabic string (no [ar, en] pairs left) and t() works for all keys", () => {
  assert.doesNotMatch(script, /[A-Za-z_$][\w$]*\s*:\s*\[\s*"[^"]*[\u0600-\u06FF][^"]*"\s*,\s*"/);
  assert.doesNotMatch(script, /\bD\.\w+\s*=\s*\[/);
  const store = {}, ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  store.ytUI = JSON.stringify({ lg: 1, lgManual: 1, th: "light" });            // an English choice saved by an older release
  const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => "" : k === "length" ? 0 : k === "then" ? undefined : ["value", "textContent", "innerHTML", "className", "content"].includes(k) ? "" : k === "matches" ? () => false : k === "forEach" ? () => {} : k === "querySelectorAll" ? () => [] : mk()), set: () => true, apply: () => mk(), construct: () => mk() });
  const ctx = vm.createContext({ console, setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {}, localStorage: ls, sessionStorage: ls, document: mk(), window: mk(), navigator: { language: "en-US", languages: ["en-US"] }, location: { protocol: "https:", hostname: "x", search: "", hash: "", href: "https://x/" }, matchMedia: () => ({ matches: false, addEventListener() {} }), fetch: () => Promise.reject(new Error("offline")), Telegram: { WebApp: undefined }, Intl, Date, Math, JSON, URL, URLSearchParams, TextEncoder, TextDecoder, crypto: globalThis.crypto, requestAnimationFrame: () => 0, addEventListener() {}, CSS: { supports: () => true }, screen: {}, performance, WebSocket: function () {}, MutationObserver: function () { this.observe = () => {}; }, IntersectionObserver: function () { this.observe = () => {}; }, ResizeObserver: function () { this.observe = () => {}; }, Image: function () {}, AbortController, Promise, Set, Map, WeakMap, btoa, atob, encodeURIComponent, decodeURIComponent, escape, unescape });
  ctx.globalThis = ctx;
  vm.runInContext(script + "\n;globalThis.__D=D;globalThis.__t=t;globalThis.__UI=UI;", ctx);
  const keys = Object.keys(ctx.__D); assert.ok(keys.length > 350, "dictionary size");
  for (const k of keys) { assert.equal(typeof ctx.__D[k], "string", k); assert.ok(ctx.__D[k].length > 0, k); ctx.__t(k, 1, 2, 3, 4); }
  const noArabic = keys.filter((k) => !/[\u0600-\u06FF]/.test(ctx.__D[k]));
  assert.deepEqual(noArabic.sort(), ["oB", "oS", "r_SO"]);                      // technical terms: Buy Stop / Sell Stop / Stop Out
  assert.equal("lg" in ctx.__UI, false); assert.equal("lgManual" in ctx.__UI, false);
  assert.equal(JSON.parse(store.ytUI).lg, undefined); assert.equal(JSON.parse(store.ytUI).th, "light");   // old English choice erased, theme kept
});
test("language: the Telegram /start caption and the bot profile are Arabic only", () => {
  assert.doesNotMatch(wk, /language_code|TGW\.en|Smart risk-sequence/);
  assert.doesNotMatch(rd("scripts/setup-bot.mjs"), /Smart risk-sequence|\ben: \{/);
});
test("bell + notification center: no button, no badge, no per-order bell, no files, no CSS, no UI calls", () => {
  for (const re of [/id="ntB"/, /ntN|nbadge|i-bell|YTNotify|yt-notify|\/notify\/|order-alert|oalerts/]) assert.doesNotMatch(html, re, String(re));
  assert.equal(fs.existsSync(new URL("../notify", import.meta.url)), false);
  assert.match(html, /@media\(min-width:700px\)\{\.app\{max-width:760px\}\}/);          // the only generic rule the old stylesheet carried is kept
  assert.match(html, /id="thB"/);                                                      // theme button, brand, connection chip stay
});
test("bell + notification center: Worker has no routes, no Hub alert code, no stored-record readers; Telegram EA-event delivery stays", () => {
  for (const re of [/\/notify\//, /order-alert/, /oalert/, /loadOa|oaMine|watch\(|tolOf|uidOf|"\/auth"/]) assert.doesNotMatch(wk, re, String(re));
  assert.doesNotMatch(nt, /async notifs|async read\(|"\/notifs"|"\/read"/);
  assert.match(wk, /nt\.fetch\("https:\/\/n\/emit"/);          // EA events -> Telegram
  assert.match(nt, /sendMessage/); assert.match(nt, /async alarm\(\)/);
});
test("sync untouched: the EA file is byte-identical to fix24 and polls every 1 s; the Worker keeps the sync / ack / command routes", () => {
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(new URL("../ea/Yetimmm.mq5", import.meta.url))).digest("hex"), "c5b74be6c850dc5a93a86dff83fa1e66a06011064437ac62b3b0bfd2513fd8ba");
  assert.match(ea, /input int\s+InpBrPollSec\s*=\s*1;/);
  for (const re of [/"\/api\/ea\/sync"/, /async sync\(/, /async command\(/, /evack/, /async events\(/]) assert.match(wk, re, String(re));
});
