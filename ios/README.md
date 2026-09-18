# VaultStreaming iOS App & Unsigned Build Pipeline

Native iOS container app for Vault Streaming, packaged with SwiftUI and WebKit, providing persistent streaming storage, video playback optimizations (inline playback, PiP, AirPlay, full landscape rotation), native Face ID biometric locking, pull-to-refresh, Tailnet connectivity diagnostics, and an automated unsigned build pipeline.

---

## Architecture Overview

- **Engine**: Pure native Swift / SwiftUI hosting a high-performance `WKWebView` with `WKWebsiteDataStore.default()` (preventing iOS Safari 7-day storage eviction for watch history and favorites).
- **Streaming Optimizations**: Inline media playback enabled without requiring user tap initiation, Picture-in-Picture (PiP), AirPlay route pickers, and complete portrait + landscape rotation support for full-screen movie viewing.
- **Tailnet-First**: Preconfigured by default for `http://100.67.25.118:5173` (Comet instance running on OVH VPS). Media streams and indexer queries resolve directly against Comet. When transcoding is required for formats incompatible with iOS WebKit, jobs are dispatched through the VaultWares API gateway on OVH (`https://api.vaultwares.ca`) to the operator's desktop workstation (`100.71.101.21`).

---

## Automated CI Pipeline (GitHub Actions)

Every push to `main` or `vw-codex-*` branches triggers `.github/workflows/ios-unsigned-build.yml`:

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
