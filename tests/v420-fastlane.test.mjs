// v4.20 / EA 2.32: fast lane. A light EA exchange (live tick + acks) between the full 1 s syncs, a price-only /px route for the app,
// the freshest tick wins in /state, and commands reach the EA through the light exchange. Worker side only: the EA is covered by v420-ea-static.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot } from "./harness.mjs";

const LOGIN = "123456";

async function setup() {
  const b = boot();
  const f = await b.sync(LOGIN, { state: { price: 2400.5, ask: 2400.7, run: true, state: "ARMED" } });
  assert.equal(f.s, 200);
  const s = await b.signIn(LOGIN);
  assert.equal(s.s, 200);
  const sess = s.j.sess;
  const lite = (px, extra = {}) => b.call("/api/ea/sync", { body: { login: LOGIN, srv: "Broker-Live", lite: true, px, ack: [], ...extra }, headers: { "X-EA-Secret": b.eas[LOGIN] } });
  const px = () => b.call("/px", { method: "GET", headers: b.auth(LOGIN, sess) });
  return { b, sess, lite, px };
}

test("a light exchange stores the live tick and the app sees it through /px", async () => {
  const { lite, px } = await setup();
  const r = await lite({ p: 2401.25, a: 2401.45 });
  assert.equal(r.s, 200);
  assert.equal(r.j.ok, true);
  const g = await px();
  assert.equal(g.s, 200);
  assert.equal(g.j.p, 2401.25);
  assert.equal(g.j.a, 2401.45);
  assert.equal(g.j.eaOnline, true);
});

test("/state returns the freshest tick (the light lane is newer than the last full snapshot)", async () => {
  const { b, sess, lite } = await setup();
  await new Promise((r) => setTimeout(r, 5));
  await lite({ p: 2405.1, a: 2405.3 });
  const s = await b.state(LOGIN, sess);
  assert.equal(s.j.price, 2405.1);
  assert.equal(s.j.ask, 2405.3);
});

test("a later full sync wins again over an older light tick", async () => {
  const { b, sess, lite, px } = await setup();
  await lite({ p: 2405.1, a: 2405.3 });
  await new Promise((r) => setTimeout(r, 5));
  await b.sync(LOGIN, { state: { price: 2410.0, ask: 2410.2, run: true, state: "ARMED" } });
  const g = await px();
  assert.equal(g.j.p, 2410.0);
  const s = await b.state(LOGIN, sess);
  assert.equal(s.j.price, 2410.0);
});

test("a light exchange never writes the EA state, history or config and answers fast=true while an app is looking", async () => {
  const { b, lite, px } = await setup();
  const before = b.hubOf(LOGIN).st;
  await px();                                         // the app is open
  const r = await lite({ p: 2500, a: 2500.2 });
  assert.equal(r.j.fast, true);
  assert.equal(r.j.cfg, undefined, "no Telegram config push on the light lane");
  assert.equal(b.hubOf(LOGIN).st, before, "the full snapshot object is untouched");
});

test("with no app open the EA is told fast=false (no extra load while nobody watches)", async () => {
  const { lite } = await setup();
  const r = await lite({ p: 2400.6, a: 2400.8 });
  assert.equal(r.j.fast, false);
});

test("a command queued by the app is delivered by the light exchange and removed once acked", async () => {
  const { b, sess, lite } = await setup();
  const c = await b.call("/command", { body: { cmd: "stop" }, headers: b.auth(LOGIN, sess) });
  assert.equal(c.s, 200);
  const r = await lite({ p: 2400.6, a: 2400.8 });
  assert.equal(r.j.commands.length, 1);
  assert.equal(r.j.commands[0].cmd, "stop");
  const r2 = await lite({ p: 2400.6, a: 2400.8 }, { ack: [c.j.id] });
  assert.equal(r2.j.commands.length, 0);
});

test("light exchange: wrong secret refused, nonsense prices ignored, no price from a stranger", async () => {
  const { b, lite, px } = await setup();
  const bad = await b.call("/api/ea/sync", { body: { login: LOGIN, lite: true, px: { p: 1, a: 1 } }, headers: { "X-EA-Secret": "z".repeat(32) } });
  assert.equal(bad.s, 401);
  await lite({ p: -5, a: "x" });
  await lite({ p: 1e12, a: 1 });
  const g = await px();
  assert.equal(g.j.p, 2400.5, "invalid ticks leave the last good price");
});

test("/px: needs a valid session, GET only", async () => {
  const { b } = await setup();
  const noSess = await b.call("/px", { method: "GET", headers: { "X-Login": LOGIN, "X-Session": "nope" } });
  assert.equal(noSess.s, 401);
  const post = await b.call("/px", { method: "POST", body: {}, headers: { "X-Login": LOGIN, "X-Session": "nope" } });
  assert.equal(post.s, 405);
});
