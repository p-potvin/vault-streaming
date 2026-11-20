# Vault Streaming — Session Handoff

**Last updated:** Fri, 20 Nov 2026 10:00
**Branch:** `main`, everything merged (vault-streaming #19–#22, vault-raggae #91). **Version 2.7.0** (vault-raggae 0.26.0).
**Next tasks:** §1 TV series resume the last episode; §2 run the playback indexing (Moments) on `greencloud-panopticam`.

Read this, then `README.md`. Company protocol entry point: `..\vaultwares-docs\instructions\ROUTER.md`; ledger last
(`..\agent-ledger\scripts\record-agent-change.ps1`).

---

## 1. Next task: TV series open on the last episode watched

### What the user wants
Opening a series (details modal, Library card, Continue Watching, Watch History) lands on the season **and episode**
watched last, ready to resume — or on the next episode when the last one was finished.

### What exists today
- `js/streaming/details-modal.js` (~line 266): the season picker already defaults to the last-watched season
  (`getWatchProgress({ mediaType: 'tv', tmdbId, title })` without season/episode returns the most recent episode of the
  show, `src/watch-history.js` `watch-history:get-progress`). The **episode** is not marked, scrolled to, or offered to
  resume; `_loadSeasonEpisodes` (~line 303) renders the list with no progress at all.
- `js/favorites.js` (~line 224, Library card): an in-progress episode is resumed directly; a finished one, or none,
  opens the season screen. "Next episode after a finished one" is not handled anywhere.
- `js/continue-watching.js` / `js/history.js`: resume the exact item stored (`triggerRDStream` with its season/episode).
- Watch progress per episode is keyed `tv:<tmdbId|title>:s<S>e<E>`; `completed` = 90 % watched.

### To do
- In the episode list: mark watched episodes / show the progress bar, highlight + scroll to the last one, a
  "Resume S02E05 (12:40)" or "Next: S02E06" button. Next episode = same season +1, else first episode of the next
  season (the TMDB season list is already loaded there).
- Library card / Continue Watching for a finished episode: offer the next one instead of re-opening the finished one.
- Watch out: `get-progress` matches `item.tmdbId === tmdbId` strictly. Series launched with an IMDb id (`tt…`) or a
  numeric string store a different tmdbId than the details modal asks with — normalise both sides (String, catalog id)
  or a show's progress looks empty.
- The episode's last source (§3) is per episode, so "Next episode" still goes through the search; that is expected.

## 2. Next task: playback indexing (Moments) on greencloud-panopticam

(Notes from the operator, Fri 20 Nov 2026. This is vault-raggae work — `app/moments/stream.py` and the gateway queue in
`app/main.py` — vault-streaming only queues jobs via `POST /v1/moments/stream`, `src/ipc/moments.ipc.js`.)

**Idea:** run the catalog's Moments ingest for streams (and possibly the Prom-King site-rebuild catalog, ADR 0001 in
vaultwares-docs) on `greencloud-panopticam`, which already pulls a second stream for its own work, instead of reading
every played title a second time from this PC.

### Measured Fri 20 Nov 2026
- **Storage per hour of video: ~4 MB** in total — nothing of the video is kept. Local numbers
  (`%LOCALAPPDATA%\VaultWares\raggae`): sound + look vectors 0.93 MB/h in `vw-moments.db` (370 windows/h, CLAP 512-d +
  SigLIP 768-d as float16), the LanceDB search copy ~2.2 MB/h (1,773 MB for 807 h, index overhead included), tags +
  "said" text + transcript ~0.1 MB/h (GoT S01E01: 501 cues, 15 KB). Disk is not the constraint.
- **What a read costs instead:** the whole file is downloaded once (the audio is interleaved): a 4K remux is
  25–80 GB, a 1080p web release 2–5 GB, a 720p copy ~1 GB (vault-streaming already passes a 720p/480p copy above
  1080p, same release group first). ffmpeg now decodes key frames only (4 % of this PC for a 4K remux).
  The models are the heavy part: SigLIP + CLAP run on GPU 1 here, and the transcript is Nemotron 3.5 through
  nemo-speech (GPU, `NEMO_SPEECH_URL`).
- **greencloud-panopticam now** (read-only check, Fri 20 Nov 09:50): 4 vCPU AMD EPYC-Milan, **no GPU**, 7.7 GB RAM
  (3.9 GB available), disk 58 GB with **18 GB free** (71 % used; `/var/lib/panopticam` 22 GB), load average 2.0–2.7.
  Panopticam's `worker.py` alone uses ~150 % CPU (running 7 days), the `panopticam` service ~30 % CPU / 28 % RAM.
