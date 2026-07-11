# Design

## Source of truth

- **Status:** Active
- **Last refreshed:** 2026-06-18
- **Primary product surfaces:** Desktop Electron app (Windows primary). Top-level tabs: **Files** | **Photos** | **Audio** | **Albums** | **Playlists** | **Streaming** | **Livestream** | **Misc**.
- **Evidence reviewed:**
  - `README.md` — product goals, feature set, FFmpeg docs
  - `index.html` — DOM structure, navigation hierarchy, player modal, empty states
  - `index.css` — component primitives, animation tokens, player layout, responsive breakpoints
  - `themes.css` + `themes.js` --14themelibrary--, 2 canonical themes (Console / Warm)
  - `vaultwares-themes/vaultwares-revisited/` — brand tokens, philosophy, typography
  - `vaultwares-themes/CONTEXT.md` — brand voice, core token mapping, spacing rhythm
  - `ROADMAP.md` — active feature backlog, open UI polish items
  - `.Jules/palette.md` — accessibility micro-UX decisions and patterns

## Brand

- **Personality:** Calm, precise, human, technically rigorous. Privacy-first security tooling that does not fear-monger.
- **Trust signals:** Explicit data handling copy ("We do not track you. Here is what we store, and why."), offline-first local processing, clean institutional typography.
- **Avoid:** Pure black + neon green, Matrix/terminal aesthetic for product chrome, military-grade encryption copy, hacker-coded jargon, alarming surveillance-justifying language.

## Product goals

- **Goals:**
  1. Be the definitive local media vault + home media server hybrid.
  2. Bridge powerful local AI workflows (Whisper/NeMo, ESRGAN) with frictionless cross-platform streaming.
  3. Maintain file-explorer-grade power while remaining visually approachable.
- **Non-goals:**
  1. Not a generic video player — file management and metadata richness are first-class.
  2. Not a streaming-only app — local files are the primary source of truth.
  3. Not a social/sharing platform — no user accounts, no cloud upload. **The clip function will eventually integrate sharing clips**
- **Success signals:** Users can browse, play, clip, upscale, translate, and stream without leaving the app. The UI feels fast on directories with thousands of items.

## Personas and jobs

- **Primary personas:**
  1. **The Media Hoarder** — Large local libraries, values metadata, cover art, and organization. Wants Plex/Jellyfin compatibility without a server setup.
  2. **The Privacy-First Streamer** — Uses Real-Debrid for cloud streams but wants a local, trackable UI instead of web portals.
  3. **The Hardware Power User** — Wants GPU-accelerated upscaling, audio normalization, and AI transcription without CLI knowledge.
- **User jobs:**
  - Browse and manage files (cut/copy/paste/zip/rename/properties).
  - Watch local videos with clipping, subtitle generation, and upscaling.
  - Discover movies/series and stream them via cloud or local sources.
  - Organize favorites, collections, playlists, and albums.
- **Key contexts of use:**
  - Full-screen desktop usage (keyboard-heavy).
  - Background streaming while doing other work (PiP mode).
  - Large monitor, grid-heavy browsing.

## Information architecture

- **Primary navigation:** Horizontal top tabs in the draggable titlebar: Files | Photos | Audio | Albums | Playlists | Streaming | Livestream | Misc.
- **Core routes/screens:**
  1. **Files Tab** — File grid, toolbar (browse/refresh/search/filter/sort), sub-nav pills (All Files / Collections). Favorites is a default collection (heart icon, colored like all other collections).
  2. **Photos Tab** — Masonry/river layout (variable-height columns, Pinterest-style). Double-click opens the Photo Editor modal.
  3. **Audio Tab** — Apple Music–style layout: left sidebar (Playlists only at first; Artists/Albums when music API is available), main area shows selected playlist with album art + artist picture header, tracklist below. Visualizer mode available but not default.
  4. **Albums Tab** — Album art grid / browsing surface.
  5. **Playlists Tab** — Playlist management and browsing.
  6. **Streaming Tab** — TMDB browser with provider filters, search, sub-nav pills (Discover / Library).
  7. **Livestream Tab** — Stream URL input, translation telemetry console.
  8. **Misc Tab** — Uncategorized files and catch-all content.
  9. **Video Player Modal** — Full-screen overlay with custom controls, seek bar, speed/subtitle/quality menus, PiP toggle, clip export.
  10. **Photo Editor Modal** — Fullscreen modal with tools on bottom and left, large canvas on the right. Filmstrip for folder navigation.
