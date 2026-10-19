// v4.24.0 (EA 2.38): CYCLE LEDGER acceptance tests (the "Stop-and-Reverse package" report, sections 1, 3 and 5).
//  (a) a reference model transcribed 1:1 from ea/Yetimmm.mq5 (CycleBook, CycleMet, CycleTryComplete, CycleFinishLedger, CycleCompletionTick,
//      NextRiskForNet, the CycleId ownership guard of ProcessClosedPosition, DoStart from WAITING_USER);
//  (b) structural checks of the REAL EA source that prove there is ONE completion rule used by every closing path.
// HONEST LIMIT: MQL5 is not executed here (no MetaEditor / terminal / broker data). F7, Strategy Tester and Demo are still mandatory.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const raw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "ea", "Yetimmm.mq5"), "utf8");
const strip = (t) => { let o = "", i = 0; const n = t.length;
  while (i < n) { const c = t[i], d = t[i + 1];
    if (c === "/" && d === "/") { while (i < n && t[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i += 2; while (i < n && !(t[i] === "*" && t[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"' || c === "'") { const q = c; o += q; i++; while (i < n && t[i] !== q) { o += t[i]; if (t[i] === "\\") { i++; o += t[i]; } i++; } o += q; i++; continue; }
    o += c; i++; }
  return o; };
const code = strip(raw);                                   // comments removed: assertions below cannot be satisfied by a comment
const fnBody = (sig) => {
  const i = code.indexOf(sig); assert.ok(i > 0, sig + " not found");
  const o = code.indexOf("{", i); let d = 0, k = o, inS = false;
  for (; k < code.length; k++) {
    const c = code[k];
    if (c === '"' && code[k - 1] !== "\\") inS = !inS;
    if (inS) continue;
    if (c === "{") d++; else if (c === "}") { d--; if (d === 0) break; }
  }
  return code.slice(i, k + 1);
};
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} !~ ${b}`);

// ---------------------------------------------------------------- reference model ----
const TARGET = 20, RR = 20, INIT = 1, EPS = 1e-6;
const nextRiskNet = (net) => { if (Math.abs(net) <= 1e-9) return INIT; const rem = TARGET - net; if (rem <= 1e-9) return INIT; let r = rem / RR; if (net > 0 && r < INIT) r = INIT; return r; };
const met = (cycNet) => cycNet >= TARGET - EPS;                                        // CycleMet: strict

function bot({ netting = false, countManual = true } = {}) {
  const st = { id: 1, net: 0, losses: 0, trades: 0, cyc: "IDLE", acc: 0, seq: 0, cur: INIT, state: "IDLE", lastDeal: 0, logged: new Set(),
               pending: 0, positions: new Map(), records: [], alerts: [], orders: [] };
  const api = {
    st,
    persist() { return JSON.parse(JSON.stringify({ ...st, logged: [...st.logged], positions: [...st.positions] })); },
    static: (j) => { const b = bot({ netting, countManual }); Object.assign(b.st, j, { logged: new Set(j.logged), positions: new Map(j.positions) }); return b; },
    book(net) {                                                                         // CycleBook
      st.net = Number((st.net + net).toFixed(8)); st.trades++; if (net < 0) st.losses += -net;
      st.acc = st.net < 0 ? -st.net : 0; st.cur = nextRiskNet(st.net); if (st.cyc !== "COMPLETING") st.cyc = "ACTIVE";
    },
    finishLedger(record) {                                                              // CycleFinishLedger
      if (record && !st.records.some((r) => r.id === st.id)) st.records.push({ id: st.id, net: st.net, losses: st.losses, trades: st.trades, seq: st.seq, met: true });
      st.acc = 0; st.seq = 0; st.cur = INIT; st.net = 0; st.losses = 0; st.trades = 0; st.id++; st.cyc = "IDLE";    // ResetRisk: NEW id, empty ledger
      st.state = "TP_RESET"; st.cyc = "COMPLETING";
    },
    tryComplete(dealOut, { cancelFails = false } = {}) {                                // CycleTryComplete
      if (st.cyc === "COMPLETING") return false;
      if (!met(st.net)) return false;
      if (st.positions.size > 0) return false;                                          // a position of the cycle is still open
      st.cyc = "COMPLETING"; if (dealOut) st.lastDeal = dealOut; api.snap = api.persist();     // SaveState
      api.finishLedger(true);
      if (!cancelFails) st.orders = [];                                                 // CleanupOrders
      if (st.orders.length === 0) st.cyc = "WAITING_USER";
      return true;
    },
    tick({ cancelFails = false } = {}) {                                                // CycleCompletionTick
      if (st.cyc !== "COMPLETING") return;
      if (st.trades > 0 && met(st.net)) api.finishLedger(true);                                          // crashed before the ledger was zeroed
      if (st.orders.length > 0) { if (!cancelFails) st.orders = []; if (st.orders.length) return; }
      st.cyc = "WAITING_USER";
    },
    open(pid) { st.positions.set(pid, { cy: st.id }); st.cyc = "ACTIVE"; st.state = "ACTIVE"; },      // PSet(pid,"CY",g_cycId)
    close(pid, deal, reason, net, { tainted = false, stale = false } = {}) {            // ProcessClosedPosition (booking part)
      const pos = st.positions.get(pid);
      if (st.logged.has(deal)) return "DUP";                                            // IsLoggedDeal / IsLoggedPos
      st.logged.add(deal); st.positions.delete(pid);
      if (tainted && netting) return "TAINTED";                                         // Netting-mixed position: never booked
      if (pos && pos.cy !== st.id) { st.alerts.push("OLDCYC"); return "ORPHAN"; }       // CycleId ownership guard
      if (reason !== "SL" && reason !== "TP" && !countManual) return "IGNORED";
      api.book(net); if (reason === "SL") st.seq++;
      st.lastDeal = deal;
      const done = api.tryComplete(deal);
      return done ? "COMPLETE" : "BOOKED";
    },
    start() {                                                                           // DoStart from WAITING_USER
      if (st.cyc === "COMPLETING") return "BUSY";
      if (st.state === "TP_RESET" || st.state === "IDLE") { st.state = "ARMED"; if (st.cyc !== "COMPLETING") st.cyc = "ACTIVE"; return "ARMED"; }
      return "ALREADY";
    },
  };
  return api;
}
const run = (seq) => { const b = bot(); let i = 0; for (const [r, n] of seq) { b.open(++i); b.close(i, 1000 + i, r, n); } return b; };

// ---------------------------------------------------------------- report section 5: acceptance cases ----
test("5.1 cycle without losses: net +20 ends the cycle and the bot WAITS for the user", () => {
  const b = run([["TP", 20]]);
  assert.equal(b.st.records.length, 1); near(b.st.records[0].net, 20);
  assert.equal(b.st.cyc, "WAITING_USER"); assert.equal(b.st.state, "TP_RESET");
  assert.equal(b.st.net, 0); assert.equal(b.st.id, 2);
});
test("5.2 losses 10+20+30 then a profit of 65: cycle net +5, NOT complete, remaining +15", () => {
  const b = run([["SL", -10], ["SL", -20], ["SL", -30], ["TP", 65]]);
  near(b.st.net, 5); assert.equal(b.st.records.length, 0); assert.equal(b.st.cyc, "ACTIVE");
  near(TARGET - b.st.net, 15); assert.equal(b.st.acc, 0); assert.equal(b.st.id, 1);
});
test("5.3 losses 10+20+30 then a profit of 80: net +20, completes exactly once", () => {
  const b = run([["SL", -10], ["SL", -20], ["SL", -30], ["TP", 80]]);
  assert.equal(b.st.records.length, 1); near(b.st.records[0].net, 20); near(b.st.records[0].losses, 60); assert.equal(b.st.cyc, "WAITING_USER");
});
test("5.4 profit 19.99 does NOT complete (strict 20.00, no 98% tolerance); 20.00 does", () => {
  assert.equal(run([["TP", 19.99]]).st.records.length, 0);
  assert.equal(run([["TP", 19.9]]).st.records.length, 0);               // the OLD rule (98% = 19.6) would have ended these
  assert.equal(run([["TP", 19.7]]).st.records.length, 0);
  assert.equal(run([["TP", 20.0]]).st.records.length, 1);
  assert.equal(run([["TP", 20.00000001]]).st.records.length, 1);
  assert.equal(met(19.99999), false); assert.equal(met(20 - 1e-9), true);   // only floating point noise is tolerated
});
test("5.5 a TP that does not cover the whole loss updates the cycle net and the cycle continues: no reset", () => {
  const b = run([["SL", -12.22], ["TP", 5]]);
  near(b.st.net, -7.22); near(b.st.acc, 7.22); assert.equal(b.st.records.length, 0); assert.equal(b.st.id, 1); assert.equal(b.st.cyc, "ACTIVE");
  near(b.st.cur, (7.22 + 20) / 20);
});
test("5.5b OLD BUG: net 65 against losses 60 used to reset the sequence (cycle net only +5); now it does not", () => {
  const b = run([["SL", -60], ["TP", 65]]);
  assert.equal(b.st.records.length, 0); near(b.st.net, 5); near(b.st.cur, 1);             // risk back to the plan: remaining 15 -> floor at the initial risk
});
test("5.6 several profits after the stops: completion depends on the SUM of the cycle, not on the last trade", () => {
  const b = run([["SL", -30], ["TP", 12], ["SL", -4], ["TP", 25]]);   // -30+12-4+25 = +3  -> not complete
  near(b.st.net, 3); assert.equal(b.st.records.length, 0);
  b.open(50); b.close(50, 2050, "TP", 17.5);                           // +20.5
  assert.equal(b.st.records.length, 1); near(b.st.records[0].net, 20.5);
  const c = run([["SL", -30], ["TP", 60]]);                           // the LAST trade alone (60) is far above 20, the cycle net (30) too: complete
  assert.equal(c.st.records.length, 1);
  const d = run([["SL", -50], ["TP", 60]]);                           // last trade 60 >> 20 but cycle net only +10: NOT complete
  assert.equal(d.st.records.length, 0); near(d.st.net, 10);
});
test("5.7 a big loss of the ACCOUNT (not booked by the EA) changes neither the cycle ledger nor the next risk", () => {
  const b = run([["SL", -1]]);
  const before = JSON.stringify([b.st.net, b.st.acc, b.st.cur]);
  // the account loses 500 elsewhere: no deal of this EA is processed, so nothing can reach the ledger
  assert.equal(JSON.stringify([b.st.net, b.st.acc, b.st.cur]), before);
  const i = code.indexOf("string CycleBook("); const body = fnBody("string CycleBook(");
  for (const bad of ["ACCOUNT_BALANCE", "ACCOUNT_EQUITY", "ACCOUNT_PROFIT", "HistorySelect(", "AccountInfoDouble"]) assert.ok(!body.includes(bad), "CycleBook must not read " + bad);
  assert.ok(i > 0);
});
test("5.8 an independent manual trade (another magic / no tracked position) never enters the cycle", () => {
  const own = fnBody("int OwnPositions(ulong &tk[])");
  assert.match(own, /POSITION_SYMBOL\)!=g_sym\) continue;/); assert.match(own, /POSITION_MAGIC\)!=g_magic\) continue;/);
  assert.match(code, /if\(!PHas\(pid,"N"\) && !IsLoggedPos\(pid\)\) RegisterPosition\(pid\);/);   // only positions of this Magic + Symbol are registered / tracked
});
test("5.9 manual close of a position of the cycle: its net is booked ONCE in that cycle (policy InpCountManualResults)", () => {
  const b = bot(); b.open(1); assert.equal(b.close(1, 11, "Manual (External)", -3), "BOOKED"); near(b.st.net, -3);
  assert.equal(b.close(1, 11, "Manual (External)", -3), "DUP"); near(b.st.net, -3);
  const off = bot({ countManual: false }); off.open(1); assert.equal(off.close(1, 11, "Manual (External)", -3), "IGNORED"); near(off.st.net, 0);
});
test("5.10 restart after a stop and before the TP: CycleId, losses and cycle net are restored; a replayed deal is not counted twice", () => {
  const b = run([["SL", -10], ["SL", -20]]);
  const j = b.persist(); const r = bot().static(j);
  assert.equal(r.st.id, 1); near(r.st.net, -30); near(r.st.losses, 30); assert.equal(r.st.lastDeal, 1002);
  assert.equal(r.close(2, 1002, "SL", -20), "DUP"); near(r.st.net, -30);                     // the same closing deal arrives again after the restart
  r.open(3); assert.equal(r.close(3, 1003, "TP", 55), "COMPLETE"); near(r.st.records[0].net, 25);
  const save = fnBody("void SaveState()");
  for (const k of ["CYCID", "CYCNET", "CYCLS", "CYCTR", "CYCST", "LDEAL"]) assert.ok(save.includes('"' + k + '"'), k + " is saved");
  const load = fnBody("void LoadState()");
  for (const k of ["CYCID", "CYCNET", "CYCST"]) assert.ok(load.includes('"' + k + '"'), k + " is restored");
});
test("5.10b a restart in the middle of a completion finishes it exactly once (COMPLETING is persisted)", () => {
  const b = bot(); b.open(1); b.st.positions.clear(); b.book(25); b.st.cyc = "COMPLETING"; b.st.state = "ACTIVE";      // saved: COMPLETING, ledger not zeroed yet
  const r = bot().static(b.persist()); r.tick(); r.tick();
  assert.equal(r.st.records.length, 1); assert.equal(r.st.cyc, "WAITING_USER"); assert.equal(r.st.net, 0); assert.equal(r.st.id, 2);
  const stuck = bot(); stuck.st.cyc = "COMPLETING"; stuck.st.net = 0; stuck.st.orders = [101]; stuck.tick({ cancelFails: true });
  assert.equal(stuck.st.cyc, "COMPLETING"); stuck.tick(); assert.equal(stuck.st.cyc, "WAITING_USER");                    // retries until no order is left
});
test("5.11 duplicate / old closing event: neither repeats the result nor touches a newer cycle", () => {
  const b = bot(); b.open(1); b.close(1, 11, "TP", 25);                                    // cycle 1 complete -> cycle 2
  assert.equal(b.st.id, 2);
  assert.equal(b.close(1, 11, "TP", 25), "DUP"); assert.equal(b.st.net, 0); assert.equal(b.st.id, 2); assert.equal(b.st.records.length, 1);
  b.start(); b.open(2); const pid3 = 3; b.open(pid3);
  b.st.positions.get(pid3).cy = 1;                                                           // a position that belongs to the OLD cycle closes late
  assert.equal(b.close(pid3, 33, "SL", -9), "ORPHAN"); assert.equal(b.st.net, 0); assert.equal(b.st.id, 2);
});
test("5.12 fast reversal Buy/Sell: each position books into its own cycle; pending orders of a completed cycle are cancelled and none remains", () => {
  const b = bot(); b.open(1); b.st.orders = [201]; b.close(1, 11, "SL", -5); b.open(2); b.st.orders = [202];     // reverse trade opened by the pre-armed order
  assert.equal(b.st.id, 1); near(b.st.net, -5);
  assert.equal(b.close(2, 12, "TP", 120), "COMPLETE"); assert.deepEqual(b.st.orders, []); assert.equal(b.st.cyc, "WAITING_USER");
  assert.equal(b.start(), "ARMED");                                                           // only the USER's start re-arms
  const tp = fnBody("bool CycleTryComplete(");
  assert.ok(tp.includes("CleanupOrders(") && tp.indexOf("CleanupOrders(") < tp.indexOf("YC_WAITING_USER"));
});
test("5.12b a profit that arrives while ANOTHER position of the EA is still open does not complete the cycle early", () => {
  const b = bot(); b.open(1); b.open(2);
  assert.equal(b.close(1, 11, "TP", 30), "BOOKED"); assert.equal(b.st.records.length, 0); assert.equal(b.st.cyc, "ACTIVE");
  assert.equal(b.close(2, 12, "TP", 5), "COMPLETE"); near(b.st.records[0].net, 35);
});
test("5.13 rejected order / low margin / volume not allowed: the cycle is NOT reset and nothing is reported as done (WAITING_*)", () => {
  const b = run([["SL", -3]]);
  b.st.state = "WAITING_VOLUME";                                                              // RiskCompute refuses: a WAITING_* code, the ledger stays
  near(b.st.net, -3); assert.equal(b.st.records.length, 0); assert.equal(b.st.id, 1);
  const rc = fnBody("bool RiskCompute(");
  assert.ok(!rc.includes("ResetRisk") && !rc.includes("CycleFinishLedger"));
  assert.ok(!fnBody("bool TryPlace(").includes("ResetRisk"));
});
test("5.14 Hedging and Netting: each account type has its own rule; (v2.44) a Netting position that absorbed foreign volume books ONLY the bot's share, never the foreign part, and never counts as an SL step / statistic", () => {
  const h = bot({ netting: false }); h.open(1); assert.equal(h.close(1, 11, "SL", -4, { tainted: true }), "BOOKED"); near(h.st.net, -4);
  // v2.44: the old model above ("TAINTED, net unchanged") is superseded - the attribution rules are covered by tests/polish-v430.test.mjs (share by entry volume; an undeterminable loss is booked in full, a profit is not credited).
  const pcp = fnBody("bool ProcessClosedPosition(");
  assert.match(pcp, /bool tainted=\(g_netting && \(foreignIn \|\| PGV\(pid,"TAINT",0\.0\)>0\.5\)\);/);
  assert.match(pcp, /if\(!stopBooked && \(\(!bookkeeping && !tainted\) \|\| \(ledgerBooked && !bookkeeping\)\)\) cycDone=CycleTryComplete\(dealOut\);/);     // v2.44: only a result that really entered the ledger (normal path or the bot's Netting share) can complete a cycle; a result booked while STOPPED never changes the state
});
test("5.15 costs: the cycle net is made of NET results (profit + commission + swap + fees), never gross; the completion test never reads gross", () => {
  const pcp = fnBody("bool ProcessClosedPosition(");
  assert.ok(pcp.includes("double net=gross+comm+swap;") && pcp.includes("DEAL_FEE"));
  assert.ok(!/CycleMet\([^)]*gross/.test(pcp) && !/CycleBook\(gross/.test(pcp));
  const gross = 20.4, comm = -0.6, swap = -0.1, fee = 0;                                      // gross 20.4 looks like "target met", the NET 19.7 is not
  const b = bot(); b.open(1); assert.equal(b.close(1, 11, "TP", gross + comm + swap + fee), "BOOKED"); assert.equal(b.st.records.length, 0);
  near(TARGET - b.st.net, 0.3);                                                               // the shortfall is carried: the cycle continues
  assert.ok(nextRiskNet(b.st.net) >= INIT);                                                   // the next risk is never below the initial one (no sub-minimum-lot stall)
});

// ---------------------------------------------------------------- report section 3: design ----
test("3.1 explicit cycle ledger: id, net, losses, target, state, last closing deal - all saved", () => {
  for (const s of ["long          g_cycId=1;", "double        g_cycNet=0.0;", "double        g_cycLosses=0.0;", "int           g_cycState=YC_IDLE;", "YC_IDLE=0,", "YC_ACTIVE=1,", "YC_COMPLETING=2,", "YC_WAITING_USER=3,", "YC_ERROR=4"])
    assert.ok(raw.includes(s), s);
  assert.match(code, /void ResetRisk\(\)[\s\S]*?g_cycNet=0\.0; g_cycLosses=0\.0; g_cycTrades=0;\s*g_cycId\+\+;/);   // a new cycle starts EMPTY with a NEW id
});
test("3.2 ONE completion rule: strict target, no 98% tolerance, no ResetRisk in any closing path, ONE call site", () => {
  assert.match(code, /bool CycleMet\(const double cycNet\) \{ return cycNet>=g_target-YT_MONEY_EPS; \}/);
  assert.match(code, /#define YT_MONEY_EPS 1e-6/);
  assert.ok(!/g_target\s*\*\s*0\.98/.test(code), "no 98% target tolerance may remain");
  assert.ok(!code.includes("LedgerApplyNet"), "the old premature-reset ledger function is gone");
  const pcp = fnBody("bool ProcessClosedPosition(");
  assert.ok(!pcp.includes("ResetRisk"), "no closing path resets the ledger by itself");
  assert.equal((code.match(/CycleTryComplete\(/g) || []).length, 2);                           // definition + the single call in ProcessClosedPosition
  assert.equal((pcp.match(/CycleTryComplete\(/g) || []).length, 1);
  assert.equal((code.match(/CycleFinishLedger\(/g) || []).length, 4);                          // definition + CycleTryComplete + CycleCompletionTick + DoStart (v2.44: closes a cycle whose target was reached while STOPPED)
  assert.equal((code.match(/\bResetRisk\(\);/g) || []).length, 2);                             // CycleFinishLedger + ResetRiskLogged (explicit user reset)
  assert.ok(!/g_accLoss\s*\+=/.test(code) && !/g_accLoss\s*-=/.test(code), "g_accLoss is DERIVED from the cycle net, never edited directly");
});
test("3.2b every closing path books through CycleBook (SL, TP, old TP, manual, extra loss, extra profit)", () => {
  const pcp = fnBody("bool ProcessClosedPosition(");
  assert.equal((pcp.match(/CycleBook\(/g) || []).length, 10);                                 // the 6 normal paths + v2.44: Netting share (normal / stopped) + SL / other result closed while STOPPED
  for (const s of ['CycleBook(net,"SL")', 'CycleBook(net,"TP")', 'CycleBook(net,"Old/overlapping TP', "CycleBook(net,rs)", 'CycleBook(net,"Extra position loss")', 'CycleBook(net,"Extra position")']) assert.ok(pcp.includes(s), s);
});
test("3.2c TP below the target: the cycle continues (re-armed at the original levels, cycle stays ACTIVE), no reset, no automatic new cycle after a success", () => {
  const pcp = fnBody("bool ProcessClosedPosition(");
  const i = pcp.indexOf("else if(isTP)\n"); const j = pcp.indexOf("else if(isDev && keepState)");
  const tp = pcp.slice(i, j);
  assert.ok(tp.includes('CycleBook(net,"TP")') && tp.includes("CycleMet(g_cycNet) && others==0") && tp.includes("YT_ARMED") && tp.includes("NOT complete"));
  assert.ok(!tp.includes("PromotePending") && !tp.includes("ResetRisk"));                       // the old "TP -> promote levels -> ARMED automatically" path is gone
  const fin = fnBody("void CycleFinishLedger(");
  assert.match(fin, /g_state=YT_TP_RESET;/); assert.ok(!fin.includes("g_state=YT_ARMED"));
});
test("3.2d completion order: COMPLETING saved -> record -> zero ledger -> cancel pending orders -> WAITING_USER", () => {
  const f = fnBody("bool CycleTryComplete(");
  const order = ["g_cycState=YC_COMPLETING;", "SaveState();", "CycleFinishLedger(true);", "CleanupOrders(", "g_cycState=YC_WAITING_USER;"].map((s) => f.indexOf(s));
  assert.ok(order.every((x) => x > 0) && order.every((x, k) => k === 0 || x > order[k - 1]), JSON.stringify(order));
  assert.ok(f.includes("OwnPositions(rp)>0) return false"));
  assert.ok(fnBody("void CycleFinishLedger(").includes("AppendLine(CycleFile(),CYCLE_HEADER,line);"));
  assert.ok(code.includes("CycleCompletionTick();"));
});
test("3.3 next risk comes from the net still needed (target - cycle net); never an unbounded lot; caps and WAITING_* are unchanged", () => {
  near(nextRiskNet(0), 1); near(nextRiskNet(-60), (60 + 20) / 20); near(nextRiskNet(5), 1); near(nextRiskNet(-0.5), 20.5 / 20);
  for (const L of [0, 1, 5.525631, 12.577894, 60]) near(nextRiskNet(-L), L <= 1e-9 ? 1 : (L + 20) / 20);     // identical to the old (L+target)/RR for any debt
  assert.ok(!code.includes("NextRiskFor(g_accLoss)"));
  for (const s of ["InpMaxLot", "WAITING_RISKCAP", "WAITING_ACCLOSSCAP", "WAITING_SEQCAP"]) assert.ok(code.includes(s), s);
});
test("3.4 ownership: Magic + Symbol + saved CycleId; a result of an older cycle is logged, never booked into a newer one", () => {
  const pcp = fnBody("bool ProcessClosedPosition(");
  assert.match(pcp, /long posCyc=\(long\)PGV\(pid,"CY",0\.0\);\s*bool orphanCyc=\(posCyc>0 && posCyc!=g_cycId\);/);
  assert.match(pcp, /if\(orphanCyc && !bookkeeping\)\s*\{\s*bookkeeping=true;/);
  assert.ok(fnBody("long RegisterPosition(").includes('PSet(pid,"CY",(double)g_cycId);'));
  assert.ok(fnBody("void ClearPosGV(").includes('"CY"'));
});
test("START: after a completed cycle nothing re-arms by itself; DoStart (the user) begins the new cycle", () => {
  const ds = fnBody("string DoStart(");
  assert.match(ds, /if\(g_state==YT_TP_RESET\)\s*\{[\s\S]*?YC_COMPLETING[\s\S]*?ValidateLevels\(g_buyLevel,g_sellLevel\)!=""/);
  assert.ok(ds.includes("CycTouch();"));
  const al = fnBody("bool ApplyLevels(");
  assert.ok(al.includes("g_cycState==YC_COMPLETING"));
  const b = bot(); b.open(1); b.close(1, 11, "TP", 30);
  assert.equal(b.st.state, "TP_RESET"); assert.equal(b.st.cyc, "WAITING_USER");
  assert.equal(b.st.state === "ARMED", false); assert.equal(b.start(), "ARMED"); assert.equal(b.st.cyc, "ACTIVE");
});
test("report items: OneCyclePerDay / SequenceLocked / fresh-checks understand a cycle that is in PROFIT but not complete", () => {
  assert.match(code, /if\(InpOneCyclePerDay && CycFresh\(\) && g_seq==0\)/);
  assert.match(code, /bool CycFresh\(\) \{ return \(g_accLoss<=1e-9 && MathAbs\(g_cycNet\)<=1e-9\); \}/);
  assert.ok(!code.includes("(g_accLoss>1e-9)?NextRiskFor(g_accLoss):g_initRisk"));
});
test("EA version and protocol are consistent (2.44) and the cycle state is exported to the app", () => {
  assert.match(raw, /#property version\s+"2\.44"/); assert.match(raw, /#define YT_VER "2\.44"/);
  assert.ok(raw.includes('",\\"cyc\\":{\\"id\\":"'));
});
