// src/usenet/cache.js - Persistent cache for Usenet NZB health checks and file structures
const path = require('path');
const fs = require('fs');

let userDataPath = '';
let cacheFilePath = null;
let cacheData = null;

// Default TTLs (in milliseconds)
const COMPLETION_TTL = 3 * 24 * 60 * 60 * 1000; // 3 days for provider availability checks
const STATIC_TTL = 30 * 24 * 60 * 60 * 1000;   // 30 days for static metadata (password checks, video files)

function init(app) {
    if (app) {
        userDataPath = app.getPath('userData');
        cacheFilePath = path.join(userDataPath, 'vault-usenet-cache.json');
    }
}

function getCachePath() {
    if (!cacheFilePath) {
        // Fallback if init hasn't been called (e.g. during testing or standalone run)
        const homeDir = require('os').homedir();
        cacheFilePath = path.join(homeDir, '.vault-explorer-usenet-cache.json');
    }
    return cacheFilePath;
}

function loadCache() {
    if (cacheData) return cacheData;
    try {
        const p = getCachePath();
        if (fs.existsSync(p)) {
            const raw = fs.readFileSync(p, 'utf8');
            cacheData = JSON.parse(raw);
            return cacheData;
        }
    } catch (e) {
        console.error('[usenet-cache] Failed to load cache file:', e.message);
    }
    cacheData = { entries: {} };
    return cacheData;
}

function saveCache() {
    if (!cacheData) return;
    try {
        const p = getCachePath();
        fs.writeFileSync(p, JSON.stringify(cacheData, null, 2), 'utf8');
    } catch (e) {
        console.error('[usenet-cache] Failed to write cache file:', e.message);
    }
}

/**
 * Clean up expired cache entries.
 */
function pruneExpired() {
    const cache = loadCache();
    const now = Date.now();
    let modified = false;

    for (const key of Object.keys(cache.entries)) {
        const entry = cache.entries[key];
        const expiry = entry.expiresAt || (entry.timestamp + COMPLETION_TTL);
        if (now > expiry) {
            delete cache.entries[key];
            modified = true;
        }
    }

    if (modified) {
        saveCache();
    }
}

/**
 * Retrieves a cached NZB health status.
 * @param {string} nzbUrlOrId Unique identifier (e.g., NZB url, guid, infohash)
 * @returns {object|null} Cached details or null if missed/expired
 */
function get(nzbUrlOrId) {
    const cache = loadCache();
    const entry = cache.entries[nzbUrlOrId];
    if (!entry) return null;

    const now = Date.now();
    if (now > entry.expiresAt) {
        // Expired entry
        delete cache.entries[nzbUrlOrId];
        saveCache();
        return null;
    }

    return entry;
}

/**
 * Caches an NZB health result.
 * @param {string} nzbUrlOrId Unique identifier (URL, infohash, GUID)
 * @param {object} statusData Verification payload:
 *    - health: 'healthy' | 'unhealthy' | 'unknown'
 *    - isPassworded: boolean
 *    - completionPercent: number (optional)
 *    - files: array of objects { name, size } (optional)
 *    - reason: string (optional)
 * @param {number} [customTtl] Custom TTL in ms
 */
function set(nzbUrlOrId, statusData, customTtl) {
    const cache = loadCache();
    const now = Date.now();
    
    // Choose appropriate TTL
    let ttl = COMPLETION_TTL;
    if (statusData.health === 'unhealthy') {
        // If it's permanently bad (passworded / no video files), keep it longer
        ttl = STATIC_TTL;
    }
    if (customTtl !== undefined) {
        ttl = customTtl;
    }

    cache.entries[nzbUrlOrId] = {
        ...statusData,
        timestamp: now,
        expiresAt: now + ttl
    };

    saveCache();
}

/**
 * Invalidates a specific cache entry.
 */
function invalidate(nzbUrlOrId) {
    const cache = loadCache();
    if (cache.entries[nzbUrlOrId]) {
        delete cache.entries[nzbUrlOrId];
        saveCache();
        return true;
    }
    return false;
}

/**
 * Clears the entire cache.
 */
function clear() {
    cacheData = { entries: {} };
    saveCache();
}

module.exports = {
    init,
    get,
    set,
    invalidate,
    clear,
    pruneExpired
};
