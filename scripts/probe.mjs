// Shared by setup.mjs and deploy.mjs. v4.18: the public GET / no longer reports configuration (it only says the Worker is up),
// so "is PAIR_CODE configured?" is answered by a harmless pairing probe against the REAL EA endpoint:
//   POST /api/ea/sync with a throw-away secret + a wrong pairing code for an account number that does not exist
//   -> 503 pair_not_configured : the Worker has NO PAIR_CODE (secret or var)
//   -> 403 pair_bad            : PAIR_CODE is configured (the probe's wrong code was refused)
// The probe changes nothing on the Worker (a refused pairing writes no account record and no directory entry - covered by tests/v418.test.mjs C1/C2).
export async function probeWorker(base) {
  const url = String(base || "").replace(/\/+$/, "");
  const out = { up: false, v: "", pair: "unknown", note: "" };
  try {
    const r = await fetch(url + "/", { headers: { accept: "application/json" } });
    const j = await r.json();
    out.up = !!(j && j.ok); out.v = String((j && j.v) || "");
  } catch (e) { out.note = "GET / failed: " + e.message; return out; }
  try {
    const r = await fetch(url + "/api/ea/sync", { method: "POST", headers: { "content-type": "application/json", "X-EA-Secret": "p".repeat(32), "X-EA-Pair": "probe-not-a-real-code" }, body: JSON.stringify({ login: "000", state: {} }) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 503 && j.error === "pair_not_configured") out.pair = "missing";
    else if (r.status === 403 && j.error === "pair_bad") out.pair = "configured";
    else out.note = "unexpected probe answer HTTP " + r.status + " " + JSON.stringify(j);
  } catch (e) { out.note = "probe failed: " + e.message; }
  return out;
}
