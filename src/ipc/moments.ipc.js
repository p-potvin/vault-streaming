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

function registerMomentsIpc(ipcMain) {
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

module.exports = { registerMomentsIpc, streamKeyFor, _episodeSuffix: episodeSuffix };
