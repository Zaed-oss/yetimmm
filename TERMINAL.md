# Terminal / agent instructions (Yetimmm v4.31)

Goal: deploy the Cloudflare Worker so the MT5 EA can pair (fixes HTTP 503 `pair_not_configured`).

1. `npm install`
2. Cloudflare auth (once): `npx wrangler login`, or export `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`).
3. `npm run setup` (first time): generates a STRONG `PAIR_CODE` (min 8 chars, never `123123`), stores it as a Cloudflare secret and writes the Worker URL + the same code to `ea/Yetimmm.cfg` (copy it to MT5 `Common\Files`).
4. `npm run deploy` -> runs `npm run check` + `npm test`, then **refuses to deploy** if `PAIR_CODE` is a plain `[vars]` entry in `wrangler.toml` or if the `BOT_TOKEN` / `APP_PASSWORD` / `PAIR_CODE` secrets are missing (it never deletes a secret), runs `wrangler deploy`, then calls `GET /` on the Worker and requires `pairConfigured:true`.
   Preview without changes: `npm run deploy:dry`.
5. If it reports a missing secret: `npx wrangler secret put BOT_TOKEN` / `APP_PASSWORD` / `PAIR_CODE`.
6. Do NOT edit `ea/Yetimmm.mq5`; the EA is compiled in MetaEditor on Windows (F7). `InpBrUrl` / `InpBrPairCode` stay EMPTY: the EA reads `Yetimmm.cfg` automatically (fill them only to override).

## PRE-CONFIGURED VALUES (owner-supplied; do NOT ask the user for them again)

All values below are already in this package. Read them, use them, and tell the user they are present and ready.

| Item | Where it lives | Value / status |
|---|---|---|
| Worker URL | `.env` (`WORKER_URL`), `ea/Yetimmm.cfg` (`url=`), `index.html` (`baseUrl`) | `https://yetimmm-bridge.sayfhazeem078.workers.dev` |
| Pairing code | `.env` (`PAIR_CODE`), `ea/Yetimmm.cfg` (`pair=`) | set (16 chars, strong). Becomes a Cloudflare secret via `npm run setup` |
| Telegram owner id | `.env` (`OWNER_TG`) | `1939458064` (signs in without a password; setup stores it as a Cloudflare secret) |
| Bot token | `.env` (`BOT_TOKEN`) | set. Read by `npm run setup`; never copied into MT5 or the EA |
| MT5 Allowed URLs | `tools/allow-urls.bat` (reads `ea/Yetimmm.cfg`, adds `api.telegram.org` itself) | `https://yetimmm-bridge.sayfhazeem078.workers.dev` + `https://api.telegram.org` |

`.env` and `ea/Yetimmm.cfg` are git-ignored: they are never pushed to GitHub. Keep it that way.

### What the agent runs (no prompts needed except the one-time Cloudflare browser login)
1. `npm install`
2. `npm run setup -- --yes`  (reads `.env`: no token prompt, no "press START" wait because `OWNER_TG` is set; deploys the Worker, writes `Yetimmm.cfg` into MT5 `Common\Files`, runs the allow-urls step, compiles the EA, configures the bot)
3. Do NOT use `npm run deploy` for the first run: it demands an `APP_PASSWORD` secret, which this owner-id setup intentionally does not create.
4. MT5 EA inputs stay EMPTY (`InpBrUrl`, `InpBrPairCode`): the EA reads `Yetimmm.cfg` automatically. If it logs "Yetimmm.cfg not found", copy `ea/Yetimmm.cfg` to MT5 `File > Open Data Folder > ..\Common\Files`.
5. Manual fallback in MT5 `Tools > Options > Experts > Allow WebRequest for listed URL`: add both URLs from the table above.
