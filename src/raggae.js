// src/raggae.js — Client for vault-raggae gateway (http://127.0.0.1:8750)
// Provides catalog resolution (/v1/resolve), catalog search (/v1/catalog/search),
// media index lookups (/v1/media/by-path), and poster routing (/v1/img).

const RAGGAE_URL = process.env.RAGGAE_URL || 'http://127.0.0.1:8750';
const DEFAULT_TIMEOUT_MS = 6000;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30000;

let raggaeOfflineUntil = 0;
let lastKnownHealth = null;

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
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

function isOffline() {
    return Date.now() < raggaeOfflineUntil;
}

function markOffline(err) {
    raggaeOfflineUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
    console.warn(`[raggae] Gateway unreachable (${err.message}). Circuit breaker active until ${new Date(raggaeOfflineUntil).toLocaleTimeString()}`);
}

function markOnline() {
    raggaeOfflineUntil = 0;
}

/**
 * Health check on vault-raggae gateway.
 */
async function health() {
    if (isOffline()) return { available: false, offline: true };
    try {
        const res = await fetchWithTimeout(`${RAGGAE_URL}/health`, { method: 'GET' }, 3000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        markOnline();
        lastKnownHealth = { available: true, data };
        return lastKnownHealth;
    } catch (err) {
        markOffline(err);
        return { available: false, error: err.message };
    }
}

/**
 * Resolve a media title, filename, or file path against vault-raggae catalog.
 * POST /v1/resolve
 * @param {object} params - { name, path, filePaths, categoryHint, project }
 */
async function resolve(params = {}) {
    if (isOffline()) return null;
    const name = typeof params === 'string' ? params : (params.name || '');
    const path = typeof params === 'object' ? params.path : undefined;
    const filePaths = (typeof params === 'object' && Array.isArray(params.filePaths)) ? params.filePaths : [];
    const categoryHint = (typeof params === 'object' && params.categoryHint) ? params.categoryHint : '';
    const project = (typeof params === 'object' && params.project) ? params.project : 'vault-streaming';

    if (!name && !path) return null;

    try {
        const res = await fetchWithTimeout(`${RAGGAE_URL}/v1/resolve`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-VW-Project': project
            },
            body: JSON.stringify({
                name,
                path,
                file_paths: filePaths,
                category_hint: categoryHint,
                project
            })
        });

        if (!res.ok) {
            console.warn(`[raggae:resolve] Failed with HTTP ${res.status}`);
            return null;
        }

        markOnline();
        return await res.json();
    } catch (err) {
        markOffline(err);
        return null;
    }
}

/**
 * Query media record and metadata for a specific local file path.
 * GET /v1/media/by-path?path=<encoded>
 * @param {string} filePath
 */
async function byPath(filePath) {
    if (isOffline() || !filePath || typeof filePath !== 'string') return null;
    try {
        const url = `${RAGGAE_URL}/v1/media/by-path?path=${encodeURIComponent(filePath)}`;
        const res = await fetchWithTimeout(url, { method: 'GET' });
        if (!res.ok) {
            if (res.status === 404) return null;
            throw new Error(`HTTP ${res.status}`);
        }
        markOnline();
        return await res.json();
    } catch (err) {
        markOffline(err);
        return null;
    }
}

/**
 * Search the 6.3M catalog items in vault-raggae.
 * GET /v1/catalog/search?q=...&category=movie|tv&limit=...
 * @param {string} query
 * @param {object} options - { category, year, mode, limit }
 */
async function search(query, options = {}) {
    if (isOffline() || !query) return [];
    const category = options.category || '';
    const year = options.year || '';
    const limit = options.limit || 20;
    const mode = options.mode || 'fts';

    try {
        let url = `${RAGGAE_URL}/v1/catalog/search?q=${encodeURIComponent(query)}&limit=${limit}&mode=${mode}`;
        if (category) url += `&category=${encodeURIComponent(category)}`;
        if (year) url += `&year=${encodeURIComponent(year)}`;

        const res = await fetchWithTimeout(url, { method: 'GET' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        markOnline();
        return await res.json();
    } catch (err) {
        markOffline(err);
        return [];
    }
}

/**
 * Permanently ingest or enrich outside API items into the vault-raggae catalog.
 * POST /v1/catalog/ingest
 * @param {Object|Array<Object>} items
 */
async function ingest(items) {
    if (isOffline() || !items) return null;
    try {
        const payload = Array.isArray(items) ? { items } : (items.items ? items : { items: [items] });
        const res = await fetchWithTimeout(`${RAGGAE_URL}/v1/catalog/ingest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!res.ok) {
            console.warn(`[raggae:ingest] Failed with HTTP ${res.status}`);
            return null;
        }
        markOnline();
        return await res.json();
    } catch (err) {
        markOffline(err);
        return null;
    }
}

/**
 * Construct resized catalog image URL from vault-raggae image service.
 * GET /v1/img?path=<posterPath>&w=<width>
 * @param {string} posterPath
 * @param {number} width
 */
function getPosterUrl(posterPath, width = 320) {
    if (!posterPath) return null;
    if (posterPath.startsWith('http://') || posterPath.startsWith('https://')) {
        return posterPath;
    }
    return `${RAGGAE_URL}/v1/img?path=${encodeURIComponent(posterPath)}&w=${width}`;
}

module.exports = {
    RAGGAE_URL,
    health,
    resolve,
    byPath,
    search,
    ingest,
    getPosterUrl,
    isOffline,
    markOnline,
    markOffline
};
