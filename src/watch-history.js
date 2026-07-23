// src/watch-history.js - Persistent media watch history: episode progress, continue watching, seen items

const path = require('path');
const fs = require('fs');

let _app = null;
let _historyPath = null;

// In-memory cache to avoid reading/writing the JSON file on every progress tick.
let _cache = null;
let _dirty = false;
let _flushTimer = null;
const FLUSH_DELAY_MS = 15000; // flush at most once per 15s

function getHistoryPath() {
    if (!_historyPath) {
        _historyPath = path.join(_app.getPath('userData'), 'vault-watch-history.json');
    }
    return _historyPath;
}

function loadHistory() {
    if (_cache) return _cache;
    try {
        const p = getHistoryPath();
        if (fs.existsSync(p)) _cache = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
        console.error('[watch-history] Failed to load:', e.message);
    }
    _cache = _cache || { items: {} };
    return _cache;
}

function scheduleFlush() {
    _dirty = true;
    if (_flushTimer) return;
    _flushTimer = setTimeout(flushNow, FLUSH_DELAY_MS);
}

function flushNow() {
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    if (!_dirty || !_cache) return;
    _dirty = false;
    try {
        fs.writeFileSync(getHistoryPath(), JSON.stringify(_cache, null, 2), 'utf8');
    } catch (e) {
        console.error('[watch-history] Failed to flush:', e.message);
    }
}

function saveHistory(history) {
    _cache = history;
    scheduleFlush();
    return true;
}

/**
 * Build a stable key for a media item.
 * Movies: "movie:tmdbId" or "movie:title"
 * TV:     "tv:tmdbId:season:episode"
 */
function makeKey(mediaType, tmdbId, title, season, episode) {
    if (mediaType === 'tv' && season != null && episode != null) {
        return `tv:${tmdbId || title}:s${season}e${episode}`;
    }
    return `${mediaType || 'movie'}:${tmdbId || title}`;
}

function registerWatchHistoryHandlers(ipcMain, app) {
    _app = app;

    // ── Mark progress (called periodically during playback) ─────────────────
    ipcMain.handle('watch-history:set-progress', (_e, data) => {
        const { mediaType, tmdbId, title, season, episode, positionSec, durationSec, poster, year } = data;
        const history = loadHistory();
        const key = makeKey(mediaType, tmdbId, title, season, episode);

        const existing = history.items[key] || {};
        history.items[key] = {
            ...existing,
            ...data,
            key,
            mediaType: mediaType || 'movie',
            tmdbId: tmdbId || null,
            title: title || 'Unknown',
            season: season || null,
            episode: episode || null,
            positionSec: positionSec || 0,
            durationSec: durationSec || 0,
            // Completed if watched >90% of runtime
            completed: durationSec > 0 && (positionSec / durationSec) >= 0.9,
            poster: poster || null,
            year: year || null,
            lastWatched: new Date().toISOString(),
            // Preserve original firstWatched
            firstWatched: existing.firstWatched || new Date().toISOString(),
        };

        saveHistory(history);
        return { success: true };
    });

    // ── Get progress for a specific item ────────────────────────────────────
    ipcMain.handle('watch-history:get-progress', (_e, { mediaType, tmdbId, title, season, episode }) => {
        const history = loadHistory();
        if (mediaType === 'tv' && (season == null || episode == null)) {
            const tvItems = Object.values(history.items).filter(item =>
                item.mediaType === 'tv' &&
                ((tmdbId != null && item.tmdbId === tmdbId) || (title != null && item.title === title))
            );
            if (tvItems.length > 0) {
                tvItems.sort((a, b) => new Date(b.lastWatched) - new Date(a.lastWatched));
                return tvItems[0];
            }
            return null;
        }
        const key = makeKey(mediaType, tmdbId, title, season, episode);
        return history.items[key] || null;
    });

    // ── Get "Continue Watching" list (incomplete, sorted by recency) ─────────
    ipcMain.handle('watch-history:continue-watching', (_e, { limit = 20 } = {}) => {
        const history = loadHistory();
        const items = Object.values(history.items)
            .filter(item => !item.completed && item.positionSec > 30) // must have watched at least 30s
            .sort((a, b) => new Date(b.lastWatched) - new Date(a.lastWatched))
            .slice(0, limit);
        return { success: true, items };
    });

    // ── Get full watch history (all, sorted by recency) ─────────────────────
    ipcMain.handle('watch-history:get-all', (_e, { limit = 100 } = {}) => {
        const history = loadHistory();
        const items = Object.values(history.items)
            .sort((a, b) => new Date(b.lastWatched) - new Date(a.lastWatched))
            .slice(0, limit);
        return { success: true, items };
    });

    // ── Mark item as fully watched (skip progress check) ────────────────────
    ipcMain.handle('watch-history:mark-watched', (_e, { mediaType, tmdbId, title, season, episode, poster, year }) => {
        const history = loadHistory();
        const key = makeKey(mediaType, tmdbId, title, season, episode);
        const existing = history.items[key] || {};
        history.items[key] = {
            ...existing,
            key,
            mediaType: mediaType || 'movie',
            tmdbId: tmdbId || null,
            title: title || 'Unknown',
            season: season || null,
            episode: episode || null,
            completed: true,
            poster: poster || null,
            year: year || null,
            lastWatched: new Date().toISOString(),
            firstWatched: existing.firstWatched || new Date().toISOString(),
        };
        saveHistory(history);
        return { success: true };
    });

    // ── Remove a single history entry ────────────────────────────────────────
    ipcMain.handle('watch-history:remove', (_e, { mediaType, tmdbId, title, season, episode }) => {
        const history = loadHistory();
        const key = makeKey(mediaType, tmdbId, title, season, episode);
        delete history.items[key];
        saveHistory(history);
        return { success: true };
    });

    // ── Clear all history ────────────────────────────────────────────────────
    ipcMain.handle('watch-history:clear', () => {
        saveHistory({ items: {} });
        return { success: true };
    });

    console.log('[watch-history] IPC handlers registered. Storage:', getHistoryPath());
}

module.exports = { registerWatchHistoryHandlers, loadHistory, makeKey, flushNow };
