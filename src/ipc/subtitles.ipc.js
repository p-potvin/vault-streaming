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
                results.push({
                    label,
                    lang,
                    path: path.join(dir, name),
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

function osRequest(endpoint, apiKey, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
        const headers = {
            'Api-Key': apiKey,
            'User-Agent': 'VaultStreaming v1.0',
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        };
        const opts = {
            hostname: OS_API_BASE,
            path: OS_API_PATH + endpoint,
            method,
            headers,
        };
        if (body) {
            const payload = JSON.stringify(body);
            headers['Content-Length'] = Buffer.byteLength(payload);
            opts.body = payload;
        }
        const req = https.request(opts, (res) => {
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

async function searchOpenSubtitles(apiKey, queryTitle, langs) {
    if (!apiKey || !queryTitle) return [];
    try {
        // OpenSubtitles wants ISO-639-1 codes ('fr', not 'fr-CA'); only a few
        // regional variants are valid. Normalize so a 'fr-CA' pick still matches.
        const OS_REGIONAL = new Set(['pt-br', 'pt-pt', 'zh-cn', 'zh-tw']);
        const normLangs = (Array.isArray(langs) && langs.length > 0)
            ? langs.map(l => { const x = String(l).toLowerCase(); return OS_REGIONAL.has(x) ? x : x.split('-')[0]; })
            : ['en'];
        const langParam = [...new Set(normLangs)].join(',');
        const qs = new URLSearchParams({ query: queryTitle, languages: langParam });
        // OpenSubtitles requires query params in ALPHABETICAL order and 301-redirects
        // otherwise. Node's https doesn't follow the redirect, so the response was a
        // 301 body -> parsed as no results -> "no subs found" every time. Sort fixes it.
        qs.sort();
        const res = await osRequest(`/subtitles?${qs.toString()}`, apiKey);
        if (res.status !== 200 || !res.data || !res.data.data) {
            console.warn('[subtitles] OpenSubtitles search returned status', res.status);
            return [];
        }
        return res.data.data.slice(0, 20).map(entry => {
            const attrs = entry.attributes || {};
            const file = (attrs.files && attrs.files[0]) || {};
            return {
                label: `${attrs.language || 'und'} — ${attrs.release || 'unknown'}`,
                lang: attrs.language || 'und',
                fileId: file.file_id || null,
                isLocal: false,
                isOpenSubtitles: true,
                downloads: attrs.download_count || 0,
                rating: attrs.ratings || 0,
            };
        }).filter(s => s.fileId);
    } catch (e) {
        console.error('[subtitles] OpenSubtitles search failed:', e.message);
        return [];
    }
}

async function downloadOpenSubtitles(apiKey, fileId) {
    if (!apiKey || !fileId) return { success: false, error: 'Missing API key or file ID' };
    try {
        const res = await osRequest('/download', apiKey, 'POST', { file_id: fileId });
        if (res.status !== 200 || !res.data || !res.data.link) {
            return { success: false, error: `OpenSubtitles download failed (status ${res.status})` };
        }
        return { success: true, link: res.data.link, fileName: res.data.file_name || 'subtitle.srt' };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

function registerSubtitlesIpc(ipcMain, _settingsPath, loadSettings) {
    // Signature mirrors the preload binding:
    //   (videoPath, queryTitle, skipOpenSubtitles, langs)
    ipcMain.handle('find-subtitles', async (event, videoPath, queryTitle, skipOpenSubtitles, langs) => {
        const local = findLocalSidecars(videoPath);

        // Remote OpenSubtitles lookup — only if not skipped and we have a query title
        if (!skipOpenSubtitles && queryTitle) {
            const settings = (typeof loadSettings === 'function') ? loadSettings() : {};
            const apiKey = settings.openSubtitlesKey || process.env.OPENSUBTITLES_API_KEY;
            if (apiKey) {
                const remote = await searchOpenSubtitles(apiKey, queryTitle, langs);
                return [...local, ...remote];
            }
        }

        return local;
    });

    // Download a remote OpenSubtitles track by fileId
    ipcMain.handle('download-subtitle-track', async (_event, { fileId, apiKey, outputDir, videoPath } = {}) => {
        const settings = (typeof loadSettings === 'function') ? loadSettings() : {};
        const key = apiKey || settings.openSubtitlesKey || process.env.OPENSUBTITLES_API_KEY;
        if (!key) return { success: false, error: 'No OpenSubtitles API key configured' };

        const result = await downloadOpenSubtitles(key, fileId);
        if (!result.success) return result;

        // Download the actual subtitle file
        try {
            const downloadUrl = result.link;
            // Streams are http(s) URLs, not files. path.dirname() on one yields a
            // nonsense relative path that path.join then hangs off the cwd —
            // producing e.g. "<repo>\http:\100.67.25.118:5173\...srt" and an
            // ENOENT. Only write next to the video when it really is a local file;
            // otherwise keep the sidecar in a writable cache under userData.
            const isLocalFile = typeof videoPath === 'string'
                && !/^[a-z][a-z0-9+.-]*:\/\//i.test(videoPath)
                && path.isAbsolute(videoPath);
            let dir = outputDir;
            if (!dir) {
                dir = isLocalFile
                    ? path.dirname(videoPath)
                    : path.join(app.getPath('userData'), 'subtitles');
            }
            fs.mkdirSync(dir, { recursive: true });
            // Remote titles can collide on filename, so key the cache by file id.
            const rawName = result.fileName || `subtitle_${fileId}.srt`;
            const safeName = rawName.replace(/[\/:*?"<>|]/g, '_');
            const fileName = isLocalFile ? safeName : `${fileId}_${safeName}`;
            const outPath = path.join(dir, fileName);

            await new Promise((resolve, reject) => {
                https.get(downloadUrl, (res) => {
                    if (res.statusCode !== 200) { reject(new Error(`Download failed: HTTP ${res.statusCode}`)); return; }
                    const ws = fs.createWriteStream(outPath);
                    res.pipe(ws);
                    ws.on('finish', () => { ws.close(); resolve(); });
                    ws.on('error', reject);
                }).on('error', reject);
            });

            return { success: true, path: outPath };
        } catch (e) {
            return { success: false, error: `Failed to save subtitle: ${e.message}` };
        }
    });

    console.log('[subtitles] IPC handler registered (find-subtitles, download-subtitle-track).');
}

module.exports = { registerSubtitlesIpc };