- **Content hierarchy:**
  - Titlebar (drag region) > Top Tabs > Toolbar / Sub-Nav > Main Grid / Content > Audio Bar (if open) > Status Bar.
  - Player modal is a fixed overlay above everything (`z-index: 10000`).
  - Photo Editor modal overlays at `z-index: 10001`.
  - Settings/Theme panels float above all (`z-index: 100002`).

## Design principles

- **Warm / Console duality:** Console mode is the dominant default. Warm mode is a per-session alternative. Future VaultWares apps will diversify beyond deep purple to avoid palette fatigue. Every theme must resolve both text and background contrast in either mode.
- **Cards are the atomic unit:** File cards, streaming cards, and album art all share the same 28px radius, border, and hover-lift treatment. Consistency here reduces cognitive load across tabs.
- **Hover effects are tab-specific:** The Streaming tab's hover treatment (scale + glow) is unique to that surface. Files, Photos, and Audio each have their own distinct hover affordance — do not replicate the Streaming effect elsewhere.
- **Progressive disclosure for power:** Basic users see a clean grid. Power users discover keyboard shortcuts, context menus, clip export, and hardware AI workflows.
- **Performance is a design feature:** The grid must remain responsive with thousands of items. Lazy previews, idle FFmpeg pipelines, and virtualized scrolling are expected.

## Visual language

- **Color:**
  - Canonical dark (Console): `#0b0813` bg, `#13101c` surface, `#2A2340` raised, `#B07CFF` accent.
  - Canonical light (Warm): `#F5F1E8` bg, `#FCFAF5` raised, `#D6A441` accent.
  - Signal palette: `#6BE675` (success), `#4173d6` (info / focus), `#F0B94B` (warning), `#FF6B7A` (error).
  - Cyan is retired. Blue `#4173d6` replaces cyan for focus rings, interactive affordance, and info states.
  - 14 additional community themes map to `--vt-*` tokens.
- **Typography:**
  - Display / Body: `"Inter", "Segoe UI", ui-sans-serif, system-ui, sans-serif`
  - Mono: `"JetBrains Mono", ui-monospace, SFMono-Regular, monospace` — **used extensively** for labels, badges, metadata, status text, toolbar items, durations, file sizes, and any technical readout.
  - Titlebar: 11px, weight 600, uppercase, letter-spacing 0.05em. **Mono.**
  - Body: 13px, weight 400, letter-spacing 0.02em.
  - Labels / Badges: 10px, weight 600–700, uppercase, letter-spacing 0.05–0.1em. **Mono.**
- **Spacing/layout rhythm:** 8px base grid. Toolbar padding `12px 24px`. Card gap `24px`. Card padding `16px`. Titlebar height `32px`. Status bar padding `8px 24px`.
- **Shape/radius/elevation:**
  - Cards: `border-radius: 28px`, `border: 1px solid var(--vault-card-border)`.
  - Buttons / Inputs: `border-radius: 4px`.
  - Pills: `border-radius: 20px`.
  - Elevation is communicated through borders and subtle background shifts, not heavy drop-shadows.
- **Motion:**
  - User-driven actions (clicks, hovers, panel switches): snappy, minimal. Hover <100ms. No sluggish transitions.
  - Card entrance: `fadeInScale` 0.4s cubic-bezier(0.16, 1, 0.3, 1), staggered by index.
  - Passive animations (LEDs, spinners, notifications, visualizers): slower, relaxed, "chill" feel.
  - Player controls: opacity fade 0.3s ease.
  - Idle auto-hide: 2s mouse-idle timer hides controls + cursor.
- **Imagery/iconography:**
  - **Custom commissioned icon set** — defining feature is a small gap on the longer edge of every icon shape. Convert React components to inline SVG for vanilla Electron stack.
  - No external icon font dependency.
  - Thumbnails: 16:9 aspect ratio, `object-fit: cover`, subtle contrast + saturation boost.

