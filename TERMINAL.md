# Terminal / agent instructions (Yetimmm v4.12)

Goal: deploy the Cloudflare Worker so the MT5 EA can pair (fixes HTTP 503 `pair_not_configured`).

1. `npm install`
2. Cloudflare auth (once): `npx wrangler login`, or export `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`).
3. First time only: `npm run setup` (creates the secrets BOT_TOKEN, APP_PASSWORD and a RANDOM PAIR_CODE, deploys, writes `Yetimmm.cfg` for the EA).
   There is no default pairing code in any file.
4. Later releases: `npm run deploy` -> runs `npm run check` + `npm test`, then a PREFLIGHT: BOT_TOKEN + APP_PASSWORD secrets and PAIR_CODE (secret, or a
   `[vars]` line you added yourself) must exist, otherwise it stops BEFORE deploying and names what is missing. It never deletes anything: a PAIR_CODE that is
   both a `[vars]` line and a secret is reported and you choose which to keep. Then `wrangler deploy`, then it verifies the Worker answers, runs this
   package's version, and has PAIR_CODE (a harmless probe: `POST /api/ea/sync` with a wrong code must answer 403 pair_bad, 503 pair_not_configured = missing).
   Preview without changes: `npm run deploy:dry`.
5. Do NOT edit `ea/Yetimmm.mq5`; the EA is compiled in MetaEditor on Windows (F7). It reads the pairing code from `Yetimmm.cfg` (`pair=`) or the input `InpBrPairCode`.
