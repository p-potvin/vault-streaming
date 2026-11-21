// src/tmdb.js - Exposes real-time TMDB Search and Trending API handlers using process.env secrets

const fs = require('fs');
const path = require('path');
const raggae = require('./raggae');
const trailers = require('./trailers');

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

/** KinoCheck's trailer for a TMDB id: { key, title, thumbnail }, null when KinoCheck answered without one, undefined
 *  when it did not answer (network, 429, 5xx: the caller must not remember that as "no trailer"). One request. */
async function fetchKinoCheckTrailer(tmdbId, category, language) {
    if (!KINOCHECK_API_KEY || !tmdbId) return null;
    const type = category === 'tv' ? 'shows' : 'movies';
    // KinoCheck takes a bare language code (fr or en)
    const kcLang = String(language || 'en').slice(0, 2).toLowerCase() === 'fr' ? 'fr' : 'en';
    try {
        const res = await fetchWithTimeout(`https://api.kinocheck.com/${type}?tmdb_id=${tmdbId}&language=${kcLang}`,
            { headers: { 'X-Api-Key': KINOCHECK_API_KEY, Accept: 'application/json' } });
        if (!res.ok) {
            console.warn(`[KinoCheck] ${type} ${tmdbId} -> HTTP ${res.status}`);
            return (res.status === 429 || res.status >= 500) ? undefined : null;
        }
        const data = await res.json();
        const pick = v => v && v.youtube_video_id ? { key: v.youtube_video_id, title: v.title, thumbnail: v.youtube_thumbnail } : null;
        if (data && data.trailer && data.trailer.youtube_video_id) return pick(data.trailer);
        if (data && Array.isArray(data.videos)) {
            return pick(data.videos.find(v => v.categories && v.categories.includes('Trailer') && v.youtube_video_id))
                || pick(data.videos.find(v => v.youtube_video_id));
        }
        return null;
    } catch (e) {
        console.warn(`[KinoCheck] ${type} ${tmdbId} failed (${e.message})`);
        return undefined;
    }
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
const { minVotesFor } = require('./catalog-coverage');

/** A card with a real poster. The lists viewers see (Discover, trending, popular) keep to these; search shows the
 *  rest after them (operator, Fri 20 Nov 2026: as few empty posters as possible in the app and the web UI). */
function hasPoster(card) {
    return !!(card && card.poster && card.poster !== PLACEHOLDER_POSTER);
}

// Pages of a catalog browse after local filtering (posters, genre, release). A fixed offset per page would give an
// empty page wherever a stretch of rows is filtered out, and the renderer stops "Load more" at the first empty page.
// So each page is filled by reading batches from where the previous page stopped; where every page starts in the
// raw rows is remembered per browse, so page N is the same titles each time it is asked for.
const FILTER_BATCH = 50;
const FILTER_MAX_SCAN = 500;             // rows read for one page at most: a page may stay short, never loops
const pageStarts = new Map();            // browse key (without the page) -> [raw offset where page 1, 2, … starts]

/** Page `page` (1-based) of `size` kept cards: `fetchRows(offset, limit)` reads raw rows, `keep(row)` returns the card
 *  to show or null. */
async function filteredPage(key, page, size, fetchRows, keep) {
    let starts = pageStarts.get(key);
    if (!starts) {
        starts = [0];
        pageStarts.set(key, starts);
        if (pageStarts.size > 200) pageStarts.delete(pageStarts.keys().next().value);
    }
    // from the furthest page whose start is known, walk forward to the one asked for
    for (let p = Math.min(page, starts.length); ; p++) {
        let raw = starts[p - 1];
        const out = [];
        let scanned = 0;
        let exhausted = false;
        while (out.length < size && scanned < FILTER_MAX_SCAN) {
            const rows = await fetchRows(raw, FILTER_BATCH);
            if (!rows.length) { exhausted = true; break; }
            for (const row of rows) {
                raw++;
                scanned++;
                const card = keep(row);
                if (card) out.push(card);
                if (out.length >= size) break;
            }
            if (rows.length < FILTER_BATCH && out.length < size) { exhausted = true; break; }
        }
        starts[p] = raw;
        if (p >= page) return out;
        if (exhausted) return [];
    }
}

/** A URL as it may be logged: API keys and tokens replaced. */
function redact(url) {
    return String(url).replace(/([?&](?:apikey|api_key|token)=)[^&]+/gi, '$1***');
}

function tmdbHeaders() {
    return { accept: 'application/json', Authorization: `Bearer ${TMDB_BEARER_TOKEN}` };
}

/** A local catalog item as the renderer's card / modal expect it. `id` is the TMDB id when the catalog knows it,
 *  else the bare IMDb id (tt…), which the TMDB handlers below map to a TMDB id on demand. */
function catalogToCard(item, language = null) {
    const ext = item.external_ids || {};
    const imdb = ext.imdb || (String(item.catalog_id || '').startsWith('imdb:') ? item.catalog_id.slice(5) : null);
    const credits = Array.isArray(item.cast_or_credits) ? item.cast_or_credits : [];
    const card = {
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
    const b = isLocalized(language) ? tmdbBlob(item, language) : null;
    return b ? applyLanguageBlob(card, b, language) : card;
}

function isLocalized(language) {
    return !!language && language !== 'en-US';
}

/** A card with the title, overview, genres and poster of the catalog's TMDB copy in another language. */
function applyLanguageBlob(card, b, language) {
    const title = card.media_type === 'tv' ? (b.name || b.title) : (b.title || b.name);
    const genres = (Array.isArray(b.genres) && b.genres.length)
        ? b.genres.slice(0, 3).map(g => (g && g.name) || g).filter(Boolean).join(', ') : null;
    return {
        ...card,
        title: title || card.title,
        overview: b.overview || card.overview,
        genres: genres || card.genres,
        poster: b.poster_path ? tmdbImage(b.poster_path) : card.poster,
        localized: language,
    };
}

// catalog id + language -> the few fields a card needs from that language's TMDB copy (null: there is none)
const languageBlobCache = new Map();

async function languageBlobFor(catalogId, language) {
    const key = `${catalogId}|${language}`;
    if (languageBlobCache.has(key)) return languageBlobCache.get(key);
    let slim = null;
    try {
        const item = await raggae.getItem(catalogId, { raw: true });
        const b = item && tmdbBlob(item, language);
        if (b) slim = { title: b.title, name: b.name, overview: b.overview, poster_path: b.poster_path, genres: b.genres };
    } catch (_) {
        return null;   // not remembered: the gateway may answer next time
    }
    languageBlobCache.set(key, slim);
    if (languageBlobCache.size > 5000) languageBlobCache.delete(languageBlobCache.keys().next().value);
    return slim;
}

/**
 * Cards in `language`. Browse and search rows come without the catalog's raw TMDB copies (only the stored lists
 * carry them), so each card not localized yet is looked up once by its catalog id (cached).
 */
async function localizeCards(cards, language) {
    if (!isLocalized(language) || !Array.isArray(cards)) return cards;
    return Promise.all(cards.map(async card => {
        if (!card || card.localized || card.source !== 'raggae' || !card.catalog_id) return card;
        const b = await languageBlobFor(card.catalog_id, language);
        return b ? applyLanguageBlob(card, b, language) : card;
    }));
}

async function searchLocalCatalog(query, options = {}) {
    if (!query) return [];
    const hits = await raggae.searchTitles(query, { limit: options.limit || 20 });
    return localizeCards(hits.map(it => catalogToCard(it, options.language || null)), options.language);
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
    const ref = await toTmdbRef(id, mediaType);
    return ref ? ref.id : null;
}

/** Like toTmdbId, with TMDB's own type for the id: { id, type: 'movie' | 'tv' }. IMDb and TMDB file some titles
 *  differently (an IMDb TV special is a TMDB movie), so /find's other list is taken when the asked one is empty, and
 *  the id is then fetched as that type (Thu, 19 Nov 2026: a catalog series holding a TMDB movie id 404'd as /tv/). */
async function toTmdbRef(id, mediaType = 'movie', { remember = true } = {}) {
    if (id === null || id === undefined || id === '') return null;
    if (/^\d+$/.test(String(id))) return { id: Number(id), type: mediaType };
    const imdb = String(id).replace(/^imdb:/, '');
    if (!/^tt\d+$/.test(imdb) || !TMDB_BEARER_TOKEN) return null;
    const cacheKey = `${mediaType}:${imdb}`;
    if (tmdbIdCache.has(cacheKey)) return tmdbIdCache.get(cacheKey);
    try {
        const res = await fetchWithTimeout(`https://api.themoviedb.org/3/find/${imdb}?external_source=imdb_id`,
            { headers: tmdbHeaders() }, 8000);
        if (!res.ok) return null;
        const data = await res.json();
        const asked = (mediaType === 'tv' ? data.tv_results : data.movie_results)?.[0];
        const other = asked ? null : (mediaType === 'tv' ? data.movie_results : data.tv_results)?.[0];
        const hit = asked || other;
        const ref = hit ? { id: hit.id, type: asked ? (mediaType === 'tv' ? 'tv' : 'movie') : (mediaType === 'tv' ? 'movie' : 'tv') } : null;
        tmdbIdCache.set(cacheKey, ref);
        if (ref && remember) {
            // the catalog item keeps the category it was asked under; tmdb_type says how to fetch the id
            ingestOutside({ category: mediaType === 'tv' ? 'tv' : 'movie', title: hit.title || hit.name,
                            external_ids: { imdb, tmdb: ref.id, tmdb_type: ref.type }, source: 'tmdb' });
        }
        return ref;
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
async function localPopular(page = 1, language = 'en-US') {
    const per = 10;
    const pageOf = category => filteredPage(`popular:${category}:${language}`, page, per,
        (offset, limit) => raggae.browse({ category, sort: 'votes', limit, offset, minVotes: minVotesFor(category) }),
        row => { const card = catalogToCard(row, language); return hasPoster(card) ? card : null; });
    const [movies, shows] = await Promise.all([pageOf('movie'), pageOf('tv')].map(p => p.then(c => localizeCards(c, language))));
    const out = [];
    for (let i = 0; i < per; i++) {
        if (movies[i]) out.push(movies[i]);
        if (shows[i]) out.push(shows[i]);
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

// ── Read-through: the catalog serves every detail; TMDB only fills it ────────
// A details request is answered from the catalog item (its own fields + raw_enrichment.tmdb[<language>], where TMDB's
// seasons, videos, backdrop… are kept). Only when the item is missing or its TMDB copy is older than its TTL is TMDB
// asked, once: the answer is ingested and the catalog's copy is read back and served. When the gateway cannot store
// it (down, writes off) the TMDB answer is served as is, so the app still works.
const DETAILS_TTL_MS = { movie: 30 * 24 * 3600 * 1000, tv: 7 * 24 * 3600 * 1000 };
const SEASON_TTL_MS = 7 * 24 * 3600 * 1000;

function tmdbImage(p, size = 'w500') {
    return p ? `https://image.tmdb.org/t/p/${size}${p}` : null;
}

function isFresh(blob, ttlMs) {
    const t = blob && Date.parse(blob.fetched_at || '');
    return Number.isFinite(t) && (Date.now() - t) < ttlMs;
}

function slimVideos(videos) {
    const list = (videos && Array.isArray(videos.results)) ? videos.results : [];
    return {
        results: list.filter(v => v && v.site === 'YouTube' && v.key).slice(0, 12)
            .map(v => ({ key: v.key, site: v.site, type: v.type, name: v.name, iso_639_1: v.iso_639_1, official: !!v.official }))
    };
}

/** What the app keeps of a TMDB movie / tv answer (raw_enrichment.tmdb[<language>]). */
function slimDetails(d, category) {
    const common = {
        id: d.id, overview: d.overview || null, tagline: d.tagline || null, status: d.status || null,
        vote_average: d.vote_average || 0, vote_count: d.vote_count || 0,
        genres: Array.isArray(d.genres) ? d.genres.map(g => ({ id: g.id, name: g.name })) : [],
        poster_path: d.poster_path || null, backdrop_path: d.backdrop_path || null,
        original_language: d.original_language || null, origin_country: d.origin_country || null,
        videos: slimVideos(d.videos), fetched_at: new Date().toISOString()
    };
    if (category === 'tv') {
        return {
            ...common, name: d.name, original_name: d.original_name || null, first_air_date: d.first_air_date || null,
            last_air_date: d.last_air_date || null, number_of_seasons: d.number_of_seasons || null,
            number_of_episodes: d.number_of_episodes || null, episode_run_time: d.episode_run_time || [],
            networks: Array.isArray(d.networks) ? d.networks.map(n => n.name) : [],
            seasons: Array.isArray(d.seasons) ? d.seasons.map(s => ({
                season_number: s.season_number, name: s.name, episode_count: s.episode_count,
                air_date: s.air_date || null, poster_path: s.poster_path || null
            })) : [],
            external_ids: { imdb_id: (d.external_ids && d.external_ids.imdb_id) || null }
        };
    }
    return {
        ...common, title: d.title, original_title: d.original_title || null, release_date: d.release_date || null,
        runtime: d.runtime || null, imdb_id: d.imdb_id || (d.external_ids && d.external_ids.imdb_id) || null
    };
}

/**
 * A person as TMDB lists them in a credit, with the TMDB person id kept so the cast catalog (vault-raggae) can join on
 * it later (operator, Sat 21 Nov 2026). `extra` holds the credit's own fields (character / job, order, roles…).
 */
function slimPerson(p, extra) {
    return {
        id: p.id, name: p.name || null, original_name: p.original_name && p.original_name !== p.name ? p.original_name : undefined,
        gender: p.gender || 0, known_for_department: p.known_for_department || null, profile_path: p.profile_path || null,
        popularity: p.popularity || 0, ...extra
    };
}

/** A title's people: movie `credits` (cast with character / order, crew with job / department) or a series'
 *  `aggregate_credits` (every role / job across its episodes, with episode counts). null when TMDB sent none. */
function slimCredits(c, aggregate = false) {
    if (!c || (!Array.isArray(c.cast) && !Array.isArray(c.crew))) return null;
    const cast = (c.cast || []).map(p => slimPerson(p, aggregate
        ? { order: p.order, total_episode_count: p.total_episode_count || 0,
            roles: (p.roles || []).map(r => ({ character: r.character || null, episode_count: r.episode_count || 0, credit_id: r.credit_id })) }
        : { character: p.character || null, order: p.order, credit_id: p.credit_id }));
    const crew = (c.crew || []).map(p => slimPerson(p, aggregate
        ? { department: p.department || null, total_episode_count: p.total_episode_count || 0,
            jobs: (p.jobs || []).map(j => ({ job: j.job || null, episode_count: j.episode_count || 0, credit_id: j.credit_id })) }
        : { department: p.department || null, job: p.job || null, credit_id: p.credit_id }));
    return { cast, crew, aggregate, fetched_at: new Date().toISOString() };
}

/** A season and every field TMDB gives its episodes (operator, Sat 21 Nov 2026: "everything TMDB has"), the episode's
 *  crew and guest stars included, people with their TMDB ids. */
function slimSeason(d) {
    return {
        id: d.id || null, name: d.name || null, overview: d.overview || null, air_date: d.air_date || null,
        poster_path: d.poster_path || null, vote_average: d.vote_average || 0, fetched_at: new Date().toISOString(),
        episodes: (Array.isArray(d.episodes) ? d.episodes : []).map(e => ({
            id: e.id || null, episode_number: e.episode_number, name: e.name, overview: e.overview || null,
            air_date: e.air_date || null, vote_average: e.vote_average || 0, vote_count: e.vote_count || 0,
            runtime: e.runtime || null, still_path: e.still_path || null, episode_type: e.episode_type || null,
            production_code: e.production_code || null,
            crew: (e.crew || []).map(p => slimPerson(p, { department: p.department || null, job: p.job || null, credit_id: p.credit_id })),
            guest_stars: (e.guest_stars || []).map(p => slimPerson(p, { character: p.character || null, order: p.order, credit_id: p.credit_id }))
        }))
    };
}

/** The catalog item behind any id the renderer holds: a TMDB id (number), tt… / imdb:tt…, or a catalog id. */
async function findCatalogItem(id, category, raw = true) {
    const sid = String(id === undefined || id === null ? '' : id);
    if (!sid) return null;
    if (/^\d+$/.test(sid)) return raggae.byExternal('tmdb', category, sid, { raw });
    if (/^(imdb:)?tt\d+$/.test(sid)) return raggae.getItem(`imdb:${sid.replace(/^imdb:/, '')}`, { raw });
    if (sid.includes(':')) return raggae.getItem(sid, { raw });
    return null;
}

function tmdbBlob(item, language) {
    const tmdb = item && item.raw_enrichment && item.raw_enrichment.tmdb;
    if (!tmdb || typeof tmdb !== 'object') return null;
    // the backfill stores French under fr-FR (scripts/backfill-catalog.js); a fr-CA client reads that copy
    return tmdb[language] || (/^fr/i.test(String(language)) ? (tmdb['fr-FR'] || tmdb['fr-CA']) : null) || null;
}

/** A catalog item (+ its TMDB copy in `language`, when there is one) in the TMDB details shape the modal reads. */
function catalogDetails(item, blob, category) {
    const card = catalogToCard(item);
    const ext = item.external_ids || {};
    const b = blob || {};
    const date = b.release_date || b.first_air_date || item.release_date || (item.year ? String(item.year) : '');
    const genres = (Array.isArray(b.genres) && b.genres.length) ? b.genres
        : (Array.isArray(item.genres) ? item.genres : []).map(name => ({ name }));
    const base = {
        ...b,
        id: ext.tmdb || b.id || card.id,
        catalog_id: item.catalog_id,
        imdb_id: card.imdb_id || b.imdb_id || null,
        // the catalog's own facts first; the localised overview from the TMDB copy when the UI language has one
        overview: b.overview || item.overview || card.overview,
        vote_average: item.rating || b.vote_average || 0,
        vote_count: item.votes || b.vote_count || 0,
        genres,
        poster: card.poster,
        poster_path: b.poster_path || null,
        backdrop: tmdbImage(b.backdrop_path, 'w1280'),
        runtime: item.runtime_mins || b.runtime || null,
        videos: b.videos || { results: [] },
        credits: (item.raw_enrichment && item.raw_enrichment.tmdb && item.raw_enrichment.tmdb.credits) || null,
        cast_or_credits: Array.isArray(item.cast_or_credits) ? item.cast_or_credits : [],
        source: 'raggae'
    };
    delete base.season_details;
    delete base.fetched_at;
    return category === 'tv'
        ? { ...base, name: b.name || card.title, first_air_date: date, seasons: b.seasons || [],
            external_ids: { imdb_id: base.imdb_id } }
        : { ...base, title: b.title || card.title, release_date: date };
}

/** The TMDB details call (one request): the answer, null when TMDB does not know the title, undefined when it did not
 *  answer (network, 429, 5xx). */
async function fetchTmdbDetails(tmdbId, category, language) {
    if (!TMDB_BEARER_TOKEN || !tmdbId) return null;
    const lang2 = String(language || 'en').slice(0, 2);
    const url = `https://api.themoviedb.org/3/${category}/${tmdbId}?append_to_response=videos,external_ids` +
        `&language=${language}&include_video_language=${lang2},en,null`;
    try {
        const res = await fetchWithTimeout(url, { headers: tmdbHeaders() });
        if (!res.ok) {
            console.warn(`[TMDB] ${category} ${tmdbId} -> HTTP ${res.status}`);
            return (res.status === 429 || res.status >= 500) ? undefined : null;
        }
        return await res.json();
    } catch (e) {
        console.warn(`[TMDB] ${category} ${tmdbId} failed (${e.message})`);
        return undefined;
    }
}

/** A TMDB details answer as a catalog ingest item. Plain fields only fill what the catalog lacks. */
function detailsToIngest(data, slim, category, language, catalogId) {
    const date = category === 'tv' ? data.first_air_date : data.release_date;
    const imdb = data.imdb_id || (data.external_ids && data.external_ids.imdb_id) || null;
    const english = String(language || '').toLowerCase().startsWith('en');
    return {
        ...(catalogId ? { catalog_id: catalogId } : {}),
        category,
        title: category === 'tv' ? (data.name || data.title) : (data.title || data.name),
        original_title: (category === 'tv' ? data.original_name : data.original_title) || null,
        year: date ? parseInt(date.substring(0, 4)) || null : null,
        release_date: date || null,
        runtime_mins: data.runtime || (Array.isArray(data.episode_run_time) && data.episode_run_time[0]) || null,
        rating: data.vote_average ? parseFloat(data.vote_average.toFixed(1)) : null,
        votes: data.vote_count || null,
        genres: english && Array.isArray(data.genres) ? data.genres.map(g => g.name).filter(Boolean) : [],
        poster_url: tmdbImage(data.poster_path),
        // the catalog's overview is language-neutral English (IMDb); only an English answer fills it
        overview: english ? (data.overview || null) : null,
        external_ids: { tmdb: data.id, tmdb_type: category, imdb: imdb },
        raw_enrichment: { tmdb: { [language]: slim } },
        source: 'tmdb'
    };
}

/** Ingest and read the catalog's copy back (with raw_enrichment). Null when the gateway did not store it. */
async function ingestAndReadBack(ingestItem) {
    const res = await raggae.ingest(ingestItem);
    const cid = res && Array.isArray(res.items) && res.items[0] && res.items[0].catalog_id;
    return cid ? raggae.getItem(cid, { raw: true }) : null;
}

/**
 * Details for a movie or series, read through the catalog. Resolves { success, source, data }, null (unknown
 * everywhere) or undefined (TMDB did not answer and nothing is local).
 */
async function readThroughDetails(id, category, language = 'en-US') {
    let item = await findCatalogItem(id, category);
    let blob = tmdbBlob(item, language);
    if (item && blob && isFresh(blob, DETAILS_TTL_MS[category])) {
        return { success: true, source: 'raggae', data: catalogDetails(item, blob, category) };
    }

    // catalog miss (or its TMDB copy is stale): TMDB once, then the catalog's copy
    const ext = (item && item.external_ids) || {};
    // A numeric id is the card's TMDB id: when the catalog item holding it says which TMDB type it is (a TV special
    // stored on a series is a TMDB movie), fetch that type: the same number in the other type is another title
    const numeric = /^\d+$/.test(String(id));
    const storedType = ext.tmdb && (!numeric || Number(ext.tmdb) === Number(id)) ? ext.tmdb_type : null;
    const ref = numeric ? { id: Number(id), type: storedType || category }
        : ext.tmdb ? { id: ext.tmdb, type: storedType || category } : await toTmdbRef(id, category);
    let tmdbId = ref && ref.id;
    let tmdbType = (ref && ref.type) || category;
    let data = tmdbId ? await fetchTmdbDetails(tmdbId, tmdbType, language) : null;
    const imdbOfItem = item && (ext.imdb || (String(item.catalog_id || '').startsWith('imdb:') ? item.catalog_id.slice(5) : null));
    if (data === null && ext.tmdb && !ext.tmdb_type && imdbOfItem) {
        // an id stored before tmdb_type existed may be of the other type: ask TMDB which title the IMDb id is
        // (/find) rather than trusting whatever the same number is in the other type
        // only the same number of the other type is taken: the catalog fills empty keys only, so a different id
        // would leave the old id beside the new id's type
        const found = await toTmdbRef(`imdb:${imdbOfItem}`, category, { remember: false });
        if (found && Number(found.id) === Number(tmdbId) && found.type !== tmdbType) {
            const retry = await fetchTmdbDetails(found.id, found.type, language);
            if (retry) { data = retry; tmdbId = found.id; tmdbType = found.type; }
        }
    }
    if (!data) {
        // TMDB unknown / down: whatever the catalog has (a stale copy included)
        if (item) return { success: true, source: 'raggae', data: catalogDetails(item, blob, category) };
        // undefined: TMDB did not answer (callers must not remember it as "unknown"); null: nobody knows the title
        return tmdbId && data === undefined ? undefined : null;
    }
    const slim = slimDetails(data, tmdbType);
    if (tmdbType !== category) {
        // a TMDB movie read as a catalog series (or the reverse): the renderer reads name or title by category
        slim.name = slim.name || slim.title;
        slim.title = slim.title || slim.name;
    }
    const ingestItem = detailsToIngest(data, slim, tmdbType, language, item && item.catalog_id);
    ingestItem.category = category;
    const saved = await ingestAndReadBack(ingestItem);
    if (saved && tmdbBlob(saved, language)) {
        console.log(`[Catalog] ${category} ${tmdbId}: filled from TMDB, served from the catalog (${saved.catalog_id})`);
        return { success: true, source: 'raggae', data: catalogDetails(saved, tmdbBlob(saved, language), category) };
    }
    console.warn(`[Catalog] ${category} ${tmdbId}: the gateway did not store the TMDB copy; serving it directly`);
    const direct = { ...slim, poster: tmdbImage(slim.poster_path) || PLACEHOLDER_POSTER, source: 'tmdb' };
    delete direct.fetched_at;
    return { success: true, source: 'tmdb', data: direct };
}

/** One season's episodes, read through the catalog (raw_enrichment.tmdb[<language>].season_details[<n>]). */
async function readThroughSeason(id, seasonNumber, language = 'en-US') {
    const n = String(parseInt(seasonNumber, 10));
    if (n === 'NaN') return null;
    let item = await findCatalogItem(id, 'tv');
    if (!item) {
        // the series itself first: it creates the catalog item the season is kept on
        await readThroughDetails(id, 'tv', language);
        item = await findCatalogItem(id, 'tv');
    }
    // the requested language's episodes, else the backfill's English ones (scripts/backfill-catalog.js keeps episodes
    // in en-US only): English episode names rather than another TMDB request
    const seasonIn = lang => { const b = tmdbBlob(item, lang); return b && b.season_details && b.season_details[n]; };
    const cached = seasonIn(language) || (language !== 'en-US' ? seasonIn('en-US') : null);
    if (cached && isFresh(cached, SEASON_TTL_MS)) {
        return { success: true, source: 'raggae', data: { ...cached, season_number: Number(n) } };
    }
    const ext = (item && item.external_ids) || {};
    const tmdbId = /^\d+$/.test(String(id)) ? Number(id) : (ext.tmdb || await toTmdbId(id, 'tv'));
    // a catalog series that TMDB files as a movie (a TV special) has no seasons there
    const notASeries = ext.tmdb_type === 'movie' || (!ext.tmdb && tmdbIdCache.get(`tv:${String(id).replace(/^imdb:/, '')}`)?.type === 'movie');
    if (!tmdbId || !TMDB_BEARER_TOKEN || notASeries) {
        return cached ? { success: true, source: 'raggae', data: { ...cached, season_number: Number(n) } } : null;
    }
    let data = null;
    try {
        const res = await fetchWithTimeout(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${n}?language=${language}`,
            { headers: tmdbHeaders() });
        if (res.ok) data = await res.json();
        else console.warn(`[TMDB] tv ${tmdbId} season ${n} -> HTTP ${res.status}`);
    } catch (e) {
        console.warn(`[TMDB] tv ${tmdbId} season ${n} failed (${e.message})`);
    }
    if (!data) return cached ? { success: true, source: 'raggae', data: { ...cached, season_number: Number(n) } } : null;
    const slim = slimSeason(data);
    if (item) {
        const saved = await ingestAndReadBack({
            catalog_id: item.catalog_id, category: 'tv', title: item.title, source: 'tmdb',
            external_ids: { tmdb: tmdbId },
            raw_enrichment: { tmdb: { [language]: { season_details: { [n]: slim } } } }
        });
        const back = saved && tmdbBlob(saved, language) && (tmdbBlob(saved, language).season_details || {})[n];
        if (back) return { success: true, source: 'raggae', data: { ...back, season_number: Number(n) } };
    }
    return { success: true, source: 'tmdb', data: { ...slim, season_number: Number(n) } };
}

/** A resolved trailer key onto the catalog item (raw_enrichment.trailer[<language>]); fire and forget. */
function ingestTrailerKey(item, language, key, provider) {
    if (!item || !item.catalog_id || !key) return;
    ingestOutside({
        catalog_id: item.catalog_id, category: item.category, title: item.title, source: 'tmdb',
        raw_enrichment: { trailer: { [language]: { youtube_id: key, provider, resolved_at: new Date().toISOString() } } }
    });
}

// ── Discover / trending from the catalog's lists ─────────────────────────────
// scripts/ingest-front-page.js copies TMDB's trending and per-provider discover pages into the catalog (items +
// ordered lists) on a schedule; these handlers only read the lists. List keys are shared with that script.
const listKeys = require('./front-page-keys');

/** Filter codes of the Discover genre <select> -> the catalog's (IMDb) genre names. Codes with no catalog genre
 *  (curated picks such as "Jodorowsky") are not filtered. */
const GENRE_CODES = {
    // the Discover dropdown (js/tmdb.js MOVIE_GENRES / TV_GENRES) sends TMDB genre ids; the catalog holds IMDb names.
    // `any`: one of them is enough ("Action & Adventure"); `all`: every one is needed.
    28: { any: ['Action'] }, 12: { any: ['Adventure'] }, 16: { any: ['Animation'] }, 35: { any: ['Comedy'] },
    80: { any: ['Crime'] }, 99: { any: ['Documentary'] }, 18: { any: ['Drama'] }, 10751: { any: ['Family'] },
    14: { any: ['Fantasy'] }, 36: { any: ['History'] }, 27: { any: ['Horror'] }, 10402: { any: ['Music', 'Musical'] },
    9648: { any: ['Mystery'] }, 10749: { any: ['Romance'] }, 878: { any: ['Sci-Fi'] }, 53: { any: ['Thriller'] },
    10752: { any: ['War'] }, 37: { any: ['Western'] },
    10759: { any: ['Action', 'Adventure'] }, 10762: { any: ['Family', 'Animation'] }, 10763: { any: ['News'] },
    10764: { any: ['Reality-TV'] }, 10765: { any: ['Sci-Fi', 'Fantasy'] }, 10766: { any: ['Drama'] },
    10767: { any: ['Talk-Show'] }, 10768: { any: ['War'] },
    // the abbreviations of the static markup in index.html (replaced by the ids above once the dropdown is built)
    wes: { any: ['Western'] }, bio: { any: ['Biography'] }, doc: { any: ['Documentary'] }, dra: { any: ['Drama'] },
    com: { any: ['Comedy'] }, rom: { any: ['Romance'] }, hor: { any: ['Horror'] }, cri: { any: ['Crime'] },
    thr: { any: ['Thriller'] }, noi: { any: ['Film-Noir'] }, tru: { all: ['Crime', 'Documentary'] },
    car: { any: ['Animation'] }, kid: { any: ['Family'] }, adv: { any: ['Adventure'] }, nat: { any: ['Documentary'] }
};
// TMDB's "TV Movie" (10770) and the curated picks (Jodorowsky…) have no catalog genre: not filtered.

function genreSpec(withGenres) {
    if (!withGenres || withGenres === 'all') return null;
    return GENRE_CODES[String(withGenres)] || null;
}

function decadeRange(decade) {
    if (!decade || decade === 'all') return null;
    const start = parseInt(decade, 10);
    if (!Number.isFinite(start)) return null;
    return start === 1920 ? { min: 0, max: 1929 } : { min: start, max: start + 9 };
}

/** Released by today (UTC): a full release date when the catalog has one, else the year. */
function isReleased(item, todayIso) {
    if (item.release_date && /^\d{4}-\d{2}-\d{2}/.test(item.release_date)) return item.release_date.slice(0, 10) <= todayIso;
    return !item.year || item.year <= parseInt(todayIso.slice(0, 4), 10);
}

function listItemMatches(item, { genreNames, range, origin }) {
    if (genreNames) {
        const g = Array.isArray(item.genres) ? item.genres : [];
        if (genreNames.any && !genreNames.any.some(name => g.includes(name))) return false;
        if (genreNames.all && !genreNames.all.every(name => g.includes(name))) return false;
    }
    if (range && !(item.year && item.year >= range.min && item.year <= range.max)) return false;
    if (origin) {
        const meta = item.raw_enrichment && item.raw_enrichment.tmdb && item.raw_enrichment.tmdb.meta;
        const countries = (meta && meta.origin_country) || [];
        if (!countries.includes(origin)) return false;
    }
    return true;
}

const PAGE_SIZE = 20;
const listCache = new Map(); // key -> { ts, items }
const browseCache = new Map(); // filtered catalog browse (slow on the gateway) -> { ts, results }
const LIST_CACHE_MS = 10 * 60 * 1000;

async function cachedList(key) {
    const hit = listCache.get(key);
    if (hit && Date.now() - hit.ts < LIST_CACHE_MS) return hit.items;
    const out = await raggae.getList(key, { limit: 500, raw: true });
    const items = (out && Array.isArray(out.items)) ? out.items : null;
    if (items && items.length) listCache.set(key, { ts: Date.now(), items });
    return items && items.length ? items : null;
}

/**
 * One Discover page from the catalog. Provider rows come from the stored lists, filtered locally; "All providers"
 * with filters is a catalog browse (genre, decade, rating / year / votes).
 */
async function discoverFromCatalog({ providerId, mediaType, page = 1, language = 'en-US', withGenres, decade, region, sort, watchRegion }) {
    const category = mediaType === 'tv' ? 'tv' : 'movie';
    page = Math.max(1, parseInt(page, 10) || 1);
    const genreNames = genreSpec(withGenres);
    const bySort = sort && /release_date|air_date/.test(sort);
    const todayIso = new Date().toISOString().slice(0, 10);
    const range = decadeRange(decade);
    const origin = region && region !== 'all' ? String(region).toUpperCase() : null;
    const filtered = !!(genreNames || range || origin);
    const provider = providerId && providerId !== 'all' ? String(providerId) : 'all';
    const wr = (watchRegion || await geoWatchRegion() || DEFAULT_WATCH_REGION).toUpperCase();

    let items = await cachedList(listKeys.discover(category, provider, wr));
    if (!items && wr !== DEFAULT_WATCH_REGION) items = await cachedList(listKeys.discover(category, provider, DEFAULT_WATCH_REGION));

    if (items && (provider !== 'all' || !filtered || origin)) {
        // the stored lists come from TMDB's pages; a title the catalog has no poster for yet is left out
        let rows = items.filter(it => listItemMatches(it, { genreNames, range, origin }) && hasPoster(catalogToCard(it, language)));
        if (sort && sort.startsWith('vote_average')) rows = [...rows].sort((a, b) => (b.rating || 0) - (a.rating || 0));
        else if (bySort) {
            // newest first, but nothing not yet released (the lists are popularity pages and hold upcoming titles)
            rows = rows.filter(it => isReleased(it, todayIso))
                .sort((a, b) => String(b.release_date || b.year || '').localeCompare(String(a.release_date || a.year || '')));
        }
        const results = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(it => catalogToCard(it, language));
        return { success: true, source: 'raggae', list: true, results };
    }

    // A provider or an origin country is only known from the stored lists: without one, say so rather than show
    // titles that do not match the selection
    if (provider !== 'all' || origin) {
        return { success: true, source: 'raggae', list: false, results: [], missingList: true };
    }

    // "All providers" with filters, or no list stored yet: the catalog's own browse
    const browseSort = sort && sort.startsWith('vote_average') ? 'rating' : (sort && /release_date|air_date/.test(sort) ? 'year' : 'votes');
    const browseKey = JSON.stringify([category, browseSort, page, language, genreNames, range]);
    const hit = browseCache.get(browseKey);
    if (hit && Date.now() - hit.ts < LIST_CACHE_MS) return { success: true, source: 'raggae', list: false, results: hit.results };
    let results = await filteredPage(JSON.stringify([category, browseSort, language, genreNames, range]), page, PAGE_SIZE,
        (offset, limit) => raggae.browse({
            category, sort: browseSort, limit, offset,
            // every sort keeps to the backfill's floor (src/catalog-coverage.js: films 600, series 1,000 votes):
            // below it titles have no poster, and a rating or newest-first sort over every title is all obscure
            // entries (operator, Fri 20 Nov 2026: 600 / 1,000 rather than the earlier 5,000 for those sorts)
            minVotes: minVotesFor(category),
            genre: genreNames ? genreNames[0] : undefined,
            yearMin: range ? range.min || undefined : undefined,
            yearMax: range ? range.max : (browseSort === 'year' ? new Date().getUTCFullYear() : undefined)
        }),
        it => {
            if (!listItemMatches(it, { genreNames, range: null, origin: null }) || (bySort && !isReleased(it, todayIso))) return null;
            const card = catalogToCard(it, language);
            return hasPoster(card) ? card : null;
        });
    results = await localizeCards(results, language);
    if (results.length) browseCache.set(browseKey, { ts: Date.now(), results });
    if (browseCache.size > 200) browseCache.delete(browseCache.keys().next().value);
    return { success: true, source: 'raggae', list: false, results };
}

/** The trending row (no query): the stored trending list, else the catalog's most voted. */
async function trendingFromCatalog(page = 1, language = 'en-US') {
    page = Math.max(1, parseInt(page, 10) || 1);
    const items = await cachedList(listKeys.trending());
    if (items) {
        const shown = items.map(it => catalogToCard(it, language)).filter(hasPoster);
        return { success: true, source: 'raggae', results: shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) };
    }
    return { success: true, source: 'raggae', results: await localPopular(page, language) };
}

/** TMDB search hits the catalog already holds (by TMDB id) are served as the catalog's cards. */
async function preferCatalogCards(outside, language = 'en-US') {
    return Promise.all(outside.map(async card => {
        if (card.source !== 'tmdb' || !/^\d+$/.test(String(card.id))) return card;
        const item = await raggae.byExternal('tmdb', card.media_type === 'tv' ? 'tv' : 'movie', card.id, { raw: language !== 'en-US' });
        if (!item) return card;
        const local = catalogToCard(item, language);
        // a catalog item with no poster yet keeps the TMDB card's
        if (local.poster === PLACEHOLDER_POSTER && card.poster !== PLACEHOLDER_POSTER) local.poster = card.poster;
        return { ...local, id: card.id };
    }));
}

const localSearchCache = new Map();

/** Local hits for a query, kept for the following pages of the same search (at most 50 queries). */
async function localHitsFor(query, language = 'en-US') {
    const key = `${language}:${query.toLowerCase()}`;
    if (localSearchCache.has(key)) return localSearchCache.get(key);
    const hits = await searchLocalCatalog(query, { limit: 20, language });
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
                const hits = await localHitsFor(query, language);
                // local hits with a poster lead; the ones without come last on page 1, after TMDB's (which may have
                // the same title with a poster: that one is shown instead)
                const local = hits.filter(hasPoster);
                const bare = hits.filter(c => !hasPoster(c));
                const withBare = list => {
                    const shown = new Set(list.map(c => c.imdb_id).filter(Boolean));
                    const keys = new Set(list.map(c => `${raggae._norm(c.title)}|${c.year}`));
                    return [...list, ...bare.filter(c => !(c.imdb_id && shown.has(c.imdb_id)) && !keys.has(`${raggae._norm(c.title)}|${c.year}`))];
                };
                const enough = localIsEnough(local);
                if (page === 1 && enough) {
                    console.log(`[Search] ${local.length} local catalog hits for "${query}" (+${bare.length} without a poster)`);
                    return { success: true, source: 'raggae', results: withBare(local) };
                }
                const outsidePage = enough ? page - 1 : page;
                let outside = await preferCatalogCards(await searchTmdbApi(query, outsidePage, language), language);
                let source = 'tmdb';
                if (!outside.length) {
                    outside = await searchOmdbApi(query, outsidePage);
                    source = 'omdb';
                }
                const merged = mergeAfterLocal(local, outside);
                // later pages leave out every local hit, the posterless ones page 1 showed included
                const results = page === 1 ? withBare(merged) : mergeAfterLocal(hits, outside).slice(hits.length);
                console.log(`[Search] "${query}" page ${page}: ${page === 1 ? local.length : 0} local + ${results.length - (page === 1 ? local.length : 0)} from ${source}`);
                return { success: true, source: page === 1 && local.length ? `raggae+${source}` : source, results };
            }

            // No query: the trending row, from the catalog (scripts/ingest-front-page.js keeps it current)
            return await trendingFromCatalog(page, language);
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

            // Read through the catalog: served from it, TMDB asked only to fill it
            const result = await readThroughDetails(id, 'movie', language);
            if (result) return result;
            throw new Error('not in the catalog and TMDB has nothing');
        } catch (e) {
            console.error('[TMDB] get-tmdb-movie failed:', e.message);
            return { success: false, error: e.message };
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

            const result = await readThroughDetails(id, 'tv', language);
            if (result) return result;
            throw new Error('not in the catalog and TMDB has nothing');
        } catch (e) {
            console.error('[TMDB] get-tmdb-tv failed:', e.message);
            return { success: false, error: e.message };
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

            const result = await readThroughSeason(id, seasonNumber, language);
            if (result) return result;
            throw new Error('season not in the catalog and TMDB has nothing');
        } catch (e) {
            console.error('[TMDB] get-tmdb-tv-season failed:', e.message);
            return { success: false, error: e.message };
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

    // ── Trailer key (KinoCheck, then the catalog's TMDB videos), remembered by src/trailers.js ──
    ipcMain.handle('get-kinocheck-trailer', async (event, { tmdbId, mediaType, language } = {}) => {
        try {
            return await trailers.resolveKey({ id: tmdbId, mediaType, language });
        } catch (err) {
            console.error('[Trailer] key lookup failed:', err);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('discover-tmdb', async (event, { providerId, mediaType, page = 1, language = 'en-US', withGenres, decade, region, sort, watchRegion }) => {
        try {
            // From the catalog's front-page lists (scripts/ingest-front-page.js), never live TMDB
            return await discoverFromCatalog({ providerId, mediaType, page, language, withGenres, decade, region, sort, watchRegion });
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

// the trailer module asks these (it is required above, so hand them over instead of a circular require)
trailers.configure({ readThroughDetails, fetchKinoCheckTrailer, findCatalogItem, ingestTrailerKey });

module.exports = {
    registerTmdbHandlers,
    readThroughDetails,
    readThroughSeason,
    findCatalogItem,
    // for tests/test_raggae_integration.js
    _internals: { catalogToCard, localIsEnough, mergeAfterLocal, redact, toTmdbId, toTmdbRef, localSearchCache, tmdbIdCache,
                  slimDetails, slimSeason, slimCredits, slimPerson, catalogDetails, listItemMatches, GENRE_CODES, genreSpec, isReleased, decadeRange, discoverFromCatalog,
                  trendingFromCatalog, detailsToIngest, tmdbImage }
};
