// v4.28.0: the documentation can never again disagree with the real suite (README said 163 while the run said 231).
// These tests check the CHECKER (scripts/test-count.mjs) with synthetic numbers; the real run is done by `npm run check`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parseTap, documentedClaims, findMismatches, changelogClaims, summarize, WORKER_FILE, LIVING_DOCS } from "../scripts/test-count.mjs";

const counts = summarize({
  "worker.test.mjs": { tests: 49, pass: 49, fail: 0, skipped: 0, exit: 0 },
  "a.test.mjs": { tests: 100, pass: 100, fail: 0, skipped: 0, exit: 0 },
  "b.test.mjs": { tests: 82, pass: 82, fail: 0, skipped: 0, exit: 0 },
});

test("TAP summary of a node:test run is parsed (tests / pass / fail / skipped)", () => {
  assert.deepEqual(parseTap("# tests 231\n# suites 0\n# pass 230\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n"), { tests: 231, pass: 230, fail: 1, skipped: 0, cancelled: 0, todo: 0 });
  assert.ok(Number.isNaN(parseTap("garbage").tests), "an unreadable run is NaN, never a silent zero");
});
test("the Worker file and the engine files are counted apart and add up to the total", () => {
  assert.deepEqual([counts.worker.tests, counts.engine.tests, counts.all.tests], [49, 182, 231]);
});
test("the report's contradiction is detected: a stale '163 اختباراً' fails while the real total is 231", () => {
  const docs = { "README.md": "tests/ اختبارات: 49 اختباراً للـ Worker + 182 لمحرك المخاطرة\nnpm test # 163 اختباراً (دخول)" };
  const bad = findMismatches(docs, counts);
  assert.equal(bad.length, 1); assert.equal(bad[0].n, 163); assert.equal(bad[0].line, 2);
  assert.equal(findMismatches({ "README.md": "npm test # 231 اختباراً\n49 اختباراً للـ Worker + 182 لمحرك" }, counts).length, 0);
});
test("a wrong engine count and a wrong English count are detected too; a count of 0 failing files is not hidden", () => {
  assert.equal(findMismatches({ "x.md": "181 لمحرك" }, counts).length, 1);
  assert.equal(findMismatches({ "x.md": "230 tests" }, counts).length, 1);
  assert.equal(documentedClaims("nothing here").length, 0);
  assert.deepEqual(summarize({ "a.test.mjs": { tests: NaN, pass: NaN, fail: NaN, skipped: NaN, exit: 1 } }).broken, ["a.test.mjs"]);
});
test("the first CHANGELOG entry may only quote the real result", () => {
  const ok = "# x\n## v4.28.0 - t\n- result: 231 ناجح / 0 فاشل\n## v4.27.0\n- 163 pass";
  assert.equal(changelogClaims(ok, counts).length, 0);
  assert.equal(changelogClaims(ok.replace("231 ناجح", "163 ناجح"), counts).length, 1);
});
test("the checker has no number typed in it: nothing but the run feeds the expectation", () => {
  const src = readFileSync(new URL("../scripts/test-count.mjs", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
  assert.ok(!/\b(163|231|226|203|177)\b/.test(src));
  assert.ok(readdirSync(new URL("../tests/", import.meta.url)).includes(WORKER_FILE));
  assert.ok(LIVING_DOCS.includes("README.md"));
});
