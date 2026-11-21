# iOS app: porting the web client's features (plan, Sat, 21 Nov 2026)

The iOS app stays **native** (SwiftUI + AVPlayer). It talks to the same server as the web client (`POST /api/invoke`
with an IPC channel, plus the `/api/hls`, `/trailers` routes), so the server already does the heavy work: catalog
read-through, trailer cache, per-device history (by tailnet address, through greencloud), HLS for Safari / AVPlayer.
The app was last changed in September 2026; this lists what it lacks and the order to add it.

Builds: `.github/workflows/ios-unsigned-build.yml` runs only on a manual dispatch (macOS runner, unsigned IPA); the
operator signs and installs it with Sideloadly (free Apple ID, 7-day certificates). Nothing here compiles on Windows,
so each phase ends with a CI build.

## State found (survey)

| Area | Now | Problem |
| --- | --- | --- |
| Token | written in `AppConfig.swift`, `StreamingBackend.swift`, and `SettingsView.swift` (PC preset) | **public repo**: remove all three, ask once (first-run screen), keep in the Keychain; rotate `VW_WEB_TOKEN` |
| Strings | ~36 English `Text("…")` literals, plus labels in models (`"Season 1 · Episode 4"`, `"AI English"`) and legacy `WebViewWrapper.swift` / Whisper UI | no French; outdated `1.0.0` version and stale diagnostics (`api.vaultwares.ca`, Comet `:5173`, `-TranslateTo fr`) |
| Catalog & Details | `discover-tmdb` / `search-tmdb` / `get-tmdb-*` without a language; `MediaItem` expects raw TMDB v3 fields; `fetchDetails` expects unwrapped `result` | pass `language` (`fr-CA` / `en-US`); decode `catalogToCard` (`poster`, `year`, `rating`, `genres`, int or string `id`); unwrap `result.data` for `get-tmdb-*` (note: server `discoverFromCatalog` also does not yet overlay `raw_enrichment.tmdb[language]`); add Discover filters, pagination, and Trending |
| Playback | Comet URL straight into AVPlayer (no `rd-stream-torrent` / `deepbrid-stream`); MKV sent to `/api/stream/remux` | MKV / HEVC / lossless audio fail or cannot seek; placeholder clips (433 KB / 410 KB) play as error videos. Use `rd-stream-torrent` (or `deepbrid-stream` fallback), probe audio (`probe-audio-tracks` + `detect-audio-language`), play `/api/hls/index.m3u8?src=…&audio=N&h=…` with `AVURLAssetHTTPHeaderFieldsKey` (`x-vw-token`) so relative `seg/<key>/<n>.ts` requests authenticate, plus `stream-keep-warm` and `moments:index-playback` |
| Subtitles | channel `get-subtitles`; legacy Whisper `-TranslateTo fr` button via `start-live-subtitles` | `get-subtitles` **does not exist**; use `subtitles:search` -> `download-subtitle-track` -> `/api/media?path=…` and `subtitles:transcript` (Moments AI transcript) -> `/api/media?path=…` |
| Trailers | none | `trailer:get` -> `/trailers/<id>.mp4` (AV1) or `/trailers/<id>.h264.mp4` (`web/trailer-h264-route.js`, currently on `vw-claude-web-mobile`) with `x-vw-token` auth |
| History | `watch-history:set-progress` sends `position`/`duration` & `tmdbId: 0`; `continue-watching` expects bare array & `posterUrl`/`updatedAt` | **broken schema**: server expects `positionSec`/`durationSec` and real `tmdbId`, and returns `{ success, items }` (`poster`, `lastWatched`); Continue Watching per series (one card per show, next episode) is also missing |
| Series | no season / episode browser in the player | episodes panel, Up next card, next-episode pre-load 30 s before the end (`get-tmdb-tv-season` wrapped in `result.data`) |
| Stream choice | top stream auto-played, sorted cached > French > 4K | the web's picker rules (`js/streaming/ranking.js`, `tests/test_stream_picker.js`) and the source limits |
| Stream reload | none | reload a dead link (the web does it automatically) |

## Phases

1. **Security and plumbing**: remove hardcoded token from all 3 files (first-run screen + Keychain, server URL & token editable in Settings); one `Api` layer with typed `IpcChannel`s and `x-vw-token` / `x-vw-client` auth; fix `MediaItem` (`catalogToCard` + string/int `id`), `result.data` unwrapping (`get-tmdb-*`), `watch-history` schemas (`positionSec`/`durationSec`/`items`/`tmdbId`), and `subtitles:search` + `download-subtitle-track` + `subtitles:transcript`; send `language` on every catalog call; align version (`2.10.2`) and diagnostics.
2. **Localization**: `Localizable.xcstrings` with `en` and `fr-CA` for every string (Settings > Language: system / English / Français (fr-CA)); the French texts taken from `js/translations.fr.js` so both clients say the same.
3. **Playback**: `rd-stream-torrent` + `deepbrid-stream` fallback; `probe-audio-tracks` + `detect-audio-language`; AVPlayer on `/api/hls/index.m3u8?src=…&audio=N&h=…` with `AVURLAssetHTTPHeaderFieldsKey` auth (resume position, progress every 10 s, `stream-keep-warm`, `moments:index-playback`); subtitles as side-loaded WebVTT via `download-subtitle-track` / `subtitles:transcript` + `/api/media`; stream picker parity; reload on a dead link.
4. **Details**: trailer at the top of the details sheet (`/trailers/<id>.h264.mp4` fallback from `web/trailer-h264-route.js`, muted per Settings, KinoCheck intro skip), cast from the catalog, IMDb / external badges, season and episode lists (`get-tmdb-tv-season`). (Also ensure server `discoverFromCatalog` overlays `raw_enrichment.tmdb[language]`.)
5. **Series flow**: Continue Watching per series, Up next card, next-episode pre-load, episodes panel in the player.
6. **iPad layout**: 4-5 poster columns, sidebar navigation (`NavigationSplitView`), details as a sheet, no hover.
7. **Docs & cleanup**: remove unused `WebViewWrapper.swift`; update `ios/README.md` (native SwiftUI + AVPlayer architecture, manual build trigger, Sideloadly); version shown in Settings.

Each phase is one PR on its own branch, built by the workflow before it is merged.

## Implementation Status (`vw-codex-ios-phase1`)

- **Phases 1–7 implemented locally** across server prerequisites (`web/trailer-h264-route.js`, `web/server.js`, `src/tmdb.js`) and all native iOS/iPadOS SwiftUI views/models (`ios/VaultStreaming/` + `ios/VaultStreaming.xcodeproj/project.pbxproj`, `ios/README.md`).
- **Pending macOS CI compile**: Dispatch `.github/workflows/ios-unsigned-build.yml` on `macos-14` once pushed to verify Xcode compilation and generate the `v2.10.2` unsigned IPA artifact.
