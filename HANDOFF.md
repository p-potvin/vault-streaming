# Vault Streaming — Session Handoff

**Last updated:** Wed, 22 Jul 2026 16:20
**Branch:** `main` — all work committed & pushed. **Current version: v1.7.1** (`6a82cdb`).

> Read this first, then `TODO.md` (prioritized backlog) and `PLAN-2026-07-22.md` (deep dives on TMDB/Comet).

---

## 1. Environment & hard constraints (don't relearn the hard way)

- **Electron:** user swapped to the **castlabs build + Widevine** — `main.js` imports `components` and calls `await components.whenReady()` before creating windows. Consequence: **AC3/E-AC3 audio + HEVC video decode natively now.** DTS/TrueHD still don't (Chrome never had them) → handled by the transcode remux to AAC.
- **Debrid is Comet-only.** STRICT single-IP policy: never call Real-Debrid / AllDebrid / TorBox / Torrentio directly. Everything goes through Comet at `http://100.67.25.118:5173`. The stream-resolve path (`src/realdebrid/stream.js`) deliberately does **not** HEAD or follow URLs to the debrid CDN.
- **Comet multi-debrid config is LOCAL ONLY** (holds API keys, gitignored): `.env` `COMET_STREAM_BASE` + `.access/comet_config.txt`. Both were **backed up** with timestamps before editing. Order: **AllDebrid → TorBox → RealDebrid**. Manifest reports `VaultWaresMedia | AD+TB+RD+TORRENT`. The config blob is **plain base64 JSON** with a `debridServices` array, so it's reconstructable (see the scratchpad scripts referenced in the ledger).
- **`.gitattributes` enforces LF.** CRLF→LF warnings on commit are cosmetic (working-tree only; committed blobs are LF).
- **Versioning protocol:** every push to `main` bumps `package.json` version **and** the `<!-- vX.Y.Z -->` comment in `index.html`.
- **Ledger script quirk:** `record-agent-change.ps1 -Summary` chokes on a literal `*` or a drive-letter-colon token like `Q:` (a guard reads them as paths). Avoid those in summaries.
- **flag-icons** is referenced via `node_modules/flag-icons/...` — works in dev, **needs bundling/asarUnpack for the packaged build** (TODO).

---

## 2. What shipped this session (v1.4.0 → v1.7.1)

- **Crash fixes:** settings-not-saving + Library-tab crash (dead Vault-Explorer DOM IDs); re-added the `find-subtitles` handler (`src/ipc/subtitles.ipc.js`).
- **TMDB boot "Unknown error"** — real bug: `renderTMDB` lost its `else` in the advanced-search commit, so boot Discover ran neither search nor discover. Restored `if(query) search else discover`.
- **Library UX:** movie click auto-plays best cached source; series open to season screen and remember last-watched season; direct-play uses the movie's own poster/year.
- **Ranking:** quality no longer biases selection (cache/health/release/language only, prefers highest quality); removed the upper-size penalties. Quality is now a **playback ceiling**.
- **Multi-debrid via Comet** (AD+TB+RD) — restores real cache detection RD lost when it killed `instantAvailability`. Test: `tt0133093` → 1273/1565 cached.
- **Placeholder guard:** `stream.js` size-probes each resolved stream (GET Range to the Comet proxy); `<50MB` → `notCached`, and `startRDDebridFlow` already falls through to the next ranked source.
- **Icons:** full 99-icon redesign-v2 set ported via `scripts/gen-icons.js` → `js/icons.v2.js`; **all UI emoji replaced** (data-icon hydration in HTML via `js/icon-hydrate.js`, `window.icons.*` in JS); flags via `flag-icons`.
- **App icon + splash:** generated `build/icon.ico`/`.png` from the logo (taskbar/tray/window/installer); `splash.html` + in-app boot overlay (~3s).
- **Transcode-to-ceiling** (v1.6.0) — see §3.
- **Search:** 380ms debounced live search. **Fullscreen:** idle-hide won't fire while a player menu is open; double-click toggles fullscreen.
- **Wins:** trailer volume −20% + Mute Trailers setting; add-to-library "+" on cards; recording LED next to title; squared underline main tabs.
- **Settings redesign:** 2-column grouped modal (`min(820px,94vw)`), no scroll, full-width Save; Mute Trailers checkbox; unified settings gear.

---

## 3. NEEDS RUNTIME VERIFICATION (highest risk first)

1. **Transcode pipeline (v1.6.0)** — never runtime-tested. Backend `src/ipc/transcode.ipc.js` (ffmpeg: `-hwaccel cuda` NVDEC → `h264_nvenc`/`libx264` → AAC → fragmented MP4). Renderer `js/player/transcode.js` (MediaSource consumer). Hooked in `playStream`: if source height > Max Stream Quality ceiling, plays transcoded; else direct. Watch for: **fMP4/MSE codec-string compatibility** (`avc1.640029, mp4a.40.2`), **seek-as-restart**, the **NNNNp badge** (click = force Original), and the **quality menu** (native picks set `_qualityOverride` to bypass the ceiling). It **fail-safes to direct playback** on any error. Test on a 4K title with a 1080p ceiling.
2. **Multi-debrid** — user reported "AllDebrid/TorBox seem inactive, defaults to RD." My tests show the config is live (manifest AD+TB+RD) and TorBox streams resolve (206, real sizes), so the likely cause is a **stale `.env` in the running build (needs restart/rebuild)**. Added a **`[Comet] provider breakdown:` console log** — confirm it shows TB/AD counts after restart.
3. **Settings modal / card "+" / tab look / splash overlay** — visual; confirm layout + no scroll.

---

## 4. Open, unstarted or partial (from `TODO.md`)

**P0 bugs**
- **Fullscreen "cursor stuck on click action"** — `[~]`; `mousedown` already re-wakes, so it needs a concrete repro (what exactly was clicked).
- **Disk thrashing** — uninvestigated. Check: resolved-link cache, watch-history writes, thumbnails, temp writes.

**P1 features**
- **Watch-status card cues** (#17) — cross-reference cards against watch history (in-history vs watched). Needs a `getWatchHistory` fetch + lookup at card render.
- **Trailer volume/mute button** next to the trailer play button (the −20% + Mute setting are done; the inline control isn't).

**Older backlog:** decouple clip IPC from `main.js`; re-add RTX VSR renderer (`upscale.js`; main handlers exist); re-add Parakeet live-subs renderer (main handlers registered); OpenSubtitles remote download in `subtitles.ipc.js` (local sidecars only today); bundle flag-icons for packaging; Library sync/backup.

---

## 5. Recommended next-session order

1. Get the user's **runtime results** on the transcode (a 4K title) and the **provider-breakdown log** after restart — fix whatever those surface.
2. **Watch-status card cues** (self-contained, high user value).
3. **Disk-thrashing** investigation.
4. Trailer volume button; then the RTX-VSR / Parakeet renderer re-adds.
