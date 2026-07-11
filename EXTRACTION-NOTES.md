# vault-streaming — extraction notes

**Created:** Wed, 08 Jul 2026 — lift-and-shift of the **Streaming tab** out of
`vault-explorer`.

## What this is

A full copy of the vault-explorer Electron source (working base), so the
streaming tab runs day one. The streaming feature set is intact:

- `js/streaming/` — ranking, badges, trailer, details-modal, rd-flow
- `js/tmdb.js`, `src/tmdb.js` — TMDB discover/search
- `src/realdebrid/` — Real-Debrid search/stream/proxy
- `src/usenet/` — Usenet search/stream/health/cache
- `js/favorites.js` `renderLibrary` — the streaming library
- IPC: TMDB/OMDb/torrent/RD/usenet + `activeStreamingMedia` player integration

## Follow-up (not yet done)

This is a working base, **not yet trimmed** to streaming-only. To make it a
focused streaming app:

1. Remove non-streaming tabs/features (files browser, music, photos, misc,
   upscale, AI subtitles, encryption, previews) from `index.html`, `main.js`,
   `preload.js`, and `js/`.
2. Default the home tab to `streaming`.
3. Rebrand icons/title/appId (`build.appId` still `com.vaultwares.vaultexplorer`).
4. Fresh `git init`, own `package-lock`, own README/AGENTS/ROADMAP.
5. Point `.env` / API keys (TMDB_BEARER_TOKEN, RD, Usenet) at this project.

## Provenance

Streaming code removed from `vault-explorer` in the same pass (tab, IPC handlers,
`js/streaming/`, `src/realdebrid/`, `src/usenet/`, `src/tmdb.js`, `js/tmdb.js`).
Live-streaming translator went to `vaultwares-realtime/integrations/vault-explorer-livestream/`.
Per the VaultWares torrent/debrid policy, all debrid/torrent lookups must route
through Comet (`http://100.67.25.118:5173`).
