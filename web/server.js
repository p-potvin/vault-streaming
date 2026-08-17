// web/server.js — Vault Streaming, served to a browser.
//
// Boots the existing src/ IPC handlers headlessly (see electron-shim.js), serves
// the existing index.html / js / css untouched, and exposes the IPC surface as
// POST /api/invoke + an SSE event stream. The renderer is not modified: a small
// client-side shim (public/electron-api-shim.js) recreates `window.electronAPI`
// on top of those two endpoints.
//
//   npm run web            → http://127.0.0.1:8722
//   VW_WEB_HOST=0.0.0.0 VW_WEB_TOKEN=<secret> npm run web   → LAN, token-gated

const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');

const ROOT = path.join(__dirname, '..');

// ── .env (mirrors main.js loadEnv) ──────────────────────────────────────────
function loadEnv() {
    const candidates = [
        path.join(process.cwd(), '.env'),
        path.join(ROOT, '.env'),
        path.join(ROOT, '..', '.env'),
    ];
    for (const envPath of candidates) {
        try {
            if (!fs.existsSync(envPath)) continue;
            console.log('[web:env] Loading environment variables from:', envPath);
            for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) continue;
                const idx = line.indexOf('=');
                if (idx < 1) continue;
                const key = line.slice(0, idx).trim();
                const value = line.slice(idx + 1).trim();
                if (key && !process.env[key]) process.env[key] = value;
            }
            return;
        } catch (e) {
            console.error('[web:env] Failed to load .env from:', envPath, e.message);
        }
    }
}
loadEnv();

// Must happen before anything under src/ is required.
const { install: installElectronShim, USER_DATA } = require('./electron-shim');
installElectronShim();

const { IpcBridge, encode } = require('./ipc-bridge');
const { limitSearchResult, maxGB, maxHeight } = require('./source-limits');

// ── Settings (mirrors main.js; same file as the desktop app) ────────────────
const settingsPath = path.join(USER_DATA, 'vault-settings.json');
function loadSettings() {
    try {
        if (fs.existsSync(settingsPath)) {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            if (settings.mutePreviews === undefined) settings.mutePreviews = false;
            settings.tmdbBearerToken = process.env.TMDB_BEARER_TOKEN;
            return settings;
        }
    } catch (e) {
        console.warn('[web:settings] Could not read settings:', e.message);
    }
    return { folders: [], mutePreviews: false, tmdbBearerToken: process.env.TMDB_BEARER_TOKEN };
}
async function saveSettings(settings) {
    try {
        await fs.promises.mkdir(USER_DATA, { recursive: true });
        await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error('[web:settings] Failed to save settings:', e.message);
        return false;
    }
}

// ── Register the real handlers, unmodified ──────────────────────────────────
const bridge = new IpcBridge();
const ipcMain = bridge.ipcMain;

const { registerSystemIpc } = require('../src/ipc/system.ipc');
const { registerMediaIpc } = require('../src/ipc/media.ipc');
const { registerSubtitlesIpc } = require('../src/ipc/subtitles.ipc');
const { registerTranscodeIpc } = require('../src/ipc/transcode.ipc');
const { registerClipIpc } = require('../src/ipc/clip.ipc');
const { registerTrailerCacheIpc } = require('../src/ipc/trailer-cache.ipc');
const { registerAudioTracksIpc } = require('../src/ipc/audio-tracks.ipc');
const { registerDebridStatsIpc } = require('../src/telemetry/debrid-stats');
const tmdbHandlers = require('../src/tmdb');
const realDebridHandlers = require('../src/realdebrid');
const watchHistoryHandlers = require('../src/watch-history');
const liveSubtitlesHandlers = require('../src/live-subtitles');
const { electronShim } = require('./electron-shim');

registerSystemIpc(ipcMain, settingsPath, loadSettings, saveSettings);
registerMediaIpc(ipcMain);
registerSubtitlesIpc(ipcMain, settingsPath, loadSettings);
registerTranscodeIpc(ipcMain);
registerClipIpc(ipcMain);
registerTrailerCacheIpc(ipcMain);
registerAudioTracksIpc(ipcMain);
registerDebridStatsIpc(ipcMain);
tmdbHandlers.registerTmdbHandlers(ipcMain);
realDebridHandlers.registerRealDebridHandlers(ipcMain);
watchHistoryHandlers.registerWatchHistoryHandlers(ipcMain, electronShim.app);
liveSubtitlesHandlers.registerLiveSubtitlesHandlers(ipcMain);

