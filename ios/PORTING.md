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
| Token | written in `AppConfig.swift` and `StreamingBackend.swift` | **public repo**: remove, ask once, keep in the Keychain; rotate `VW_WEB_TOKEN` |
| Strings | ~36 English `Text("…")` literals, plus labels in models (`"Season 1 · Episode 4"`, `"AI English"`) | no French |
| Playback | Comet URL straight into AVPlayer; MKV sent to `/api/stream/remux` | MKV / HEVC / lossless audio fail or cannot seek; use `/api/hls/index.m3u8?src=` (full duration, seeking, built for iOS) |
| Subtitles | channel `get-subtitles` | **does not exist** on the server (it is `subtitles:search`) |
| Trailers | none | `trailer:get` -> `/trailers/<id>.mp4` (AV1) or `.h264.mp4` when the device has no AV1 decoder |
| Catalog | `discover-tmdb` / `search-tmdb` / `get-tmdb-*` without a language | pass the app language (`fr-CA` / `en-US`) so titles, overviews and posters come back in French |
| History | `watch-history:set-progress`, `continue-watching` | ok; Continue Watching per series (one card per show, next episode) is missing |
| Series | no season / episode browser in the player | episodes panel, Up next card, next-episode pre-load 30 s before the end |
| Stream choice | top stream auto-played, sorted cached > French > 4K | the web's picker rules (`js/streaming`, `tests/test_stream_picker.js`) and the source limits |
| Stream reload | none | reload a dead link (the web does it automatically) |

## Phases

1. **Security and plumbing**: token out of the code (first-run screen + Keychain, server URL editable in Settings);
   one `Api` layer with typed channels; fix `subtitles:search`; send the language on every catalog call.
2. **Localization**: `Localizable.xcstrings` with `en` and `fr-CA` for every string (Settings > Language: system /
   English / Français (fr-CA)); the French texts taken from `js/translations.fr.js` so both clients say the same.
3. **Playback**: AVPlayer on `/api/hls/index.m3u8?src=…` (audio track choice, resume position, progress every 10 s);
   subtitles as side-loaded WebVTT; stream picker parity; reload on a dead link.
4. **Details**: trailer at the top of the details sheet (muted per Settings, KinoCheck intro skip), cast from the
   catalog, IMDb / external badges, season and episode lists.
5. **Series flow**: Continue Watching per series, Up next card, next-episode pre-load, episodes panel in the player.
6. **iPad layout**: 4-5 poster columns, sidebar navigation (`NavigationSplitView`), details as a sheet, no hover.
7. **Docs**: `ios/README.md` (manual build trigger, Sideloadly), version shown in Settings.

Each phase is one PR on its own branch, built by the workflow before it is merged.
