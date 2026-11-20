# Vault Streaming — Session Handoff

**Last updated:** Thu, 19 Nov 2026 09:00
**Branch:** `main`, everything merged (vault-streaming #15–#18, vault-raggae #85–#88). **Version 2.4.0** (vault-raggae 0.25.1).
**Next task:** fix Real-Debrid / Deepbrid stream selection — popular titles (that play fine in Stremio) try 5 sources
and give up. See §1; it already has a measured root-cause list.

Read this, then `README.md` ("Metadata, trailers and debrid", "Version"). Company protocol entry point:
`..\vaultwares-docs\instructions\ROUTER.md`; ledger last (`..\agent-ledger\scripts\record-agent-change.ps1`).

---

## 1. Next task: stream selection gives up after 5 tries

### What the user sees
Popular movies/series: the app tries 5 sources, then "Real-Debrid Error" / "none of the found streams are cached".
The same titles play in Stremio.

### Measured Wed 18 Nov (Game of Thrones S01E01, `tt0944947:1:1`)
Comet returned 71 entries: 24 `[RD…]`, 24 `[AD…]`, 23 `[TORRENT🧲]`, plus one `[RD🔄] Comet Sync` and one
`[AD🔄] Comet Sync` ("Sync debrid account library now"). Run through the app's own ranking (`js/streaming/ranking.js`)
and the retry order (`js/streaming/rd-flow.js` `startRDDebridFlow`, ~line 560), the 5 attempts were:

| # | Entry | Playable? |
|---|---|---|
| 1 | `[RD⚡]` 720p 584 MB, single episode | yes — only cached because we played it the day before; before that nothing was ⚡ |
| 2 | `[TORRENT🧲]` 1080p 30 GB season pack | **no link** — skipped as `notCached`, but it **uses up an attempt** |
| 3 | `[RD⬇️]` same 30 GB pack | uncached pack, Comet has to download it |
| 4 | `[AD⬇️]` **same pack, same hash** via AllDebrid | duplicate of #3 |
| 5 | `[TORRENT🧲]` 1080p 3.7 GB | **no link** again |

So of 5 attempts, at most one is a real distinct try. Root causes, most likely first:

1. **Link-less `[TORRENT🧲]` entries consume attempts.** `rd-stream-torrent` returns `notCached` for them (no url)
   and the loop `continue`s, but the attempt counter still advances. Fix: drop entries without a `url` (and the
   `🔄 Comet Sync` entries) before ranking/retrying, or don't count them.
2. **The same torrent (same `hash`) appears once per debrid service** (RD + AD) and is retried as if different.
   Dedupe by hash (prefer the cached / RD copy), or at least count one attempt per hash.
3. **Uncached season packs rank high** (big size, 1080p). Single-episode files that match the requested SxxEyy
   should outrank packs; a pack ⬇️ almost never plays instantly.
4. **"Cached" is nearly meaningless now.** Real-Debrid removed `instantAvailability`; Comet checks availability through
   StremThru's shared list, which knows almost nothing: Comet's own log (ssh, below) said
   `realdebrid: Found 1 cached … Available cached torrents on realdebrid: 1/132, alldebrid: 0/132`, and the user's RTN
   filter in the Comet config then kept 23/132. **`⬇️` entries still play** when RD actually has the file (that is
   what Stremio does: it just tries the link) — the app already accepts them; `src/realdebrid/stream.js` size-probes
   each resolved url and treats < 50 MB as Comet's "downloading / unavailable" placeholder → next source.
5. **5 is a hard cap** (`const maxAttempts = Math.min(torrentsToTry.length, 5)`, rd-flow.js ~589) and each ⬇️ try can
   take up to Comet's resolve time. With 1–4 fixed, a higher cap of *distinct, linked* candidates (e.g. 8–10, with an
   overall time budget) is reasonable.
6. **Index mismatch on a manual pick:** `startIndex` is found in `allTorrents` (ranked order) but used to index
   `torrentsToTry` (re-sorted cached-first): `torrentsToTry[startIndex + attempt]`. Picking a source by hand can start
   on a different one.
