# 🎬 Vault Streaming

Vault Streaming is a lightweight, high-performance desktop application for discovering and managing cloud-streamed media. Originally built as part of the broader Vault Explorer ecosystem, it has been streamlined to focus entirely on cloud discovery, library tracking, and AI-powered media playback.

## Features

- **Streamlined Discovery**: Scrapes TMDB/TVDB for rich cover art, backdrops, and cast info to help you find your next watch.
- **Library Tracking**: Keep track of the series and movies you are currently watching or have completed.
- **Hardware AI Workflows**: Leverage your local GPU for advanced, real-time video upscaling and audio processing capabilities.
- **Live AI Subtitles**: Enjoy real-time, multilingual AI transcription for your streams without the overhead of saving `.srt` files to your disk.
- **Premium User Interface**: Features a beautiful, minimalist UI with smooth transitions and customizable themes (Warm and Console modes) out of the box.

## Development

This application is built with **Electron** and utilizes local FFmpeg and Python scripts for backend processing and AI workloads.

### Tech Stack

- **Frontend**: Vanilla HTML/CSS/JS (No frameworks, pure performance).
- **Backend**: Electron (Node.js) IPC handling.
- **AI Daemon**: Python-based daemon managing NVIDIA NeMo (Parakeet-TDT) models for real-time transcription.
- **Video Processing**: FFmpeg integration for clipping, upscaling, and format conversion.

### Version

One version, set only in `package.json`: bump with `node scripts/sync-version.js X.Y.Z`, which writes the copies
(the `<!-- vX.Y.Z -->` comment in `index.html`, `package-lock.json`); `node tests/test_version.js` names any file that
drifts. The iOS app keeps its own version.

## Quick Start

1. Ensure you have Node.js and npm installed.
2. Clone the repository and run:

```bash
npm install
npm start
```

## 🎥 AI Subtitles & Playback

Vault Streaming includes an embedded AI subtitle engine powered by the `parakeet-tdt-0.6b-v3` model.
When you start a stream, a Python daemon is spawned that processes audio via FFmpeg in real-time. Transcriptions are broadcasted directly to the Electron renderer via stdout, ensuring that no temporary `.srt` files clutter your disk while maintaining perfect sync with your video.

---

## Metadata, trailers and debrid

- **Metadata comes from the local catalog** (vault-raggae, `http://127.0.0.1:8750`, `src/raggae.js`). Details, seasons
  and episodes are read through it: on a miss TMDB is asked once, the answer is ingested (TMDB's extras under the
  item's `raw_enrichment.tmdb[<language>]`) and the catalog's copy is served (`src/tmdb.js`).
- **Discover and trending** read ordered catalog lists. `scripts/ingest-front-page.js` fills them from TMDB (trending,
  and each provider's popular titles per watch region); `scripts/Register-FrontPageTask.ps1` schedules it at 06:30 and
  18:30 (at most 1500 TMDB requests a run, 4/s). Dry run: `node scripts/ingest-front-page.js --dry-run`.
- **Trailers** are looked up (KinoCheck, then the catalog's TMDB videos) and downloaded with yt-dlp once, then played
  from `TRAILER_CACHE_DIR` (default `G:\VaultStreaming\trailers`, `src/trailers.js`); the web client gets them at
  `/trailers/<id>.mp4`.
- **Deepbrid** is the fallback when Real-Debrid fails (Debrid Downloader, and one attempt after every stream source
  failed), through the proxy tunnel when one is enabled, else directly (`src/deepbrid/client.js`; key `DEEPBRID_API_TOKEN` or
  `deepbrid_api_token.txt` in the `.access` folder next to this repo, i.e. `..\.access\`).

## 📋 FFmpeg Requirements

Vault Streaming uses FFmpeg for audio extraction and video manipulation.

**Recommended Version**: FFmpeg 6.0 or later
**Minimum Version**: FFmpeg 4.4

### Installation (Windows)

1. Download from: <https://ffmpeg.org/download.html>
2. Choose: **Windows builds from gyan.dev**
3. Extract to `C:\ffmpeg` and add `C:\ffmpeg\bin` to your system PATH.

### Installation (macOS / Linux)

- **macOS**: `brew install ffmpeg`
- **Ubuntu/Debian**: `sudo apt install ffmpeg -y`

---

## Theming & UI Architecture

The UI is built on a custom design system with two primary canonical shells:

- **Console Mode**: Deep purple/black aesthetic (`#0b0813` background).
- **Warm Mode**: Light, approachable aesthetic (`#F5F1E8` background).

All components are styled using CSS Custom Properties (`--vault-*` tokens). If you wish to create a custom theme, simply override these variables in your own stylesheet or through the in-app settings menu.

## License

This project is licensed under the MIT License. See the `LICENSE` file for details.
