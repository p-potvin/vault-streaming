// src/usenet/search.js - Usenet source discovery via Prowlarr
const { fetchWithTimeout, PROWLARR_URL, PROWLARR_API_KEY, TMDB_BEARER_TOKEN } = require("./client");
const cache = require("./cache");
const { formatBytes } = require("../utils");

async function searchUsenet(event, { movieTitle, tmdbId, mediaType, season, episode }) {
    if (!PROWLARR_URL || !PROWLARR_API_KEY) {
        console.warn('[Usenet] Prowlarr URL or API key is not configured');
        return { success: false, error: 'Prowlarr is not configured' };
    }

    try {
        let imdbId = null;
        const itemMediaType = mediaType || 'movie';

        // 1. Resolve IMDB ID if TMDB ID is available (Prowlarr performs best with structural ID searches)
        if (tmdbId && TMDB_BEARER_TOKEN) {
            console.log(`[Usenet] Fetching IMDB ID from TMDB for TMDB ID: ${tmdbId} (${itemMediaType})`);
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
                    console.log(`[Usenet] Resolved IMDB ID: ${imdbId}`);
                }
            } catch (err) {
                console.error('[Usenet] Failed to fetch external IDs from TMDB:', err);
            }
        }

        // 2. Formulate Prowlarr search query
        let queryStr = '';
        let categories = '2000'; // Default to Movie
        let type = 'movie';

        if (itemMediaType === 'tv' || itemMediaType === 'series') {
            categories = '5000';
            type = 'tvsearch';
            if (imdbId) {
                queryStr = `{ImdbId:${imdbId}} {Season:${season || 1}} {Episode:${episode || 1}}`;
            } else {
                queryStr = `${movieTitle} S${String(season || 1).padStart(2, '0')}E${String(episode || 1).padStart(2, '0')}`;
            }
        } else {
            // Movie
            if (imdbId) {
                queryStr = `{ImdbId:${imdbId}}`;
            } else {
                queryStr = movieTitle;
            }
        }

        const cacheKey = `search:${itemMediaType}:${imdbId || movieTitle}:${season || ''}:${episode || ''}`;
        const cachedSearch = cache.get(cacheKey);
        if (cachedSearch && cachedSearch.streams) {
            console.log(`[Usenet] Returning cached search results for query: ${cacheKey}`);
            const updatedStreams = cachedSearch.streams.map(s => {
                const uniqueId = s.guid || s.downloadUrl;
                const cachedResult = cache.get(uniqueId);
                return {
                    ...s,
                    cached: !!cachedResult,
                    health: cachedResult ? cachedResult.health : s.health,
                    isPassworded: cachedResult ? cachedResult.isPassworded : s.isPassworded
                };
            });
            return {
                success: true,
                title: movieTitle,
                streams: updatedStreams,
                fromCache: true
            };
        }

        const url = `${PROWLARR_URL}/api/v1/search?query=${encodeURIComponent(queryStr)}&indexerIds=-1&categories=${categories}&type=${type}&apikey=${PROWLARR_API_KEY}`;
        console.log(`[Usenet] Querying Prowlarr: ${url.replace(PROWLARR_API_KEY, '<api_key>')}`);

        const res = await fetchWithTimeout(url, {}, 10000);
        if (!res.ok) {
            console.error(`[Usenet] Prowlarr HTTP error: ${res.status}`);
            return { success: false, error: `Prowlarr returned HTTP ${res.status}` };
        }

        const data = await res.json();
        if (!Array.isArray(data)) {
            console.warn('[Usenet] Prowlarr returned unexpected payload (not an array)');
            return { success: true, title: movieTitle, streams: [] };
        }

        console.log(`[Usenet] Found ${data.length} releases`);

        // 3. Process and map results
        const mappedStreams = data.map(release => {
            const title = release.title || 'Unknown Release';
            
            // Parse quality from release title
            const qualMatch = title.match(/(4[Kk]|2160[Pp]|1080[Pp]|720[Pp]|480[Pp]|HDR10\+?|HDR|DV|DoVi)/i);
            const quality = qualMatch ? qualMatch[0] : 'HD';

            // Check cache status
            const uniqueId = release.guid || release.downloadUrl;
            const cachedResult = cache.get(uniqueId);
            
            return {
                quality,
                type: `NZB [${release.indexer || 'Prowlarr'}]`,
                size: formatBytes(release.size || 0),
                guid: release.guid,
                downloadUrl: release.downloadUrl,
                desc: title,
                cached: !!cachedResult,
                health: cachedResult ? cachedResult.health : 'unknown',
                isPassworded: cachedResult ? cachedResult.isPassworded : false
            };
        });

        // 4. Sort: Prioritize healthy ones, then cached, then order by rank
        const sortedStreams = mappedStreams.sort((a, b) => {
            if (a.health === 'healthy' && b.health !== 'healthy') return -1;
            if (a.health !== 'healthy' && b.health === 'healthy') return 1;
            if (a.health === 'unhealthy' && b.health !== 'unhealthy') return 1;
            if (a.health !== 'unhealthy' && b.health === 'unhealthy') return -1;
            if (a.cached && !b.cached) return -1;
            if (!a.cached && b.cached) return 1;
            return 0; // maintain Prowlarr's default sorting order otherwise
        });

        // Cache search results for 12 hours to avoid hitting indexer limits
        const SEARCH_CACHE_TTL = 12 * 60 * 60 * 1000;
        cache.set(cacheKey, { streams: sortedStreams }, SEARCH_CACHE_TTL);

        return {
            success: true,
            title: movieTitle,
            streams: sortedStreams
        };

    } catch (e) {
        console.error('[Usenet] Search workflow error:', e);
        return { success: false, error: e.message };
    }
}

function registerUsenetSearchHandlers(ipcMain) {
    ipcMain.handle('search-usenet', async (event, params) => {
        return searchUsenet(event, params);
    });
}

module.exports = {
    searchUsenet,
    registerUsenetSearchHandlers
};
