# Vault Streaming — Session Handoff

**Last updated:** Sat, 21 Nov 2026 14:10
**Branch:** `vw-claude-web-mobile` = open PR **#29** (web client on phones / iPhone & iPad playback / per-device data /
French strings). Everything else is merged: vault-streaming #24–#28 (**2.10.1** on `main`, #29 makes it 2.10.2),
vault-raggae #92–#94 (**0.29.0**; its checkout is back on `main`).

Read this, then `README.md` and `web/README.md`. Company protocol entry point: `..\vaultwares-docs\instructions\ROUTER.md`;
ledger last (`..\agent-ledger\scripts\record-agent-change.ps1`). Act on Devin / Gemini review comments, ignore CodeRabbit.

---

## 0. Running right now / waiting

- **TMDB catalog backfill** (`scripts/backfill-catalog.js --execute`, started from this checkout ~10:20, log
  `%LOCALAPPDATA%\VaultWares\vault-streaming\backfill-20261121.log`): films >= 600 votes (72.5 k) and every series
  >= 600 votes (18.1 k) with **all** episodes (1.6 M, specials included), full episode fields (crew, guest stars) and
  cast / crew per title in `raw_enrichment.tmdb.credits`. At 14:10: ~44 k / 86.7 k titles, 302 misses. Resumable
  (done files in that folder: `backfill-done.txt`, `backfill-episodes-done-v2.txt`, `backfill-credits-done.txt`).
  The catalog (`G:\Catalogs\vw-catalog.db`, 23.6 GB before) grows ~12 GB.
- **After the backfill** (vault-raggae, all built and tested on samples, not run for real):
  1. `python -m app.cast.build` — the cast catalog `G:\Catalogs\vw-cast.db` (people kept: top-billed 20 + key crew
     jobs + people named by a Celebrities identity; 300-title sample: 14,471 people).
  2. `python -m app.pictures seasons profiles stills` (`--dry-run` first: counts / time; stills ~1.6 M at 4 req/s =
     days, run seasons and profiles first).
  3. `python -m app.picture_vectors posters seasons stills profiles` (SigLIP into `G:\Catalogs\vw-pictures.lance`,
     RTX 2060).
  4. Later, ask the operator first (new batch of requests): TMDB person details (biography, birthday, imdb id) for
     the people in the most titles; face vectors of profiles vs the Celebrities exemplars (`method = face`).
- **The operator is testing the web client on iPhone and iPad** (live server restarted 13:30 with the HLS route).
  **Restarting the live server** is now `Stop-ScheduledTask` then `Start-ScheduledTask -TaskPath '\VaultWares\' -TaskName VaultStreamingWeb`: the supervisor (`web/service/start-web.ps1`) holds node in a kill-on-close job and quits when the task's conhost does, so stopping the task frees 8722 (tested Sat, 21 Nov 2026).

## 1. PR #29 — what is in it

- **Phones**: Library / History no longer stacked under Discover (`css/mobile.css` forced `display:grid
  !important`); bottom-bar Settings opens; details window and settings full screen, one column; player controls,
  Up next / loading card, episodes panel and loading card fit; search box on its own row. Review fixes: sticky details
  header under a notch, control groups wrap.
- **iPhone / iPad playback** (`web/hls-route.js`, `web/public/web-overrides.js`): Safari gets HLS
  (`/api/hls/index.m3u8?src=…`): VOD playlist with the probed duration, 6 s MPEG-TS segments made on demand,
  far seeks restart ffmpeg there (`-output_ts_offset`, `-forced-idr` for NVENC), ffmpeg stopped 20 segments ahead /
  idle. Cause: the piped fMP4 of `/api/transcode` has no length / ranges (iPhone: "format not supported"; iPad: a
  few-second duration the <60 s provider-error-clip guard paused). `playsinline` + iPhone fullscreen fallback;
  `body.vw-player-open` (js/mobile.js) hides the app's top and bottom bars over the player on any touch device.
  Verified in the browser pane (native HLS there): full duration, plays, seek works. **Not yet confirmed on the
  operator's devices.**
- **Per-device settings and watch history** (`web/devices.js`): device = tailnet address (greencloud's X-Real-IP,
  trusted only from greencloud 100.73.93.84 / loopback); files in `%APPDATA%\vault-streaming\devices\<ip>\`; a new
  device starts with the shared settings and an empty history; the desktop app and local requests keep the shared
  files. Test: `tests/test_web_devices.js`.
- **French**: English-only strings translated (details window, bottom bar, player tooltips, filters, countdown,
  quick actions, stream status lines, History badge, IMDb button, quality menu); "Québécois (QC)" labels are now
  "Français (fr-CA)" / "French (fr-CA)". French subtitles checked: fr track auto-selected, accents fine.

## 2. Open findings / next ideas

- **Episode numbering mismatch** (subtitles): American Dad! S07E14 is "School Lies" on TMDB but the French subtitle
  picked was Addic7ed's 07x14 "Stan's Best Friend" (TVDB order). Subtitle matching by season/episode numbers can give
  another episode's subtitles; match by episode IMDb id or title instead. Not started.
- Web client on desktop browsers still uses the piped `/api/transcode` (no seeking past the buffer). The HLS route
  could serve them too (via hls.js where there is no native HLS).
- Device names: `web/devices.js` resolves the tailnet machine name (`tailscale whois`) for the log only; a "this
  device" line in Settings would help.

## 3. Done this session (for context)

- Stream reload (F5 / context menu / automatic on a dead link) — #26.
- Diarized AI subtitles (Nemotron-3-Diarization on nemo-speech, `D:\HuggingFace\models\NeMoSpeech`) — vault-raggae #93.
- Splash-style stream loading card, in-player loading on the Up next card, next-episode pre-load 30 s before the end,
  Continue Watching per series, Play next fix (the stream dialog sat under the player and any click cancelled it) — #27.
- Series backfill limits (600 votes, no top-3000, no episode cap), cast / crew and full episode fields — #28.
- Cast catalog, picture phases, picture vectors — vault-raggae #94.

## 4. Testing notes

- GUI tests (Playwright `_electron`) must run with `VAULT_STREAMING_E2E=1 VAULT_STREAMING_USER_DATA=<scratch>` (a copy
  of settings / history), never the operator's real data; delete the copy after (it holds keys).
- Web dev instance: `.claude/launch.json` "web-dev" (port 8723, token `devlocal`, `VW_WEB_USERDATA` = a scratch copy).
- Unit tests: `node tests/test_series_resume.js`, `test_stream_picker.js`, `test_version.js`, `test_web_devices.js`.
