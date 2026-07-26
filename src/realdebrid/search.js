// src/realdebrid/search.js - torrent source discovery (Comet primary, Torrentio/EZTV/YTS fallbacks)
const { fetchWithTimeout, checkRealDebridCache, TMDB_BEARER_TOKEN, COMET_STREAM_BASE } = require("./client");

async function fetchCometStreams(streamType, idParam, cleanTitle) {
    if (!COMET_STREAM_BASE) return null;
    const url = `${COMET_STREAM_BASE}/stream/${streamType}/${idParam}.json`;

    // Comet fans out to indexers + AllDebrid/TorBox/RD on a rotating IP; a cold,
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

    // Provider breakdown — makes it obvious in the console whether TorBox /
    // AllDebrid are actually returning results (vs everything falling to RD).
    try {
        const counts = { TorBox: 0, AllDebrid: 0, RealDebrid: 0, other: 0, cached: 0 };
        for (const s of streams) {
            const n = s.name || '';
            if (/\bTB\b|torbox/i.test(n)) counts.TorBox++;
            else if (/\bAD\b|alldebrid/i.test(n)) counts.AllDebrid++;
            else if (/RD\+?|real-?debrid/i.test(n)) counts.RealDebrid++;
            else counts.other++;
            if (s.url) counts.cached++;
        }
        console.log('[Comet] provider breakdown:', counts);
    } catch (_) { /* diagnostics only */ }
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
            const magnet = hash
                ? `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(cleanTitle)}&tr=udp://tracker.coppersurfer.tk:6969/announce&tr=udp://tracker.opentrackr.org:1337/announce`
                : '';
            const hasRdUrl = !!s.url;
            return {
                quality,
                // Comet's own name already carries the provider marker (e.g. [TB⚡],
                // [AD], [RD+]) now that we fan out to AllDebrid/TorBox/RD, so just
                // flag cached generically here rather than hardcoding [RD+].
                type: (hasRdUrl ? '⚡ ' : '') + 'Comet ' + nameStr.split('\n')[0].trim(),
                size,
                seeds,
                peers: '—',
                hash,
                magnet,
                desc: descStr.split('\n')[0] || nameStr,
                url: s.url || null,
                cached: hasRdUrl
            };
    });
}

function registerSearchHandlers(ipcMain) {
    ipcMain.handle('search-torrents', async (event, { movieTitle, tmdbId, mediaType, season, episode }) => {
        try {
            let imdbId = null;
            const itemMediaType = mediaType || 'movie';

            // Resolve IMDB ID if TMDB ID is available
            if (tmdbId && TMDB_BEARER_TOKEN) {
                console.log(`[Real-Debrid] Fetching IMDB ID from TMDB for TMDB ID: ${tmdbId} (${itemMediaType})`);
                try {
                    const extRes = await fetchWithTimeout(`https://api.themoviedb.org/3/${itemMediaType}/${tmdbId}/external_ids`, {
                        headers: {
                            accept: 'application/json',
                            Authorization: `Bearer ${TMDB_BEARER_TOKEN}`
                        }
                    });
                    if (extRes.ok) {
                        const extData = await extRes.json();
                        imdbId = extData.imdb_id;
                        console.log(`[Real-Debrid] Resolved IMDB ID: ${imdbId}`);
                    }
                } catch (err) {
                    console.error('[Real-Debrid] Failed to fetch external IDs from TMDB:', err);
                }
            }

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
                    return { success: true, title: cleanTitle, torrents: cometList };
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

module.exports = { registerSearchHandlers };
