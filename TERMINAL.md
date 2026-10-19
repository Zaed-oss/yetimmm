# Terminal / agent instructions (Yetimmm v4.31)

Goal: deploy the Cloudflare Worker so the MT5 EA can pair (fixes HTTP 503 `pair_not_configured`).

1. `npm install`
2. Cloudflare auth (once): `npx wrangler login`, or export `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`).
3. `npm run setup` (first time): generates a STRONG `PAIR_CODE` (min 8 chars, never `123123`), stores it as a Cloudflare secret and writes the Worker URL + the same code to `ea/Yetimmm.cfg` (copy it to MT5 `Common\Files`).
4. `npm run deploy` -> runs `npm run check` + `npm test`, then **refuses to deploy** if `PAIR_CODE` is a plain `[vars]` entry in `wrangler.toml` or if the `BOT_TOKEN` / `PAIR_CODE` secrets are missing (`APP_PASSWORD` is required only when no `OWNER_TG` secret exists) (it never deletes a secret), runs `wrangler deploy`, then calls `GET /` on the Worker and requires `pairConfigured:true`.
   Preview without changes: `npm run deploy:dry`.
5. If it reports a missing secret: `npx wrangler secret put BOT_TOKEN` / `PAIR_CODE` (and `APP_PASSWORD` only if you do not use the owner id).
6. Do NOT edit `ea/Yetimmm.mq5`; the EA is compiled in MetaEditor on Windows (F7). `InpBrUrl` / `InpBrPairCode` stay EMPTY: the EA reads `Yetimmm.cfg` automatically (fill them only to override).

## Pre-configured values (kept OUT of git)

The owner's Telegram id, Worker URL and the ready-made values live in `.env` and in the git-ignored `TERMINAL.local.md` (this machine only).
Read them from there; do not ask the user again, and never paste them into a tracked file (`npm run check` fails if `OWNER_TG` appears in any tracked file).

### What the agent runs
1. `npm install`
2. `npm run setup -- --yes`  (reads `.env`: no token prompt, no "press START" wait because `OWNER_TG` is set; deploys the Worker, writes `Yetimmm.cfg` into MT5 `Common\Files`, runs the allow-urls step, compiles the EA, configures the bot)
3. Later releases: `npm run deploy` works with the owner-id setup (no `APP_PASSWORD` needed since v4.31.1).
4. GitHub pushes: sign in once with `gh auth login`; then `npm run setup` or `powershell -File tools\repo-update.ps1` need no tokens.
5. MT5 EA inputs stay EMPTY (`InpBrUrl`, `InpBrPairCode`): the EA reads `Yetimmm.cfg` automatically. If it logs "Yetimmm.cfg not found", copy `ea/Yetimmm.cfg` to MT5 `File > Open Data Folder > ..\Common\Files`.
6. Manual fallback in MT5 `Tools > Options > Experts > Allow WebRequest for listed URL`: add the Worker URL and `https://api.telegram.org`.
