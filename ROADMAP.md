# Vault Explorer Roadmap

> [!NOTE]
> **Strategic Pivot: Transitioning towards a Unified Home Media Server**
> We are expanding Vault Explorer from a desktop media vault and local AI workstation into a hybrid, decentralized Home Media Server. Our objective is to bridge powerful local hardware AI workflows (Parakeet transcription, ESRGAN upscaling, custom search indexing) with frictionless, cross-platform streaming access across phones, TVs, and web browsers.

## 1. Vault Tab (Windows File Explorer)

- [x] Context menus (Open Folder, Remove Folder, Zip/Delete/Properties)
- [x] Paste-files and zip-selection IPC handlers
- [x] Popover menu for sorting
- [x] Keyboard shortcuts (F5, Ctrl+A/V, F2, Delete, Ctrl+N)
- [x] Properties modal (frontend)
- [x] Implement missing backend IPC handler: `get-file-properties`
- [x] Implement missing backend IPC handler: `get-folder-size-smart`
- [x] Implement missing backend IPC handler: `schedule-idle-previews`
- [x] FFMPEG idle timer (60s) in renderer for previews
- [x] Arrow key grid navigation
- [x] Escape key back navigation
- [x] Clipboard notification pill (green upward fade)
- [x] Add the ability to rename a video while it is playing. Also re-add the rename function in the context menu.
- [x] Add a way to generate subtitles while watching a video.
- [ ] Add an image viewer with zoom, crop, pan, resize, basic photo manipulation, gallery view, slideshow view.
- [ ] Add a minimal audio player (could fit in the bottom bar),a playlist system, a queue system with random shuffle, and loop.
- [ ] It should have a "playlist" view mode with 1 song per line showing name, artist, album, duration, etc. At the top left is top name of the playlist with an image (taken from an open API or local files),on the right we could toggle the audio visualizer. Think very much like apple music on windows.
- [ ] Add an "editing" view mode, for images only. Picture in the middle, toolbars at the top and bottom and other pictures on each side to allow quick switching between images or batch editing. Something different than the millions of photo viewer but still usable i suppose.
- [ ] Add ML-KEM PQC Encryption for any file type with the ability to decrypt in the video player, the photo viewer and the music player. Low priority for now.

## 1.5 Virtual Folders Transformation

- [x] Instead of having virtual folders, we should have 3 categories; Collections for videos, Playlists for music and Albums for photos. They cannot be mix and matched. We can still browse the Vault as usual but we also have the option of browsing our own custom "Folders"

## 2. Favorites Tab

- [x] Fix virtual folder interaction bugs (path-based favorite toggling)
- [x] Separate Tab Architecture: Decouple Library and Favorites into distinct tabs (favorites migrated to sub-nav capsule pill, library migrated under Streaming)
- [x] Ensure resumed media maintains exact state (stream, position, subs, language)
- [x] Add ability to remove movies and tv shows from Library
- [x] Add ability to download movies and tv shows to a Collection from the Library. With a dialog to choose which collection.
- [ ] Show the actual favorites videos, not the whole collection.
- [ ] Once this is done, lock the files in the tab. Unless the user clicks on the star button, no files should ever move from there. Virtual folders are disabled. Moving becomes copying, etc. No other new functionality is necessary unless it is also done in the Vault tab.

## 3. Streaming Tab

- [x] Real-Debrid API Client integration for high-speed cloud streams
- [x] Torrent selection logic audit for consistent streaming quality
- [x] Add preview images when hovering the seek bar as well as the time. Use the metadata already provided by the library.
- [x] Unified Virtual Storage Model (merge local paths with active cloud torrent links)
- [x] Strip response headers for embedded YouTube iframes
- [ ] Compact the header, lots of wasted space right now. keep the watch providers branded logos prominent, place the search bar next to them. Add a very obvious visual cue that we are either viewing only movies or only series.
- [ ] In the search bar, add a pill on the left side to indicate movies or series.
- [ ] Make the cards less tall and a little bit larger. Right now i have 8 cards, lets reduce to 7.
- [ ] Movies and Series should become subtabs for the Streaming section, replacing discover and defaulting to last state.

## 4. Library Tab

- [x] Metadata Scraper Agents (TMDB & TVDB APIs)
- [x] Plex/Jellyfin/Kodi NFO Interoperability (read existing libraries without altering them)
- [x] Dynamic TV/Movie Library Tabs with nested views (Seasons, Episodes)
- [x] Enable bilingual TMDB metadata integration

## 5. Livestreams Tab

- [x] Livestream translation integration
- [x] Persistent mini-player "Picture-in-Picture" mode
- [x] Localize KinoCheck fallbacks for trailer playback
- [ ] Determine if we move this into another project since it is completely broken at the moment and also doesn't really fit.

## Vault Tab Polish (Added 2026-05-30)

- [x] Centralized SVG icon dictionary (icons.js) — all inline SVGs and translation-string icons replaced with named tokens
- [x] Three-tab navigation overhaul: consolidated to **Vault**, **Streaming**, and **Livestream** with vertically centered tabs and capsule pill subtabs
- [x] Multi-color animated audio waveform visualizer for .audio-card items (12 bars, violet/cyan/gold/rose palette, hover-accelerate)
- [x] Background image enhancement IPC pipeline:
egisterImageEnhanceHandler in previews.js applies ImageMagick adaptive-sharpen + saturation + sigmoidal-contrast live on visible cards
- [x] Global **Mute Hover Previews** setting wired to ppSettings.mutePreviews
- [x] Subtab categorization within streaming/media tabs
- [ ] Make sure all the FR strings are showing QC to the users when under our control (e.g. not in the subtitles but in the top bar, yes).
