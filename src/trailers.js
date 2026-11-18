// src/trailers.js — every trailer is looked up and downloaded once, then served from the local disk.
//
// Two caches, both on the G: drive by default (TRAILER_CACHE_DIR overrides):
//   index.json        title -> YouTube id ("movie:603:en-US" -> { youtube_id, provider }), and the misses
//                     ("none", retried after NEGATIVE_TTL_MS) so a title with no trailer is not asked again every view
//   <youtubeId>.mp4   the trailer itself, downloaded once with yt-dlp (H.264 + AAC, <= 1080p, plays in <video>)
// The resolved key is also written onto the catalog item (raw_enrichment.trailer), so vault-raggae knows it.
//
// Key lookup order: the catalog item's trailer key -> index.json -> KinoCheck -> the catalog's TMDB videos (read
// through, src/tmdb.js). A download failure is remembered too (FAILED_TTL_MS) so YouTube is not hammered.
//
// Served as a file:// URL in the Electron window and as /trailers/<id>.mp4 by web/server.js.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

// read when used, not at require time: src/tmdb.js loads .env after requiring this module
const cacheDir = () => process.env.TRAILER_CACHE_DIR || 'G:\\VaultStreaming\\trailers';
const indexFile = () => path.join(cacheDir(), 'index.json');
const NEGATIVE_TTL_MS = 7 * 24 * 3600 * 1000;      // "no trailer" is asked again after a week
const FAILED_TTL_MS = 24 * 3600 * 1000;            // a failed download is retried after a day
const DOWNLOAD_TIMEOUT_MS = 4 * 60 * 1000;
const YT_ID = /^[A-Za-z0-9_-]{6,20}$/;

let deps = null;   // { readThroughDetails, fetchKinoCheckTrailer, findCatalogItem, ingestTrailerKey } from src/tmdb.js

function configure(d) {
    deps = d;
}

// ── index.json ───────────────────────────────────────────────────────────────
function ensureDir() {
    fs.mkdirSync(cacheDir(), { recursive: true });
}

function loadIndex() {
    try {
        const j = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
        return { keys: j.keys || {}, downloads: j.downloads || {} };
    } catch (_) {
        return { keys: {}, downloads: {} };
    }
}

