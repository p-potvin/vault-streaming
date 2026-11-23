// moments.ipc.js — what plays through the app becomes searchable (operator, Wed 18 Nov 2026).
//
// After two minutes of playback the player hands over the stream (js/player/player.js). This queues it with
// vault-raggae (POST /v1/moments/stream, app/moments/stream.py there), which reads the stream once in the background
// (throttled, nothing saved but vectors and text) for the whole audio track's transcript (Nemotron 3.5) and the
// Moments of every 10 seconds: what is seen (SigLIP, 10 frames), heard (CLAP) and said.
//
// The key is the catalog item, plus the episode: stream:imdb:tt0133093, stream:imdb:tt0903747:s01e02. A title
// already done is not read again. The transcript's language is the played track's as the stream reports it (tag or
// title); a detected one only when the stream says nothing (src/ipc/audio-tracks.ipc.js).

const raggae = require('../raggae');

function episodeSuffix(season, episode) {
    const s = parseInt(season, 10);
    const e = parseInt(episode, 10);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return '';
    return `:s${String(s).padStart(2, '0')}e${String(e).padStart(2, '0')}`;
}

/** The catalog id behind the renderer's id (a TMDB id, tt…, or a catalog id), or null. */
async function catalogIdFor(id, category) {
    const { findCatalogItem } = require('../tmdb');
    const item = await findCatalogItem(id, category, false).catch(() => null);
    if (item && item.catalog_id) return item.catalog_id;
    const sid = String(id || '');
    if (/^\d+$/.test(sid)) return `tmdb:${category}:${sid}`;
    if (/^(imdb:)?tt\d+$/.test(sid)) return `imdb:${sid.replace(/^imdb:/, '')}`;
    return null;
}

/** The Moments key of a played title: stream:<catalog id>[:sNNeNN], or null without a catalog id. */
async function streamKeyFor({ tmdbId, mediaType, season, episode } = {}) {
    const category = mediaType === 'tv' ? 'tv' : 'movie';
    const catalogId = await catalogIdFor(tmdbId, category);
    if (!catalogId) return null;
    return { key: `stream:${catalogId}${category === 'tv' ? episodeSuffix(season, episode) : ''}`, catalogId, category };
}

/**
 * Jump-to inside the playing title (semantic plan section 3.3): a line, a scene or a sound in this stream's Moments.
 * { tmdbId, mediaType, season, episode, q } -> { indexed, state, duration, hits: [{ kind: 'said' | 'seen', t0, t1,
 *   said }], error? }. `indexed` false: the
 * title has not been read yet (it is after 15 s of playback, src/ipc/moments.ipc.js above).
 */
async function jumpSearch(p = {}) {
    const q = String(p.q || '').trim().slice(0, 200);
    const sk = await streamKeyFor(p);
    if (!sk || !q) return { indexed: false, state: null, hits: [] };
    // Lines said first (the words typed), then scenes seen: fused in one list, a snowy shot outranked the line that
    // says "winter". Sound alone is left out (it rarely answers a sentence).
    const [said, seen, status] = await Promise.all([
        raggae.momentsSearch(q, sk.key, { mode: 'said', k: 4 }),
        raggae.momentsSearch(q, sk.key, { mode: 'look', k: 4 }),
        raggae.streamStatus(sk.key).catch(() => null),
    ]);
    if (said === null && seen === null) return { key: sk.key, indexed: false, state: null, hits: [], error: 'unreachable' };
    const hits = [];
    const near = (t) => hits.some(h => Math.abs(h.t0 - t) < 10);
    for (const [kind, list] of [['said', said || []], ['seen', seen || []]]) {
        for (const h of list) {
            if (!Number.isFinite(h.t0) || near(h.t0)) continue;
            hits.push({ kind, t0: h.t0, t1: h.t1, said: h.said || '' });
        }
    }
    return {
        key: sk.key,
        indexed: hits.length > 0 || !!(status && (status.windows || status.state === 'done')),
        state: status ? status.state || null : null,
        // the length of the source Moments read: its times only match a playing source of the same cut
        duration: status && Number.isFinite(status.duration) ? status.duration : null,
        hits,
    };
}

