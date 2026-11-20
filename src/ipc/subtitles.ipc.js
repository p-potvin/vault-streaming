// src/ipc/subtitles.ipc.js — subtitle discovery for the player.
//
//   • Local files  → scans for sidecar .srt/.vtt subtitles beside the video.
//   • Stream URLs  → returns [] gracefully (nothing local to find).
//   • OpenSubtitles remote → searches via v5 API when queryTitle + API key are available.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');

const SUB_EXTS = ['.srt', '.vtt'];

const OS_API_BASE = 'api.opensubtitles.com';
const OS_API_PATH = '/api/v1';

// Map a trailing language token in a sidecar filename to a label/lang code.
function parseLangToken(token) {
    if (!token) return { lang: 'und', label: 'Original' };
    const t = token.toLowerCase();
    const map = {
        en: 'English', eng: 'English',
        fr: 'French', fre: 'French', fra: 'French',
        'fr-ca': 'French (CA)',
        es: 'Spanish', spa: 'Spanish',
        de: 'German', ja: 'Japanese', ko: 'Korean'
    };
    if (map[t]) return { lang: t, label: map[t] };
    return { lang: 'und', label: 'Original' };
}

// Convert SubRip (.srt) to WebVTT (.vtt) format
function srtToVtt(srtText) {
    if (!srtText) return 'WEBVTT\n\n';
    let vtt = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    vtt = vtt.replace(/^\uFEFF/, '');
    // Convert 00:00:20,000 --> 00:00:24,400 to 00:00:20.000 --> 00:00:24.400
    vtt = vtt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    vtt = vtt.replace(/(\d{2}:\d{2}),(\d{3})/g, '00:$1.$2');
    if (!vtt.trim().startsWith('WEBVTT')) {
        vtt = 'WEBVTT\n\n' + vtt;
    }
    return vtt;
}

// Find sidecar subtitles ("<base>.srt", "<base>.en.srt", …) next to a video.
function findLocalSidecars(videoPath) {
    try {
        if (!videoPath || !fs.existsSync(videoPath)) return [];
        const dir = path.dirname(videoPath);
        const base = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
        const results = [];
        for (const name of fs.readdirSync(dir)) {
            const ext = path.extname(name).toLowerCase();
            if (!SUB_EXTS.includes(ext)) continue;
            const stem = path.basename(name, ext).toLowerCase();
            if (stem === base || stem.startsWith(base + '.')) {
                const token = stem === base ? '' : stem.slice(base.length + 1);
                const { lang, label } = parseLangToken(token);
                let targetPath = path.join(dir, name);

                // If sidecar is .srt, ensure a .vtt copy exists beside it for HTML5 <track>
                if (ext === '.srt') {
                    const vttName = name.replace(/\.srt$/i, '.vtt');
                    const vttPath = path.join(dir, vttName);
                    if (!fs.existsSync(vttPath)) {
                        try {
                            const srtContent = fs.readFileSync(targetPath, 'utf8');
                            fs.writeFileSync(vttPath, srtToVtt(srtContent), 'utf8');
                            targetPath = vttPath;
                        } catch (_) {}
                    } else {
                        targetPath = vttPath;
                    }
                }

                results.push({
                    label,
                    lang,
                    path: targetPath,
                    isLocal: true,
                    isOpenSubtitles: false
                });
            }
        }
        return results;
    } catch (e) {
        console.error('[subtitles] sidecar scan failed:', e.message);
        return [];
    }
}

// ── OpenSubtitles v5 API helpers ───────────────────────────────────────

function osRequest(endpoint, apiKey, method = 'GET', body = null, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 3) return reject(new Error('Too many redirects'));
        const headers = {
            'Api-Key': apiKey,
            'User-Agent': 'VaultStreaming v1.0',
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        };
        const requestPath = endpoint.startsWith(OS_API_PATH) ? endpoint : (OS_API_PATH + endpoint);
        const opts = {
            hostname: OS_API_BASE,
            path: requestPath,
            method,
            headers,
        };
        if (body) {
            const payload = JSON.stringify(body);
            headers['Content-Length'] = Buffer.byteLength(payload);
            opts.body = payload;
        }
        const req = https.request(opts, (res) => {
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
                return resolve(osRequest(res.headers.location, apiKey, method, body, redirects + 1));
            }
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch (_) {
                    resolve({ status: res.statusCode, data: null });
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('OpenSubtitles request timed out')); });
        if (opts.body) req.write(opts.body);
        req.end();
    });
}

