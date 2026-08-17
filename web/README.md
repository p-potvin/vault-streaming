# Vault Streaming — web client

Serves the existing Vault Streaming UI to a browser. **No files under `js/`,
`css/`, or `index.html` were forked or modified** — the browser loads the exact
same renderer the Electron app does. `src/` is likewise reused verbatim.

```bash
npm run web
```

→ http://127.0.0.1:8722

## How it works

The renderer only ever touches the host through `window.electronAPI`, and `src/`
only touches Electron through `app.getPath`, `shell`, `clipboard`, `dialog`,
`Menu` and `event.sender.send`. That narrow waist is what makes the port cheap.

| Piece | Role |
|---|---|
| `electron-shim.js` | Intercepts `require('electron')` so `src/` loads in plain Node, unmodified. |
| `ipc-bridge.js` | Fake `ipcMain` that records `.handle()` registrations; dispatches them from HTTP. |
| `server.js` | Express: static assets, `/api/invoke`, SSE, ranged media, health. |
| `transcode-route.js` | ffmpeg → fragmented MP4 piped down HTTP, for sources browsers can't decode. |
| `public/electron-api-shim.js` | Rebuilds `window.electronAPI` over fetch + `EventSource`. Mirrors `preload.js`. |
| `public/web-overrides.js` | Repoints `sanitizePath()` from `file:///` to `/api/media`. |

`index.html` is read from the repo at request time and the two shim `<script>`
tags are spliced in, so the desktop and web clients can never drift apart.

**When you add a method to `preload.js`, add it to `electron-api-shim.js` too.**
That is the one manual sync point in the whole design.

### Transports

- **Request/response** — `POST /api/invoke` `{channel, args}`. Handler exceptions
  are re-thrown in the browser so existing `try/catch` blocks behave unchanged.
- **Push** (`event.sender.send`) — SSE on `/api/events?client=<id>`, routed to the
  client whose invoke started the work. Node `Buffer`s are base64-tagged and
  revived as `Uint8Array` in the browser.
- **Local library files** — `/api/media?path=…`, with full byte-range support
  (including suffix ranges), restricted to the configured vault roots.

## Playback: why transcoding is the normal path

The desktop build runs castlabs Electron, which ships proprietary codecs, so it
plays debrid remuxes directly. A browser cannot. Measured against one title's
cached source list:

| | count |
|---|---|
| cached sources | 181 |
| MKV container | 97 |
| HEVC / Dolby Vision | 86 |
| lossless audio (TrueHD/DTS/Atmos) | 76 |
| **playable in Chrome as-is** | **3** |

So `/api/transcode` is the default route, not a fallback. It reuses the exact
ffmpeg invocation from `src/ipc/transcode.ipc.js` (`buildArgs`), but pipes the
fragmented MP4 straight into the HTTP response — no MediaSource code needed:

```
video.src = '/api/transcode?src=<streamUrl>&h=1080'
```

Verified end to end: a 4K UHD BluRay REMUX (DoVi / HDR10+ / HEVC / TrueHD Atmos
7.1, MKV) plays in Chrome at 1920×1080 via `h264_nvenc`, encoding ~1.4× faster
than realtime. Sources that are already browser-native (MP4 + H.264 + lossy
audio) get a 302 redirect instead of being needlessly re-encoded.

ffmpeg is killed on client disconnect. This matters: a browser abandons the
connection on every seek, and an orphaned ffmpeg keeps pulling the full source
from the debrid provider.

## Source limits (web only)

The desktop app hands a source to Electron's decoder; the web client transcodes,
and that cost lands on whatever machine runs the server. `source-limits.js`
filters `search-torrents` results on the web path only — the desktop client still
sees everything.

| Variable | Default | Bounds |
|---|---|---|
| `VW_WEB_MAX_SOURCE_GB` | `5` | the debrid pull |
| `VW_WEB_MAX_HEIGHT` | `1080` | the decode |

Both, because size alone is the wrong proxy for encoder load: measured across
9,267 cached sources, 98 of the 1,512 2160p ones were already under 5 GB, so a
size cap by itself still feeds 4K to the encoder.

Measured distribution of cached sources (8 titles, n=9,267):

| | GB |
|---|---|
| p10 | 1.0 |
| p25 | 1.7 |
| **median** | **4.0** |
| p75 | 11.3 |
| p90 | 30.8 |
| mean | 10.9 |

A 5 GB cap keeps **57%** of all cached sources — 2 GB keeps 30%, 10 GB keeps 73%.
By resolution the medians are 2160p 27.4 GB, 1080p 5.2 GB, 720p 2.7 GB. Only 6%
of 2160p sources fall under 5 GB, which is the intent: 4K is what kills the
encoder. When every source for a title is filtered out the result carries an
explicit error rather than an empty list, so it doesn't read as a debrid fault.

## Live subtitles

