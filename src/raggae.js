// src/raggae.js — Client for the vault-raggae gateway (http://127.0.0.1:8750): the local catalog first.
//   POST /v1/resolve            a title / file name / path -> the best catalog match
//   GET  /v1/catalog/search     full-text search (one category at a time)
//   GET  /v1/catalog/{id}       one item (e.g. imdb:tt0133093)
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
async function call(method, route, { body, timeoutMs = DEFAULT_TIMEOUT_MS, quiet404 = false } = {}) {
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
        markOffline(err);
        return null;
    } finally {
        clearTimeout(timer);
    }
    markOnline();
    if (!res.ok) {
        if (!(quiet404 && res.status === 404)) {
            console.warn(`[raggae] ${method} ${route.split('?')[0]} -> HTTP ${res.status}`);
        }
        return null;
    }
    try {
        return await res.json();
    } catch (_) {
        return null;
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

/** One catalog item by id (`imdb:tt…`, `tmdb:movie:…`), or null. */
async function getItem(catalogId) {
    if (!catalogId) return null;
    return call('GET', `/v1/catalog/${encodeURIComponent(catalogId).replace(/%3A/gi, ':')}`, { quiet404: true });
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
async function browse({ category = 'movie', sort = 'votes', limit = 20, offset = 0, minVotes } = {}) {
    let route = `/v1/catalog/browse?category=${category}&sort=${sort}&limit=${limit}&offset=${offset}`;
    if (minVotes) route += `&min_votes=${minVotes}`;
    const data = await call('GET', route);
    return Array.isArray(data && data.items) ? data.items : [];
}

/**
 * Outside metadata into the catalog (POST /v1/catalog/ingest). New items are added; a known one (same catalog id,
 * e.g. imdb:tt…) only gets its empty fields filled. Fire and forget: resolves the gateway's answer or null.
 */
async function ingest(items) {
    const list = (Array.isArray(items) ? items : [items]).filter(i => i && i.title && i.category);
    if (!list.length) return null;
    return call('POST', '/v1/catalog/ingest', { body: { items: list.slice(0, 100) } });
}

/**
 * The poster to show for a catalog item: its own URL when it has one (an https URL works in the Electron window
 * and for web-mode clients alike), else the gateway's cached copy (local only: a web-mode client cannot reach
 * 127.0.0.1:8750), else null.
 */
function posterFor(item) {
    if (!item) return null;
    if (item.poster_url && /^https?:\/\//.test(item.poster_url)) return item.poster_url;
    if (item.poster_local_path && item.catalog_id) return `${RAGGAE_URL}/v1/artwork/${item.catalog_id}`;
    return null;
}

module.exports = {
    RAGGAE_URL,
    health,
    resolve,
    byPath,
    getItem,
    search,
    searchTitles,
    browse,
    ingest,
    posterFor,
    isOffline,
    markOnline,
    markOffline,
    _norm: norm,
};