/** Re-read, apply, write atomically: the Electron app and the web server may both write it. */
function updateIndex(mutate) {
    try {
        ensureDir();
        const idx = loadIndex();
        mutate(idx);
        const tmp = `${indexFile()}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(idx, null, 1));
        fs.renameSync(tmp, indexFile());
    } catch (e) {
        console.error('[Trailer] index write failed:', e.message);
    }
}

function titleKey(category, id, language) {
    return `${category}:${id}:${language}`;
}

// ── key resolution ───────────────────────────────────────────────────────────
function pickTmdbVideo(videos) {
    const list = (videos && Array.isArray(videos.results)) ? videos.results : [];
    const yt = list.filter(v => v && v.site === 'YouTube' && YT_ID.test(v.key || ''));
    return yt.find(v => v.type === 'Trailer' && v.official) || yt.find(v => v.type === 'Trailer')
        || yt.find(v => v.type === 'Teaser') || yt[0] || null;
}

/**
 * The YouTube id of a title's trailer: { success, key, provider, cached } or { success: false, error }.
 * Outside services (KinoCheck, TMDB) are asked only on the first lookup of a title.
 */
async function resolveKey({ id, mediaType, language } = {}) {
    if (!deps) throw new Error('trailers: not configured');
    if (id === undefined || id === null || id === '') return { success: false, error: 'no id' };
    const category = mediaType === 'tv' ? 'tv' : 'movie';
    const lang = language || 'en-US';
    const k = titleKey(category, id, lang);

    // 1. the catalog item
    const item = await deps.findCatalogItem(id, category).catch(() => null);
    const onItem = item && item.raw_enrichment && item.raw_enrichment.trailer && item.raw_enrichment.trailer[lang];
    if (onItem && YT_ID.test(onItem.youtube_id || '')) {
        return { success: true, key: onItem.youtube_id, provider: onItem.provider || 'catalog', cached: true };
    }

    // 2. index.json (a hit, or a recent miss)
    const known = loadIndex().keys[k];
    if (known && known.youtube_id) {
        if (item) deps.ingestTrailerKey(item, lang, known.youtube_id, known.provider);
        return { success: true, key: known.youtube_id, provider: known.provider, cached: true };
    }
    if (known && known.none && Date.now() - Date.parse(known.resolved_at || 0) < NEGATIVE_TTL_MS) {
        return { success: false, error: 'No trailer known for this title (cached miss)', cached: true };
    }

    // 3. outside, once: KinoCheck, then the TMDB videos the catalog keeps (read through). A title known only by its
    // IMDb id gets its TMDB id from the read-through first, so KinoCheck is still asked.
    let tmdbId = /^\d+$/.test(String(id)) ? Number(id) : (item && item.external_ids && item.external_ids.tmdb);
    let details;          // undefined: not asked yet; 'unanswered': TMDB did not answer; null: unknown title
    if (!tmdbId) {
        details = await deps.readThroughDetails(id, category, lang).catch(() => undefined);
        if (details === undefined) details = 'unanswered';
        const did = details && details.data && details.data.id;
        if (/^\d+$/.test(String(did || ''))) tmdbId = Number(did);
    }
    let found = null;
    let unanswered = false;
    if (tmdbId) {
        const kc = await deps.fetchKinoCheckTrailer(tmdbId, category, lang);
        if (kc === undefined) unanswered = true;
        if (kc && YT_ID.test(kc.key)) found = { youtube_id: kc.key, provider: 'kinocheck', title: kc.title || null };
    }
    if (!found) {
        if (details === undefined) details = await deps.readThroughDetails(id, category, lang).catch(() => undefined);
        if (details === undefined || details === 'unanswered') unanswered = true;
        const v = details && details.data && pickTmdbVideo(details.data.videos);
        if (v) found = { youtube_id: v.key, provider: 'tmdb', title: v.name || null };
    }

    const now = new Date().toISOString();
    if (!found && unanswered) {
        // a service did not answer: not a fact about the title, so nothing is remembered and the next view asks again
        return { success: false, error: 'Trailer lookup failed (a service did not answer)' };
    }
    updateIndex(idx => { idx.keys[k] = found ? { ...found, resolved_at: now } : { none: true, resolved_at: now }; });
    if (!found) return { success: false, error: 'No trailer found (KinoCheck, TMDB)' };
    const saved = item || await deps.findCatalogItem(id, category).catch(() => null);
    if (saved) deps.ingestTrailerKey(saved, lang, found.youtube_id, found.provider);
    console.log(`[Trailer] ${k} -> ${found.youtube_id} (${found.provider}), remembered`);
    return { success: true, key: found.youtube_id, provider: found.provider, title: found.title, cached: false };
}

// ── the files ────────────────────────────────────────────────────────────────
function fileFor(youtubeId) {
    return path.join(cacheDir(), `${youtubeId}.mp4`);
}

function describe(youtubeId) {
    const file = fileFor(youtubeId);
    return {
        success: true, youtubeId, file: path.basename(file), path: file,
        fileUrl: pathToFileURL(file).href, httpPath: `/trailers/${encodeURIComponent(path.basename(file))}`,
    };
}

function ytDlpPath() {
    try {
        const utils = require('./utils');
        const p = utils.resolveToolPath && utils.resolveToolPath('yt-dlp.exe');
        if (p && fs.existsSync(p)) return p;
    } catch (_) { }
    return 'yt-dlp';
}

function ffmpegDir() {
    try {
        const utils = require('./utils');
        const p = utils.getFFmpegPath && utils.getFFmpegPath();
        if (p && fs.existsSync(p)) return path.dirname(p);
    } catch (_) { }
    return null;
}

const inFlight = new Map(); // youtubeId -> Promise

function download(youtubeId) {
    return new Promise((resolve, reject) => {
        ensureDir();
        const partDir = path.join(cacheDir(), '.part');
        fs.mkdirSync(partDir, { recursive: true });
        const out = path.join(partDir, `${youtubeId}.%(ext)s`);
        const args = [
            // H.264 + AAC so Chromium's <video> plays it; progressive mp4 when no separate streams exist
            '-f', 'bv*[height<=1080][ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/b',
            // yt-dlp's default YouTube clients: forcing android,web limited it to the 360p progressive file
            '--merge-output-format', 'mp4', '--no-playlist', '--no-warnings', '--no-progress', '-o', out,
        ];
        const ff = ffmpegDir();
        if (ff) args.push('--ffmpeg-location', ff);
        args.push(`https://www.youtube.com/watch?v=${youtubeId}`);
        const proc = spawn(ytDlpPath(), args, { windowsHide: true });
        let stderr = '';
        const timer = setTimeout(() => { proc.kill(); }, DOWNLOAD_TIMEOUT_MS);
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('error', err => { clearTimeout(timer); reject(err); });
        proc.on('close', code => {
            clearTimeout(timer);
            const done = path.join(partDir, `${youtubeId}.mp4`);
            if (code === 0 && fs.existsSync(done)) {
                fs.renameSync(done, fileFor(youtubeId));
                return resolve();
            }
            for (const f of fs.readdirSync(partDir)) {
                if (f.startsWith(youtubeId)) { try { fs.rmSync(path.join(partDir, f), { force: true }); } catch (_) { } }
            }
            reject(new Error(stderr.trim().slice(-300) || `yt-dlp exited ${code}`));
        });
    });
}

