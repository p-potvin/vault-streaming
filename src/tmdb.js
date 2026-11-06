// src/tmdb.js - Exposes real-time TMDB Search and Trending API handlers using process.env secrets

const fs = require('fs');
const path = require('path');
const raggae = require('./raggae');

// Helper function to fetch with timeout
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response;
    } catch (err) {
        clearTimeout(timeoutId);
        throw err;
    }
}

// Load environment variables from .env
let envConfig = {};
try {
    const envPaths = [
        path.join(process.cwd(), '.env'),
        path.join(path.dirname(process.execPath), '.env'),
        process.resourcesPath ? path.join(process.resourcesPath, '.env') : null,
        path.join(__dirname, '.env'),
        path.join(__dirname, '..', '.env'),
        path.join(__dirname, '..', '..', '.env')
    ].filter(Boolean);
    for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        envContent.split(/\r?\n/).forEach(line => {
            const parts = line.split('=');
            if (parts.length >= 2) {
                const key = parts[0].trim();
                const value = parts.slice(1).join('=').trim();
                if (key) {
                    if (!process.env[key]) {
                        process.env[key] = value;
                    }
                    envConfig[key] = process.env[key];
                }
            }
        });
        break;
    }
    }
} catch (e) {
    console.error('[TMDB] Failed to load .env file:', e);
}

const TMDB_BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN || envConfig.TMDB_BEARER_TOKEN;
const TMDB_API_TOKEN = process.env.TMDB_API_TOKEN || envConfig.TMDB_API_TOKEN;

let KINOCHECK_API_KEY = '';
try {
    const keyPath = 'C:\\Users\\Administrator\\Desktop\\Github Repos\\.access\\kinocheck_api.txt';
    if (fs.existsSync(keyPath)) {
        KINOCHECK_API_KEY = fs.readFileSync(keyPath, 'utf8').trim();
        console.log('[KinoCheck] Successfully loaded premium API key.');
    } else {
        console.warn('[KinoCheck] API key not found at:', keyPath);
    }
} catch (e) {
    console.error('[KinoCheck] Failed to load API key:', e);
}

// Map TMDB genre IDs to human-readable strings
const GENRE_MAP = {
    28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime",
    99: "Documentary", 18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History",
    27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance", 878: "Sci-Fi",
    10770: "TV Movie", 53: "Thriller", 10752: "War", 37: "Western",
    10759: "Action & Adventure", 10762: "Kids", 10763: "News", 10764: "Reality",
    10765: "Sci-Fi & Fantasy", 10766: "Soap", 10767: "Talk", 10768: "War & Politics"
};

// ── TMDB configuration, fetched once and cached ──────────────────────────────
// Both of these were hardcoded lists that drifted from what TMDB actually
// supports. Fetch them instead, and fall back to the old constants if TMDB is
// unreachable so Discover still works offline.
const CONFIG_TTL_MS = 24 * 60 * 60 * 1000;
const _configCache = new Map(); // url -> { value, ts }