console.log(`[web:bridge] ${bridge.channels().length} IPC channels registered`);

// ── App ─────────────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');

const HOST = process.env.VW_WEB_HOST || '127.0.0.1';
const PORT = parseInt(process.env.VW_WEB_PORT || '8722', 10);
const TOKEN = process.env.VW_WEB_TOKEN || '';

// Token gate. Off when unset AND bound to loopback; refuses to start wide open.
if (!TOKEN && HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.error('[web:auth] VW_WEB_HOST is not loopback and VW_WEB_TOKEN is unset.');
    console.error('[web:auth] Refusing to expose the client (and your debrid/TMDB creds) unauthenticated.');
    process.exit(1);
}

app.use((req, res, next) => {
    if (!TOKEN) return next();
    const supplied = req.get('x-vw-token')
        || req.query.token
        || (req.headers.cookie || '').match(/(?:^|;\s*)vw_token=([^;]+)/)?.[1];
    if (supplied === TOKEN) {
        if (req.query.token) res.setHeader('Set-Cookie', `vw_token=${TOKEN}; Path=/; HttpOnly; SameSite=Lax`);
        return next();
    }
    res.status(401).type('text/plain').send('Unauthorized — append ?token=<VW_WEB_TOKEN> to the URL once.');
});

app.use(express.json({ limit: '64mb' }));

// ── index.html, with the shim injected ──────────────────────────────────────
// Served from the repo's own index.html so the desktop and web clients can
// never drift apart. Two scripts are spliced in: the electronAPI shim (before
// the first renderer script, since the renderer reads it at load) and the web
// overrides (after the last, so it can patch what the renderer defined).
const SHIM_TAG = '<script src="/__vw/electron-api-shim.js"></script>\n  ';
const OVERRIDES_TAG = '\n  <script src="/__vw/web-overrides.js" defer></script>';

function renderIndex() {
    let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const first = html.indexOf('<script src="js/');
    const lastOpen = html.lastIndexOf('<script src="js/');
    if (first === -1 || lastOpen === -1) {
        throw new Error('[web] Could not locate renderer <script src="js/..."> tags in index.html');
    }
    const lastEnd = html.indexOf('</script>', lastOpen) + '</script>'.length;
    // Splice back-to-front so the first offset stays valid.
    html = html.slice(0, lastEnd) + OVERRIDES_TAG + html.slice(lastEnd);
    html = html.slice(0, first) + SHIM_TAG + html.slice(first);
    return html;
}

app.get(['/', '/index.html'], (_req, res) => {
    try {
        res.type('html').send(renderIndex());
    } catch (e) {
        console.error('[web] index render failed:', e);
        res.status(500).type('text/plain').send(e.message);
    }
});

// ── Static assets, straight off the repo ────────────────────────────────────
app.use('/__vw', express.static(path.join(__dirname, 'public')));
app.use('/js', express.static(path.join(ROOT, 'js')));
app.use('/css', express.static(path.join(ROOT, 'css')));
app.use('/public', express.static(path.join(ROOT, 'public')));
app.use('/build', express.static(path.join(ROOT, 'build')));
app.use('/vaultwares-themes', express.static(path.join(ROOT, 'vaultwares-themes')));
// index.html pulls flag-icons from node_modules; expose only that package.
app.use('/node_modules/flag-icons', express.static(path.join(ROOT, 'node_modules', 'flag-icons')));

// ── IPC over HTTP ───────────────────────────────────────────────────────────
app.post('/api/invoke', async (req, res) => {
    const { channel, args } = req.body || {};
    if (typeof channel !== 'string') {
        return res.status(400).json({ ok: false, error: 'Missing channel' });
    }
    const clientId = req.get('x-vw-client') || 'anonymous';
    const payload = await bridge.invoke(channel, Array.isArray(args) ? args : [], clientId);

    // Web-only playback limits. Applied to the result rather than inside the
    // handler so src/ stays shared with the desktop app, which has no such cap.
    if (payload.ok && channel === 'search-torrents') {
        payload.result = limitSearchResult(payload.result);
    }

    res.type('application/json').send(encode(payload));
});

app.get('/api/channels', (_req, res) => res.json(bridge.channels()));

