# Vault Streaming - Active TODO List

## Batch — Wed, 22 Jul 2026 (big list)

> Note: user swapped to the **castlabs Electron build + Widevine** (main.js imports `components`) — AC3/E-AC3 audio + HEVC now decode natively; DTS/TrueHD still need transcode-remux to AAC.

### P0 — bugs / regressions (do first)
- [ ] **AllDebrid/TorBox appear inactive** — no loading animation while picking a torrent, seems to default to RD. Investigate whether the multi-debrid Comet config is actually being used (needs app restart to reload `.env`?), whether the size-probe misfires on TB/AD stream URLs (flagging them placeholder → skipping to RD), and stream-object parsing for non-RD providers.
- [x] **Hover effect broken on larger cards** — hover should trigger anywhere on the card (regression after cards were enlarged / 25px padding). Fix the trigger area in `hover-card.js` / card CSS.
- [~] **Fullscreen menu disappears + cursor stuck on click action** in the video player.
- [ ] **Disk thrashing** — app writes a LOT to disk. Verify cache flushing (resolved-link cache, watch-history writes, thumbnails, any per-frame/temp writes) and stop excessive writes.
- [x] **Tray icon shows even when the setting is off** — respect `minimizeToTray`/tray setting before `createTray()`.

### P1 — features
- [x] **Transcode-to-ceiling renderer wiring** (see Active Tasks; backend done). Also hosts the <5-min duration guard + fixes DTS/TrueHD audio via `-c:a aac`.
- [x] **Dynamic search bar with debounce** — port the debounced live search from `vault-tv`.
- [x] **Double-click on video → toggle fullscreen.**
- [~] **YouTube trailer volume**: default −20%; setting to mute trailers by default; add a volume icon next to the trailer play/pause button.
- [x] **Add-to-library "+" on movie card** (top-right); fills gold on click when added.
- [ ] **Watch-status cues on cards**: one visual cue for "in watch history", a different one for "watched".

### P2 — UI / polish
- [x] **Splash**: add an overlay to hide the main container behind the splash; lengthen to ~3s.
- [x] **Header logo**: put the logo top-left of the window, next to the "Vault Streaming" text.
- [x] **Recording LED**: move the flashing LED next to the movie title (currently next to settings).
- [ ] **Settings modal redesign**: split into sections, make larger so it no longer scrolls; add Language selector inside; move region → **nationality** naming in advanced search.
- [ ] **Settings icons**: modal settings SVG icons should match the main settings icon.
- [x] **Remove Debrid Downloader button**; align the Save button to the right.
- [x] **Advanced search**: rename "Region" → "Nationality".
- [x] **Main tabs restyle**: make the 3 primary tabs visually distinct from ordinary pills.

## Active Tasks

- [x] **Transcode-to-ceiling — renderer wiring** (backend done: `src/ipc/transcode.ipc.js` + preload `transcodeStream*`/`onTranscode*`). Remaining: in `js/player/playStream`, compare `activeStreamingMedia.quality` vs `appSettings.streamQuality` (map 2160p/1080p/720p → height); if source > ceiling, play via MediaSource fed by `transcode-chunk` (codec `avc1.640029, mp4a.40.2`) instead of `vp.src = url`; show a "1080p" badge; use ffmpeg `-ss` for resume (guard the double-seek); seeking mid-stream restarts the transcode at the new position; fall back to direct playback on transcode error.
- [x] **Provider-unavailable fallback**: `stream.js` now size-probes each resolved stream (one GET Range to the Comet proxy); placeholder-sized (<50MB) results return `notCached`, which the existing `startRDDebridFlow` loop already skips to the next ranked source. Wed, 22 Jul 2026.
- [x] **Multi-debrid via Comet**: Comet config now fans out AllDebrid → TorBox → RealDebrid (manifest reports "AD+TB+RD+TORRENT"). Local-only change (`.env` COMET_STREAM_BASE + `.access/comet_config.txt`, both backed up); TorBox/AllDebrid restore real cache detection that RD lost with instantAvailability. Test: tt0133093 → 1273/1565 cached.

