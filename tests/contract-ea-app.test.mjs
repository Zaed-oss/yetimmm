// CONTRACT between the EA (BsJson / RkJson) and the Mini App: every broker field the app READS is a field the EA PUBLISHES.
// A field that is read but never sent silently falls back to a guess (that is how a "$" or a lot step ends up wrong on one broker).
// The only fields the app may read without the EA sending them are the ones it guards with a fallback and that are listed in OPTIONAL below.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ea = readFileSync(join(root, "ea", "Yetimmm.mq5"), "utf8");
const html = readFileSync(join(root, "index.html"), "utf8");

// keys published by BsJson(): every  \"name\":  inside the function body
const i = ea.indexOf("string BsJson()");
const body = ea.slice(i, ea.indexOf("string RkJson()", i));
const published = new Set([...body.matchAll(/\\"([A-Za-z0-9_]+)\\":/g)].map((m) => m[1]));

// keys the app reads: bs.xxx / b.xxx / x.xxx on the spec object inside the risk core and the helpers that take it
const core = html.split("/*RISK-CORE-BEGIN*/")[1].split("/*RISK-CORE-END*/")[0];
const reads = new Set([...core.matchAll(/\bbs\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
for (const m of html.matchAll(/\bbs\.([A-Za-z0-9_]+)/g)) reads.add(m[1]);
for (const m of html.matchAll(/\b(?:x|b)\.(stops|point|spr|digits|vdig|ccy|contract|tick|vmin|vstep|vmax)\b/g)) reads.add(m[1]);

const OPTIONAL = new Set([]);   // nothing is optional: an older EA is handled by the "recompile" label, not by a missing field

test("EA publishes at least the fields of the broker specification", () => {
  for (const k of ["vmin", "vmax", "vstep", "vlimit", "vdig", "contract", "tick", "tvl", "point", "digits", "stops", "ccy", "spr", "plu", "cpl", "mpl", "capLot", "capPct", "capUsd", "capDay", "dayLoss", "bld"])
    assert.ok(published.has(k), "BsJson does not publish " + k);
});
test("every bs.<field> the app reads is published by the EA", () => {
  assert.ok(reads.size >= 12, "the scan found too few reads: " + [...reads]);
  const missing = [...reads].filter((k) => !published.has(k) && !OPTIONAL.has(k));
  assert.deepEqual(missing, [], "the app reads fields the EA never sends: " + missing.join(", "));
});
test("the simulation profiles carry the same field names as the live spec (so a profile cannot hide a missing field)", () => {
  const prof = html.match(/"XAU-100-0\.01":\{([^}]*)\}/)[1];
  const keys = [...prof.matchAll(/([A-Za-z0-9_]+):/g)].map((m) => m[1]);
  for (const k of keys) assert.ok(published.has(k), "profile field " + k + " is not in BsJson");
});
test("the Worker passes the whole bs / acct object through (numbers are never filtered)", () => {
  const w = readFileSync(join(root, "worker", "worker.js"), "utf8");
  assert.match(w, /for \(const k of \["bs", "acct"\]\) if \(o\[k\] && typeof o\[k\] === "object"\) \{ o\[k\] = \{ \.\.\.o\[k\] \}/);
});
