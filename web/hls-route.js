// web/hls-route.js — HLS for Safari on iPhone / iPad (Sat, 21 Nov 2026).
//
// Why: /api/transcode pipes a fragmented MP4 with no length and no byte ranges. Desktop browsers play that, but
// Safari on iOS only plays progressive video from a server that answers range requests ("cannot play this format"
// on the iPhone), and on the iPad it learned no duration: the stream looked like a clip of a few seconds, which the
// player's provider-error-clip guard paused. HLS is what Safari plays natively, with the whole duration, seeking
// and its own controls.
//
//   GET /api/hls/index.m3u8?src=<comet url>[&audio=N][&h=1080]
//        a VOD playlist of the whole film: its duration probed once (ffprobe), segments of SEG_S seconds
//   GET /api/hls/seg/<key>/<n>.ts
//        segment n, made by ffmpeg as Safari asks for it. ffmpeg runs from the segment asked for and keeps going;
//        a request far from what it is making (a seek) restarts it there. MPEG-TS segments carry their own
//        timestamps (-output_ts_offset), so segments from different runs line up on one timeline.
//
// Bounded: one ffmpeg per playback (key = source + audio + height); it stops when it is AHEAD_MAX segments ahead of
// the last one asked for, or when nothing was asked for IDLE_MS; a session unused for SESSION_TTL_MS is removed with
// its files. Never pulls more from the debrid provider than the viewer is about to watch.

const child_process = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pickH264Encoder } = require('../src/ipc/transcode.ipc');
const utils = require('../src/utils');

const SEG_S = 6;
const AHEAD_MAX = 20;            // segments made ahead of the viewer before ffmpeg is stopped (2 min)
const RESTART_GAP = 4;           // a request this many segments past what ffmpeg has made restarts it there
const WAIT_MS = 45000;           // how long a segment request waits for ffmpeg to make it
const IDLE_MS = 2 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;
// one folder per server (port): a second instance (a dev copy) must not empty the live one's segments on start
const ROOT = path.join(os.tmpdir(), `vault-streaming-hls-${process.env.VW_WEB_PORT || '8722'}`);

const sessions = new Map();      // key -> session

function ffprobePath() {
    return utils.getFFmpegPath().replace('ffmpeg.exe', 'ffprobe.exe').replace(/ffmpeg$/, 'ffprobe');
}

function probeDuration(src) {
    return new Promise((resolve) => {
        const args = ['-v', 'error', '-reconnect', '1', '-reconnect_streamed', '1', '-show_entries', 'format=duration',
                      '-of', 'csv=p=0', src];
        child_process.execFile(ffprobePath(), args, { windowsHide: true, timeout: 30000 }, (err, stdout) => {
            const d = parseFloat(String(stdout || '').trim());
            resolve(Number.isFinite(d) && d > 0 ? d : null);
        });
    });
}

function h264Level(h) { return h > 1088 ? '5.1' : '4.1'; }

function ffmpegArgs(s, startSeg) {
    const t = startSeg * SEG_S;
    const encoder = pickH264Encoder();
    const args = [];
    if (t > 0) args.push('-ss', String(t));
    if (encoder === 'h264_nvenc') args.push('-hwaccel', 'cuda');
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-i', s.src);
    if (s.audio !== null) args.push('-map', '0:v:0', '-map', `0:a:${s.audio}`);
    else args.push('-map', '0:v:0', '-map', '0:a:0?');
    args.push(
        '-vf', `scale=-2:${s.height}`, '-c:v', encoder, '-preset', 'fast', '-profile:v', 'high', '-level', h264Level(s.height),
        '-pix_fmt', 'yuv420p',
        // a keyframe at every segment boundary: segments cut exactly where the playlist says they start (NVENC
        // honours forced keyframes only as IDR frames: without -forced-idr the segments came out ~10.4 s long)
        '-force_key_frames', `expr:gte(t,n_forced*${SEG_S})`,
        ...(encoder === 'h264_nvenc' ? ['-forced-idr', '1'] : []),
        '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
        // timestamps from the film's own time (no muxer start delay), so each run's segments sit where they belong
        '-muxdelay', '0', '-muxpreload', '0', '-output_ts_offset', String(t),
        '-f', 'hls', '-hls_time', String(SEG_S), '-hls_list_size', '0', '-hls_segment_type', 'mpegts',
        '-start_number', String(startSeg), '-hls_segment_filename', path.join(s.dir, '%05d.ts'),
        path.join(s.dir, `run-${startSeg}.m3u8`),
    );
    return args;
}

function stop(s, why) {
    if (s.proc && s.proc.exitCode === null && !s.proc.killed) {
        console.log(`[web:hls] ${s.key.slice(0, 8)} ffmpeg stopped (${why}) at segment ${s.made}`);
        try { s.proc.kill('SIGKILL'); } catch (_) { try { s.proc.kill(); } catch (__) { } }
    }
    s.proc = null;
}