/**
 * The local file for a trailer, downloading it the first time (one download per id, however many callers).
 * Resolves describe(...) plus { cached }, or { success: false, error }.
 */
async function ensureFile(youtubeId, title = '') {
    if (!YT_ID.test(youtubeId || '')) return { success: false, error: 'Invalid YouTube id' };
    if (fs.existsSync(fileFor(youtubeId))) return { ...describe(youtubeId), cached: true };

    const failed = loadIndex().downloads[youtubeId];
    if (failed && failed.failed_at && Date.now() - Date.parse(failed.failed_at) < FAILED_TTL_MS) {
        return { success: false, error: `Download failed earlier (${failed.error || 'unknown'}); retried after a day`, cachedFailure: true };
    }

    if (!inFlight.has(youtubeId)) {
        const job = (async () => {
            const t0 = Date.now();
            try {
                await download(youtubeId);
                const bytes = fs.statSync(fileFor(youtubeId)).size;
                updateIndex(idx => {
                    idx.downloads[youtubeId] = { title, bytes, downloaded_at: new Date().toISOString() };
                });
                console.log(`[Trailer] ${youtubeId} saved (${(bytes / 1048576).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
                return { ...describe(youtubeId), cached: false };
            } catch (e) {
                console.warn(`[Trailer] ${youtubeId} download failed: ${e.message}`);
                updateIndex(idx => {
                    idx.downloads[youtubeId] = { title, failed_at: new Date().toISOString(), error: e.message.slice(0, 200) };
                });
                return { success: false, error: e.message };
            } finally {
                inFlight.delete(youtubeId);
            }
        })();
        inFlight.set(youtubeId, job);
    }
    return inFlight.get(youtubeId);
}

/** Key + file in one call: what the details modal and the hover card ask for. */
async function getTrailer({ id, mediaType, language, title } = {}) {
    const key = await resolveKey({ id, mediaType, language });
    if (!key.success) return key;
    const file = await ensureFile(key.key, title || key.title || '');
    return { ...file, key: key.key, provider: key.provider, success: !!file.success, error: file.error };
}

function stats() {
    const idx = loadIndex();
    let files = 0;
    let bytes = 0;
    try {
        for (const f of fs.readdirSync(cacheDir())) {
            if (f.endsWith('.mp4')) { files++; bytes += fs.statSync(path.join(cacheDir(), f)).size; }
        }
    } catch (_) { }
    return { dir: cacheDir(), files, bytes, keys: Object.keys(idx.keys).length };
}

module.exports = { cacheDir, configure, resolveKey, ensureFile, getTrailer, stats, _pickTmdbVideo: pickTmdbVideo };