- [ ] **Library Sync**: Implement logic to persist the user's Library (tracked movies/series) locally in `appSettings` or a dedicated DB file.
- [ ] **Subtitle UX**: Ensure the player overlay for AI Subtitles properly handles overlapping text when multiple speakers talk simultaneously.
- [ ] **Decouple clip IPC from `main.js`**: Move the clip handler (`registerClipHandler`) out of `main.js` into its own `src/ipc/clip.ipc.js` module, matching the `system.ipc`/`media.ipc`/`subtitles.ipc` pattern.
- [x] **App icon wired**: generated `build/icon.ico` (multi-res 16–256) + `build/icon.png` from `public/vault-streaming-logo.png`; `main.js` (window + tray) and `package.json` `build.icon` already referenced `build/icon.ico` (the file was just missing). Taskbar/tray/window/installer now show the logo. Wed, 22 Jul 2026.
- [x] **Animated splash screen**: frameless branded `splash.html` (pulsing logo, shimmer bar, rotating status) shown on launch; main window created hidden and revealed on `ready-to-show` with a 1.6s minimum + 8s safety net. `main.js`.
- [ ] **RTX VSR upscaling (`upscale.js`)**: Re-add the renderer module + player control. NOTE: main-process handlers already exist (`upscale-video`, `upscale-stream-start/stop` in `src/ipc/media.ipc.js`); only the renderer UI was stripped.
- [ ] **Live / instant subtitles (Parakeet)**: Re-add the renderer UI for `parakeet-tdt-0.6b-v3` (or `parakeet-tdt_ctc-1.1b`). NOTE: main-process handlers already exist and are registered (`warm/start/stop-live-subtitles` in `src/live-subtitles.js`, `main.js:463`); the renderer button/overlay was removed in the trim.
- [ ] **OpenSubtitles download**: Reimplement remote subtitle fetch in `src/ipc/subtitles.ipc.js` (currently local sidecars only). Wire `queryTitle` + `langs` + `settings.openSubtitlesKey`; results must set `{ isOpenSubtitles: true, fileId, lang, ... }` as `js/player/subtitles.js` expects.
- [ ] **Bundle `flag-icons` in the packaged build**: dev references `node_modules/flag-icons/css/flag-icons.min.css` directly; ensure `flag-icons` (css + `flags/`) is included/unpacked in the Electron build config so flags render in the packaged app.
- [x] **Header Refresh**: Compact the top navigation area to allow more vertical space for the media grid. _(Done in the compact-toolbar redesign commit.)_
- [x] **Resume State**: Make sure leaving a movie midway through saves the timestamp in the Library so it can be resumed later. _(Playback persists `streamUrl`+position via `setWatchProgress`; Library click resumes in-progress items directly. Wed, 22 Jul 2026.)_

## Recently Completed — Wed, 22 Jul 2026

- [x] Fixed settings not saving (dead `settings-default-folder` ref threw before `saveSettings`). `js/settings/core.js`
- [x] Fixed Library tab crash from removed toolbar IDs (`search-box`/`filter-type`/`sort-by`/`btn-sort-order`). `js/favorites.js`
- [x] Library movie click now auto-plays the best cached source (skips the details modal); series open to the season screen. `js/favorites.js`
- [x] Series season picker remembers the last-watched season. `js/streaming/details-modal.js`
- [x] Direct movie play uses the movie's own poster/year for watch history (no stale thumbnail). `js/streaming/rd-flow.js`
- [x] Fixed `No handler registered for 'find-subtitles'` crash — re-added handler (local sidecar discovery, graceful `[]` for streams). `src/ipc/subtitles.ipc.js`, `main.js`, `preload.js`
- [x] Integrated the redesign-v2 icon set (99 icons) — generator `scripts/gen-icons.js` ports `redesignv2/vw-icons.jsx` → `js/icons.v2.js` (`window.iconsV2` + additive backfill of `window.icons`, preserving the 40 originals); referenced in `index.html`. Sources copied to `vaultwares-themes/vaultwares-revisited/icons/redesign-v2/`.
- [x] Replaced all hardcoded UI emoji with SVG icons. `index.html` uses `data-icon="…"` hydrated by `js/icon-hydrate.js`; JS files call `window.icons.*`. Authored two house-style icons (`palette`, `scissors`) for glyphs absent from the redesign set. Language flags (🇬🇧🇨🇦🇫🇷) now use `flag-icons` CSS (`fi fi-gb/ca/fr`). `🗗` PiP button → `pip`; `🟪` was the clip Crop tool → `crop`. Remaining emoji are code comments only.