7. **Deepbrid** is the fallback after the loop fails (`rd-flow.js`, "Fallback: nothing played through Real-Debrid /
   Comet", `src/deepbrid/client.js`): one attempt with the best-ranked magnet; it adds the torrent to Deepbrid and waits
   ~16 s (`POLL_ATTEMPTS` 8 × 2 s); a season pack picks the requested episode's file or fails. Never tested live.
   Deepbrid has no cache-check API (docs: https://www.deepbrid.com/api-docs).
8. Also check the old claim that Comet's config is **AD + TB + RD** (July handoff): the 18 Nov responses showed only
   `realdebrid+alldebrid` — TorBox is not in the current Comet config (`.access/comet_config.txt` / `.env`
   `COMET_STREAM_BASE`, base64 JSON with `debridServices`; never print it, it holds API keys).

### How to reproduce / measure (no UI needed)
- Script pattern (worked Wed 18 Nov): register the main-process handlers with a fake ipcMain and call them, e.g.
  `require('./src/tmdb').registerTmdbHandlers(reg); require('./src/realdebrid').registerRealDebridHandlers(reg);`
  then `h['search-torrents']({}, { movieTitle, tmdbId, mediaType: 'tv', season, episode })` → `s.torrents`
  (`name`, `desc`, `size`, `url`, `hash`, `cached`), and `h['rd-stream-torrent']({}, { magnet, hash, url, name })`
  to resolve one (adds it to the RD account, exactly like pressing play). Ranking: `eval` `js/streaming/ranking.js`
  with a stub `window` / `localStorage`, then `window.rankTorrents(list)` where `list = torrents.map(t => ({...t,
  isRDCached: !!t.cached}))`. Redact urls in output (`/eyJ…` is the Comet config with keys).
- Comet logs (read-only): `ssh -i ~/.ssh/<vps key> ubuntu@100.67.25.118 "sudo -n docker logs --since 30m comet"`
  (containers `comet`, `comet-postgres`, `comet-vpn`; stop/start: `cd /opt/vw-comet && sudo docker compose …`).
- Each Comet search is an outside request: a handful while debugging is fine; ask before any loop over many titles
  (REQUEST_RATE_LIMITING).

---

## 2. Environment and rules that still hold

- **Debrid through Comet** (`COMET_STREAM_BASE`, Comet at `100.67.25.118:5173` behind ProtonVPN on vps-ovhcloud) for
  search and streaming; the app never calls `api.real-debrid.com` for playback. **Proxy tunnel is optional now**
  (operator, 18 Nov) for the Debrid Downloader (RD direct calls) and Deepbrid; it is used when enabled.
- **Metadata comes from the vault-raggae catalog** (`127.0.0.1:8750`, `src/raggae.js`), read through `src/tmdb.js`:
  TMDB only on a miss (ingested, then served from the catalog). Torrent search gets its IMDb id from the catalog.
- **Versions come from one place:** vault-streaming `package.json` (`node scripts/sync-version.js X.Y.Z`,
  `tests/test_version.js`); vault-raggae `pyproject.toml` (`python tools/sync_version.py X.Y.Z`). Bump on every PR.
- **Git:** branch `vw-codex-*`, PR with reviewer p-potvin, the user merges. Devin / CodeRabbit review within ~5 min;
  Auto-fix relays comments — fix, reply on the thread, resolve.
- **Windows shell traps:** backslashes in Bash heredocs get mangled (`\n`, `\d`, `\b`, `\t`): write scripts with the
  Write tool and run them. Scratchpad `.js` files run as ES modules (a parent `package.json` has `"type": "module"`):
  use `.cjs`.
- **Ledger quirk:** `record-agent-change.ps1 -Summary` rejects a literal `*` or a drive-letter token like `Q:`.
- **Public hygiene:** no adult-site names in commits, PRs, branches or public docs.

---

## 3. What shipped 18 Nov (for context)

- Catalog read-through; Discover/trending from catalog lists (`scripts/ingest-front-page.js`, scheduled 06:30/18:30 as
  `\VaultWares\Vault Streaming Front Page`).
- **TMDB backfill done** (`scripts/backfill-catalog.js`): 80,205 titles stored, 1,798 TMDB misses, 161,948 requests,
  316 min (films ≥ 600 votes, series ≥ 1,000; episodes for the top 3,000 series ≤ 500 episodes; en-US + fr-FR blobs).
  Resumable: `%LOCALAPPDATA%\VaultWares\vault-streaming\backfill-done.txt` / `backfill-misses.txt`.
- **Posters cached** by vault-raggae `python -m app.pictures catalog`: 84,014 kept (16.7 GB), 43 failed, finished
  Thu 19 Nov 00:52 (log `pictures-after-backfill.log` in the same folder). Not yet embedded for image search.
- Trailers: downloaded once, 720p AV1, `G:\VaultStreaming\trailers` (`src/trailers.js`).
- Audio language: stream tag → track title → Nemotron detection only when the stream reports nothing
  (`src/ipc/audio-tracks.ipc.js`); `qc` dropped as a language code.
- **Playback Moments:** after 2 min of playback the stream is handed to vault-raggae (`src/ipc/moments.ipc.js` →
  `POST /v1/moments/stream`), which reads it once (unthrottled since #88) for a Nemotron transcript + SigLIP/CLAP
  windows. Verified live on GoT S01E01: 370 windows, 501 cues, searchable ("winter is coming", "a direwolf pup").
  Unthrottled speed ≈ 20× real time, set by the image/sound work.

## 4. Open after this task
- Embed the 84k cached posters for image search (SigLIP, vault-raggae).
- Moments re-index of the 2,331 library videos at 10 frames (`python -m app.moments.index …`, ~11 h+ GPU; not scheduled).
- A Settings switch for `indexPlayback` (today only `appSettings.indexPlayback = false`).
- `tests/ai_separation_settings_test.js` fails on its live-subtitles assertion (pre-existing, also on main).
