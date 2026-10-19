// v4.28.0 - the documented test counts are checked against the REAL run of the suite (never against a number typed in this file).
//   npm run check              runs the suite, compares every documented number, fails on any mismatch
//   npm run check -- --write-docs   rewrites the numbers of the living documents from the real run (then re-checks)
// Node's TAP summary ("# tests / # pass / # fail / # skipped") of each test file is the only source of the numbers.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const WORKER_FILE = "worker.test.mjs";                       // README splits the suite into the Worker file and the engine files
export const LIVING_DOCS = ["README.md", "TERMINAL.md", "docs/MT5-TESTING.md", "docs/CURRENT_BEHAVIOR.md"];
const readIf = (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return null; } };

export function parseTap(out) {
  const g = (k) => Number((out.match(new RegExp("^# " + k + " (\\d+)", "m")) || [])[1] ?? NaN);
  return { tests: g("tests"), pass: g("pass"), fail: g("fail"), skipped: g("skipped"), cancelled: g("cancelled"), todo: g("todo") };
}

// runs every tests/*.test.mjs in its own process and returns the real numbers
export function runSuite() {
  const files = readdirSync(join(root, "tests")).filter((f) => f.endsWith(".test.mjs")).sort();
  const per = {};
  for (const f of files) {
    const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", join(root, "tests", f)], { encoding: "utf8", env: { ...process.env, YT_TEST_COUNT_RUN: "1" } });
    per[f] = { ...parseTap(r.stdout || ""), exit: r.status };
  }
  return summarize(per);
}

export function summarize(per) {
  const sum = (pick) => Object.entries(per).filter(([f]) => pick(f)).reduce((a, [, v]) => ({ tests: a.tests + v.tests, pass: a.pass + v.pass, fail: a.fail + v.fail, skipped: a.skipped + v.skipped }), { tests: 0, pass: 0, fail: 0, skipped: 0 });
  const all = sum(() => true), worker = sum((f) => f === WORKER_FILE), engine = sum((f) => f !== WORKER_FILE);
  const broken = Object.entries(per).filter(([, v]) => Number.isNaN(v.tests) || v.exit !== 0 && v.exit !== undefined && v.fail === 0).map(([f]) => f);
  return { per, all, worker, engine, broken };
}

// every "<N> اختباراً|اختبار|tests" is a claim about the whole suite or the Worker file; every "<N> لمحرك" a claim about the engine files
export function documentedClaims(text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/(\d+)\s*(اختباراً|اختبارا|اختبار|tests?\b|لمحرك)/g)) out.push({ n: Number(m[1]), kind: m[2] === "لمحرك" ? "engine" : "suite", line: i + 1, text: line.trim().slice(0, 100) });
  });
  return out;
}

// `docs` = { path: text }. A claim passes when it equals the real total, the real Worker count (suite claims) or the real engine count (engine claims).
export function findMismatches(docs, counts) {
  const bad = [];
  for (const [path, text] of Object.entries(docs)) {
    if (text == null) continue;
    for (const c of documentedClaims(text)) {
      const okSet = c.kind === "engine" ? [counts.engine.tests] : [counts.all.tests, counts.worker.tests];
      if (!okSet.includes(c.n)) bad.push({ path, ...c, expected: okSet.join(" or ") });
    }
  }
  return bad;
}

// the first CHANGELOG entry may state results: "<N> ناجح" / "<N> pass" must equal the real total or the real pass count
export function changelogClaims(changelog, counts) {
  const first = changelog.split(/^## v/m)[1] || "";
  const bad = [];
  for (const m of first.matchAll(/(\d+)\s*(?:ناجح|pass(?:ed)?\b)/g)) if (![counts.all.pass, counts.all.tests].includes(Number(m[1]))) bad.push({ path: "CHANGELOG.md (top entry)", n: Number(m[1]), expected: counts.all.pass });
  return bad;
}

export function loadLivingDocs() { return Object.fromEntries(LIVING_DOCS.map((p) => [p, readIf(p)])); }

// --write-docs: replaces each wrong number with the real one (suite claims -> total, "لمحرك" claims -> engine; a claim equal to the Worker count is left alone)
export function rewriteDocs(counts) {
  const changed = [];
  for (const p of LIVING_DOCS) {
    const t = readIf(p); if (t == null) continue;
    const next = t.replace(/(\d+)(\s*)(اختباراً|اختبارا|اختبار|tests?\b|لمحرك)/g, (m, n, sp, w) => {
      const num = Number(n);
      if (w === "لمحرك") return num === counts.engine.tests ? m : counts.engine.tests + sp + w;
      if (num === counts.all.tests || num === counts.worker.tests) return m;
      return counts.all.tests + sp + w;
    });
    if (next !== t) { writeFileSync(join(root, p), next); changed.push(p); }
  }
  return changed;
}
