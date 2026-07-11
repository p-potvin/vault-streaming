# TASKS.md
<!-- run_id: vw-2026-05-20-001 -->
<!-- goal: Revamp Vault Explorer visual layout and implement robust backend IPCs for file management and WebM previews -->
<!-- approved_by: USER -->
<!-- approved_at: 2026-05-20T09:20:00-04:00 -->

## H1 [x] Update TODO.md and ROADMAP.md
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: TODO.md, ROADMAP.md -->
<!-- ESTIMATE: 5min -->
Update the root-level hygiene tracking files to reflect this multi-agent execution phase.

## 1 [x] Implement Main Backend IPCs and Handlers
<!-- TASK_TYPE: CLOUD -->
<!-- FILE_SCOPE: main.js, preload.js -->
<!-- PARALLEL: 2 -->
<!-- BLOCKS: 3 -->
<!-- ESTIMATE: 60min -->
Add backend handlers in `main.js` and their `preload.js` bridges for file cut/copy/paste, zip selection, properties, idle WebM generation, and smart folder size calculation. Update context menu handlers to reflect new visual semantics (removing 'fake').

### 1a [x] Symlink and Context Menu IPCs
<!-- TASK_TYPE: CLOUD -->
<!-- FILE_SCOPE: main.js, preload.js -->
<!-- PARALLEL: 1b -->
Implement symlink deletion (using `fs.rmdirSync`), update context menu names (Fake -> Folder), and implement cut/copy clipboard internal tracking.

### 1b [x] Heavy Compute IPCs (ZIP, Size, Properties)
<!-- TASK_TYPE: CLOUD -->
<!-- FILE_SCOPE: main.js, preload.js -->
<!-- PARALLEL: 1a -->
<!-- BLOCKS: 1c -->
Implement PowerShell ZIP archival, Everything-backed folder size calculations with fallback cache, and ffprobe-backed file properties retrieval.

### 1c [x] Background FFmpeg Idle Previews
<!-- TASK_TYPE: CLOUD -->
<!-- FILE_SCOPE: main.js, preload.js -->
<!-- BLOCKS_ON: 1b -->
Remove eager `schedulePreviewGeneration` from directory scans, and implement the new `schedule-idle-previews` IPC that sequentially manages preview generation queue.

## 2 [x] Frontend Revamp and Layout Restructuring
<!-- TASK_TYPE: CLOUD -->
<!-- FILE_SCOPE: index.html -->
<!-- PARALLEL: 1 -->
<!-- BLOCKS: 3 -->
<!-- ESTIMATE: 60min -->
Update `index.html` layout: shrink titlebar to 32px, align buttons left, implement icon-based toolbar, replace select dropdowns with styled buttons, implement arrow key list focus navigation, F5/Esc keyboard shortcuts, and idle timers.

### 2a [x] Titlebar and Toolbar Restructuring
<!-- TASK_TYPE: CLOUD -->
<!-- FILE_SCOPE: index.html -->
<!-- PARALLEL: 2b, 2c -->
Shrink titlebar, move action items to the left, remove "aultWares" text from logo. Move folder and refresh buttons to `.toolbar` as icons. Replace sort order select with an icon button.

### 2b [x] List Navigation and Metadata Features
<!-- TASK_TYPE: CLOUD -->
<!-- FILE_SCOPE: index.html -->
<!-- PARALLEL: 2a, 2c -->
Implement ArrowLeft/Right/Up/Down grid navigation. Add duration/file type metadata badges to `.file-card`.

### 2c [x] Frontend Modals and Clipboard Notifications
<!-- TASK_TYPE: CLOUD -->
<!-- FILE_SCOPE: index.html -->
<!-- PARALLEL: 2a, 2b -->
Implement the green upward-animating clipboard toast, the properties modal, and the idle timer logic firing after 60s of inactivity to call background FFmpeg preview queue.