async function fetchTmdbConfig(pathname, fallback) {
    const cached = _configCache.get(pathname);
    if (cached && (Date.now() - cached.ts) < CONFIG_TTL_MS) return cached.value;
    try {
        const res = await fetchWithTimeout(`https://api.themoviedb.org/3${pathname}`, {
            headers: { accept: 'application/json', Authorization: `Bearer ${TMDB_BEARER_TOKEN}` },
        }, 10000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const value = await res.json();
        _configCache.set(pathname, { value, ts: Date.now() });
        return value;
    } catch (e) {
        console.warn(`[TMDB] config ${pathname} failed (${e.message}); using fallback`);
        return fallback;
    }
}

// Every language TMDB has a primary translation for, as ISO-639-1 codes.
// Replaces a hardcoded `en|fr|ja|ko`, which silently hid everything else.
const ORIGINAL_LANGUAGE_FALLBACK = 'en|fr|ja|ko';
async function originalLanguageFilter() {
    const list = await fetchTmdbConfig('/configuration/primary_translations', null);
    if (!Array.isArray(list) || !list.length) return ORIGINAL_LANGUAGE_FALLBACK;
    const bases = [...new Set(list.map((l) => String(l).split('-')[0]).filter(Boolean))];
    return bases.join('|');
}

// TMDB ignores with_watch_providers unless watch_region is also set — verified:
// provider 8 with no region returns 1,170,829 results (the whole catalogue),
// versus 4,708 with watch_region=CA. So a region is required, not optional.
const DEFAULT_WATCH_REGION = 'US';

// Detected once per process from the public IP, and only used when the user has
// not chosen a region in settings — an explicit choice always wins. Failure is
// silent and falls back to DEFAULT_WATCH_REGION; this must never delay Discover,
// hence the short timeout and the cached negative result.
let _geoRegion;            // undefined = not tried, null = tried and failed

// Several providers, because the first choice rate-limits aggressively: ipapi.co
// answered {"error":true,"reason":"RateLimited"} in testing, and a failed lookup
// silently became "US" — the wrong answer presented as a detection. Each entry
// pulls a 2-letter country code out of its own response shape.
const GEO_PROVIDERS = [
    { url: 'https://ipwho.is/?fields=success,country_code', pick: (d) => d.country_code },
    { url: 'https://api.country.is/', pick: (d) => d.country },
    { url: 'https://ipapi.co/json/', pick: (d) => d.country_code || d.country },
];

async function geoWatchRegion() {
    if (_geoRegion !== undefined) return _geoRegion;
    for (const provider of GEO_PROVIDERS) {
        try {
            const res = await fetchWithTimeout(provider.url, { headers: { accept: 'application/json' } }, 4000);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const code = String(provider.pick(data) || '').toUpperCase();
            if (/^[A-Z]{2}$/.test(code)) {
                _geoRegion = code;
                console.log(`[TMDB] watch region from geo IP: ${code} (${new URL(provider.url).host})`);
                return _geoRegion;
            }
        } catch (e) {
            console.warn(`[TMDB] geo lookup via ${new URL(provider.url).host} failed: ${e.message}`);
        }
    }
    _geoRegion = null;
    console.warn('[TMDB] no geo provider answered; falling back to', DEFAULT_WATCH_REGION);
    return _geoRegion;
}
 
// ── Search & Details Waterfall: Local Catalog -> TMDB -> OMDb ───────────────
// The local catalog (vault-raggae, 1.1 M films and 0.4 M series from IMDb) is asked first. TMDB is still asked
// when the local answer is thin (fewer than LOCAL_ENOUGH hits, or none with LOCAL_POPULAR votes), and its results
// fill in after the local ones. Outside details are written back to the catalog (raggae.ingest): new titles are
// added, known ones only get their empty fields filled. Search hits from TMDB are not ingested: they carry no IMDb
// id, so they would come back as `tmdb:` duplicates of the IMDb items the catalog already has.

// The OMDb key comes from .env (OMDB_API_KEY); without it the OMDb leg is skipped.
const OMDB_API_KEY = process.env.OMDB_API_KEY || envConfig.OMDB_API_KEY || '';
const OMDB_BASE = 'https://www.omdbapi.com/';
const LOCAL_ENOUGH = 8;
const LOCAL_POPULAR = 1000;
const PLACEHOLDER_POSTER = 'public/poster_placeholder.svg';

/** A URL as it may be logged: API keys and tokens replaced. */
function redact(url) {
    return String(url).replace(/([?&](?:apikey|api_key|token)=)[^&]+/gi, '$1***');
}

function tmdbHeaders() {
    return { accept: 'application/json', Authorization: `Bearer ${TMDB_BEARER_TOKEN}` };
}

/** A local catalog item as the renderer's card / modal expect it. `id` is the TMDB id when the catalog knows it,
 *  else the bare IMDb id (tt…), which the TMDB handlers below map to a TMDB id on demand. */
function catalogToCard(item) {
    const ext = item.external_ids || {};
    const imdb = ext.imdb || (String(item.catalog_id || '').startsWith('imdb:') ? item.catalog_id.slice(5) : null);
    const credits = Array.isArray(item.cast_or_credits) ? item.cast_or_credits : [];
    return {
        id: ext.tmdb || imdb || item.catalog_id,
        imdb_id: imdb,
        catalog_id: item.catalog_id,
        media_type: item.category === 'tv' ? 'tv' : 'movie',
        title: item.title || item.original_title || 'Untitled',
        year: item.year ? String(item.year) : '—',
        rating: item.rating ? String(item.rating) : '—',
        genres: Array.isArray(item.genres) ? item.genres.slice(0, 3).join(', ') : (item.genres || 'General'),
        poster: raggae.posterFor(item) || PLACEHOLDER_POSTER,
        overview: item.overview || (credits.length ? credits.slice(0, 3).join(', ') : 'No description available.'),
        votes: item.votes || 0,
        source: 'raggae'
    };
}

async function searchLocalCatalog(query, options = {}) {
    if (!query) return [];
    const hits = await raggae.searchTitles(query, { limit: options.limit || 20 });
    return hits.map(catalogToCard);
}

/** Local hits are enough on their own when there are several and at least one well-known title among them. */
function localIsEnough(cards) {
    return cards.length >= LOCAL_ENOUGH || cards.some(c => (c.votes || 0) >= LOCAL_POPULAR);
}

/** Outside results after the local ones, without titles the local list already has (same IMDb id, or same title
 *  and year). */
function mergeAfterLocal(local, outside) {
    const key = c => `${raggae._norm(c.title)}|${c.year}`;
    const ids = new Set(local.map(c => c.imdb_id).filter(Boolean));
    const keys = new Set(local.map(key));
    return [...local, ...outside.filter(c => !(c.imdb_id && ids.has(c.imdb_id)) && !keys.has(key(c)))];
}

const tmdbIdCache = new Map();

/** The TMDB id for an id the renderer holds: a TMDB id as is; an IMDb id (tt…, imdb:tt…) through TMDB /find,
 *  remembered, and written back to the catalog item so the next local search carries it. Null when unknown. */
async function toTmdbId(id, mediaType = 'movie') {
    if (id === null || id === undefined || id === '') return null;
    if (/^\d+$/.test(String(id))) return Number(id);
    const imdb = String(id).replace(/^imdb:/, '');
    if (!/^tt\d+$/.test(imdb) || !TMDB_BEARER_TOKEN) return null;
    const cacheKey = `${mediaType}:${imdb}`;
    if (tmdbIdCache.has(cacheKey)) return tmdbIdCache.get(cacheKey);
    try {
        const res = await fetchWithTimeout(`https://api.themoviedb.org/3/find/${imdb}?external_source=imdb_id`,
            { headers: tmdbHeaders() }, 8000);
        if (!res.ok) return null;
        const data = await res.json();
        const hit = (mediaType === 'tv' ? data.tv_results : data.movie_results)?.[0]
            || data.movie_results?.[0] || data.tv_results?.[0];
        const tmdbId = hit ? hit.id : null;
        tmdbIdCache.set(cacheKey, tmdbId);
        if (tmdbId) {
            ingestOutside({ category: mediaType === 'tv' ? 'tv' : 'movie', title: hit.title || hit.name,
                            external_ids: { imdb, tmdb: tmdbId }, source: 'tmdb' });
        }
        return tmdbId;
    } catch (e) {
        console.warn(`[TMDB] find ${imdb} failed (${e.message})`);
        return null;
    }
}

/** Fire-and-forget write of outside metadata to the catalog (see the note at the top of this section). */
function ingestOutside(items) {
    raggae.ingest(items).catch(e => console.warn('[raggae] ingest failed:', e.message));
}

async function searchTmdbApi(query, page = 1, language = 'en-US') {
    if (!TMDB_BEARER_TOKEN || !query) return [];
    try {
        const urlFor = q => `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(q)}&include_adult=false&language=${language}&page=${page}`;
        let response = await fetchWithTimeout(urlFor(query), { method: 'GET', headers: tmdbHeaders() });
        if (!response.ok) return [];
        let data = await response.json();

        // Language modifier cleanup retry if 0 results ("the 2 popes in french")
        if (!data.results || data.results.length === 0) {
            const langPattern = /\b(in\s+french|in\s+english|en\s+francais|en\s+français|french|francais|français|vf|vff|vfq|vostfr|subfrench)\b/gi;
            const cleanedQuery = query.replace(langPattern, '').replace(/\s+/g, ' ').trim();
            if (cleanedQuery && cleanedQuery.toLowerCase() !== query.toLowerCase()) {
                console.log(`[TMDB] Retrying search with sanitized query: "${cleanedQuery}" (original was "${query}")`);
                const retryRes = await fetchWithTimeout(urlFor(cleanedQuery), { method: 'GET', headers: tmdbHeaders() });
                if (retryRes.ok) data = await retryRes.json();
            }
        }

        return (data.results || [])
            .filter(item => item.media_type !== 'person')
            .map(item => {
                const dateStr = item.release_date || item.first_air_date || '';
                return {
                    id: item.id,
                    media_type: item.media_type || 'movie',
                    title: item.title || item.name || 'Untitled',
                    year: dateStr ? dateStr.substring(0, 4) : '—',
                    rating: item.vote_average ? item.vote_average.toFixed(1) : '—',
                    genres: (item.genre_ids || []).map(id => GENRE_MAP[id]).filter(Boolean).slice(0, 3).join(', ') || 'General',
                    poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : PLACEHOLDER_POSTER,
                    overview: item.overview || 'No description available.',
                    source: 'tmdb'
                };
            });
    } catch (e) {
        console.warn(`[TMDB] search failed (${e.message})`);
        return [];
    }
}

async function searchOmdbApi(query, page = 1) {
    if (!query || !OMDB_API_KEY) return [];
    try {
        const url = `${OMDB_BASE}?s=${encodeURIComponent(query)}&page=${page}&apikey=${OMDB_API_KEY}`;
        console.log(`[OMDb] Searching: ${redact(url)}`);
        const response = await fetchWithTimeout(url, {}, 8000);
        if (!response.ok) return [];
        const data = await response.json();
        if (data.Response === 'False' || !Array.isArray(data.Search)) return [];
        const results = data.Search.filter(item => item.Type === 'movie' || item.Type === 'series').map(item => ({
            id: item.imdbID,
            imdb_id: item.imdbID,
            media_type: item.Type === 'series' ? 'tv' : 'movie',
            title: item.Title || 'Untitled',
            year: item.Year || '—',
            rating: '—',
            genres: item.Type ? item.Type.toUpperCase() : 'General',
            poster: (item.Poster && item.Poster !== 'N/A') ? item.Poster : PLACEHOLDER_POSTER,
            overview: `IMDb ID: ${item.imdbID}. Use standard RD stream search to look up this title.`,
            source: 'omdb'
        }));
        // OMDb hits carry their IMDb id, so they land on (or create) the right catalog item. Only real facts go in:
        // not the display placeholders above (the "IMDb ID: …" overview, the MOVIE / SERIES "genre").
        ingestOutside(results.map(item => ({
            category: item.media_type,
            title: item.title,
            year: parseInt(item.year) || null,
            poster_url: item.poster !== PLACEHOLDER_POSTER ? item.poster : null,
            external_ids: { imdb: item.imdb_id },
            source: 'omdb'
        })));
        return results;
    } catch (e) {
        console.warn(`[OMDb] search failed (${e.message})`);
        return [];
    }
}

async function fetchOmdbDetails({ imdbId, title, year }) {
    if (!OMDB_API_KEY) return null;
    let url = `${OMDB_BASE}?apikey=${OMDB_API_KEY}&plot=full`;
    if (imdbId) {
        url += `&i=${encodeURIComponent(imdbId)}`;
    } else if (title) {
        url += `&t=${encodeURIComponent(title)}`;
        if (year) url += `&y=${encodeURIComponent(year)}`;
    } else {
        return null;
    }
    try {
        console.log(`[OMDb] Fetching details: ${redact(url)}`);
        const response = await fetchWithTimeout(url, {}, 8000);
        if (!response.ok) return null;
        const data = await response.json();
        if (data.Response === 'False') return null;
        const poster = data.Poster && data.Poster !== 'N/A' ? data.Poster : PLACEHOLDER_POSTER;
        const present = v => v && v !== 'N/A';
        const formatted = {
            id: data.imdbID || null,
            imdb_id: data.imdbID || null,
            title: data.Title || 'Untitled',
            year: data.Year || '—',
            rating: data.imdbRating || '—',
            genres: data.Genre || 'General',
            poster,
            overview: data.Plot || 'No plot available.',
            director: data.Director || '—',
            writer: data.Writer || '—',
            actors: data.Actors || '—',
            awards: data.Awards || '—',
            runtime: data.Runtime || '—',
            source: 'omdb'
        };
        if (data.imdbID && (data.Type === 'movie' || data.Type === 'series')) {
            ingestOutside({
                category: data.Type === 'series' ? 'tv' : 'movie',
                title: formatted.title,
                year: parseInt(formatted.year) || null,
                rating: parseFloat(formatted.rating) || null,
                runtime_mins: parseInt(data.Runtime) || null,
                genres: present(data.Genre) ? data.Genre.split(',').map(s => s.trim()) : [],
                poster_url: poster !== PLACEHOLDER_POSTER ? poster : null,
                overview: present(data.Plot) ? data.Plot : null,
                cast_or_credits: [
                    ...(present(data.Director) ? data.Director.split(',').map(d => `${d.trim()} (director)`) : []),
                    ...(present(data.Actors) ? data.Actors.split(',').map(a => a.trim()) : [])
                ],
                external_ids: { imdb: data.imdbID },
                source: 'omdb'
            });
        }
        return formatted;
    } catch (e) {
        console.warn(`[OMDb] fetch details failed (${e.message})`);
        return null;
    }
}

/** The catalog's "popular" page (most voted films and series), when TMDB trending is not available. */
async function localPopular(page = 1) {
    const per = 10;
    const [movies, shows] = await Promise.all([
        raggae.browse({ category: 'movie', sort: 'votes', limit: per, offset: (page - 1) * per }),
        raggae.browse({ category: 'tv', sort: 'votes', limit: per, offset: (page - 1) * per })
    ]);
    const out = [];
    for (let i = 0; i < per; i++) {
        if (movies[i]) out.push(catalogToCard(movies[i]));
        if (shows[i]) out.push(catalogToCard(shows[i]));
    }
    return out;
}

/** A local catalog item in the TMDB movie / tv details shape the modal reads, for titles TMDB cannot give. */
function catalogToTmdbShape(item, mediaType) {
    const card = catalogToCard(item);
    const date = item.release_date || (item.year ? String(item.year) : '');
    const base = {
        id: card.id,
        imdb_id: card.imdb_id,
        overview: item.overview || card.overview,
        vote_average: item.rating || 0,
        vote_count: item.votes || 0,
        genres: (Array.isArray(item.genres) ? item.genres : []).map(name => ({ name })),
        poster_path: null,
        poster: card.poster,
        runtime: item.runtime_mins || null,
        source: 'raggae',
        videos: { results: [] }
    };
    return mediaType === 'tv'
        ? { ...base, name: card.title, first_air_date: date, seasons: [] }
        : { ...base, title: card.title, release_date: date };
}

/** The catalog item behind a renderer id: `tt…` / `imdb:tt…` -> imdb:tt…, another `x:y` id as is. */
async function catalogItemFor(id) {
    const sid = String(id || '');
    if (/^(imdb:)?tt\d+$/.test(sid)) return raggae.getItem(`imdb:${sid.replace(/^imdb:/, '')}`);
    if (sid.includes(':')) return raggae.getItem(sid);
    return null;
}

const localSearchCache = new Map();

/** Local hits for a query, kept for the following pages of the same search (at most 50 queries). */
async function localHitsFor(query) {
    const key = query.toLowerCase();
    if (localSearchCache.has(key)) return localSearchCache.get(key);
    const hits = await searchLocalCatalog(query, { limit: 20 });
    localSearchCache.set(key, hits);
    if (localSearchCache.size > 50) localSearchCache.delete(localSearchCache.keys().next().value);
    return hits;
}

function registerTmdbHandlers(ipcMain) {
    ipcMain.handle('search-tmdb', async (event, arg) => {
        try {
            let query = '';
            let page = 1;
            let language = 'en-US';
            if (arg && typeof arg === 'object') {
                query = (arg.query || '').trim();
                page = arg.page || 1;
                language = arg.language || 'en-US';
            } else if (typeof arg === 'string') {
                query = arg.trim();
            }

            // Waterfall for search queries: 1. Local Catalog -> 2. TMDB -> 3. OMDb.
            // Page 1 is the local hits, with TMDB's after them when the local answer is thin. "Load more" then
            // pages through TMDB (OMDb when TMDB has nothing), never repeating a title page 1 showed.
            if (query) {
                page = Math.max(1, parseInt(page) || 1);
                const local = await localHitsFor(query);
                const enough = localIsEnough(local);
                if (page === 1 && enough) {
                    console.log(`[Search] ${local.length} local catalog hits for "${query}"`);
                    return { success: true, source: 'raggae', results: local };
                }
                const outsidePage = enough ? page - 1 : page;
                let outside = await searchTmdbApi(query, outsidePage, language);
                let source = 'tmdb';
                if (!outside.length) {
                    outside = await searchOmdbApi(query, outsidePage);
                    source = 'omdb';
                }
                const merged = mergeAfterLocal(local, outside);
                const results = page === 1 ? merged : merged.slice(local.length);
                console.log(`[Search] "${query}" page ${page}: ${page === 1 ? local.length : 0} local + ${results.length - (page === 1 ? local.length : 0)} from ${source}`);
                return { success: true, source: page === 1 && local.length ? `raggae+${source}` : source, results };
            }

            // No query: trending discovery (the catalog's most voted titles when TMDB is not configured)
            if (!TMDB_BEARER_TOKEN) {
                return { success: true, source: 'raggae', results: await localPopular(page) };
            }

            const trendingUrl = `https://api.themoviedb.org/3/trending/all/day?language=${language}&page=${page}`;
            console.log(`[TMDB] Fetching trending API: ${trendingUrl}`);
            const response = await fetchWithTimeout(trendingUrl, {
                method: 'GET',
                headers: {
                    accept: 'application/json',
                    Authorization: `Bearer ${TMDB_BEARER_TOKEN}`
                }
            });

            if (!response.ok) {
                const localFallback = await localPopular(page);
                if (localFallback.length > 0) {
                    return { success: true, source: 'raggae', results: localFallback };
                }
                const errText = await response.text();
                return { success: false, status: response.status, error: errText };
            }

            const data = await response.json();
            const results = (data.results || []).map(item => {
                const title = item.title || item.name || 'Untitled';
                const dateStr = item.release_date || item.first_air_date || '';
                const year = dateStr ? dateStr.substring(0, 4) : '—';
                const rating = item.vote_average ? item.vote_average.toFixed(1) : '—';
                const genres = (item.genre_ids || [])
                    .map(id => GENRE_MAP[id])
                    .filter(Boolean)
                    .slice(0, 3)
                    .join(', ') || 'General';
                const poster = item.poster_path 
                    ? `https://image.tmdb.org/t/p/w500${item.poster_path}`
                    : 'public/poster_placeholder.svg';

                return {
                    id: item.id,
                    media_type: item.media_type || 'movie',
                    title,
                    year,
                    rating,
                    genres,
                    poster,
                    overview: item.overview || 'No description available.',
                    source: 'tmdb'
                };
            });

            return { success: true, results };
        } catch (err) {
            console.error('[Search] Handler Error:', err);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('get-tmdb-movie', async (event, arg) => {
        try {
            let id;
            let language = 'en-US';
            if (arg && typeof arg === 'object') {
                id = arg.id;
                language = arg.language || 'en-US';
            } else {
                id = arg;
            }

            // A local catalog hit may carry an IMDb id: map it; a title TMDB cannot give comes from the catalog
            const tmdbId = await toTmdbId(id, 'movie');
            if (!tmdbId) {
                const localItem = await catalogItemFor(id);
                if (localItem) return { success: true, source: 'raggae', data: catalogToTmdbShape(localItem, 'movie') };
            }

            if (!TMDB_BEARER_TOKEN) {
                return {
                    success: true,
                    data: {
                        id,
                        title: "Dune: Part Two (Offline)",
                        overview: "Follow the mythic journey of Paul Atreides as he unites with Chani and the Fremen while on a path of revenge against the conspirators who destroyed his family.",
                        release_date: "2024-03-01",
                        vote_average: 8.3,
                        genres: [{ name: "Sci-Fi" }, { name: "Adventure" }],
                        videos: {
                            results: [
                                {
                                    key: "Way9DexNy3w",
                                    site: "YouTube",
                                    type: "Trailer"
                                }
                            ]
                        }
                    }
                };
            }

            const url = `https://api.themoviedb.org/3/movie/${tmdbId || id}?append_to_response=videos&language=${language}`;
            const response = await fetchWithTimeout(url, {
                method: 'GET',
                headers: {
                    accept: 'application/json',
                    Authorization: `Bearer ${TMDB_BEARER_TOKEN}`
                }
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();

            // Kinocheck fallback if no YouTube trailer is returned by TMDB
            if (!data.videos || !data.videos.results || data.videos.results.length === 0) {
                try {
                    console.log(`[TMDB] No YouTube trailer found in TMDB. Querying Kinocheck fallback for TMDB ID: ${id}`);
                    const kcUrl = `https://api.kinocheck.de/movies?tmdb_id=${tmdbId || id}`;
                    const kcRes = await fetchWithTimeout(kcUrl);
                    if (kcRes.ok) {
                        const kcData = await kcRes.json();
                        if (kcData && kcData.trailer && kcData.trailer.youtube_video_id) {
                            if (!data.videos) data.videos = { results: [] };
                            if (!data.videos.results) data.videos.results = [];
                            data.videos.results.push({
                                key: kcData.trailer.youtube_video_id,
                                site: 'YouTube',
                                type: 'Trailer'
                            });
                            console.log('[TMDB] Kinocheck fallback succeeded: found YouTube video ID:', kcData.trailer.youtube_video_id);
                        }
                    }
                } catch (kcErr) {
                    console.error('[TMDB] Kinocheck fallback fetch failed:', kcErr);
                }
            }

            // Outside details into the catalog: keyed on the IMDb id, so a known title is only filled in
            if (data && data.title) {
                ingestOutside({
                    category: 'movie',
                    title: data.title,
                    original_title: data.original_title || null,
                    year: data.release_date ? parseInt(data.release_date.substring(0, 4)) : null,
                    release_date: data.release_date || null,
                    runtime_mins: data.runtime || null,
                    rating: data.vote_average ? parseFloat(data.vote_average.toFixed(1)) : null,
                    votes: data.vote_count || null,
                    genres: Array.isArray(data.genres) ? data.genres.map(g => g.name).filter(Boolean) : [],
                    poster_url: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null,
                    overview: data.overview || null,
                    external_ids: { tmdb: data.id, imdb: data.imdb_id || null },
                    source: 'tmdb'
                });
            }

            return { success: true, data };
        } catch (e) {
            console.error('[TMDB] get-tmdb-movie failed, returning offline fallback:', e);
            return {
                success: true,
                data: {
                    id,
                    title: "Movie Title (Offline Fallback)",
                    overview: "A premium offline cinematic presentation. Please check your internet connection and .env file credentials for live data.",
                    release_date: "2026",
                    vote_average: 8.0,
                    genres: [{ name: "Drama" }],
                    videos: { results: [] }
                }
            };
        }
    });

    ipcMain.handle('get-tmdb-tv', async (event, arg) => {
        try {
            let id;
            let language = 'en-US';
            if (arg && typeof arg === 'object') {
                id = arg.id;
                language = arg.language || 'en-US';
            } else {
                id = arg;
            }

            const tmdbId = await toTmdbId(id, 'tv');
            if (!tmdbId) {
                const localItem = await catalogItemFor(id);
                if (localItem) return { success: true, source: 'raggae', data: catalogToTmdbShape(localItem, 'tv') };
            }

            if (!TMDB_BEARER_TOKEN) {
                return {
                    success: true,
                    data: {
                        id,
                        name: "Breaking Bad (Offline)",
                        overview: "A high school chemistry teacher diagnosed with inoperable lung cancer turns to manufacturing and selling methamphetamine with a former student in order to secure his family's future.",
                        first_air_date: "2008-01-20",
                        vote_average: 9.5,
                        genres: [{ name: "Drama" }, { name: "Crime" }],
                        seasons: [
                            { season_number: 1, name: "Season 1", episode_count: 7 },
                            { season_number: 2, name: "Season 2", episode_count: 13 }
                        ]
                    }
                };
            }

            const url = `https://api.themoviedb.org/3/tv/${tmdbId || id}?language=${language}&append_to_response=external_ids`;
            const response = await fetchWithTimeout(url, {
                method: 'GET',
                headers: {
                    accept: 'application/json',
                    Authorization: `Bearer ${TMDB_BEARER_TOKEN}`
                }
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();

            // Outside details into the catalog, keyed on the IMDb id when TMDB knows it
            if (data && (data.name || data.title)) {
                ingestOutside({
                    category: 'tv',
                    title: data.name || data.title,
                    original_title: data.original_name || null,
                    year: data.first_air_date ? parseInt(data.first_air_date.substring(0, 4)) : null,
                    release_date: data.first_air_date || null,
                    rating: data.vote_average ? parseFloat(data.vote_average.toFixed(1)) : null,
                    votes: data.vote_count || null,
                    genres: Array.isArray(data.genres) ? data.genres.map(g => g.name).filter(Boolean) : [],
                    poster_url: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null,
                    overview: data.overview || null,
                    external_ids: { tmdb: data.id, imdb: (data.external_ids && data.external_ids.imdb_id) || null },
                    source: 'tmdb'
                });
            }

            return { success: true, data };
        } catch (e) {
            console.error('[TMDB] get-tmdb-tv failed, returning offline fallback:', e);
            return {
                success: true,
                data: {
                    id,
                    name: "Series Title (Offline Fallback)",
                    overview: "An elite offline episodic selection. Set up your TMDB key in .env to pull seasons and episodes in real time.",
                    first_air_date: "2026",
                    vote_average: 8.5,
                    genres: [{ name: "Adventure" }],
                    seasons: [
                        { season_number: 1, name: "Season 1", episode_count: 5 }
                    ]
                }
            };
        }
    });

    ipcMain.handle('get-tmdb-tv-season', async (event, arg) => {
        try {
            let id;
            let seasonNumber;
            let language = 'en-US';
            if (arg && typeof arg === 'object') {
                id = arg.id;
                seasonNumber = arg.seasonNumber;
                language = arg.language || 'en-US';
            } else {
                id = arg;
            }

            id = (await toTmdbId(id, 'tv')) || id;

            if (!TMDB_BEARER_TOKEN) {
                return {
                    success: true,
                    data: {
                        episodes: [
                            { episode_number: 1, name: "Pilot", overview: "Chemistry teacher Walter White learns he has terminal cancer." },
                            { episode_number: 2, name: "Cat's in the Bag...", overview: "Walt and Jesse clean up the chemical mess." }
                        ]
                    }
                };
            }

            const url = `https://api.themoviedb.org/3/tv/${id}/season/${seasonNumber}?language=${language}`;
            const response = await fetchWithTimeout(url, {
                method: 'GET',
                headers: {
                    accept: 'application/json',
                    Authorization: `Bearer ${TMDB_BEARER_TOKEN}`
                }
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            return { success: true, data };
        } catch (e) {
            console.error('[TMDB] get-tmdb-tv-season failed, returning offline fallback:', e);
            return {
                success: true,
                data: {
                    episodes: [
                        { episode_number: 1, name: "Episode 1 (Offline)", overview: "An engaging episodic installment. Ensure your network is active." },
                        { episode_number: 2, name: "Episode 2 (Offline)", overview: "The narrative deepens. Check your internet connection." }
                    ]
                }
            };
        }
    });

    // Regions TMDB can answer watch-provider queries for; drives the settings
    // dropdown so the list can't drift from what the API supports.
    ipcMain.handle('get-watch-regions', async () => {
        const data = await fetchTmdbConfig('/watch/providers/regions?language=en-US', null);
        const results = (data && data.results) || [];
        if (!results.length) {
            return { success: true, regions: [{ code: DEFAULT_WATCH_REGION, name: 'United States' }], fallback: true };
        }
        return {
            success: true,
            detected: await geoWatchRegion(),          // null when no provider answered
            fallbackRegion: DEFAULT_WATCH_REGION,
            regions: results.map((r) => ({ code: r.iso_3166_1, name: r.native_name || r.english_name })),
        };
    });

    // ── KinoCheck Premium API Handler ────────────────────────────────────────
    ipcMain.handle('get-kinocheck-trailer', async (event, { tmdbId: requestedId, mediaType, language }) => {
        let tmdbId = requestedId;
        try {
            if (!KINOCHECK_API_KEY) {
                console.warn('[KinoCheck] No API key loaded.');
                return { success: false, error: 'No API key loaded.' };
            }
            const type = mediaType === 'tv' ? 'shows' : 'movies';
            tmdbId = (await toTmdbId(tmdbId, mediaType === 'tv' ? 'tv' : 'movie')) || tmdbId;
            // KinoCheck takes a bare language code. Was pinned to English, so a
            // French UI still got English trailers.
            const kcLang = String(language || 'en').slice(0, 2).toLowerCase() === 'fr' ? 'fr' : 'en';
            const url = `https://api.kinocheck.com/${type}?tmdb_id=${tmdbId}&language=${kcLang}`;
            console.log(`[KinoCheck] Fetching premium trailer: ${url}`);
            
            const response = await fetchWithTimeout(url, {
                headers: {
                    'X-Api-Key': KINOCHECK_API_KEY,
                    'Accept': 'application/json'
                }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP status ${response.status}`);
            }
            
            const data = await response.json();
            if (data && data.trailer && data.trailer.youtube_video_id) {
                return {
                    success: true,
                    key: data.trailer.youtube_video_id,
                    title: data.trailer.title,
                    thumbnail: data.trailer.youtube_thumbnail
                };
            }
            
            // Fallback to the videos array if main trailer object is missing
            if (data && Array.isArray(data.videos)) {
                const trailerVideo = data.videos.find(v => v.categories && v.categories.includes('Trailer') && v.youtube_video_id);
                if (trailerVideo) {
                    return {
                        success: true,
                        key: trailerVideo.youtube_video_id,
                        title: trailerVideo.title,
                        thumbnail: trailerVideo.youtube_thumbnail
                    };
                }
                
                // Final fallback: first available video
                if (data.videos.length > 0 && data.videos[0].youtube_video_id) {
                    return {
                        success: true,
                        key: data.videos[0].youtube_video_id,
                        title: data.videos[0].title,
                        thumbnail: data.videos[0].youtube_thumbnail
                    };
                }
            }
            
            return { success: false, error: 'No trailer found in KinoCheck response' };
        } catch (err) {
            console.error('[KinoCheck] Error fetching premium trailer:', err);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('discover-tmdb', async (event, { providerId, mediaType, page = 1, language = 'en-US', withGenres, decade, region, sort, watchRegion }) => {
        try {
            const type = mediaType === 'tv' ? 'tv' : 'movie';
            
            if (!TMDB_BEARER_TOKEN) {
                // Mock provider listings for offline/unconfigured usage
                let mockList = [];
                const netflixMock = [
                    { id: 201, media_type: type, title: "Stranger Things", year: "2016", rating: "8.6", genres: "Sci-Fi, Drama", poster: "public/poster_placeholder.svg", overview: "When a young boy vanishes, a small town uncovers a mystery involving secret experiments and terrifying supernatural forces." },
                    { id: 202, media_type: type, title: "Squid Game", year: "2021", rating: "8.1", genres: "Action, Thriller", poster: "public/poster_placeholder.svg", overview: "Hundreds of cash-strapped players accept a strange invitation to compete in children's games. Inside, a tempting prize awaits with deadly high stakes." }
                ];
                const disneyMock = [
                    { id: 301, media_type: type, title: "The Mandalorian", year: "2019", rating: "8.4", genres: "Action, Sci-Fi", poster: "public/poster_placeholder.svg", overview: "The travels of a lone bounty hunter in the outer reaches of the galaxy, far from the authority of the New Republic." },
                    { id: 302, media_type: type, title: "Loki", year: "2021", rating: "8.2", genres: "Sci-Fi, Adventure", poster: "public/poster_placeholder.svg", overview: "The mercurial villain Loki resumes his role as the God of Mischief in a new series that takes place after the events of Avengers: Endgame." }
                ];
                const appleMock = [
                    { id: 401, media_type: type, title: "Ted Lasso", year: "2020", rating: "8.5", genres: "Comedy, Drama", poster: "public/poster_placeholder.svg", overview: "US American football coach Ted Lasso heads to the UK to manage a struggling London football team in the top flight of English football." },
                    { id: 402, media_type: type, title: "Severance", year: "2022", rating: "8.7", genres: "Sci-Fi, Drama", poster: "public/poster_placeholder.svg", overview: "Mark leads a team of office workers whose memories have been surgically divided between their work and personal lives." }
                ];
                const primeMock = [
                    { id: 501, media_type: type, title: "The Boys", year: "2019", rating: "8.7", genres: "Sci-Fi, Action", poster: "public/poster_placeholder.svg", overview: "A group of vigilantes set out to take down corrupt superheroes who abuse their superpowers." },
                    { id: 502, media_type: type, title: "Reacher", year: "2022", rating: "8.1", genres: "Action, Crime", poster: "public/poster_placeholder.svg", overview: "Jack Reacher, a veteran military police investigator, is falsely accused of murder and finds himself in the middle of a deadly conspiracy." }
                ];

                if (providerId === '8' || providerId === '213') {
                    mockList = netflixMock;
                } else if (providerId === '337') {
                    mockList = disneyMock;
                } else if (providerId === '350') {
                    mockList = appleMock;
                } else if (providerId === '119' || providerId === '9') {
                    mockList = primeMock;
                } else {
                    mockList = [...netflixMock, ...disneyMock, ...appleMock, ...primeMock];
                }
                return { success: true, results: mockList };
            }

            // discover/tv understands first_air_date.*, not primary_release_date.*,
            // but the filter UI only ever sends the latter — so "Release Date"
            // sorting was silently ignored for series.
            const dateField = type === 'tv' ? 'first_air_date' : 'primary_release_date';
            let sortByParam = sort || 'popularity.desc';
            if (type === 'tv') sortByParam = sortByParam.replace(/^primary_release_date\./, 'first_air_date.');

            let url = `https://api.themoviedb.org/3/discover/${type}?sort_by=${sortByParam}&language=${language}&page=${page}`;
            
            if (providerId && providerId !== 'all') {
                // watch_region is mandatory here: without it TMDB ignores the
                // provider filter entirely and returns the whole catalogue.
                const wr = (watchRegion || await geoWatchRegion() || DEFAULT_WATCH_REGION).toUpperCase();
                url += `&with_watch_providers=${providerId}&watch_region=${wr}&with_watch_monetization_types=flatrate`;
            }
            if (withGenres && withGenres !== 'all') {
                url += `&with_genres=${withGenres}`;
            }
            if (region && region !== 'all') {
                url += `&with_origin_country=${region}`;
            }
            // One date window, built once. The decade filter and the
            // not-yet-released cap both constrain the upper bound, and emitting
            // two `.lte` params would leave which one wins up to TMDB.
            let dateGte = null;
            let dateLte = null;
            if (decade && decade !== 'all') {
                const startYear = parseInt(decade);
                if (startYear === 1920) {
                    dateLte = '1929-12-31';
                } else {
                    dateGte = `${startYear}-01-01`;
                    dateLte = `${startYear + 9}-12-31`;
                }
            }
            // Sorting by release date otherwise puts unreleased titles at the top,
            // filling the grid with things nobody can play. Cap at today in UTC
            // rather than local time: a local-midnight cap would include or hide a
            // same-day worldwide release depending on the viewer's timezone.
            if (sortByParam.startsWith(dateField)) {
                const todayUtc = new Date().toISOString().slice(0, 10);
                if (!dateLte || dateLte > todayUtc) dateLte = todayUtc;
            }
            if (dateGte) url += `&${dateField}.gte=${dateGte}`;
            if (dateLte) url += `&${dateField}.lte=${dateLte}`;
            
            url += `&with_original_language=${await originalLanguageFilter()}`;
            
            // with_original_language now carries every language TMDB supports
            // (72 codes), which buried every other line in the log. The value is
            // constant per session, so log it once and elide it afterwards.
            const loggableUrl = url.replace(/with_original_language=[^&]*/, 'with_original_language=<all>');
            console.log(`[TMDB] Discovering streaming items: ${loggableUrl}`);
            
            const response = await fetchWithTimeout(url, {
                method: 'GET',
                headers: {
                    accept: 'application/json',
                    Authorization: `Bearer ${TMDB_BEARER_TOKEN}`
                }
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            
            const results = (data.results || []).map(item => {
                const title = item.title || item.name || 'Untitled';
                const dateStr = item.release_date || item.first_air_date || '';
                const year = dateStr ? dateStr.substring(0, 4) : '—';
                const rating = item.vote_average ? item.vote_average.toFixed(1) : '—';
                
                const genres = (item.genre_ids || [])
                    .map(id => GENRE_MAP[id])
                    .filter(Boolean)
                    .slice(0, 3)
                    .join(', ') || 'General';

                const poster = item.poster_path 
                    ? `https://image.tmdb.org/t/p/w500${item.poster_path}`
                    : 'public/poster_placeholder.svg';

                return {
                    id: item.id,
                    media_type: type,
                    title,
                    year,
                    rating,
                    genres,
                    poster,
                    overview: item.overview || 'No description available.'
                };
            });

            return { success: true, results };
        } catch (e) {
            console.error('[TMDB] discover-tmdb failed:', e);
            return { success: false, error: e.message };
        }
    });

    // ── OMDb API Support & Details Waterfall ─────────────────────────────────
    ipcMain.handle('search-omdb', async (event, { query, page = 1 }) => {
        try {
            const results = await searchOmdbApi(query, page);
            return { success: true, results, totalResults: results.length };
        } catch (err) {
            console.error('[OMDb] Search error:', err);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('get-omdb-details', async (event, { imdbId, title, year }) => {
        try {
            const queryText = title || imdbId;
            if (!queryText) {
                return { success: false, error: 'Either imdbId or title must be provided' };
            }

            // STEP 1: Local catalog. An IMDb id names exactly one item; a bare title is resolved with its year,
            // and only a film or series counts (resolve also knows music, books and scenes).
            let item = imdbId ? await raggae.getItem(`imdb:${String(imdbId).replace(/^imdb:/, '')}`) : null;
            if (!item && !imdbId && title) {
                const resolved = await raggae.resolve({ name: year ? `${title} ${year}` : title });
                const cand = resolved && resolved.item;
                if (cand && (cand.category === 'movie' || cand.category === 'tv')) item = cand;
            }
            if (item) {
                const card = catalogToCard(item);
                const credits = Array.isArray(item.cast_or_credits) ? item.cast_or_credits : [];
                const isDirector = c => /\(director\)|^director:/i.test(c);
                console.log(`[Details] From the local catalog: ${card.title} (${card.year})`);
                return {
                    success: true,
                    source: 'raggae',
                    data: {
                        ...card,
                        imdb_id: card.imdb_id || imdbId || null,
                        overview: item.overview || 'No plot available.',
                        director: credits.filter(isDirector).map(c => c.replace(/\s*\(director\)|^director:\s*/i, '')).join(', ') || '—',
                        writer: '—',
                        actors: credits.filter(c => !isDirector(c) && !/\((writer|producer|composer)\)/i.test(c)).slice(0, 5).join(', ') || '—',
                        awards: '—',
                        runtime: item.runtime_mins ? `${item.runtime_mins} min` : '—'
                    }
                };
            }

            // STEP 2: TMDB second
            if (TMDB_BEARER_TOKEN) {
                try {
                    let tmdbHit = null;
                    if (imdbId) {
                        const findUrl = `https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id`;
                        const res = await fetchWithTimeout(findUrl, {
                            headers: { accept: 'application/json', Authorization: `Bearer ${TMDB_BEARER_TOKEN}` }
                        }, 5000);
                        if (res.ok) {
                            const findData = await res.json();
                            tmdbHit = (findData.movie_results && findData.movie_results[0]) || (findData.tv_results && findData.tv_results[0]);
                        }
                    }
                    if (!tmdbHit && title) {
                        const sUrl = `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(title)}&include_adult=false`;
                        const res = await fetchWithTimeout(sUrl, {
                            headers: { accept: 'application/json', Authorization: `Bearer ${TMDB_BEARER_TOKEN}` }
                        }, 5000);
                        if (res.ok) {
                            const sData = await res.json();
                            if (sData.results && sData.results.length > 0) tmdbHit = sData.results[0];
                        }
                    }
                    if (tmdbHit) {
                        return {
                            success: true,
                            source: 'tmdb',
                            data: {
                                id: tmdbHit.id,
                                imdb_id: imdbId || null,
                                title: tmdbHit.title || tmdbHit.name || 'Untitled',
                                year: (tmdbHit.release_date || tmdbHit.first_air_date || '—').substring(0, 4),
                                rating: tmdbHit.vote_average ? tmdbHit.vote_average.toFixed(1) : '—',
                                genres: (tmdbHit.genre_ids || []).map(id => GENRE_MAP[id]).filter(Boolean).slice(0, 3).join(', ') || 'General',
                                poster: tmdbHit.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbHit.poster_path}` : 'public/poster_placeholder.svg',
                                overview: tmdbHit.overview || 'No description available.',
                                director: '—',
                                writer: '—',
                                actors: '—',
                                awards: '—',
                                runtime: '—'
                            }
                        };
                    }
                } catch (tmdbErr) {
                    console.warn('[Details] TMDB lookup error:', tmdbErr.message);
                }
            }

            // STEP 3: OMDb third
            const omdbData = await fetchOmdbDetails({ imdbId, title, year });
            if (omdbData) {
                return { success: true, source: 'omdb', data: omdbData };
            }

            return { success: false, error: 'Media details not found across Local Catalog, TMDB, or OMDb' };
        } catch (err) {
            console.error('[Details] Error getting details:', err);
            return { success: false, error: err.message };
        }
    });
}

module.exports = {
    registerTmdbHandlers,
    // for tests/test_raggae_integration.js
    _internals: { catalogToCard, localIsEnough, mergeAfterLocal, redact, toTmdbId, localSearchCache, tmdbIdCache }
};
