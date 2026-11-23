// src/raggae.js — Client for the vault-raggae gateway (http://127.0.0.1:8750): the local catalog first.
//   POST /v1/resolve            a title / file name / path -> the best catalog match
//   GET  /v1/catalog/search     full-text search (one category at a time)
//   GET  /v1/catalog/{id}       one item (e.g. imdb:tt0133093); ?raw=true adds raw_enrichment (TMDB extras)
//   GET  /v1/catalog/xref/tmdb/{movie|tv}/{id}   the item carrying a TMDB id
//   GET  /v1/catalog/search?mode=hybrid  the Ask bar: words + meaning, with year / genre / vote filters
//   GET  /v1/catalog/similar/{id} "more like this": nearest titles by the item's own stored vector
//   POST /v1/moments/stream     queue the Moments + transcript of a stream being played (loopback only)
//   GET  /v1/catalog/lists/{key} an ordered list (the Discover front page); POST replaces it (loopback only)
//   GET  /v1/catalog/browse     a sorted page of a category (the offline "popular" list)
//   POST /v1/catalog/ingest     outside metadata in: new items added, known ones only filled (loopback only)
//   GET  /v1/media/by-path      the media index's view of a local file
//   GET  /v1/artwork/{id}       a catalog item's cached poster
//
// Every request carries X-VW-Project so the gateway's stats attribute it. The circuit breaker trips on a network
// failure only (gateway down, timeout): an HTTP error is an answer about one request, not a reason to send every
// search to TMDB for 30 s.

const RAGGAE_URL = process.env.RAGGAE_URL || 'http://127.0.0.1:8750';
const PROJECT = 'vault-streaming';
const DEFAULT_TIMEOUT_MS = 6000;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30000;
const TITLE_CATEGORIES = ['movie', 'tv'];

let raggaeOfflineUntil = 0;

function isOffline() {
    return Date.now() < raggaeOfflineUntil;
}

function markOffline(err) {
    raggaeOfflineUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
    console.warn(`[raggae] Gateway unreachable (${err && err.message}); local catalog skipped for ${CIRCUIT_BREAKER_COOLDOWN_MS / 1000} s`);
}

function markOnline() {
    raggaeOfflineUntil = 0;
}

/** One request. Resolves the parsed JSON, or null for an HTTP error (logged, breaker untouched) or when the gateway
 *  is known to be down; a network failure trips the breaker and resolves null. */
