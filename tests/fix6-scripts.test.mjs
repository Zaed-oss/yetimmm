// v4.31.0-fix6: regression guards for the deploy / setup-bot / git / TERMINAL fixes (static: no network, no Cloudflare)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rd = (f) => readFileSync(join(root, f), "utf8");

test("deploy: APP_PASSWORD is required only when no OWNER_TG exists", () => {
  const s = rd("scripts/deploy.mjs");
  assert.match(s, /hasOwner/);
  assert.match(s, /\["BOT_TOKEN", "PAIR_CODE", \.\.\.\(hasOwner \? \[\] : \["APP_PASSWORD"\]\)\]/);
  assert.doesNotMatch(s, /\["BOT_TOKEN", "APP_PASSWORD", "PAIR_CODE"\]\.filter/);
});

test("setup-bot: reads getMyName before setMyName and treats 429 as a warning", () => {
  const s = rd("scripts/setup-bot.mjs");
  assert.ok(s.indexOf('"getMyName"') > 0 && s.indexOf('"getMyName"') < s.indexOf('api("setMyName"'));
  assert.match(s, /error_code === 429/);
  assert.match(s, /limited \? "WARN "/);
});

test(".gitattributes enforces LF", () => {
  assert.ok(existsSync(join(root, ".gitattributes")));
  assert.match(rd(".gitattributes"), /^\* text=auto eol=lf$/m);
});

test("setup checks GitHub push credentials before committing; repo-update.ps1 exists", () => {
  const s = rd("scripts/setup.mjs");
  assert.ok(s.indexOf('"push", "--dry-run"') > 0 && s.indexOf('"push", "--dry-run"') < s.indexOf('"commit"'));
  assert.match(s, /gh auth login/);
  assert.ok(existsSync(join(root, "tools/repo-update.ps1")));
});

test("TERMINAL.md holds no Telegram id; local values file is git-ignored", () => {
  const t = rd("TERMINAL.md");
  assert.doesNotMatch(t, /\b\d{8,12}\b/);
  assert.match(rd(".gitignore"), /^TERMINAL\.local\.md$/m);
  assert.match(rd("scripts/check.mjs"), /OWNER_TG value found in tracked file/);
});