Transcription only (no translation). Cues stream to the browser over the same
SSE channel as every other push event, and land in an in-memory `TextTrack` that
the browser syncs to `currentTime` — the renderer code for this is unchanged.

The engine is `nvidia/parakeet_realtime_eou_120m-v1`: a streaming model that
emits an `<EOU>` token at end-of-utterance, so phrases are segmented by the model
rather than guessed from silence. It loads in ~35 s (once, into a long-lived
daemon) and holds **~550 MB VRAM**, which sits comfortably beside the NVENC
transcode. Inference is ~40 ms per 1 s chunk.

Selectable via `VAULT_ASR_ENGINE=nemotron`, but note the Nemotron path is
currently broken upstream (`No module named
'nemo.collections.asr.models.rnnt_bpe_models_prompt'`).

Three things had to change to make this usable on real film audio, each verified
against a Dune remux rather than reasoned about:

- **The audio conditioning had to go.** The existing chain (`afftdn` denoise +
  `dynaudnorm`) was tuned for the cache-aware model. `dynaudnorm` pumps the quiet
  gaps between words up to full scale and the EOU model reads those as phrase
  boundaries — 8 spurious firings vs 4 over the same clip, turning whole
  sentences into fragments and inventing words. The EOU path now applies only the
  requested gain.
- **`<EOU>` on a short buffer is not trustworthy.** Score and room tone trigger
  it constantly, and acting on it resets the model's context so it only ever sees
  ~1 s fragments. The same 30 s of dialogue transcribes correctly as one window
  but degrades to `yeah / yeah / so / done / yeah` when chopped at every
  boundary. A boundary now needs `EOU_MIN_UTTERANCE_S` (2.5 s) of audio behind it.
- **Non-speech hallucination.** Roughly half the remaining cues were a bare
  "yeah" over music. Cues that are only a filler token are dropped, as are cues
  identical to the one before them.

Result on Dune from 10:00 — "the slow blade penetrates the shield", "i hold at
your neck the gum jabar", "poison needle instant death", "by your footsteps
gerny halleck". Not perfect: proper nouns drift (Harkonnen → "harkin", Fremen →
"ferment") and stray numbers still appear during silence. It is English-only,
lowercase, and unpunctuated — that is the model, not the plumbing.

### Bandwidth

ASR opens a **second** read of the source, independent of the one feeding the
player. Left alone, ffmpeg pulls it as fast as the link allows — measured ~9×
realtime, i.e. a session on a 70 GB remux tries to drag the whole file down at
once, from an account that is rate-sensitive and already serving playback. The
live path is therefore capped with `-readrate` (`VAULT_ASR_READRATE`, default
`4.0`): fast enough to stay ahead of playback — cues must arrive *before* the
position they are stamped for — without the burst.

Teeing audio out of the transcode ffmpeg instead of opening a second read would
remove the duplicate pull entirely. That is the right long-term shape and is not
done yet.

### Known gap: seeking

A piped transcode has no `Content-Length` and no range support, so the browser
cannot seek natively. The server already accepts `&t=<seconds>` (fast input-seek
via `-ss`); what's missing is the client-side shim in `js/player/player.js` that
intercepts a seek and re-points `video.src` at the new offset. This is the main
piece of remaining work for full playback parity.

## Security

`VW_WEB_TOKEN` gates every request. The server **refuses to start** if bound to
a non-loopback address without one.

Be deliberate about exposing this beyond loopback: Comet stream URLs carry the
debrid service configuration — including API keys — in the base64 path segment.
Anyone who can load the client, read devtools, or read the server log can
recover those keys. Loopback or a trusted LAN behind the token is fine; the open
internet is not.

`/api/media` resolves and confirms every path is inside a configured vault root
before reading, so an exposed port can't be walked into an arbitrary-file read.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `VW_WEB_HOST` | `127.0.0.1` | Bind address. Non-loopback requires a token. |
| `VW_WEB_PORT` | `8722` | Port. |
| `VW_WEB_TOKEN` | *(unset)* | Shared secret. Pass `?token=…` once; it sets a cookie. |
| `VW_WEB_USERDATA` | `%APPDATA%\vault-streaming` | Settings/history store. |
| `VW_WEB_MEDIA_ROOTS` | *(unset)* | Extra `;`-separated roots `/api/media` may serve. |

`VW_WEB_USERDATA` defaults to the **same directory the desktop app uses**, so
settings, watch history and caches are shared rather than starting empty.

## Not available in the browser

These are host-bound and resolve to a structured refusal rather than hanging:
native context menus, folder pickers, reveal-in-explorer, backup import/export.
Clipboard, external links and fullscreen are re-implemented with web APIs.

The ffmpeg-backed *library* features (clip, audio normalize, upscale, webm
previews) still execute — but on the **server**, writing to the server's disk.
That is correct when the server is your own desktop, and probably surprising
otherwise.