async function call(method, route, { body, timeoutMs = DEFAULT_TIMEOUT_MS, quiet404 = false, tripOnTimeout = true } = {}) {
    if (isOffline()) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
        res = await fetch(`${RAGGAE_URL}${route}`, {
            method,
            headers: { 'X-VW-Project': PROJECT, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
    } catch (err) {
        // a known-slow call (a filtered browse: 14 s, Wed 18 Nov 2026) timing out says nothing about the gateway
        if (!tripOnTimeout && err && err.name === 'AbortError') {
            console.warn(`[raggae] ${method} ${route.split('?')[0]} timed out after ${timeoutMs / 1000} s`);
            return null;
        }
        clearTimeout(timer);
        markOffline(err);
        return null;
    }
    markOnline();
    if (!res.ok) {
        clearTimeout(timer);
        if (!(quiet404 && res.status === 404)) {
            console.warn(`[raggae] ${method} ${route.split('?')[0]} -> HTTP ${res.status}`);
        }
        return null;
    }
    // the deadline covers the body too: headers then a stalled body must not hold a caller (the quit-time pause)
    try {
        return await res.json();
    } catch (_) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function health() {
    const data = await call('GET', '/health', { timeoutMs: 3000 });
    return data ? { available: true, data } : { available: false, offline: isOffline() };
}

/**
 * Resolve a title, file name or path against the catalog (POST /v1/resolve).
 * @param {object|string} params - { name, path, filePaths, categoryHint }
 */
async function resolve(params = {}) {
    const p = typeof params === 'string' ? { name: params } : (params || {});
    if (!p.name && !p.path) return null;
    return call('POST', '/v1/resolve', {
        body: { name: p.name || '', path: p.path, file_paths: Array.isArray(p.filePaths) ? p.filePaths : [],
                category_hint: p.categoryHint || '' },
    });
}

/** The media index's view of a local file, or null (404: not indexed). */
async function byPath(filePath) {
    if (!filePath || typeof filePath !== 'string') return null;
    return call('GET', `/v1/media/by-path?path=${encodeURIComponent(filePath)}`, { quiet404: true });
}

/** One catalog item by id (`imdb:tt…`, `tmdb:movie:…`), or null. `raw` adds its raw_enrichment (TMDB extras). */
async function getItem(catalogId, { raw = false } = {}) {
    if (!catalogId) return null;
    return call('GET', `/v1/catalog/${encodeURIComponent(catalogId).replace(/%3A/gi, ':')}${raw ? '?raw=true' : ''}`,
        { quiet404: true });
}

/** The item carrying an outside id (`byExternal('tmdb', 'movie', 603)`), or null. */
async function byExternal(source, category, extId, { raw = false } = {}) {
    if (!source || !category || extId === null || extId === undefined || extId === '') return null;
    return call('GET', `/v1/catalog/xref/${encodeURIComponent(source)}/${encodeURIComponent(category)}/` +
        `${encodeURIComponent(String(extId))}${raw ? '?raw=true' : ''}`, { quiet404: true });
}

/**
 * "More like this" (GET /v1/catalog/similar/{id}): the titles nearest to one catalog item by meaning, same kind by
 * default. `minVotes` keeps obscure entries out (without it, neighbours lean on title words: The Matrix ->
 * "Matrix Zone"). Resolves the result list, [] when the item has no vector or on any failure. 30 s: a title's first
 * call can take 6-20 s while the gateway is busy (the row fills in late rather than not at all).
 */
async function similar(catalogId, { category, k = 12, minVotes = 5000, timeoutMs = 30000 } = {}) {
    if (!catalogId) return [];
    let route = `/v1/catalog/similar/${encodeURIComponent(catalogId).replace(/%3A/gi, ':')}?k=${k}`;
    if (category) route += `&category=${encodeURIComponent(category)}`;
    if (minVotes) route += `&min_votes=${minVotes}`;
    const data = await call('GET', route, { quiet404: true, timeoutMs, tripOnTimeout: false });
    return Array.isArray(data && data.results) ? data.results : [];
}

/**
 * "More like this" for a title the app shows: its catalog item (the card's own `catalogId` when it has one, else
 * the item carrying its TMDB id, else its IMDb id as a last guess), then that item's nearest titles of its own kind.
 * Resolves raw catalog items (the source left out), [] when the gateway has nothing.
 */
async function similarTo({ catalogId, mediaType, tmdbId, imdbId, k = 12, minVotes } = {}) {
    const category = mediaType === 'tv' ? 'tv' : 'movie';
    let id = catalogId || null;
    if (!id && tmdbId && /^\d+$/.test(String(tmdbId))) {
        const item = await byExternal('tmdb', category, tmdbId);
        id = item && item.catalog_id;
    }
    if (!id && imdbId && /^tt\d+$/.test(imdbId)) id = `imdb:${imdbId}`;
    if (!id) return [];
    // series gather fewer votes than films: the same floor would leave most of them out
    const floor = minVotes !== undefined ? minVotes : (category === 'tv' ? 2000 : 5000);
    const results = await similar(id, { k, minVotes: floor });   // the item's own kind (the gateway's default)
    return results.filter(r => r && r.catalog_id && r.catalog_id !== id);
}

/**
 * The Ask bar (js/streaming/ask.js parses the sentence): `look` is searched by words and meaning together
 * (GET /v1/catalog/search?mode=hybrid), the named year / genres filter it; with no `look`, the filters alone list the
 * most voted titles (GET /v1/catalog/browse). Known titles only: most of the catalog is obscure, undated entries.
 * The default floors (films 1,250 votes, series 250) keep each kind's set under the 60k titles the gateway scans
 * exactly by meaning (vault-raggae 0.40.0); a lower floor falls back to its ANN index, which finds far fewer.
 * Resolves the catalog items in rank order, or null when the gateway did not answer.
 */
async function ask({ look = '', mediaType = 'movie', yearMin, yearMax, genres = [], minVotes, limit = 60,
                     timeoutMs = 30000 } = {}) {
    const category = mediaType === 'tv' ? 'tv' : 'movie';
    if (minVotes === undefined) minVotes = category === 'tv' ? 250 : 1250;
    const qs = new URLSearchParams({ category, limit: String(Math.max(1, Math.min(limit, 100))) });
    if (yearMin !== undefined && yearMin !== null) qs.set('year_min', String(yearMin));
    if (yearMax !== undefined && yearMax !== null) qs.set('year_max', String(yearMax));
    if (Array.isArray(genres) && genres.length) qs.set('genre', genres.join(','));   // every genre named
    if (minVotes) qs.set('min_votes', String(minVotes));
    let items;
    if (look && String(look).trim()) {
        qs.set('q', String(look).trim());
        qs.set('mode', 'hybrid');
        const data = await call('GET', `/v1/catalog/search?${qs}`, { timeoutMs, tripOnTimeout: false });
        items = data && data.results;
    } else {
        qs.set('sort', 'votes');
        const data = await call('GET', `/v1/catalog/browse?${qs}`, { timeoutMs, tripOnTimeout: false });
        items = data && data.items;
    }
    if (!Array.isArray(items)) return null;
    // the gateway filters (0.33.0+); an older one ignores the filters, so check again
    return items.filter(it => it && it.catalog_id
        && (yearMin == null || (it.year || 0) >= yearMin)
        && (yearMax == null || (it.year || 9999) <= yearMax)
        && (genres || []).every(g => (it.genres || []).includes(g)));
}

/** One ordered list (the Discover front page): { key, total, updated_at, items } or null. */
async function getList(key, { limit = 100, offset = 0, raw = false } = {}) {
    if (!key) return null;
    return call('GET', `/v1/catalog/lists/${encodeURIComponent(key).replace(/%3A/gi, ':')}?limit=${limit}&offset=${offset}` +
        (raw ? '&raw=true' : ''), { timeoutMs: 15000 });
}

/** Replace one ordered list (loopback only). Resolves { key, count } or null. */
async function setList(key, catalogIds) {
    if (!key || !Array.isArray(catalogIds)) return null;
    return call('POST', `/v1/catalog/lists/${encodeURIComponent(key).replace(/%3A/gi, ':')}`,
        { body: { catalog_ids: catalogIds.slice(0, 1000) } });
}

/** Queue the Moments + transcript of a stream being played (POST /v1/moments/stream, loopback only): resolves
 *  { key, state: 'queued' | 'running' | 'done', position? } or null. */
async function queueStream(job) {
    if (!job || !job.key || !job.url) return null;
    return call('POST', '/v1/moments/stream', { body: job, timeoutMs: 10000, tripOnTimeout: false });
}

/** Pause every Moments stream read (the app is closing): each keeps a checkpoint. { running, paused } or null. */
async function pauseStreams({ timeoutMs = 2500 } = {}) {
    return call('POST', '/v1/moments/stream/pause', { body: {}, timeoutMs, tripOnTimeout: false });
}

/** Resume the paused Moments stream reads from their checkpoints (the app started). { resumed, waiting_for_play }. */
async function resumeStreams() {
    return call('POST', '/v1/moments/stream/resume', { body: {}, timeoutMs: 10000, tripOnTimeout: false });
}

/** The Moments job of a played stream (GET /v1/moments/stream/{key}): { state: 'queued' | 'starting' | 'reading' |
 *  'done' | 'failed', read_s?, duration?, transcript? } or null (no job yet / gateway down). */
/** Moments of one video (a stream key, stream:imdb:tt…[:sNNeNN]): GET /v1/moments/search?video=. What is said, seen
 *  and heard, fused; each hit has t0 / t1 (seconds) and said. Resolves [] on any failure. */
async function momentsSearch(q, video, { mode = 'all', k = 6, timeoutMs = 20000 } = {}) {
    if (!q || !video) return [];
    const data = await call('GET', `/v1/moments/search?q=${encodeURIComponent(q)}&mode=${mode}&k=${k}` +
        `&video=${encodeURIComponent(video)}`, { timeoutMs, tripOnTimeout: false });
    return Array.isArray(data && data.hits) ? data.hits : [];
}

async function streamStatus(key) {
    if (!key) return null;
    return call('GET', `/v1/moments/stream/${encodeURIComponent(key)}`, { quiet404: true, tripOnTimeout: false });
}

/** The transcripts store's subtitle files for a path — a library video, or a stream's key (stream:imdb:tt…) — each
 *  with its cue_list ({ idx, start_ms, end_ms, text }) and language (GET /v1/transcripts/by-path); [] when none. */
async function transcriptsByPath(p) {
    if (!p) return [];
    const data = await call('GET', `/v1/transcripts/by-path?path=${encodeURIComponent(p)}`,
        { quiet404: true, timeoutMs: 15000, tripOnTimeout: false });
    return (data && Array.isArray(data.files)) ? data.files : [];
}

/**
 * Full-text search (GET /v1/catalog/search) in one category; resolves the hit list ([] on any failure).
 * @param {object} options - { category, year, mode, limit }
 */
async function search(query, options = {}) {
    if (!query) return [];
    let route = `/v1/catalog/search?q=${encodeURIComponent(query)}&limit=${options.limit || 20}&mode=${options.mode || 'fts'}`;
    if (options.category) route += `&category=${encodeURIComponent(options.category)}`;
    if (options.year) route += `&year=${encodeURIComponent(options.year)}`;
    const data = await call('GET', route);
    return Array.isArray(data && data.results) ? data.results : [];
}

function norm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Films and series only (the catalog also holds 4.5 M music items, books and adult scenes), ranked for a person
 * searching a title: exact title matches first, then the most voted (FTS order alone put "Rifftrax: The Matrix"
 * above The Matrix). Resolves at most `limit` items.
 */
async function searchTitles(query, { limit = 20 } = {}) {
    const lists = await Promise.all(TITLE_CATEGORIES.map(category => search(query, { category, limit: 40 })));
    const q = norm(query);
    const seen = new Set();
    const hits = [];
    for (const item of lists.flat()) {
        if (!item || seen.has(item.catalog_id)) continue;
        seen.add(item.catalog_id);
        hits.push(item);
    }
    // the title itself first; the original title only for a known film (a foreign one searched by its own name):
    // "Rifftrax: The Matrix" (28 votes) has "The Matrix" as original title
    const exact = item => (norm(item.title) === q ? 2
        : norm(item.original_title) === q && (item.votes || 0) >= 1000 ? 1 : 0);
    hits.sort((a, b) => exact(b) - exact(a) || (b.votes || 0) - (a.votes || 0));
    return hits.slice(0, limit);
}

/** A sorted page of one category (GET /v1/catalog/browse): the "popular" list when TMDB is not available. */
async function browse({ category = 'movie', sort = 'votes', limit = 20, offset = 0, minVotes, genre, yearMin, yearMax, nullOnError = false, timeoutMs = 30000 } = {}) {
    let route = `/v1/catalog/browse?category=${category}&sort=${sort}&limit=${limit}&offset=${offset}`;
    if (minVotes) route += `&min_votes=${minVotes}`;
    if (genre) route += `&genre=${encodeURIComponent(genre)}`;
    if (yearMin) route += `&year_min=${yearMin}`;
    if (yearMax) route += `&year_max=${yearMax}`;
    const data = await call('GET', route, { timeoutMs, tripOnTimeout: false });
    if (Array.isArray(data && data.items)) return data.items;
    // a failed page is not an empty one: callers that page through everything must be able to tell
    return nullOnError ? null : [];
}

/**
 * Outside metadata into the catalog (POST /v1/catalog/ingest). New items are added; a known one (same catalog id,
 * e.g. imdb:tt…) only gets its empty fields filled. Fire and forget: resolves the gateway's answer or null.
 */
async function ingest(items, { timeoutMs, tripOnTimeout = true } = {}) {
    const list = (Array.isArray(items) ? items : [items]).filter(i => i && i.title && i.category);
    if (!list.length) return null;
    // a batch carrying TMDB extras (seasons, episodes) can take the gateway well over the default 6 s to store
    return call('POST', '/v1/catalog/ingest', { body: { items: list.slice(0, 100) }, timeoutMs, tripOnTimeout });
}

/**
 * The poster to show for a catalog item, local copies first (operator, Mon 23 Nov 2026): the gateway's own artwork
 * when the item has one, else its poster URL, which is never loaded from TMDB as is: the window redirects it to the
 * gateway's kept copy and web / iOS clients get it through web/server.js (src/image-links.js). Else null.
 */
function posterFor(item) {
    if (!item) return null;
    if (item.poster_local_path && item.catalog_id) return `${RAGGAE_URL}/v1/artwork/${item.catalog_id}`;
    if (item.poster_url && /^https?:\/\//.test(item.poster_url)) return item.poster_url;
    return null;
}

module.exports = {
    RAGGAE_URL,
    health,
    resolve,
    byPath,
    getItem,
    byExternal,
    getList,
    setList,
    queueStream,
    streamStatus,
    momentsSearch,
    transcriptsByPath,
    pauseStreams,
    resumeStreams,
    search,
    searchTitles,
    browse,
    similar,
    similarTo,
    ask,
    ingest,
    posterFor,
    isOffline,
    markOnline,
    markOffline,
    _norm: norm,
};