## 3 [ ] Playwright Visual QA and Verification
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: tests/gui.spec.js -->
<!-- BLOCKS_ON: 1, 2 -->
<!-- ESTIMATE: 30min -->
Write and run Playwright tests for `index.html` using Electron. Establish visual regression baselines and verify hover, focus states, titlebar arrangements, and bilingual text lengths.

**Note (2026-05-30):** Started smoke-testing with Gemini Code Assist integration. Created draft PR #34 to test Gemini Code Assist for GitHub. CodeQL checks in-progress; no Gemini bot response yet. Branch: `vw-codex-gemini-test`.

### 3t [ ] Run GUI Visual Regression
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: tests/gui.spec.js -->
<!-- BLOCKS_ON: 1, 2 -->
Execute `toHaveScreenshot` and verify contrast ratios and bilingual alignment.

---

## Phase 2: Redesigned Tabs & Media UX (in progress)

### 2.1 [x] Fix startup bug from stale `vault` tab
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: js/app.js, js/navigation/tabs.js, js/settings/core.js, js/navigation/directory.js, js/navigation/idle.js -->
Replaced old `vault` tab references with `files`, added backward-compat redirect, and fixed the window startup failure.

### 2.2 [x] Photos tab + Photo Editor
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: js/photos.js, js/photo-editor.js, index.html -->
- Photos tab: masonry river layout for images, double-click opens editor.
- Photo Editor: modal with canvas, zoom, filmstrip, rotate, flip, brightness/contrast/saturation, grayscale/sepia/invert, reset, save-to-download.

### 2.3 [x] Audio tab + Audio Bottom Bar
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: js/audio.js, js/audio-bar.js, index.html -->
- Audio tab: sidebar playlists, tracklist, double-click to play.
- Audio Bottom Bar: play/pause, prev/next, seek, volume, real HTML5 audio playback.

### 2.4 [x] Albums, Playlists, and Misc tabs
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: js/albums.js, js/playlists.js, js/misc.js, index.html -->
- Albums: image groups by folder, clickable cards that jump to Photos filtered by album.
- Playlists: audio groups by folder, clickable cards that jump to Audio filtered by playlist.
- Misc: non-media/uncategorized files grid with document icons.

### 2.5 [ ] Next: Video player context menu
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: js/player/player.js, index.html -->
<!-- ESTIMATE: 45min -->
Right-click menu on the video canvas for speed, audio track, subtitles, PiP, clip start/end markers.

### 2.6 [ ] Settings panel segmentation
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: js/settings/core.js, index.html -->
<!-- ESTIMATE: 45min -->
Break the monolithic settings panel into tabbed sections (General, Playback, Appearance, Shortcuts, Network).

### 2.7 [ ] Custom icon set integration
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: js/icons.js, index.html, css -->
<!-- ESTIMATE: 60min -->
Replace generic inline SVGs with the VaultWares custom icon set where appropriate.

### 2.8 [ ] Keyboard shortcut mapper
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: js/navigation/keybindings.js, js/settings/core.js -->
<!-- ESTIMATE: 60min -->
Allow users to view and rebind keyboard shortcuts from the settings panel.

### 2.9 [x] Default home tab setting (Vault/Files)
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: js/app.js, js/settings/core.js, index.html -->
<!-- ESTIMATE: 15min -->
Default boot tab is `files` (Vault). Updated settings dropdown to include all redesigned tabs and added validation so legacy/invalid values fall back to Vault safely.

### 2.10 [x] Hide Photos tab; unify Albums/Photos section
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: js/albums.js, js/photos.js, index.html, js/navigation/tabs.js -->
<!-- ESTIMATE: 45min -->
Removed Photos from top-level navigation. Albums tab now hosts both the album grid and a photo river view with a "Back to Albums" button. Deleted standalone `photos-container` from layout.

### 2.11 [x] Empty states with folder chooser
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: js/utils.js, js/albums.js, js/audio.js, js/playlists.js, js/misc.js -->
<!-- ESTIMATE: 30min -->
All empty states now include a "Choose Folder" button. Clicking it opens the system picker, loads the folder, and saves it as the tab-specific default.

