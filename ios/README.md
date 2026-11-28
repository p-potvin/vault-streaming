# VaultStreaming iOS App & Unsigned Build Pipeline

100% native SwiftUI application for Vault Streaming, crafted in accordance with Apple Human Interface Guidelines (HIG). Features a 5-tab native navigation hierarchy, native TMDB catalog discovery, seamless Comet stream resolution, native Face ID biometric locking, full-screen AVPlayer video playback with PiP/AirPlay, and an automated GitHub Actions CI pipeline producing unsigned `.ipa` packages for direct sideloading.

---

## Architecture Overview

VaultStreaming iOS has transitioned from a WebKit/WKWebView hybrid container to a **100% native Swift & SwiftUI architecture**:

- **Native UI & Navigation (Apple HIG)**:
  - **Discover (`DiscoverView.swift`)**: Trending movies and TV shows powered by TMDB, featured hero banner with high-resolution backdrops, horizontal media carousels, genre filter chips, and one-tap quick playback.
  - **Search (`SearchView.swift`)**: Live instant search querying TMDB with automatic debouncing, filter chips (Movies, TV Shows, All), and responsive media grid.
  - **Library (`LibraryView.swift`)**: Persistent local watchlist stored on-device (`UserDefaults`), poster card grid, and quick toggle/remove actions.
  - **History (`HistoryView.swift`)**: Watch progress tracking with visual percentage bars, playback timestamp retention, and one-tap resume.
  - **Settings (`SettingsView.swift`)**: Tailnet server endpoint configuration, Comet resolution endpoints, Biometric Face ID / Touch ID toggle, cache management, and application build metadata.

- **Details & Presentation (`MovieDetailsSheet.swift`)**:
  - Native bottom sheet presentation (`.sheet(item: $selectedMedia)`) replacing legacy web hover cards and modal overlays.
  - Prevents double-popup collisions on touch devices.
  - Displays backdrop, synopses, cast/crew, release dates, runtime, genres, and live Real-Debrid / Comet cached torrent streams tagged by quality (4K, 1080p, HDR), file size, and seeders.

- **Native Video Playback (`NativePlayerView.swift`)**:
  - Full-screen `AVPlayer` presentation (`.fullScreenCover(item: $activeStream)`), bypassing WebKit video restrictions.
  - Native playback controls, edge-to-edge rendering (`.ignoresSafeArea()`), automatic portrait and landscape auto-rotation.
  - Native Picture-in-Picture (PiP) and AirPlay route pickers.
  - Continuous playback progress tracking automatically synchronizing back to `HistoryView` upon dismissal.

- **Biometric Security (`LAContext`)**:
  - Native Face ID / Touch ID biometric authentication via Apple's `LocalAuthentication` framework.
  - Full-screen biometric lock overlay requiring authentication on application launch and foreground resume when enabled in Settings.

- **Tailnet-First Streaming**:
  - Configured by default for Tailscale node `http://100.67.25.118:5173` (Comet instance running on OVH VPS).
  - Media streams and indexer queries resolve directly against Comet using Cinemeta/Kitsu identifiers with provider tag `comet`.
  - When transcoding is required for legacy containers incompatible with iOS `AVPlayer`, jobs route through the VaultWares API gateway on OVH (`https://api.vaultwares.ca`) to the local desktop GPU node (`100.71.101.21`).

---

## Non-Automated CI Pipeline (GitHub Actions)

Manually trigger `.github/workflows/ios-unsigned-build.yml`:

1. Boots a clean `macos-14` (Apple Silicon M1) runner with Xcode 15/16.
2. Compiles `ios/VaultStreaming.xcodeproj` with `CODE_SIGNING_ALLOWED=NO`.
3. Packages `VaultStreaming.app` into `build/VaultStreaming-unsigned.ipa`.
4. Uploads `VaultStreaming-iOS-Unsigned` as a downloadable artifact.

---

## How to Sign and Install onto iPhone

### Option 1: Direct in Xcode (Zero Extra Tools, Free Apple ID)

1. Open `ios/VaultStreaming.xcodeproj` in Xcode on your Mac.
2. In the project navigator, select the **VaultStreaming** target.
3. Under **Signing & Capabilities**:
   - Check **Automatically manage signing**.
   - Select your Personal Team (associated with your standard free Apple ID).
   - Change the Bundle Identifier if needed (e.g., `ca.vaultwares.streaming.yourname`).
4. Connect your iPhone via USB or Wi-Fi.
5. Select your device in the top bar and press **Run** (`⌘R`).
6. On your iPhone: Go to **Settings → General → VPN & Device Management** and tap **Trust [Your Apple ID]**.

*Note: Free Apple ID certificates remain valid on-device for 7 days and can be refreshed anytime by re-running in Xcode.*

### Option 2: Sideloading the Unsigned IPA (Sideloadly / AltStore / SideStore)

1. Go to your repository's **Actions** tab on GitHub.
2. Select the latest **Build Unsigned iOS App** run.
3. Download the **`VaultStreaming-iOS-Unsigned`** artifact (unzip to get `VaultStreaming-unsigned.ipa`).
4. Sideload via your preferred tool:
   - **Sideloadly**: Drag and drop `VaultStreaming-unsigned.ipa`, enter your Apple ID, and click **Start**.
   - **AltStore / SideStore**: Import `VaultStreaming-unsigned.ipa` into AltStore/SideStore directly from your Files app.
5. The tool signs the IPA using Apple's free developer provisioning profile and installs it on your iPhone.

---

## Local Development & Manual Build

To build the unsigned IPA locally on a Mac:

```bash
cd ios
xcodebuild clean build \
  -project VaultStreaming.xcodeproj \
  -scheme VaultStreaming \
  -sdk iphoneos \
  -configuration Release \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  BUILD_DIR=build

./scripts/package-unsigned-ipa.sh build/Release-iphoneos build/VaultStreaming-unsigned.ipa
```
