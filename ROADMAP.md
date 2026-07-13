# Vault Streaming Roadmap

> [!NOTE]
> **Strategic Pivot: Transitioned towards a Streaming-Only Application**
> We have successfully expanded and refactored Vault Explorer from a hybrid local file manager into **Vault Streaming**, a dedicated cloud streaming and library tracking tool. This version drops local file management features to provide a purely focused, ultra-lean experience for TMDB discovery, media tracking, and AI-accelerated playback.

## 1. Streaming Discovery (TMDB)

- [x] Integrate TMDB trending and search APIs.
- [x] Enable bilingual TMDB metadata integration.
- [x] Rich UI with hero banners, provider filters, and dynamic backgrounds.
- [ ] Compact the header: keep the watch providers branded logos prominent, place the search bar next to them. Add a very obvious visual cue that we are either viewing only movies or only series.
- [ ] In the search bar, add a pill on the left side to indicate movies or series.
- [ ] Optimize the card layout: make the cards less tall and a slightly larger. Reduce the grid from 8 cards across to 7 for better cover art visibility.
- [ ] Sub-routing improvement: Movies and Series should become explicit sub-views for the Streaming section, replacing the top-level generic 'discover' and defaulting to the last used state.

## 2. Library & Tracking

- [x] Create the Library tab for tracking watched and currently-watching content.
- [x] Ability to save movies and TV shows from the Discover tab directly into the Library.
- [x] Ability to remove items from the Library.
- [ ] Enhanced progress tracking: automatically mark items as "watched" when viewing completes.
- [ ] Syncing and backup capabilities for the Library state.

## 3. Video Player & AI Subtitles

- [x] Integrated custom video player with real-time UI overlay.
- [x] Added persistent mini-player "Picture-in-Picture" mode.
- [x] **Live Subtitles**: Integrated local NVIDIA Parakeet-TDT model for real-time transcription.
- [x] Refactored live subtitles to stream text directly over IPC without generating local `.srt` files on disk.
- [ ] Expand translation features: Add more destination languages and custom visual styling for the subtitle overlay (font size, background opacity).

## 4. Completed Legacy Polish

- [x] Centralized SVG icon dictionary (`icons.js`).
- [x] Unified canonical themes (`Console` and `Warm` modes).
- [x] Navigation overhaul: Consolidated tabs strictly to the Streaming pill bar (Discover / Library).