/**
 * One frame of the playing source as JPEG bytes, read by ffmpeg at `t` seconds: the window cannot read the pixels of a
 * cross-origin <video> (a tainted canvas), ffmpeg can. http(s) sources only; null on any failure.
 */
function grabFrame(url, t, { timeoutMs = 20000 } = {}) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || !Number.isFinite(Number(t)) || Number(t) < 0) {
        return Promise.resolve(null);
    }
    const { spawn } = require('child_process');
    const { getFFmpegPath } = require('../utils');
    return new Promise((resolve) => {
        let proc;
        try {
            proc = spawn(getFFmpegPath(), ['-hide_banner', '-loglevel', 'error', '-ss', Number(t).toFixed(3), '-i', url,
                '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '3', 'pipe:1'],
            { windowsHide: true });
        } catch (_) {
            resolve(null);
            return;
        }
        const chunks = [];
        let size = 0;
        const timer = setTimeout(() => { try { proc.kill(); } catch (_) { /* gone */ } }, timeoutMs);
        proc.stdout.on('data', (c) => { size += c.length; if (size <= 16 * 2 ** 20) chunks.push(c); });
        proc.on('error', () => { clearTimeout(timer); resolve(null); });
        proc.on('close', (code) => {
            clearTimeout(timer);
            resolve(code === 0 && size > 0 && size <= 16 * 2 ** 20 ? Buffer.concat(chunks) : null);
        });
    });
}

/**
 * Who is this, on the paused frame (semantic plan section 3.5). { image?: base64 JPEG (the window's canvas), url?, t?
 * (ffmpeg reads the source when the canvas could not), tmdbId, mediaType, season, episode } -> raggae.facesWho's
 * answer, scored against the playing title's cast too.
 */
async function whoIsThis(p = {}) {
    let jpeg = null;
    if (typeof p.image === 'string' && p.image) {
        jpeg = Buffer.from(p.image.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        if (jpeg.length > 16 * 2 ** 20) return { success: false, error: 'too-big', faces: [] };
    } else {
        jpeg = await grabFrame(p.url, p.t);
    }
    if (!jpeg || !jpeg.length) return { success: false, error: 'no-frame', faces: [] };
    const sk = await streamKeyFor(p).catch(() => null);
    return raggae.facesWho(jpeg, { catalogId: sk ? sk.catalogId : null });
}

function registerMomentsIpc(ipcMain) {
    ipcMain.handle('raggae-who', async (_e, p = {}) => {
        try {
            return await whoIsThis(p);
        } catch (e) {
            return { success: false, error: e.message, faces: [] };
        }
    });

    ipcMain.handle('moments:jump-search', async (_e, p = {}) => {
        try {
            return await jumpSearch(p);
        } catch (e) {
            return { indexed: false, state: null, hits: [], error: e.message };
        }
    });

    ipcMain.handle('moments:index-playback', async (_e, p = {}) => {
        try {
            const url = String(p.url || '');
            if (!/^https?:\/\//i.test(url)) return { success: false, skipped: 'not a stream (library files are indexed by Moments itself)' };
            const sk = await streamKeyFor(p);
            if (!sk) return { success: false, skipped: 'no catalog id for this title' };
            const { key, catalogId } = sk;
            const res = await raggae.queueStream({
                key, url, catalog_id: catalogId, title: p.title || null,
                audio_index: Number.isInteger(p.audioIndex) ? p.audioIndex : 0,
                language: p.language || 'und', language_source: p.languageSource || 'none',
                duration: Number(p.durationSec) || null,
                // a lighter copy read instead of the played source (above 1080p): which release it was
                source_release: p.sourceRelease ? String(p.sourceRelease).slice(0, 200) : null,
            });
            if (!res) return { success: false, error: 'vault-raggae did not take the job' };
            console.log(`[moments] ${key}: ${res.state}${res.position ? ` (#${res.position} in the queue)` : ''}`);
            return { success: true, key, state: res.state };
        } catch (e) {
            console.warn('[moments] queue failed:', e.message);
            return { success: false, error: e.message };
        }
    });
}

module.exports = { registerMomentsIpc, streamKeyFor, jumpSearch, whoIsThis, grabFrame, _episodeSuffix: episodeSuffix };