### 2.12 [x] Per-tab default folders
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: js/utils.js, js/navigation/tabs.js, js/navigation/filters.js, js/settings/core.js, index.html -->
<!-- ESTIMATE: 45min -->
Each media tab (Audio, Albums, Playlists, Misc) can have its own default folder. Falls back to the global Vault folder if unset. Added settings UI section and auto-load on first tab visit.

### 2.13 [x] Settings folder inputs: icon inside, no browse button
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: index.html, js/settings/core.js -->
<!-- ESTIMATE: 20min -->
Default folder inputs now show a folder icon on the left inside the input. Removed the separate Browse button; clicking the input wrapper opens the picker.

### 2.14 [x] Default Favorites virtual folder
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: js/navigation/virtual-folders.js, js/app.js -->
<!-- ESTIMATE: 15min -->
A `Favorites` collection virtual folder is created automatically on startup and is protected from removal.

### 2.15 [x] Fix first-load default folder bug
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: js/navigation/tabs.js, js/utils.js, js/navigation/filters.js -->
<!-- ESTIMATE: 30min -->
Media tabs now load their own default folder on every switch, falling back to the global Vault folder. Removed the first-visit flag that could skip loading after settings changes.

### 2.16 [x] Fix missing streaming poster fallback
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: public/poster_placeholder.svg, js/tmdb.js, js/streaming/details-modal.js, src/tmdb.js -->
<!-- ESTIMATE: 15min -->
Replaced all `oppenheimer_poster.png` and `dune_poster.png` fallbacks with a real `public/poster_placeholder.svg` asset.

### 2.17 [x] Audio → Music Playlists; Albums → Photo Albums; Misc before Streaming; remove Playlists tab
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: index.html, js/navigation/tabs.js, js/navigation/filters.js, js/app.js, js/utils.js, js/settings/core.js, js/audio.js, js/albums.js -->
<!-- ESTIMATE: 45min -->
Renamed top tabs, removed the Playlists tab, reordered Misc before Streaming, and updated default-folder settings and startup tab validation to match the new names.

### 2.18 [x] Kill all vault-explorer processes on close
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: main.js -->
<!-- ESTIMATE: 30min -->
Implemented Windows-only cleanup that kills all `vault-explorer.exe` processes (including the current one) when the app closes via X, tray Quit, or graceful End Task. Startup also cleans up any orphaned processes from previous bad exits.

### 2.19 [x] Remove Browse button from top toolbar
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: index.html, js/navigation/directory.js, js/navigation/filters.js, js/app.js, tests/refactor_smoke_test.js, tests/comprehensive_test.js -->
<!-- ESTIMATE: 20min -->
Removed the standalone `Browse` button from the second toolbar. The path display now contains the folder icon on the left (matching the settings inputs) and is clickable to browse. Updated translation wiring, empty-state buttons, and smoke tests.

### 2.20 [x] Pin Favorites folder, yellow star, sync favorited videos
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: js/navigation/virtual-folders.js, js/app.js, js/favorites.js, js/navigation/filters.js, js/navigation/card.js -->
<!-- ESTIMATE: 30min -->
Pinned the Favorites virtual folder to the top of folder lists. Rendered it with a yellow star icon instead of the generic folder icon. Added `vf.syncFavorites()` to keep the Favorites folder in sync with `appSettings.favorites` (videos/encrypted/streaming entries). Wired sync on startup and after every favorite toggle.

### 2.21 [x] Video pills, no size decimals, inline add-to-folder menu, enhance 4058 logging
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: js/navigation/card.js, js/utils.js, js/navigation/virtual-folders.js, js/navigation/card-events.js, src/ipc/media.ipc.js -->
<!-- ESTIMATE: 45min -->
Populated the duration badge and kept the size badge for video cards. Removed decimals from `formatBytes`. Replaced the central add-to-folder modal with an inline menu anchored to the plus button: lists recent collections (Favorites pinned first), scrollable, includes a "Create new..." fallback. Added recency tracking (`lastUsed`) to virtual folders. Added defensive path logging and early `.venv`/script checks for the context-menu video enhancement flow to help diagnose ENOENT (Windows 4058).

