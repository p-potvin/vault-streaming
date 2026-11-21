// web/trailer-h264-route.js — the cached trailers as H.264, for browsers that cannot decode AV1.
//
// src/trailers.js keeps each trailer as 720p AV1 + AAC (half the size of H.264). Chromium plays that; Safari on an
// iPhone or iPad without an AV1 decoder (before the A17 Pro / M3 chips) does not, and the details window showed
// nothing. Those clients ask for /trailers/<id>.h264.mp4 instead (js/streaming/trailer.js, window.trailerSrc): the
// first request re-encodes the cached file once (a few seconds for a 2-minute trailer) into <cache>/h264/<id>.mp4,
// later ones are a file read. A trailer that is already H.264 is served as it is.

const child_process = require('child_process');
const fs = require('fs');
const path = require('path');
const { pickH264Encoder } = require('../src/ipc/transcode.ipc');
const trailers = require('../src/trailers');
const utils = require('../src/utils');

const ID = /^[A-Za-z0-9_-]{6,20}$/;
const ENCODE_TIMEOUT_MS = 3 * 60 * 1000;
const inFlight = new Map();   // youtube id -> Promise<path>

function ffprobePath() {
    return utils.getFFmpegPath().replace('ffmpeg.exe', 'ffprobe.exe').replace(/ffmpeg$/, 'ffprobe');
}

function videoCodec(file) {
    return new Promise((resolve) => {
        child_process.execFile(ffprobePath(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
            'stream=codec_name', '-of', 'csv=p=0', file], { windowsHide: true, timeout: 20000 },
        (_err, stdout) => resolve(String(stdout || '').trim()));
    });
}

function encode(src, out) {
    return new Promise((resolve, reject) => {
        const tmp = `${out}.${process.pid}.part.mp4`;
        const encoder = pickH264Encoder();
        const quality = encoder === 'h264_nvenc' ? ['-rc', 'vbr', '-cq', '24', '-b:v', '0'] : ['-crf', '23'];
        const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-map', '0:v:0', '-map', '0:a:0?',
            '-c:v', encoder, '-preset', 'fast', ...quality, '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
            '-c:a', 'copy', '-movflags', '+faststart', tmp];
        const proc = child_process.spawn(utils.getFFmpegPath(), args, { windowsHide: true });
        let stderr = '';
        const timer = setTimeout(() => proc.kill(), ENCODE_TIMEOUT_MS);
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('error', err => { clearTimeout(timer); reject(err); });
        proc.on('close', code => {
            clearTimeout(timer);
            if (code === 0 && fs.existsSync(tmp)) {
                fs.renameSync(tmp, out);
                return resolve(out);
            }
            try { fs.rmSync(tmp, { force: true }); } catch (_) { }
            reject(new Error(stderr.trim().slice(-300) || `ffmpeg exited ${code}`));
        });
    });
}

/** The path to serve for a trailer id as H.264, encoding it the first time; null when the trailer is not cached. */
async function h264File(id) {
    const src = path.join(trailers.cacheDir(), `${id}.mp4`);
    if (!fs.existsSync(src)) return null;
    const out = path.join(trailers.cacheDir(), 'h264', `${id}.mp4`);
    if (fs.existsSync(out)) return out;
    if (!inFlight.has(id)) {
        const job = (async () => {
            if ((await videoCodec(src)) === 'h264') return src;
            fs.mkdirSync(path.dirname(out), { recursive: true });
            const t0 = Date.now();
            await encode(src, out);
            console.log(`[web:trailer] ${id} re-encoded to H.264 (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
            return out;
        })().finally(() => inFlight.delete(id));
        inFlight.set(id, job);
    }
    return inFlight.get(id);
}

function registerTrailerH264Route(app) {
    // before the static /trailers route, which only serves <id>.mp4
    app.get('/trailers/:file', async (req, res, next) => {
        const m = /^(.+)\.h264\.mp4$/.exec(req.params.file);
        if (!m) return next();
        if (!ID.test(m[1])) return res.status(404).end();
        try {
            const file = await h264File(m[1]);
            if (!file) return res.status(404).end();
            res.sendFile(file, { maxAge: '30d', headers: { 'Content-Type': 'video/mp4' } });
        } catch (e) {
            console.warn(`[web:trailer] ${m[1]} H.264 failed: ${e.message}`);
            res.status(500).end();
        }
    });
}

module.exports = { registerTrailerH264Route };
