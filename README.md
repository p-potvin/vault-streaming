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
