# Vault Explorer - Active TODO List

## Active Tasks

- [x] **WebM Generation Fix**: WebM preview generation is not working. Switch to standard VP8 (`libvpx`) + Vorbis or VP9 (`libvpx-vp9`) with correct parameters, avoiding encoding mismatches, and ensuring robust CPU fallbacks.
- [x] **AI Upscaling Verification**: Fixed by implementing missing 'upscale-stream-start' and 'upscale-stream-stop' IPC handlers in src/ipc/media.ipc.js. The error occurred because the frontend was calling these handlers but they didn't exist in the backend.
- [x] **Persistent Player Volume**: Ensure the video player volume setting is persistent across plays and that the volume slider bar displays the correct initial and updated values.
- [x] **Responsive Video Player Controls overhauls**:
  - Remove the row containing only the timestamps to reduce control bar height.
  - On wide enough displays, position the seek bar *between* control buttons.
  - On smaller screens, leave the seek bar above buttons, bordered on each side by current time and total time.
  - Reduce player control margin slightly.
- [x] **Renaming & Spacebar Hotkey Fix**: When renaming, pressing `Spacebar` shouldn't trigger video playback. Prevent global hotkeys/event listeners from firing when focus is inside any `input` or `textarea`.
- [x] **Subtitle Download Performance**: Fixed subtitles getting stuck or being very slow by adding 15-second timeouts to all OpenSubtitles API fetch calls in src/scanner.js. This prevents the UI from hanging indefinitely when the OpenSubtitles API is slow or unresponsive.
- [x] **Picture-in-Picture Control Overlay**:
  - Add 3 small control buttons (`Previous`, `Play/Pause`, `Next`) in the center of the PiP player window.
  - Make these buttons appear dynamically on hover.
  - Clicking outside these center buttons on the video player container should restore the video player to its normal size/state.
  - Modify the PiP container shadow to be sharper/deeper, and remove rounded corners.
- [x] **Brand Identity Integration**: Change the Windows taskbar icon and top-left corner window icons to the VaultWares official brand logo.
- [x] **Minimize to System Tray**: Add a settings option to minimize the application to the system tray upon clicking the close (X) button. Default to `off`.
- [x] **Status Bar "Progress Zone"**:
  - Add a dedicated segment next to the items count in the status bar (separated by a visual delimiter).
  - Internal "progress zone" to dynamically track WebM generation, AI tasks, etc.
  - Shorter operations (e.g. single WebM preview generation) should show a loading spinner.
  - Long-running/batch operations (e.g. generating all previews in a folder) should show a clear loading percentage progress bar.
- [x] **Subfolder Thumbnail Scanning**: Fix scanning logic to resolve `.thumbs/` folders located at the exact same directory level as each respective video file rather than solely looking at the root vault folder.
- [x] **VLC Player Launch Fix**: Investigate and fix why clicking "Open File" breaks VLC (likely due to an unescaped or incorrectly formatted file path).
- [x] **Fix the pasting inside a fake folder**: Fully enabled pasting files into virtual folders and correctly associated pasted file paths in configuration.

## Utility Scripts

- [x] **PowerShell Directory Preview Generator**: Refactor `scripts/generate_webm.js` to accept a path as an argument, scan recursively, create local `.thumbs/` subdirectories, and robustly generate keyframes + WebM concats on demand.