## Components

- **Existing components to reuse:**
  - `.file-card` — 28px radius, thumbnail container, filename clamp (2 lines), duration badge, size badge, checkbox overlay.
  - `.top-tab` / `.sub-nav-pill` — capsule pills for primary and secondary navigation.
  - `.theme-trigger` — titlebar icon buttons (settings, language, theme).
  - `.toast-container` / `.toast` — bottom-right notification stack with success/error variants.
  - `.empty-state` — centered icon + heading + description + CTA button pattern.
  - Video player modal with `#custom-controls`, `#player-topbar`, seek bar, PiP overlay.
- **New/changed components (per ROADMAP):**
  - **Audio Bottom Bar** — Thin, full-width persistent bar (closeable). Shows track info + play/pause + progress + volume. Appears once user opens it; video player closes it; photo fullscreen hides it; photo edit mode leaves space for it.
  - **Audio View** — Left sidebar (Playlists tree) + main area (selected playlist tracklist or visualizer). Visualizer always occupies main space but building a compelling interactive one is low priority.
  - **Photo Editor Modal** — Fullscreen. Tools dock bottom and left. Canvas is spacious on the right. Filmstrip of folder photos at bottom.
  - Image viewer with zoom, crop, pan, gallery/slideshow modes.
  - Minimal audio player + playlist queue system with shuffle/loop.
- **Variants and states:**
  - Card: default, hover, selected, `.in-library` (gold border + glow), `.fake-folder` (dashed border).
  - Button: default, hover (`translateY(-1px)`), focus-visible (2px solid `#4173d6` outline, `outline-offset: 2px`), disabled (opacity 0.5).
  - Pill: active (filled accent), inactive (transparent border).
- **Token/component ownership:** `vaultwares-themes` submodule owns canonical tokens. `index.css` owns app-specific component overrides. `themes.css` owns the 14-theme variable blocks.

## Accessibility

- **Priority note:** Responsive behavior and interaction polish are higher priority than accessibility. Accessibility improvements are deferred to final polish phase.
- **Target standard:** WCAG AA (4.5:1 body contrast minimum). Aim for AAA where possible on primary text.
- **Keyboard/focus behavior:**
  - All interactive elements must have `:focus-visible` outline (`2px solid var(--vault-blue)`, `outline-offset: 2px`). Blue `#4173d6` replaces the retired cyan.
  - Custom dialogs must restore focus to trigger on close.
  - Custom modals (player, settings) need `tabindex="-1"` + programmatic `.focus()` on open.
  - Grid cards need `tabIndex="0"` and Space/Enter keydown handlers.
  - Hover-revealed children must also respond to `:focus-within`.
- **Contrast/readability:**
  - Console mode text on surface must exceed 4.5:1.
  - Warm mode uses `#161320` on `#F5F1E8` for ~12:1 ratio.
- **Screen-reader semantics:**
  - Loading overlays: `role="status"`, `aria-live="polite"`.
  - Custom modals: `role="dialog"`, `aria-modal="true"`, `aria-label`.
  - Icon-only buttons: `aria-label` + `title` tooltip for sighted users.
  - Sort/filter controls: `aria-label` on `<select>` and trigger buttons.
- **Reduced motion and sensory considerations:**
  - Respect `prefers-reduced-motion` for card entrance animations and spinner animations.
  - Audio visualizers should be decorative, not required for functionality.

## Responsive behavior

- **Supported breakpoints/devices:**
  - Primary: Desktop 1280px+ (large monitor grid browsing).
  - Secondary: Desktop 800–1279px (smaller window / laptop).
  - Minimum viable: 600px width (graceful degradation, not primary target).
- **Layout adaptations:**
  - Player controls: `@media (min-width: 800px)` shows full seek bar + time display; below 800px wraps controls and shows compact time labels.
  - Streaming toolbar: flex-wrap currently allowed, but ROADMAP wants compact single-row header.
  - Grid: `repeat(auto-fill, minmax(240px, 1fr))` adapts naturally.
- **Touch/hover differences:**
  - Hover previews (video trickplay) are desktop-only. Touch devices should tap-to-preview or skip.
  - Player idle auto-hide is mouse-movement based; touch should use a tap timer.

