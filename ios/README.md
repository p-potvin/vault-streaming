# Vault Streaming — Native iOS & iPadOS App (`v2.10.3`)

100% native SwiftUI & AVPlayer app for iOS 16+ / iPadOS 16+, connecting over Tailscale/Tailnet to the Vault Streaming HTTP/SSE backend (`streaming.vaultwares.ca` or a local workstation worker).

## Architecture

- **Authentication & First-Run Gate**: `FirstRunConnectView.swift` validates server URL + `VW_WEB_TOKEN` with one `POST /api/invoke` call (`trailer-cache:stats`) (supports pasting an invite URL with `?token=`) and stores the token in the iOS Keychain via `KeychainHelper.swift`. No hardcoded tokens exist in the bundle.
- **Networking (`StreamingBackend.swift` / `Api.shared`)**: Wraps `POST /api/invoke` (IPC channels) and authenticates all media, subtitle, trailer and HLS requests with the `x-vw-token` and `x-vw-client` headers (never a `?token=` in the URL). Catalog calls send `fr-FR` / `en-US`, the keys the catalog stores (the app's own text is fr-CA).
- **Localization (`L10n.swift` & `Localizable.xcstrings`)**: Dynamic English (`en`) and Quebec French (`fr-CA`) switching (`LanguageManager.shared`), passed as `language` (`en-US` / `fr-CA`) to catalog/TMDB/RAGGAE endpoints.
- **Discovery, Search, Library & History**:
  - `DiscoverView.swift`: Horizontal Continue Watching strip, Featured hero banner, Netflix / Disney+ / Apple TV+ / Prime Video provider filters, Popular / Top Rated / Newest sorting, and paginated responsive grids (`AdaptiveGrid.swift`: 4–5 columns on iPad, 2–3 on iPhone).
  - `ContentView.swift`: `TabView` on iPhone and `NavigationSplitView` sidebar on iPadOS.
  - `HistoryView.swift`: Fetches `watch-history:get-all` grouped per series (`SeriesFlow.swift`), with swipe-to-delete (`watch-history:remove`) and direct resume.
- **Details & Trailers (`MovieDetailsSheet.swift` & `TrailerPlayerView.swift`)**:
  - Autoplays server-cached trailers from `/trailers/<id>.h264.mp4` (authenticated via `AVURLAssetHTTPHeaderFieldsKey`, `.mp4` and YouTube thumbnail fallbacks, KinoCheck 3 s intro skip, persistent mute toggle).
  - Shows external links (YouTube, IMDb, TMDB, JustWatch, Apple TV), Cast carousel, series season selector + per-episode progress, and per-series intro/outro skip timers.
- **Playback (`StreamPicker.swift`, `PlayerViewModel.swift`, `NativePlayerView.swift`)**:
  - Client-side torrent ranking + `rd-stream-torrent` / `deepbrid-stream` resolution and `lastSource` resume.
  - `AVPlayer` HLS playback via `/api/hls/index.m3u8?src=...&audio=N&h=1080` with audio track probing (`probe-audio-tracks`), side-loaded WebVTT subtitles (`subtitles:search` -> `download-subtitle-track`) & AI transcript polling (`subtitles:transcript`) parsed by `WebVTTParser.swift`, dead-link auto-reload + candidate failover, Next Episode background preloading (`NextEpisodePreloader`), and Up Next countdown overlay.
- **Security**: Optional Face ID / Touch ID / Optic ID lock screen on launch and background return (`BiometricAuth.swift`).

## Building on Windows + GitHub Actions CI

Because Xcode requires macOS, this repository uses a manually dispatched workflow:
- Workflow: `.github/workflows/ios-unsigned-build.yml` (`macos-15`, `xcodebuild clean build -configuration Release -sdk iphoneos CODE_SIGNING_ALLOWED=NO`).
- Output: Download `VaultStreaming-Unsigned-IPA` from GitHub Actions artifacts and sideload onto your iPhone/iPad with **Sideloadly** or **AltStore** using your Apple ID, or open `ios/VaultStreaming.xcodeproj` in Xcode on a Mac to sign and install directly.