// ── Push channels over SSE ──────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
    const clientId = req.query.client;
    if (!clientId) return res.status(400).end('Missing client id');

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    const detach = bridge.subscribe(clientId, res);
    // Comment frames keep proxies and idle-timeout logic from closing the stream.
    const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) { } }, 20000);

    req.on('close', () => {
        clearInterval(keepAlive);
        detach();
    });
});

// ── Local library media, with byte ranges ───────────────────────────────────
// The desktop build plays local files via file:///. A browser cannot, so the
// renderer's sanitizePath() is repointed here (see web-overrides.js) and this
// route streams the bytes — scoped to the vault roots so an open port can't be
// walked into an arbitrary-file read.
function allowedRoots() {
    const roots = (loadSettings().folders || []).map(f => f && f.path).filter(Boolean);
    const extra = (process.env.VW_WEB_MEDIA_ROOTS || '').split(/[;,]/).map(s => s.trim()).filter(Boolean);
    return [...roots, ...extra].map(r => path.resolve(r));
}

function isInsideAllowedRoot(target) {
    const resolved = path.resolve(target);
    return allowedRoots().some(root => {
        const rel = path.relative(root, resolved);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
}

const MIME = {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska',
    '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.opus': 'audio/opus',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.vtt': 'text/vtt', '.srt': 'application/x-subrip', '.ass': 'text/plain',
};

app.get('/api/media', (req, res) => {
    const target = req.query.path;
    if (!target) return res.status(400).end('Missing path');
    if (!isInsideAllowedRoot(target)) {
        console.warn('[web:media] Refused out-of-root read:', target);
        return res.status(403).end('Path is outside the configured vault roots');
    }

    let stat;
    try {
        stat = fs.statSync(target);
        if (!stat.isFile()) return res.status(404).end('Not a file');
    } catch (_) {
        return res.status(404).end('Not found');
    }

    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    const range = req.get('range');

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', type);

    if (req.method === 'HEAD') {
        res.setHeader('Content-Length', stat.size);
        return res.status(200).end();
    }

    if (!range) {
        res.setHeader('Content-Length', stat.size);
        return fs.createReadStream(target).on('error', () => res.destroy()).pipe(res);
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match) {
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        return res.status(416).end();
    }
    let [, startRaw, endRaw] = match;
    let start, end;
    if (startRaw === '') {
        // Suffix range: "bytes=-N" means the LAST N bytes.
        const suffix = parseInt(endRaw, 10);
        if (!Number.isFinite(suffix) || suffix <= 0) {
            res.setHeader('Content-Range', `bytes */${stat.size}`);
            return res.status(416).end();
        }
        start = Math.max(0, stat.size - suffix);
        end = stat.size - 1;
    } else {
        start = parseInt(startRaw, 10);
        end = endRaw === '' ? stat.size - 1 : parseInt(endRaw, 10);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        return res.status(416).end();
    }
    end = Math.min(end, stat.size - 1);

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(target, { start, end }).on('error', () => res.destroy()).pipe(res);
});

// On-the-fly remux/transcode so browsers can play MKV/HEVC/lossless-audio sources.
require('./transcode-route').registerTranscodeRoute(app);

app.get('/api/health', (_req, res) => res.json({
    ok: true,
    channels: bridge.channels().length,
    userData: USER_DATA,
    mediaRoots: allowedRoots(),
}));

// ── Boot ────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, HOST, () => {
    const shown = HOST === '0.0.0.0' ? firstLanAddress() : HOST;
    console.log(`[web] Vault Streaming web client → http://${shown}:${PORT}${TOKEN ? '?token=<VW_WEB_TOKEN>' : ''}`);
    console.log(`[web] userData: ${USER_DATA}`);
    console.log(`[web] media roots: ${allowedRoots().join(' | ') || '(none configured)'}`);
});

function firstLanAddress() {
    for (const list of Object.values(os.networkInterfaces())) {
        for (const net of list || []) {
            if (net.family === 'IPv4' && !net.internal) return net.address;
        }
    }
    return 'localhost';
}

function shutdown() {
    console.log('\n[web] Shutting down…');
    try { liveSubtitlesHandlers.shutdownLiveSubtitles(); } catch (_) { }
    try { watchHistoryHandlers.flushNow(); } catch (_) { }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