// OpenSubtitles wants ISO-639-1 codes ('fr', not 'fr-CA'); only a few regional variants are valid.
const OS_REGIONAL = new Set(['pt-br', 'pt-pt', 'zh-cn', 'zh-tw']);
function osLangs(langs) {
    const list = (Array.isArray(langs) ? langs : String(langs || '').split(','))
        .map(l => String(l).trim().toLowerCase()).filter(Boolean)
        .map(x => (x === 'qc' ? 'fr' : (OS_REGIONAL.has(x) ? x : x.split('-')[0])));
    return [...new Set(list.length ? list : ['en'])].join(',');
}

const CAM_RELEASE_RE = /\b(cam|camrip|hdcam|ts|hdts|telesync|tc|hdtc|telecine)\b/i;

/** One OpenSubtitles result as the player lists it. */
function osEntry(entry) {
    const a = entry.attributes || {};
    const file = (a.files && a.files[0]) || {};
    const fd = a.feature_details || {};
    return {
        fileId: file.file_id || null,
        lang: a.language || 'und',
        release: a.release || file.file_name || '',
        label: `${String(a.language || 'und').toUpperCase()} — ${a.release || file.file_name || 'unknown release'}`,
        downloads: a.download_count || 0,
        hearingImpaired: !!a.hearing_impaired,
        machineTranslated: !!(a.machine_translated || a.ai_translated),
        trusted: !!a.from_trusted,
        fps: a.fps || null,
        // which title OpenSubtitles matched — shown so a wrong film (same name, other year) is visible
        feature: [fd.parent_title || fd.title, fd.year].filter(Boolean).join(' · ') || null,
        isLocal: false,
        isOpenSubtitles: true,
    };
}

/**
 * Search OpenSubtitles, best first (most downloaded; machine translations last).
 *   { imdbId }                          a film, matched by its IMDb id — never another film of the same name
 *   { imdbId, season, episode }         an episode: the series' IMDb id + season + episode
 *   { query, year }                     no IMDb id (a library file): by name, narrowed by year when known
 */
async function searchOpenSubtitles(apiKey, { imdbId, season, episode, query, year, langs, limit = 20 } = {}) {
    if (!apiKey) return [];
    const p = { languages: osLangs(langs), order_by: 'download_count', order_direction: 'desc' };
    const num = imdbId ? String(imdbId).replace(/^tt/i, '').replace(/^0+/, '') : '';
    if (num && season != null && episode != null) {
        p.parent_imdb_id = num;
        p.season_number = String(season);
        p.episode_number = String(episode);
    } else if (num) {
        p.imdb_id = num;
    } else if (query) {
        p.query = query;
        if (year) p.year = String(year);
    } else {
        return [];
    }
    try {
        // OpenSubtitles requires query params in ALPHABETICAL order and 301-redirects otherwise.
        const qs = new URLSearchParams(p);
        qs.sort();
        const res = await osRequest(`/subtitles?${qs.toString()}`, apiKey);
        if (res.status !== 200 || !res.data || !Array.isArray(res.data.data)) {
            console.warn('[subtitles] OpenSubtitles search returned status', res.status);
            return [];
        }
        // CAM / telesync subtitles are timed for a camcorder copy the app never auto-plays: after the rest
        const cam = (r) => (CAM_RELEASE_RE.test(r.release) ? 1 : 0);
        return res.data.data.map(osEntry).filter(s => s.fileId)
            .map(r => ({ ...r, cam: !!cam(r) }))
            .sort((a, b) => (a.machineTranslated - b.machineTranslated) || (cam(a) - cam(b)) || (b.downloads - a.downloads))
            .slice(0, limit);
    } catch (e) {
        console.error('[subtitles] OpenSubtitles search failed:', e.message);
        return [];
    }
}