## Interaction states

- **Loading:** `.spinner` (48px, rotating border) + status message. Progress bar for directory scanning.
- **Empty:** `.empty-state` with icon, heading, description, and CTA button (e.g., "Browse Vault").
- **Error:** Toast notification with `.toast.error` border color. Console error messages in monospace for technical contexts.
- **Success:** Toast with `.toast.success` border color. Clipboard operations show green upward fade pill.
- **Disabled:** `opacity: 0.5`, `cursor: not-allowed`, and `title` explaining why (e.g., "No folder selected").
- **Offline/slow network:** Not currently a distinct state. Open question: should Real-Debrid streams show buffering/retry UI?

## Content voice

- **Tone:** Calm, precise, human. Technical enough to be trustworthy, simple enough to not alienate.
- **Terminology:**
  - "Vault" = local file storage.
  - "Streaming" = TMDB discovery + cloud streams.
  - "Collections" = video groupings. "Playlists" = music groupings. "Albums" = photo groupings.
  - "Clipping" = exporting a video segment (not "cutting" or "trimming" to avoid editor confusion).
- **Microcopy rules:**
  - Use sentence case for descriptions, title case for buttons and labels.
  - Placeholder text should surface keyboard shortcuts where applicable (e.g., "Search files… (Ctrl/Cmd+F)").
  - Action confirmations should state the outcome, not just the action ("Clip saved to Videos" not "Export complete").

## Implementation constraints

- **Framework/styling system:**
  - Electron + vanilla HTML/CSS/JS. No React, Vue, or other component framework.
  - CSS custom properties (`--vault-*` and `--vt-*`) are the design token layer.
  - `index.css` is the canonical app stylesheet; `themes.css` holds theme variable blocks.
- **Design-token constraints:**
  - Never use raw hex values — always reference `--vault-*` or `--vt-*` tokens.
  - Warm/Console shell classes (`.vw-warm-shell`, `.vw-console-shell`) override the token map at the body level.
- **Performance constraints:**
  - Grid must handle 1000+ cards without jank. Use `content-visibility` or virtual scrolling if needed.
  - Thumbnail generation is offloaded to FFmpeg idle timer (60s) and ImageMagick adaptive-sharpen pipeline.
  - Player modal reuses a single `<video>` element, not per-card instances.
- **Compatibility constraints:**
  - Windows primary. macOS/Linux supported but secondary.
  - Electron 41.x. Node.js built-ins available in main + preload.
- **Test/screenshot expectations:**
  - Playwright is listed as a devDependency. Visual regression should cover: grid layout, player modal, theme switching, empty states.
  - ROADMAP indicates screenshot/QA expectations for feature polish.

## Open questions

- [ ] **Mobile/TV viewport target** — The README mentions cross-platform streaming access across phones and TVs. Is there a planned web-based media server UI (separate from the Electron app), and if so, should it share this DESIGN.md or have its own? / Owner: Product / Impact: Responsive breakpoint and touch strategy.
- [ ] **Custom icon set integration** — User has commissioned icons with a "gap on the longer edge" style. Need to convert React components to inline SVG and integrate into the vanilla JS stack. / Owner: Design / Impact: Icon system and component library.
- [ ] **Music API for Artists/Albums** — Audio sidebar is playlists-only until a music metadata API (MusicBrainz, Last.fm, etc.) is integrated. / Owner: Product / Impact: Audio view sidebar content.
- [ ] **Photo editor toolset** — "New Windows Photos and more" — need to define exact tool list (crop, rotate, filters, adjustments, markup, etc.). / Owner: UX / Impact: Photo editor toolbar design.

## Future features (backlog)
- **Segmented settings** — Break the monolithic settings panel into tabbed sections (General, Playback, Appearance, Shortcuts, Network).
- **Keyboard shortcuts mapper** — Allow users to remap shortcuts inside the settings panel.
- **Subtitles editor** — Inline subtitle timing and text editing, synced with the video player.
- **Video player context menu** — Right-click on video canvas for quick actions (speed, subtitles, audio track, PiP, clip start/end).
