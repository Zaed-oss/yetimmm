# Terminal / agent instructions (Yetimmm v4.30)

Goal: deploy the Cloudflare Worker so the MT5 EA can pair (fixes HTTP 503 `pair_not_configured`).

1. `npm install`
2. Cloudflare auth (once): `npx wrangler login`, or export `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`).
3. `npm run setup` (first time): generates a STRONG `PAIR_CODE` (min 8 chars, never `123123`), stores it as a Cloudflare secret and writes the Worker URL + the same code to `ea/Yetimmm.cfg` (copy it to MT5 `Common\Files`).
4. `npm run deploy` -> runs `npm run check` + `npm test`, then **refuses to deploy** if `PAIR_CODE` is a plain `[vars]` entry in `wrangler.toml` or if the `BOT_TOKEN` / `APP_PASSWORD` / `PAIR_CODE` secrets are missing (it never deletes a secret), runs `wrangler deploy`, then calls `GET /` on the Worker and requires `pairConfigured:true`.
   Preview without changes: `npm run deploy:dry`.
5. If it reports a missing secret: `npx wrangler secret put BOT_TOKEN` / `APP_PASSWORD` / `PAIR_CODE`.
6. Do NOT edit `ea/Yetimmm.mq5`; the EA is compiled in MetaEditor on Windows (F7). `InpBrUrl` / `InpBrPairCode` stay EMPTY: the EA reads `Yetimmm.cfg` automatically (fill them only to override).
