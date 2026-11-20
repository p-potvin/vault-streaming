// src/realdebrid/search.js - torrent source discovery (Comet primary, Torrentio/EZTV/YTS fallbacks)
const { fetchWithTimeout, checkRealDebridCache, COMET_STREAM_BASE } = require("./client");
const { recordResolve, detectDebridProvider } = require("../telemetry/debrid-stats");
const { filterAndDedupe, episodeFit } = require("./candidates");

// The magnet handed to Deepbrid (Comet keeps each torrent's own trackers server-side and does not return them).
// Fri 20 Nov 2026: with one dead tracker (coppersurfer, offline for years) and one live one, Deepbrid sat on
// "Family Guy" / "American Dad!" at QUEUED, 0 seeds, 0 % — no peer found, not even the torrent's metadata.
// Long-running public trackers instead, and the release's file name as the name (Deepbrid lists it).
const PUBLIC_TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.demonii.com:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://explodie.org:6969/announce',
    'udp://tracker.tiny-vps.com:6969/announce',
    'http://tracker.opentrackr.org:1337/announce',
];

function magnetOf(hash, name) {
    const tr = PUBLIC_TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
    return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(String(name || '').trim())}${tr}`;
}

async function fetchCometStreams(streamType, idParam, cleanTitle) {
    if (!COMET_STREAM_BASE) return null;
    const url = `${COMET_STREAM_BASE}/stream/${streamType}/${idParam}.json`;

    // Comet fans out to indexers + the debrid services in its config on a rotating IP; a cold,
    // uncached query routinely takes 15-40s (hence the 45s per-attempt timeout).
    // It also frequently returns an EMPTY list on the first hit for a title while
    // it's still scraping server-side, then populates seconds later. So retry on
    // empty — otherwise a popular movie is wrongly reported "no sources" and, since
    // nothing was cached, stayed that way until an app restart.
    const MAX_ATTEMPTS = 3;
    let streams = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            console.log(`[Comet] Fetching (attempt ${attempt}/${MAX_ATTEMPTS}): ${url.replace(/\/eyJ[^/]+/, '/<config>')}`);
            const res = await fetchWithTimeout(url, {}, 45000);
            if (!res.ok) {
                console.warn(`[Comet] HTTP ${res.status}`);
            } else {
                const data = await res.json();
                if (data && Array.isArray(data.streams) && data.streams.length > 0) {
                    streams = data.streams;
                    console.log(`[Comet] Found ${streams.length} streams`);
                    break;
                }
                console.log(`[Comet] No streams returned${attempt < MAX_ATTEMPTS ? ' — retrying (Comet may still be scraping)…' : ''}`);
            }
        } catch (err) {
            console.warn(`[Comet] Fetch failed: ${err.message}`);
        }
        if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 3000));
    }
    if (!streams) return null;

    // Provider breakdown. This used to be a console line that vanished on
    // restart; it is now persisted, because "which service can we drop?" needs
    // history rather than a snapshot of the last search.
    //
    // Detection moved into debrid-stats: the bare `\bAD\b` / `RD\+?` substrings
    // used here matched ordinary release titles (NORDiC, ADDiCT, HDR) and filed
    // those results under the wrong service.
    try {
        const isStreamCached = (s) => !!s.url && ((s.name && s.name.includes('⚡')) || (s.description && s.description.includes('⚡')));
        recordResolve(streams.map((s) => ({ name: s.name, cached: isStreamCached(s) })));
        const counts = {};
        for (const s of streams) {
            const provider = detectDebridProvider(s.name);
            counts[provider] = (counts[provider] || 0) + 1;
        }
        console.log('[Comet] provider breakdown:', counts, `cached: ${streams.filter(isStreamCached).length}`);
    } catch (e) {
        console.warn('[Comet] provider breakdown failed:', e.message);
    }
    return streams.map(s => {
            const nameStr = s.name || '';
            const descStr = s.description || s.title || '';
            const qualMatch = nameStr.match(/(4[Kk]|2160[Pp]|1080[Pp]|720[Pp]|480[Pp]|HDR10\+?|HDR|DV|DoVi)/i)
                || descStr.match(/(4[Kk]|2160[Pp]|1080[Pp]|720[Pp]|480[Pp]|HDR10\+?|HDR|DV|DoVi)/i);
            const quality = qualMatch ? qualMatch[0] : 'HD';
            const sizeMatch = descStr.match(/💾\s*([0-9.]+\s*[GgMm][Bb])/i)
                || descStr.match(/Size:\s*([0-9.]+\s*[GgMm][Bb])/i)
                || descStr.match(/([0-9.]+\s*[GgMm][Bb])/i);
            const size = sizeMatch ? sizeMatch[1] : 'Unknown Size';
            const seedsMatch = descStr.match(/👥\s*([0-9]+)/i) || descStr.match(/S:\s*([0-9]+)/i);
            const seeds = seedsMatch ? seedsMatch[1] : '—';
            const hash = (s.infoHash || s.behaviorHints?.bingeGroup?.match(/[a-fA-F0-9]{40}/)?.[0] || '').toLowerCase();
            const magnet = hash ? magnetOf(hash, s.behaviorHints?.filename || cleanTitle) : '';
            const isCached = !!s.url && ((s.name && s.name.includes('⚡')) || (s.description && s.description.includes('⚡')));
            return {
                quality,
                // Raw Comet name, kept unprefixed so the debrid marker stays at
                // the start where detection anchors. `type` below decorates it
                // for display and is not safe to attribute from.
                name: nameStr,
                // Comet's own name already carries the provider marker (e.g. [TB⚡],
                // [RD⚡], [RD⬇️]). Lapsed services are dropped afterwards (candidates.js).
                // Prepend ⚡ only if genuinely cached; otherwise show download symbol.
                type: (isCached ? '⚡ ' : (nameStr.includes('⬇️') ? '⬇️ ' : '')) + 'Comet ' + nameStr.split('\n')[0].trim(),
                size,
                seeds,
                peers: '—',
                hash,
                magnet,
                desc: descStr.split('\n')[0] || nameStr,
                url: s.url || null,
                cached: isCached
            };
    });
}

/**
 * The IMDb id of a title, from the catalog: the item carrying this TMDB id, or (first time) the catalog's
 * read-through details, which fill it from TMDB once. An IMDb id passed as the id is used as is. Null when unknown.
 * Shared by the torrent search (Comet) and the subtitle search (OpenSubtitles).
 */
async function imdbIdFor(tmdbId, mediaType = 'movie') {
    if (!tmdbId) return null;
    const sid = String(tmdbId).replace(/^imdb:/, '');
    if (/^tt\d+$/.test(sid)) return sid;
    const category = mediaType === 'tv' || mediaType === 'series' ? 'tv' : 'movie';
    try {
        const { readThroughDetails, findCatalogItem } = require('../tmdb');
        const item = await findCatalogItem(tmdbId, category, false);
        let imdbId = (item && item.external_ids && item.external_ids.imdb)
            || (item && String(item.catalog_id || '').startsWith('imdb:') ? item.catalog_id.slice(5) : null);
        if (!imdbId) {
            const details = await readThroughDetails(tmdbId, category);
            imdbId = details && details.data && (details.data.imdb_id
                || (details.data.external_ids && details.data.external_ids.imdb_id)) || null;
        }
        console.log(`[Search] IMDb id for ${category} ${tmdbId}: ${imdbId || 'unknown'} (catalog)`);
        return imdbId;
    } catch (err) {
        console.error('[Search] IMDb id lookup failed:', err.message);
        return null;
    }
}

function registerSearchHandlers(ipcMain) {
    ipcMain.handle('search-torrents', async (event, arg) => {
        try {
            const opts = typeof arg === 'string' ? { movieTitle: arg } : (arg || {});
            const { movieTitle = '', tmdbId, mediaType, season, episode } = opts;
            const itemMediaType = mediaType || 'movie';
            const imdbId = tmdbId ? await imdbIdFor(tmdbId, itemMediaType) : null;

            // ── Comet is the ONLY torrent source ────────────────────────────
            // VaultWares policy: every torrent/debrid lookup MUST go through
            // Comet, which fans out to indexers + debrid on a rotating IP.
            // Talking to Torrentio / EZTV / YTS / Real-Debrid directly uses the
            // account's own IP and gets it banned. The old direct-indexer
            // fallbacks were removed for exactly this reason — do NOT re-add them.
            const cleanTitle = movieTitle.replace(/[.]/g, '').trim();

            if (!COMET_STREAM_BASE) {
                return { success: false, error: 'Comet is not configured (COMET_STREAM_BASE). Streaming is disabled to protect the debrid account.' };
            }

            if (imdbId) {
                const streamType = itemMediaType === 'tv' || itemMediaType === 'series' ? 'series' : 'movie';
                const s = season || 1;
                const e = episode || 1;
                const idParam = (itemMediaType === 'tv' || itemMediaType === 'series') ? `${imdbId}:${s}:${e}` : imdbId;

                const cometList = await fetchCometStreams(streamType, idParam, cleanTitle);
                if (cometList && cometList.length > 0) {
                    // Comet already flags cached streams (they carry a resolved
                    // url). No direct Real-Debrid instantAvailability call.
                    // One entry per torrent, no sync actions, no lapsed services; each tagged with how it fits the
                    // requested episode so the picker can prefer the episode itself over a season pack.
                    const isTv = streamType === 'series';
                    const torrents = filterAndDedupe(cometList).map(t => ({
                        ...t,
                        fit: episodeFit(`${t.desc || ''} ${t.name || ''}`, isTv ? s : null, isTv ? e : null),
                    }));
                    console.log(`[Comet] ${torrents.length} distinct candidates (from ${cometList.length} entries)`);
                    if (torrents.length > 0) return { success: true, title: cleanTitle, torrents };
                }
                return { success: false, error: 'No streams found via Comet for this title.' };
            }

            return { success: false, error: 'No IMDb id available — cannot query Comet.' };
        } catch (e) {
            console.error('[Real-Debrid] Search error:', e);
            return { success: false, error: e.message };
        }
    });
}

module.exports = { registerSearchHandlers, imdbIdFor, magnetOf, PUBLIC_TRACKERS };