/** Segments ffmpeg has finished in the current run: those its own playlist lists. */
function refreshDone(s) {
    if (!s.runPlaylist) return;
    let text = '';
    try { text = fs.readFileSync(s.runPlaylist, 'utf8'); } catch (_) { return; }
    for (const m of text.matchAll(/^(\d{5})\.ts$/gm)) {
        const n = Number(m[1]);
        s.done.add(n);
        if (n > s.made) s.made = n;
    }
}

function start(s, seg) {
    stop(s, 'restart');
    s.runStart = seg;
    s.made = seg - 1;
    s.runPlaylist = path.join(s.dir, `run-${seg}.m3u8`);
    const proc = child_process.spawn(utils.getFFmpegPath(), ffmpegArgs(s, seg), { windowsHide: true });
    s.proc = proc;
    let tail = '';
    proc.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-3000); });
    proc.on('close', (code) => {
        refreshDone(s);
        if (code && code !== 255 && s.proc === proc) console.warn(`[web:hls] ffmpeg exited ${code}: ${tail.trim().slice(-400)}`);
        if (s.proc === proc) s.proc = null;
    });
    console.log(`[web:hls] ${s.key.slice(0, 8)} ffmpeg from segment ${seg} (${seg * SEG_S} s)`);
}

function sessionFor(src, audio, height) {
    const key = crypto.createHash('sha1').update(`${src}|${audio}|${height}`).digest('hex');
    let s = sessions.get(key);
    if (!s) {
        s = { key, src, audio, height, dir: path.join(ROOT, key), duration: null, segments: 0, proc: null,
              done: new Set(), made: -1, runStart: 0, runPlaylist: null, lastAsked: 0, lastSeen: Date.now() };
        fs.mkdirSync(s.dir, { recursive: true });
        sessions.set(key, s);
    }
    s.lastSeen = Date.now();
    return s;
}

// housekeeping: stop ffmpeg far ahead of the viewer or when nobody watches; drop old sessions
setInterval(() => {
    const now = Date.now();
    for (const [key, s] of sessions) {
        refreshDone(s);
        if (s.proc && s.made - s.lastAsked > AHEAD_MAX) stop(s, 'far enough ahead');
        if (s.proc && now - s.lastSeen > IDLE_MS) stop(s, 'idle');
        if (now - s.lastSeen > SESSION_TTL_MS) {
            stop(s, 'expired');
            sessions.delete(key);
            fs.rm(s.dir, { recursive: true, force: true }, () => { });
        }
    }
}, 5000).unref();

function registerHlsRoute(app) {
    fs.rmSync(ROOT, { recursive: true, force: true });   // segments of a previous server run
    fs.mkdirSync(ROOT, { recursive: true });

    app.get('/api/hls/index.m3u8', async (req, res) => {
        const src = req.query.src;
        if (!src || !/^https?:\/\//i.test(src)) return res.status(400).type('text/plain').send('Missing or invalid src');
        const audio = req.query.audio !== undefined && req.query.audio !== '' ? parseInt(req.query.audio, 10) : null;
        const height = parseInt(req.query.h || '1080', 10) || 1080;
        const s = sessionFor(src, Number.isInteger(audio) ? audio : null, height);
        if (!s.duration) {
            s.duration = await probeDuration(src);
            if (!s.duration) return res.status(502).type('text/plain').send('Could not read the source');
            s.segments = Math.ceil(s.duration / SEG_S);
        }
        const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEG_S}`, '#EXT-X-MEDIA-SEQUENCE:0',
                       '#EXT-X-PLAYLIST-TYPE:VOD'];
        for (let n = 0; n < s.segments; n++) {
            const len = Math.min(SEG_S, s.duration - n * SEG_S);
            lines.push(`#EXTINF:${len.toFixed(3)},`, `seg/${s.key}/${n}.ts`);
        }
        lines.push('#EXT-X-ENDLIST', '');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store');
        res.send(lines.join('\n'));
    });

    app.get('/api/hls/seg/:key/:n.ts', async (req, res) => {
        const s = sessions.get(req.params.key);
        const n = parseInt(req.params.n, 10);
        if (!s || !Number.isInteger(n) || n < 0 || (s.segments && n >= s.segments)) return res.status(404).end();
        s.lastSeen = Date.now();
        s.lastAsked = n;
        refreshDone(s);
        const running = !!s.proc;
        // not made and not about to be: (re)start ffmpeg at this segment
        if (!s.done.has(n) && (!running || n < s.runStart || n > s.made + RESTART_GAP)) start(s, n);
        const t0 = Date.now();
        while (!s.done.has(n)) {
            if (Date.now() - t0 > WAIT_MS || (!s.proc && !s.done.has(n) && Date.now() - t0 > 2000)) {
                return res.status(503).type('text/plain').send('Segment not ready');
            }
            await new Promise(r => setTimeout(r, 250));
            refreshDone(s);
        }
        res.setHeader('Content-Type', 'video/mp2t');
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(path.join(s.dir, `${String(n).padStart(5, '0')}.ts`));
    });

    console.log('[web:hls] route registered (GET /api/hls/index.m3u8, /api/hls/seg/...)');
}

module.exports = { registerHlsRoute, SEG_S };