### 2.22 [x] Size decimals for GB only, Real-ESRGAN model path, idle preview fixes
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: js/utils.js, src/ipc/media.ipc.js, js/navigation/idle.js, src/previews.js, js/progress.js, js/app.js -->
<!-- ESTIMATE: 45min -->
`formatBytes` now shows decimals only for GB/TB. Real-ESRGAN image enhancement explicitly resolves and passes the `tools/models` directory so the `realesrgan-x4plus.bin` model is found; it also scans that directory for any `.safetensors` model (preferred) or `*Nomos*.bin` model and uses it when present. Rewrote the idle preview runner: after 60s of inactivity it crawls `window.allItems` for videos without `hoverWebm`, queues 10 missing previews immediately, then another 10 every 30s while still idle, until no missing previews remain. The backend PriorityQueue executes those 10 queued jobs one at a time (sequentially). Fixed the stuck "Generating Previews: 0/0 (0%)" alert by sending a final `isBatchComplete` event with real totals before resetting counters.

### 2.23 [x] Harden preview generation against stale paths and atomic rename failures
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: src/previews.js, js/navigation/card-events.js -->
<!-- ESTIMATE: 30min -->
Improved preview generation diagnostics and robustness. Added path logging in `generateThumbAndPreview`, `generate-webm`, and the context-menu handler. Added an explicit input-video existence check in the `generate-webm` IPC handler. Kept the atomic temp-file strategy: ffmpeg writes to `.tmp` files and only renames them to the final `.jpg`/`.webm` on success; old previews are never deleted before generation. Atomic rename failures now throw instead of silently logging, and a final existence check ensures previews are actually present before reporting success. This prevents passive generation from claiming success while leaving no thumbnail/webm.

### 2.25 [x] Harden AI enhancements against crashes with atomic temp files and stale temp cleanup
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: src/ipc/media.ipc.js, src/previews.js, src/scanner.js, src/utils.js, main.js, python-scripts/rtx_vsr_stream.py, python-scripts/audio_normalize.py -->
<!-- ESTIMATE: 60min -->
Made every enhancement path crash-safe by writing to `.tmp` files first and only renaming them to the final output on success. Updated RTX VSR (`python-scripts/rtx_vsr_stream.py`) and audio normalization/subtitles/translation (`python-scripts/audio_normalize.py`) to use atomic temp files. Hardened image enhancements (Real-ESRGAN, ImageMagick, thumbnail enhancement) in `src/ipc/media.ipc.js` and `src/previews.js`. Added reusable `cleanupTemp` / `promoteTempFile` helpers in `src/utils.js`. Updated `src/scanner.js` to treat `meta.json` as the source of truth for `enhancedPath`, so an existing partial file is never exposed as a completed enhancement. Added startup cleanup in `main.js` that removes stale `.tmp` files from `.thumbs` and `.enhanced` under every configured vault folder. Smoke test and Python syntax check passed.

### 2.24 [x] Context menu inside the video player
<!-- TASK_TYPE: LOCAL -->
<!-- FILE_SCOPE: src/ipc/system.ipc.js, js/player/player.js -->
<!-- ESTIMATE: 45min -->
Added a native right-click context menu inside the video player. It includes playback controls (Play/Pause, Mute, Playback Speed, Picture-in-Picture, Fullscreen), local file operations (Show in Explorer, Copy Path, Properties), and AI Enhancements (Enhance Audio, Generate Subtitles, Translate, Enhance Video) plus Generate Preview. Streaming sources get only playback controls and Copy Stream URL. The `handlePlayerContextMenu` helper in `js/player/player.js` dispatches the selected action, reusing existing language/enhancement dialogs and IPC endpoints.

**Note (2026-06-19):** Smoke tests passed. All redesigned tabs have real content renderers. Ledger events recorded.
