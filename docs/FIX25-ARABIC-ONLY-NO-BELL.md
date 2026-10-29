# fix25 — Arabic only, no language switch, no bell / notification center

## Decision: what "notifications" meant
Deleted: everything behind the bell button (UI, history, read state, `/notify/*`, per-order alerts `/order-alert`, Hub watcher, `oa:` records).
Kept: Telegram messages for EA events (SL / TP / activation / errors). They run EA -> `Hub.events` -> `Notify.emit` -> Telegram with dedupe + retry and do not depend on the bell. The EA `act` event used to be swallowed when a user alert was armed; it is now always delivered (the no-alert path that already existed).

## Deleted files
- `notify/yt-notify.js`, `notify/yt-notify.css` (folder removed)

## Modified files
- `index.html` — buttons removed, language state/functions removed, dictionary -> Arabic strings, old `lg` storage erased, per-order bell removed, `.app` wide-screen rule moved here, Arabic aria-labels.
- `anim/yt-anim.js` — state labels Arabic only.
- `worker/worker.js` — routes + Hub alert code removed, one-time `oa:` cleanup, Arabic-only `/start` caption.
- `worker/notify.js` — `/notifs` `/read` and read flag removed, cleanup of non-`ea` records (`purged` = 2).
- `worker/wrangler.toml` — comments only (class names and migrations unchanged on purpose: no DO migration needed).
- `scripts/setup-bot.mjs` — Arabic-only bot profile. `scripts/check.mjs` — file list.
- Tests: `worker.test.mjs`, `connection-recovery-v4311`, `exact-risk-fix21`, `v411` adapted; `arabic-only-fix25.test.mjs` added.
- Docs: README, CHANGELOG, this file.

## Verification
- `rg`-style scans: no `LG`, `setLang`, `lgB`, `ntB`, `YTNotify`, `/notify/`, `order-alert`, `oalert` left in app or Worker.
- Behaviour run of the page script against a DOM stub: 402 keys, all non-empty Arabic strings (3 technical terms excepted), `t()` OK for every key, legacy `{"lg":1,"lgManual":1}` erased.
- `npm test` 542/542, `npm run check` passes.

## Not tested for real
Telegram Mini App on a device, RTL rendering in a browser, a live Cloudflare deploy, MT5, `setup-bot` (needs a real token), real Telegram delivery.