- `ovh-panopticam` is retired (provider terminating, Thu 29 Oct 2026) and no longer answers.

### What that means (to decide next session)
- Without a GPU, SigLIP/CLAP on CPU at 1 frame/s and Nemotron speech on CPU would be far slower than real time on
  4 shared cores already half-used by Panopticam. The realistic split: greencloud does the **read** (ffmpeg, key frames
  + 16 kHz audio, a lighter copy) and ships the small extracts (JPEG frames + WAV segments, or the 1 fps frames only)
  to this PC's gateway, which runs the models — or the models stay here and greencloud is not needed for streams at
  all. Measure before choosing: frames + audio per hour at 224 px JPEG is roughly 360 × 10 frames × ~10 KB ≈ 36 MB +
  ~115 MB of 16 kHz WAV per hour.
- The site-rebuild catalog is a separate source (its own media, not debrid streams): same per-hour storage, but its
  size (number of hours) decides whether 18 GB free is enough — check the catalog's total runtime first.
- Any outside requests in a loop (catalog ingest) need the operator's go-ahead with counts and rate
  (REQUEST_RATE_LIMITING).

## 3. What shipped Thu 19 – Fri 20 Nov (for context)

- **Stream picking** (#19): sync entries and lapsed AllDebrid/TorBox dropped, one entry per hash, episode fit, cached →
  single episode → packs, 8 tries / 120 s. Only Real-Debrid (via Comet) and Deepbrid are paid for.
- **Settings / subtitles** (#21): Upscaling (off by default), skip the KinoCheck trailer intro (on), subtitles by
  IMDb id with a picker per language, the AI transcript from vault-raggae listed (never starts a speech job), no live ASR.
- **Moments** (#21, vault-raggae #91): a lighter copy above 1080p; reads pause when the app quits and resume at start
  (checkpoints per transcribed 10-min segment; stopped reads resume from what they stored); ffmpeg key frames only.
- **Playback** (#22): HEVC Main 10 copied as `hvc1.2.4`, Dolby Vision 7/5 never copied, a failing copy recovers as a
  1080p tone-mapped re-encode; the transcode knows the runtime (clock, seek restarts ffmpeg, progress saved);
  **the last source of a title replays directly** (`lastSource` in the watch history, "Other sources…" in the quality
  menu searches again); start tab and Continue Watching settings; PiP fixes; vault-explorer collection leftovers removed.
- **Logs:** `%APPDATA%\vault-streaming\logs\vault-streaming.log` (previous run `.1.log`), every line redacted
  (`src/app-log.js`). Stream links are stored as `comet:/playback/…` — never with the Comet config (debrid keys).

## 4. Environment and rules that still hold

- **Debrid through Comet** (`COMET_STREAM_BASE`, Comet on vps-ovhcloud behind its VPN); the app never calls
  `api.real-debrid.com` for playback. Comet's own config still lists AllDebrid (the app drops those entries; removing
  it from Comet's config saves Comet a lookup per search — operator's call, the config holds keys).
- **Testing in the app:** Electron ignores an `APPDATA` override, so a Playwright-launched copy uses the operator's
  real settings and watch history. Back up `%APPDATA%\vault-streaming\vault-settings.json` and
  `vault-watch-history.json` first and restore what a test changed. `VAULT_STREAMING_E2E=1` skips the Moments
  pause/resume and the splash.
- **Versions:** vault-streaming `package.json` (`node scripts/sync-version.js X.Y.Z`); vault-raggae `pyproject.toml`
  (`python tools/sync_version.py X.Y.Z`). Bump on every PR.
- **Git:** branch `vw-codex-*` / `vw-claude-*`, PR with reviewer p-potvin, the operator merges (or asks you to).
  Act on Devin / Gemini review comments; CodeRabbit is ignored.
- **Windows shell traps:** write scripts with the Write tool; Python `write_text` on Windows writes CRLF (index.html
  is LF); scratchpad `.js` files run as ES modules — use `.cjs`.
- **Public hygiene:** vault-streaming is a public repo — no adult-site names in commits, PRs, branches or docs.

## 5. Still open
- Embed the 84k cached posters for image search (SigLIP, vault-raggae).
- Moments re-index of the 2,331 library videos at 10 frames (`python -m app.moments.index …`, ~11 h+ GPU).
- A Settings switch for `indexPlayback` (today only `appSettings.indexPlayback = false`).
- The intermittent mid-play failure of a copied 4K Dolby Vision video is recovered (1080p re-encode) but its cause is
  not pinned down; the log file will show `copied video not playable` when it happens.