async function downloadOpenSubtitles(apiKey, fileId) {
    if (!apiKey || !fileId) return { success: false, error: 'Missing API key or file ID' };
    try {
        // a 5xx (often 521: their server unreachable behind Cloudflare) usually passes on a second try
        let res = await osRequest('/download', apiKey, 'POST', { file_id: fileId });
        for (let retry = 1; retry <= 2 && res.status >= 500; retry++) {
            console.warn(`[subtitles] OpenSubtitles download HTTP ${res.status}, retry ${retry}/2`);
            await new Promise(r => setTimeout(r, 1500 * retry));
            res = await osRequest('/download', apiKey, 'POST', { file_id: fileId });
        }
        if (res.status !== 200 || !res.data || !res.data.link) {
            return { success: false, error: `OpenSubtitles download failed (status ${res.status})` };
        }
        return { success: true, link: res.data.link, fileName: res.data.file_name || 'subtitle.srt', remaining: res.data.remaining };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// A subtitle file's text, whatever its encoding: UTF-8 (with or without BOM), UTF-16 with a BOM, else Windows-1252
// (most older Western-European .srt files) — decoding those as UTF-8 turned every accented letter into "�".
function decodeSubtitle(buf) {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
    } catch (_) {
        return new TextDecoder('windows-1252').decode(buf);
    }
}

/** GET a URL into a Buffer, following redirects (OpenSubtitles' download links may redirect to a CDN). */
function fetchBuffer(url, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 4) return reject(new Error('Too many redirects'));
        const req = https.get(url, { headers: { 'User-Agent': 'VaultStreaming v1.0' } }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                return resolve(fetchBuffer(new URL(res.headers.location, url).toString(), redirects + 1));
            }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Download failed: HTTP ${res.statusCode}`)); }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(20000, () => { req.destroy(); reject(new Error('Subtitle download timed out')); });
    });
}

const msToVtt = (ms) => {
    const t = Math.max(0, Math.round(ms));
    const h = Math.floor(t / 3600000), m = Math.floor(t / 60000) % 60, s = Math.floor(t / 1000) % 60, x = t % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(x).padStart(3, '0')}`;
};

/** WebVTT text from the transcripts store's cues ({ start_ms, end_ms, text }). */
function cuesToVtt(cues) {
    const out = ['WEBVTT', ''];
    for (const c of cues || []) {
        const text = String(c.text || '').trim();
        if (!text) continue;
        out.push(`${msToVtt(c.start_ms)} --> ${msToVtt(Math.max(c.end_ms, c.start_ms + 500))}`, text, '');
    }
    return out.join('\n');
}

const subtitleCacheDir = () => {
    const dir = path.join(app.getPath('userData'), 'subtitles');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};

function apiKeyFrom(loadSettings) {
    const settings = (typeof loadSettings === 'function') ? loadSettings() : {};
    return settings.openSubtitlesKey || process.env.OPENSUBTITLES_API_KEY || '';
}

