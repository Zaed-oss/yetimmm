// FIX19: broker gold symbol names (GOLDm#, GOLD, XAUUSD.pro ...). Reference model of YtClassifySymbol + structural checks of the EA source.
// It does NOT run MQL5: compile (F7), then verify with the "Symbol check | ..." line in the Experts tab on a Demo account.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ea = readFileSync(join(root, "ea", "Yetimmm.mq5"), "utf8");
const news = readFileSync(join(root, "news", "yt-news.js"), "utf8");

// mirrors YtNorm / YtClassifySymbol (calc: "stocks" = SYMBOL_CALC_MODE_EXCH_STOCKS[_MOEX])
const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
function classify({ name, base = "", path = "", desc = "", calc = "cfd" }) {
  const b = norm(base), p = norm(path), d = norm(desc), nm = norm(name);
  if (calc === "stocks") return { ok: false, score: 0 };
  if (b === "XAG" || nm.startsWith("XAG") || nm.startsWith("SILVER")) return { ok: false, score: 0 };
  if (nm.startsWith("GOLDMAN")) return { ok: false, score: 0 };
  let score = 0;
  if (b === "XAU") score += 3;
  if (nm.includes("XAUUSD")) score += 3;
  if (nm.startsWith("XAU") || nm.startsWith("GOLD")) score += 2;
  if (p.includes("GOLD") || p.includes("METAL")) score += 1;
  if (d.includes("GOLD")) score += 1;
  return { ok: score >= 3, score };
}

test("the reported case: XM GOLDm# is accepted (it used to fail with code 1)", () => {
  assert.equal(classify({ name: "GOLDm#", base: "XAU", path: "Metals\\GOLDm#", desc: "Gold Micro" }).ok, true);
  assert.equal(classify({ name: "GOLDm#", desc: "Gold vs US Dollar" }).ok, true);       // even with an empty base currency
});

test("common gold names from other brokers are accepted", () => {
  for (const name of ["XAUUSD", "xauusd", "XAUUSDm", "XAUUSD#", "XAUUSD.pro", "XAUUSD.c", "XAU/USD", "GOLD", "GOLD#", "GOLD.a"])
    assert.equal(classify({ name, base: "XAU", desc: "Gold" }).ok, true, name);
  for (const name of ["XAUUSD", "XAUUSDm", "XAUUSD.pro", "XAUUSD#"])                    // the old rule is never lost, whatever the broker fields say
    assert.equal(classify({ name }).ok, true, name + " (no broker data)");
});

test("non-gold symbols are rejected", () => {
  assert.equal(classify({ name: "EURUSD", base: "EUR" }).ok, false);
  assert.equal(classify({ name: "US30" }).ok, false);
  assert.equal(classify({ name: "BTCUSD", base: "BTC" }).ok, false);
  assert.equal(classify({ name: "XAGUSD", base: "XAG", desc: "Silver" }).ok, false);
  assert.equal(classify({ name: "SILVER", base: "XAG" }).ok, false);
  assert.equal(classify({ name: "GOLD", calc: "stocks", desc: "Gold Fields Ltd" }).ok, false);   // a share called GOLD
  assert.equal(classify({ name: "GOLDMAN", desc: "Goldman Sachs" }).ok, false);
});

test("the name alone is never enough unless it contains XAUUSD", () => {
  assert.equal(classify({ name: "GOLDX" }).ok, false);                                    // score 2: needs base / path / description to agree
  assert.equal(classify({ name: "GOLDX", path: "Commodities\\Metals" }).ok, true);
});

test("EA: ONE classifier, used by both OnInit and DoStart; the old literal checks are gone", () => {
  assert.match(ea, /SSymClass\s+YtClassifySymbol\(const string sym\)/);
  assert.equal(/StringFind\(g_sym,"XAUUSD"\)<0\) return/.test(ea), false, "DoStart must not test the raw name any more");
  assert.equal(/Yetimmm works on XAUUSD only/.test(ea), false, "the generic refusal text is gone");
  const onInit = ea.slice(ea.indexOf("int OnInit()"));
  assert.match(onInit.slice(0, 2500), /YtClassifySymbol\(g_sym\)/);
  const doStart = ea.slice(ea.indexOf("string DoStart("));
  assert.match(doStart.slice(0, 1500), /InpSymbolPolicy!=YT_SYM_ANY && !g_symOk/);
});

test("EA: policy input defaults to AUTO and offers STRICT_GOLD (old behaviour) and ANY", () => {
  assert.match(ea, /enum ENUM_YT_SYMPOL[\s\S]*YT_SYM_AUTO=0[\s\S]*YT_SYM_GOLD_STRICT=1[\s\S]*YT_SYM_ANY=2/);
  assert.match(ea, /input ENUM_YT_SYMPOL InpSymbolPolicy = YT_SYM_AUTO;/);
});

test("EA: every decision is logged with its reason, and the refusal reaches the Experts log", () => {
  assert.match(ea, /YLog\("Symbol check \| "\+g_sym\+/);
  assert.match(ea, /YLog\("INIT REFUSED: "\+sm\)/);
});

test("EA: hard rejections are in the classifier (stocks, silver, GOLDMAN)", () => {
  const fn = ea.slice(ea.indexOf("SSymClass YtClassifySymbol"), ea.indexOf("double YtSymHash"));
  for (const k of ["SYMBOL_CALC_MODE_EXCH_STOCKS", "\"XAG\"", "SILVER", "GOLDMAN", "SYMBOL_CURRENCY_BASE", "SYMBOL_PATH", "SYMBOL_DESCRIPTION"]) assert.ok(fn.includes(k), k);
});

test("EA: a changed symbol name with an open cycle is reported (state is keyed by Magic only)", () => {
  assert.match(ea, /GV\("SYMH",0\.0\)/);
  assert.match(ea, /RaiseAlert\("SYMCHG",g_symChgMsg,false,true\)/);
});

test("EA -> Worker: the heartbeat carries bccy and cls next to pccy", () => {
  assert.match(ea, /\\"bccy\\":\\""\+JEsc\(SymbolInfoString\(g_sym,SYMBOL_CURRENCY_BASE\)\)/);
  assert.match(ea, /\\"cls\\":\\""\+g_symClass/);
});

test("Mini App news: a broker gold name still gets the USD tag (symCur)", () => {
  const src = news.match(/const symCur=\(\)=>\{[^\n]*\};/)[0];
  const FLG = { USD: 1, EUR: 1, GBP: 1, JPY: 1 };
  const run = (sym) => new Function("S", "FLG", src + "; return symCur();")({ sym }, FLG);
  assert.deepEqual(run("GOLDm#"), ["USD"]);
  assert.deepEqual(run("XAUUSD"), ["USD"]);
  assert.deepEqual(run("GOLD"), ["USD"]);
  assert.deepEqual(run("EURUSD"), ["EUR", "USD"]);
});
