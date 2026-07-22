# Vault Streaming Roadmap

> [!NOTE]
> **Strategic Pivot: Transitioned towards a Streaming-Only Application**
> We have successfully expanded and refactored Vault Explorer from a hybrid local file manager into **Vault Streaming**, a dedicated cloud streaming and library tracking tool. This version drops local file management features to provide a purely focused, ultra-lean experience for TMDB discovery, media tracking, and AI-accelerated playback.

## 1. Streaming Discovery (TMDB)

- [x] Integrate TMDB trending and search APIs.
- [x] Enable bilingual TMDB metadata integration.
- [x] Rich UI with hero banners, provider filters, and dynamic backgrounds.
- [x] Compact the header: keep the watch providers branded logos prominent, place the search bar next to them. Add a very obvious visual cue that we are either viewing only movies or only series.
- [x] In the search bar, add a pill on the left side to indicate movies or series.
- [x] Optimize the card layout: make the cards less tall and a slightly larger. Reduce the grid from 8 cards across to 7 for better cover art visibility.
- [ ] Sub-routing improvement: Movies and Series should become explicit sub-views for the Streaming section, replacing the top-level generic 'discover' and defaulting to the last used state. (Partially bypassed: kept Discover and added format toggles & advanced search instead)

## 2. Library & Tracking

- [x] Create the Library tab for tracking watched and currently-watching content.
- [x] Ability to save movies and TV shows from the Discover tab directly into the Library.
- [x] Ability to remove items from the Library.
- [x] Create the Watch History tab alongside Discover and Library.
- [ ] Enhanced progress tracking: automatically mark items as "watched" when viewing completes.
- [ ] Syncing and backup capabilities for the Library state.

## 3. Video Player & AI Subtitles

- [x] Integrated custom video player with real-time UI overlay.
- [x] Added persistent mini-player "Picture-in-Picture" mode.
- [~] **Live Subtitles**: local NVIDIA Parakeet-TDT real-time transcription. _(Reconciled Wed, 22 Jul 2026: the **renderer UI was removed** in the 12 Jul streaming-only trim — see `EXTRACTION-NOTES.md`. The **main-process IPC still exists and is registered** (`warm/start/stop-live-subtitles` in `src/live-subtitles.js`, wired at `main.js`). Re-adding the renderer button/overlay is tracked in `TODO.md`.)_
- [x] Refactored live subtitles to stream text directly over IPC without generating local `.srt` files on disk. _(Historical — landed while this was still part of vault-explorer; the IPC contract survives, the UI does not.)_
- [x] **Local subtitles**: sidecar `.srt`/`.vtt` discovery via `find-subtitles` (restored Wed, 22 Jul 2026 after it was dropped in the trim).
- [ ] **OpenSubtitles download**: remote subtitle fetch not yet reimplemented after the trim (local sidecars only). Tracked in `TODO.md`.
- [ ] Expand translation features: Add more destination languages and custom visual styling for the subtitle overlay (font size, background opacity).

## 4. Completed Legacy Polish

- [x] Centralized SVG icon dictionary (`icons.js`).
- [x] Unified canonical themes (`Console` and `Warm` modes).
- [x] Navigation overhaul: Consolidated tabs strictly to the Streaming pill bar (Discover / Library).