function registerSubtitlesIpc(ipcMain, _settingsPath, loadSettings) {
    // Library player: sidecars beside a local file, plus (when a title is given) OpenSubtitles by name.
    // Signature mirrors the preload binding: (videoPath, queryTitle, skipOpenSubtitles, langs)
    ipcMain.handle('find-subtitles', async (event, videoPath, queryTitle, skipOpenSubtitles, langs) => {
        const local = findLocalSidecars(videoPath);
        if (!skipOpenSubtitles && queryTitle) {
            const apiKey = apiKeyFrom(loadSettings);
            if (apiKey) return [...local, ...await searchOpenSubtitles(apiKey, { query: queryTitle, langs })];
        }
        return local;
    });

    // OpenSubtitles for the title being played, matched by IMDb id (a film; a series + season + episode), falling
    // back to its name and year: { success, results: [...best first], imdbId } or { success: false, error }.
    ipcMain.handle('subtitles:search', async (_e, p = {}) => {
        const apiKey = apiKeyFrom(loadSettings);
        if (!apiKey) return { success: false, error: 'No OpenSubtitles API key configured (Settings).' };
        try {
            const isTv = p.mediaType === 'tv';
            const { imdbIdFor } = require('../realdebrid/search');
            const imdbId = p.tmdbId ? await imdbIdFor(p.tmdbId, isTv ? 'tv' : 'movie') : null;
            const results = await searchOpenSubtitles(apiKey, {
                imdbId, langs: p.langs, limit: p.limit || 20,
                season: isTv ? p.season : null, episode: isTv ? p.episode : null,
                query: p.title || null, year: p.year || null,
            });
            return { success: true, results, imdbId };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // The AI transcript of what is playing — made by vault-raggae's Moments job for every played stream (and by
    // Moments for library files). Never starts a job: { state: 'ready', path, lang, cues } once it exists, else
    // { state: 'queued' | 'starting' | 'reading' | 'none' | 'failed' | 'unavailable', progress? }.
    ipcMain.handle('subtitles:transcript', async (_e, p = {}) => {
        const raggae = require('../raggae');
        try {
            const isStream = /^https?:\/\//i.test(String(p.videoPath || '')) || !p.videoPath;
            let key = null;
            if (isStream) {
                const { streamKeyFor } = require('./moments.ipc');
                const sk = await streamKeyFor(p);
                if (!sk) return { state: 'unavailable' };
                key = sk.key;
            } else {
                key = p.videoPath;
            }
            const files = (await raggae.transcriptsByPath(key))
                // a library .srt beside the video is a sidecar (listed already), not the AI transcript
                .filter(f => !/\.(srt|vtt|ass|ssa)$/i.test(String(f.path || '')) && Array.isArray(f.cue_list) && f.cue_list.length);
            if (files.length) {
                const f = files[0];
                const safe = String(key).replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120);
                const out = path.join(subtitleCacheDir(), `transcript-${safe}.vtt`);
                fs.writeFileSync(out, cuesToVtt(f.cue_list), 'utf8');
                return { state: 'ready', path: out, lang: f.language || 'und', cues: f.cue_list.length };
            }
            if (!isStream) return { state: 'none' };
            const st = await raggae.streamStatus(key);
            if (!st) return { state: raggae.isOffline() ? 'unavailable' : 'none' };
            const progress = st.duration && st.read_s ? Math.min(99, Math.round((st.read_s / st.duration) * 100)) : null;
            // 'done' with no transcript in the store yet = the gateway is still saving it
            return { state: st.state === 'done' ? 'reading' : st.state, progress, error: st.error || null };
        } catch (e) {
            console.warn('[subtitles] transcript lookup failed:', e.message);
            return { state: 'unavailable', error: e.message };
        }
    });

    // Download a remote OpenSubtitles track by fileId -> a .vtt in the subtitle cache (UTF-8, whatever the source
    // encoding). Streams and library files alike: the cache is keyed by file id, nothing is written beside videos.
    ipcMain.handle('download-subtitle-track', async (_event, { fileId, apiKey } = {}) => {
        const key = apiKey || apiKeyFrom(loadSettings);
        if (!key) return { success: false, error: 'No OpenSubtitles API key configured' };
        if (!fileId) return { success: false, error: 'No subtitle file id' };
        const cached = path.join(subtitleCacheDir(), `os-${fileId}.vtt`);
        if (fs.existsSync(cached)) return { success: true, path: cached, cached: true };

        const result = await downloadOpenSubtitles(key, fileId);
        if (!result.success) return result;
        try {
            const text = decodeSubtitle(await fetchBuffer(result.link));
            const vtt = /^\s*WEBVTT/.test(text) ? text : srtToVtt(text);
            if (!/-->/.test(vtt)) return { success: false, error: 'The downloaded file has no subtitle cues' };
            fs.writeFileSync(cached, vtt, 'utf8');
            return { success: true, path: cached, remaining: result.remaining };
        } catch (e) {
            return { success: false, error: `Failed to save subtitle: ${e.message}` };
        }
    });

    console.log('[subtitles] IPC handlers registered (find-subtitles, subtitles:search, subtitles:transcript, download-subtitle-track).');
}

module.exports = { registerSubtitlesIpc, _decodeSubtitle: decodeSubtitle, _cuesToVtt: cuesToVtt, _searchOpenSubtitles: searchOpenSubtitles };
