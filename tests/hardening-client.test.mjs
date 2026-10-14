// v4.18 second-pass audit: client-side guards (source-level checks on the real files).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const rd = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const app = rd("app.js"), news = rd("news/yt-news.js"), page = rd("index.html");

test("postMessage commands are dead in LIVE mode and need an allow-listed origin otherwise", () => {
  assert.match(app, /if\(CONFIG\.mode==="live"\|\|!CONFIG\.origins\.includes\(e\.origin\)/);
});
test("the app refuses to run inside a frame that is not Telegram (anti-clickjacking)", () => {
  assert.match(app.slice(0, 900), /location\.ancestorOrigins/);
  assert.match(app.slice(0, 900), /telegram\\\.org\|t\\\.me/);
});
test("no referrer is sent and the CSP has no inline-script / eval allowance", () => {
  assert.match(page, /<meta name="referrer" content="no-referrer">/);
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(page)[1];
  assert.ok(!/script-src[^;]*unsafe-/.test(csp));
});
test("news UI: impact class is whitelisted, ids and statuses are escaped", () => {
  assert.match(news, /i=\["low","medium","high","holiday"\]\.includes\(i\)\?i:"low"/);
  assert.ok(!/\$\{e\.id\}/.test(news) && !/\$\{x\.status\}/.test(news));
});
test("the new login errors have texts in both languages", () => {
  for (const k of ["e_tg_stale", "e_too_many_sessions"]) assert.match(app, new RegExp(k + ':\\["[^"]+","[^"]+"\\]'));
});
