# vault-streaming — extraction notes

**Created:** Wed, 08 Jul 2026 — lift-and-shift of the **Streaming tab** out of
`vault-explorer`.
**Trimmed to streaming-only:** Sat, 12 Jul 2026.

## What this is

The VaultWares streaming client: TMDB Discover/search, Real-Debrid + Usenet
resolution, library/favorites, watch history, player with clip export and
subtitle downloads. Boots straight into the Discover view.

## Trim completed (Sat, 12 Jul 2026)

- **Removed local-vault features**: file explorer boot path, music/photos/misc
  modules, idle preview generation, AI live subtitles, RTX upscaling module +
  player button, ASR benchmark panel, encryption (crypto + crypto.ipc),
  normalization, previews. Deleted `python-scripts/`, `vault_explorer/`,
  `powershell/`, `tools/`, `scripts/pwsh/`.
- **Boot**: Discover renders at the END of initApp — after `initTMDBListeners()`.
  (Firing it from initTabListeners rendered before TMDB state existed → empty
  grid. Don't move it back.)
- **Fixed inherited breakage**: `src/ipc/files.ipc.js` was missing (system.ipc
  imports `safeOpenFile` from it) → app failed to load with
  "No handler registered for get-settings". Recreated minimal module.
  Guarded all `el(...)` reads in app.js language pass + init calls that
  referenced removed modules. Added a streaming `updateStatusBar` to utils.js.
- **Theme**: copied `vaultwares-themes/vaultwares-revisited/` from vault-explorer
  (the index.css `@import`s 404'd without it). Long-term: restore as submodule.
- **Rebranded**: title/header "Vault Streaming", appId
  `com.vaultwares.vaultstreaming`, productName, artifactName
  `vault-streaming-setup-*`; build.files + asarUnpack trimmed of deleted dirs.
- **Kept intentionally**: `js/settings/debrid-downloader.js` (RD URL downloader —
  fits this app), clip export (works on remote streams), watch history,
  hover-card/favorites/library. Dormant preload entries for removed handlers
  reject gracefully. Inert hidden `benchmark-dialog` markup remains in
  index.html (launcher button removed).

## Verified

Playwright-Electron boot: title/header "Vault Streaming", zero console errors,
TMDB Discover renders 20 cards at boot (two consecutive runs).

## Provenance

Streaming code was removed from `vault-explorer` (now local-media only).
Live-streaming translator lives in
`vaultwares-realtime/integrations/vault-explorer-livestream/`.
Per VaultWares torrent/debrid policy, all debrid/torrent lookups must route
through Comet (`http://100.67.25.118:5173`).
