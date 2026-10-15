# Terminal / agent instructions (Yetimmm v4.12)

Goal: deploy the Cloudflare Worker so the MT5 EA can pair (fixes HTTP 503 `pair_not_configured`).

1. `npm install`
2. Cloudflare auth (once): `npx wrangler login`, or export `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`).
3. `npm run deploy`  -> runs `npm run check` + `npm test`, deletes a conflicting `PAIR_CODE` *secret* if one exists
   (`worker/wrangler.toml [vars]` now carries `PAIR_CODE = "123123"`), runs `wrangler deploy`, then calls `GET /`
   on the Worker and requires `pairConfigured:true`.
   Preview without changes: `npm run deploy:dry`.
4. If it reports a missing secret: `npx wrangler secret put BOT_TOKEN` / `APP_PASSWORD`.
5. Do NOT edit `ea/Yetimmm.mq5`; the EA is compiled in MetaEditor on Windows (F7). `InpBrPairCode` default must equal `PAIR_CODE`.
