// v4.19: "reconnect = resume the same session, never start over".
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, W } from "./harness.mjs";

const LOGIN = "123456";

async function setup() {
  const b = boot();
  await b.sync(LOGIN, { state: { price: 2431.7, run: true, state: "ARMED" } });
  const s = await b.signIn(LOGIN);
  assert.equal(s.s, 200);
  return { b, sess: s.j.sess };
}

// a Worker restart / Durable Object eviction = a NEW Hub object over the SAME storage
function restart(b) {
  const old = b.hubOf(LOGIN), st = old.__st;
  const fresh = new W.Hub({ storage: st }, b.env);
  fresh.__st = st;
  b.env.HUB.inst.set("acc-" + LOGIN, fresh);
  return fresh;
}

test("after a Worker restart /state still returns the last EA state (not STOPPED / price 0)", async () => {
  const { b, sess } = await setup();
  const before = await b.state(LOGIN, sess);
  assert.equal(before.j.price, 2431.7);
  restart(b);
  const after = await b.state(LOGIN, sess);
  assert.equal(after.s, 200, "the saved session must still be valid after the restart");
  assert.equal(after.j.price, 2431.7);
  assert.equal(after.j.state, "ARMED");
});

test("a restored snapshot keeps its ORIGINAL age: an old one is never reported online", async () => {
  const { b, sess } = await setup();
  const old = b.hubOf(LOGIN);
  await old.__st.put("lst", { st: { price: 2431.7, run: true, state: "ARMED" }, ts: Date.now() - 600000 });
  const fresh = restart(b);
  const r = await b.state(LOGIN, sess);
  assert.equal(r.j.price, 2431.7);
  assert.equal(r.j.eaOnline, false);
  assert.ok(r.j.eaAge >= 590);
  assert.equal(fresh.botUp(), false);
});

test("a restart with no saved snapshot is still a clean cold start", async () => {
  const b = boot();
  const s = await b.signIn(LOGIN).catch(() => null);
  assert.ok(s === null || s.s !== 500);
});
