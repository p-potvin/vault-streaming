# Design: Vault Streaming

## Source of truth

- **Status:** Active
- **Last refreshed:** 2026-07-11
- **Primary product surfaces:** Desktop Electron app (Windows primary). Top-level view is strictly **Streaming** (with Discover and Library sub-views).
- **Evidence reviewed:**
  - `README.md` — product goals, feature set, FFmpeg docs
  - `index.html` — DOM structure, streaming navigation hierarchy, player modal, TMDB grid
  - `index.css` — component primitives, animation tokens, player layout, responsive breakpoints
  - `themes.css` + `themes.js` — canonical themes (Console / Warm)
  - `vaultwares-themes/CONTEXT.md` — brand voice, core token mapping, spacing rhythm

## Brand

- **Personality:** Calm, precise, human, technically rigorous. A highly curated, media-focused experience.
- **Trust signals:** Clean institutional typography, offline-first AI models (like live subtitles).
- **Avoid:** Generic neon accents, overwhelming the user with unnecessary file management complexity, alarming or overly technical jargon.

## Product goals

- **Goals:**
  1. Be the definitive streaming client for TMDB discovery and cloud playback.
  2. Provide friction-free AI-powered subtitles via local hardware inference (Parakeet-TDT).
  3. Maintain an ultra-lean, performant UI focused only on watching and discovering.
- **Non-goals:**
  1. Not a file explorer — local file management has been stripped out.
  2. Not a photo or music manager.
  3. Not a social platform.
- **Success signals:** Users can discover movies/series on TMDB, seamlessly switch between Discover and Library views, and experience real-time AI subtitles directly in the video player without disk I/O overhead.

## Personas and jobs

- **Primary personas:**
  1. **The Streamer** — Wants a clean interface to track TMDB libraries and watch cloud streams.
  2. **The Hardware Power User** — Uses local GPUs to generate real-time subtitles and upscaling for web streams.
- **User jobs:**
  - Discover new movies and TV series (Discover tab).
  - Track viewing history and current watchlists (Library tab).
  - Watch videos with real-time translation and hardware acceleration.

## Information architecture

- **Primary navigation:** Top-level pill bar offering: **Discover** | **Library**.
- **Core routes/screens:**
  1. **Discover Subtab** — TMDB browser with provider filters, trending feeds, and search functionalities.
  2. **Library Subtab** — Personal media tracking, resume-play functionality, and watch history.
  3. **Video Player Modal** — Full-screen overlay with custom controls, seek bar, subtitle selection, and real-time AI subtitle overlay.
- **Content hierarchy:**
  - Sub-Nav Bar (Discover/Library) > Main Grid (TMDB cards) > Status Bar.
  - Player modal is a fixed overlay above everything (`z-index: 10000`).

## Design principles

- **Warm / Console duality:** Console mode is the dominant default (deep purple). Warm mode is a lighter per-session alternative. Every theme must resolve both text and background contrast in either mode.
- **Cards are the atomic unit:** Streaming cards share a 28px radius, border, and unique hover-lift treatments (scale + glow).
- **Performance is a design feature:** The grid must remain responsive. Thumbnails are lazy-loaded.

## Visual language

- **Color:**
  - Canonical dark (Console): `#0b0813` bg, `#13101c` surface, `#2A2340` raised, `#B07CFF` accent.
  - Canonical light (Warm): `#F5F1E8` bg, `#FCFAF5` raised, `#D6A441` accent.
  - Cyan is retired. Blue `#4173d6` replaces cyan for focus rings and interactive affordance.
- **Typography:**
  - Display / Body: `"Inter", "Segoe UI", ui-sans-serif, system-ui, sans-serif`
  - Mono: `"JetBrains Mono", ui-monospace` — used for labels, badges, durations, and readouts.
  - Body: 13px, weight 400, letter-spacing 0.02em.
- **Spacing/layout rhythm:** 8px base grid. Card gap `24px`. Card padding `16px`. Titlebar height `32px`.
- **Shape/radius/elevation:**
  - Cards: `border-radius: 28px`, `border: 1px solid var(--vault-card-border)`.
  - Buttons: `border-radius: 4px`.
  - Elevation communicated through borders and subtle shifts, not heavy shadows.
- **Motion:**
  - Hover effects: <100ms and snappy.
  - Card entrance: `fadeInScale` 0.4s cubic-bezier(0.16, 1, 0.3, 1).

## Components

- **Existing components to reuse:**
  - `.sub-nav-pill` — capsule pills for streaming sub-navigation.
  - `.theme-trigger` — titlebar icon buttons for settings.
  - Video player modal with custom controls and real-time subtitle overlay elements.
  - TMDB cards with hover meta overlays.
- **Variants and states:**
  - Card: default, hover (scale & glow).
  - Pill: active (filled accent), inactive (transparent border).

## Content voice

- **Tone:** Calm, precise, human. Technical but accessible.
- **Terminology:**
  - "Discover" = TMDB trending and search.
  - "Library" = Tracked movies and series.
  - "Live Subtitles" = Real-time transcription (no `.srt` files involved).
