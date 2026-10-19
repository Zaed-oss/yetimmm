import test from "node:test"; import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEnv, cleanToken, diagnose } from "../scripts/diagnose.mjs";
const TOK = "8714000000:AAH_" + "x".repeat(32);
test("diagnose: quoted .env values are stripped (the 404 on getMe came from quotes in BOT_TOKEN)", () => {
  assert.equal(parseEnv(`BOT_TOKEN="${TOK}"\nX='a b'\nY=plain # c`).BOT_TOKEN, TOK);
  assert.equal(parseEnv("X='a b'").X, "a b"); assert.equal(parseEnv("Y=plain # c").Y, "plain");
  assert.equal(cleanToken(`"${TOK}"`), TOK); assert.equal(cleanToken(`'${TOK}' `), TOK);
});
const mk = (over = {}) => async (u) => {
  const body = u.endsWith("/getMe") ? { ok: true, result: { username: "b" } }
    : u.includes("getWebhookInfo") ? { ok: true, result: { url: "https://w.dev/tg/abc", pending_update_count: 0, ...over.wh } }
    : { ok: true, v: "4.31.0", ea_protocol: "2.45", pairConfigured: over.pair !== false };
  return { status: 200, json: async () => body };
};
const env = { BOT_TOKEN: `"${TOK}"`, WORKER_URL: "https://w.dev/" };
test("diagnose: healthy setup passes and never prints the token", async () => {
  const lines = []; const r = await diagnose({ env, fetchImpl: mk(), log: (l) => lines.push(l) });
  assert.ok(r.every((x) => x.ok)); assert.ok(!lines.join("\n").includes(TOK));
});
test("diagnose: pending updates / last_error / missing pairing are flagged", async () => {
  const r = await diagnose({ env, fetchImpl: mk({ wh: { pending_update_count: 3, last_error_message: "500" }, pair: false }), log() {} });
  assert.equal(r.filter((x) => !x.ok).length, 3);
});
test("diagnose: malformed token is reported without calling Telegram", async () => {
  let called = 0; const r = await diagnose({ env: { ...env, BOT_TOKEN: "bad" }, fetchImpl: async (u) => { if (u.includes("telegram")) called++; return mk()(u); }, log() {} });
  assert.equal(called, 0); assert.ok(r.some((x) => !x.ok && /malformed/.test(x.msg)));
});
test("setup writes unquoted .env and the shipped .env has no quotes", () => {
  assert.ok(!/`\$\{k\}="/.test(readFileSync(new URL("../scripts/setup.mjs", import.meta.url), "utf8")));
  assert.ok(!/^[A-Z_]+=["']/m.test(readFileSync(new URL("../.env", import.meta.url), "utf8")));
});
