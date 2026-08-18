// web/transcode-route.js — on-the-fly remux/transcode for browser playback.
//
// Why this exists: the desktop build runs castlabs Electron, which ships the
// proprietary codecs, so it plays a debrid MKV/HEVC/TrueHD remux directly. A
// browser cannot — of 181 cached sources measured for one title, 3 were natively
// playable in Chrome. So for the web client, transcoding is the normal path, not
// a fallback.
//
// The desktop app already solves the encode (src/ipc/transcode.ipc.js) but ships
// the result as MediaSource chunks over IPC. Here we reuse the identical ffmpeg
// invocation and just pipe the fragmented MP4 into the HTTP response, so
// `video.src = '/api/transcode?...'` works with no client-side MSE code at all.
//
// Seeking: a piped transcode has no Content-Length and no range support, so the
// browser cannot seek natively. The client seeks by re-requesting with `&t=`,
// which ffmpeg serves via fast input-seek (`-ss` before `-i`).

const child_process = require('child_process');
const { buildArgs, pickH264Encoder } = require('../src/ipc/transcode.ipc');
const utils = require('../src/utils');

// Release names that a browser can already handle: MP4 container, H.264 video,
// lossy stereo-friendly audio. Anything else gets sent through ffmpeg.
function isBrowserNative(sourceUrl) {
    let name = '';
    try { name = decodeURIComponent(new URL(sourceUrl).searchParams.get('torrent_name') || ''); } catch (_) { }
    name = name.toLowerCase();
    if (!name) return false;
    if (!name.endsWith('.mp4')) return false;
    if (/hevc|x265|h\.?265|dovi|dolby.?vision|av1/.test(name)) return false;
    if (/truehd|atmos|dts|flac|pcm|eac3|ac3/.test(name)) return false;
    return true;
}

function registerTranscodeRoute(app) {
    app.get('/api/transcode', (req, res) => {
        const src = req.query.src;
        if (!src || !/^https?:\/\//i.test(src)) {
            return res.status(400).type('text/plain').send('Missing or invalid src');
        }

        const startTime = Math.max(0, parseFloat(req.query.t || '0') || 0);
        const targetHeight = parseInt(req.query.h || '1080', 10);
        const audioIndex = req.query.audio !== undefined && req.query.audio !== ''
            ? parseInt(req.query.audio, 10) : null;
        const mode = req.query.mode || 'auto';

        // Don't burn a GPU re-encoding something the browser could have played.
        if (mode === 'auto' && startTime === 0 && audioIndex === null && isBrowserNative(src)) {
            console.log('[web:transcode] source is browser-native, redirecting');
            return res.redirect(302, src);
        }

        const encoder = pickH264Encoder();
        const args = buildArgs({ url: src, startTime, targetHeight, encoder, audioIndex, copyVideo: false });

        // NOTE for whoever adds seeking: `-ss` restarts output timestamps at
        // zero, so with t>0 video.currentTime reports time-since-seek, not
        // position in the film — while live-subtitle cues and watch-history both
        // use absolute source time. `-output_ts_offset` does not fix this for
        // fragmented MP4 (verified: start_time stays 0.000), and `-copyts`
        // produces an unreadable stream here. The offset therefore has to be
        // applied on the client, which is why t>0 is only reachable by building
        // the URL directly and not yet by the player.
        const ffmpegPath = utils.getFFmpegPath();

        console.log(`[web:transcode] ${encoder} → ${targetHeight}p, t=${startTime}s`);

        let proc;
        try {
            proc = child_process.spawn(ffmpegPath, args, { windowsHide: true });
        } catch (err) {
            console.error('[web:transcode] spawn failed:', err.message);
            return res.status(500).type('text/plain').send(err.message);
        }

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'no-store');
        // The stream is generated live: length is unknown and ranges are unsupported.
        res.setHeader('Accept-Ranges', 'none');

        proc.stdout.pipe(res);

        let stderrTail = '';
        proc.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-4000); });

        proc.on('error', (err) => {
            console.error('[web:transcode] process error:', err.message);
            if (!res.headersSent) res.status(500).end(err.message);
            else res.end();
        });

        proc.on('close', (code) => {
            if (code && code !== 0 && code !== 255) {
                console.warn(`[web:transcode] ffmpeg exited ${code}:`, stderrTail.trim().slice(-500));
            }
            if (!res.writableEnded) res.end();
        });

        // Critical: a browser abandons a transcode on every seek and on tab close.
        // Without this the orphaned ffmpeg keeps pulling the full source from the
        // debrid provider — wasted bandwidth on an account that is rate-sensitive.
        const kill = () => {
            if (proc.exitCode === null && !proc.killed) {
                console.log('[web:transcode] client disconnected, killing ffmpeg');
                try { proc.kill('SIGKILL'); } catch (_) { try { proc.kill(); } catch (__) { } }
            }
        };
        res.on('close', kill);
        res.on('error', kill);
    });

    console.log('[web:transcode] route registered (GET /api/transcode)');
}

module.exports = { registerTranscodeRoute, isBrowserNative };
