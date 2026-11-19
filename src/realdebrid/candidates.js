// src/realdebrid/candidates.js — turns Comet's raw stream list into the candidates worth showing and trying.
//
// Comet returns one entry per (torrent × debrid service) plus plain torrents it could not hand to any service and a
// "Sync debrid account library" action per service. Measured on Game of Thrones S01E01 (Wed 18 Nov 2026): 71
// entries, but only 24 distinct torrents, and the retry loop spent its 5 attempts on link-less torrents and the same
// hash twice. This module removes what can never play and keeps one entry per torrent.
const { detectDebridProvider } = require('../telemetry/debrid-stats');

// Debrid subscriptions that have lapsed (Thu 19 Nov 2026: only Real-Debrid and Deepbrid are paid for). Comet may
// still list them while its config names them; their links would fail or eat an attempt. Remove a service from this
// list if its subscription comes back.
const INACTIVE_PROVIDERS = new Set(['alldebrid', 'torbox']);

/** Comet's "🔄 Comet Sync — Sync debrid account library now." action. It has a url, but it is not a stream. */
function isSyncEntry(t) {
    const text = `${t.name || ''} ${t.desc || ''}`;
    return /🔄/.test(t.name || '') || /sync debrid account library/i.test(text);
}

// Higher wins when two entries carry the same torrent: a cached link, then any link, then a bare magnet.
function preference(t) {
    return (t.url && t.cached ? 4 : 0) + (t.url ? 2 : 0) + (t.provider === 'realdebrid' ? 1 : 0);
}

/**
 * Drop sync actions and inactive services, then keep one entry per torrent (by info hash; by name + size when Comet
 * gave no hash). Order is preserved by first appearance.
 */
function filterAndDedupe(list) {
    const byKey = new Map();
    for (const raw of list || []) {
        if (!raw) continue;
        const t = { ...raw, provider: raw.provider || detectDebridProvider(raw.name) };
        if (isSyncEntry(t)) continue;
        if (INACTIVE_PROVIDERS.has(t.provider)) continue;
        const key = t.hash ? `h:${t.hash.toLowerCase()}` : `n:${(t.desc || t.name || '').toLowerCase()}|${t.size || ''}`;
        const prev = byKey.get(key);
        if (!prev || preference(t) > preference(prev)) byKey.set(key, t);
    }
    return [...byKey.values()];
}

/**
 * How a release relates to the requested episode:
 *   'exact'   — that one episode (S01E01, S01 E01, 1x01, S01EP01)
 *   'pack'    — a range or a whole season that contains it (S01E01-10, S01EP(01-10), S01, Season 1, Complete)
 *   'other'   — clearly a different episode or season
 *   'unknown' — no episode marker at all
 * Films (season == null) are always 'exact'.
 */
function episodeFit(text, season, episode) {
    if (season == null) return 'exact';
    const s = Number(season);
    const e = Number(episode || 1);
    const str = String(text || '');

    // S01E01, S1E01, S01 E01, S01.E01, S01EP01, S01EP(01-10), S01E01-E05, S01E01-02, S01 E01-10
    // (the range end must not run into a resolution: "S01E01-1080p" is one episode)
    const m = str.match(/\bS(\d{1,2})[ ._-]?EP?\(?(\d{1,3})(?:\s*-\s*(?:EP?)?(\d{1,3})(?![\dp]))?\)?/i)
        || str.match(/\b(\d{1,2})x(\d{1,3})(?:-(\d{1,3}))?\b/i);
    if (m) {
        const ms = Number(m[1]);
        const from = Number(m[2]);
        const to = m[3] ? Number(m[3]) : from;
        if (ms !== s) return 'other';
        if (e < from || e > to) return 'other';
        return to > from ? 'pack' : 'exact';
    }
    // A season with no episode: S01, Season 1, Saison 1
    const sm = str.match(/\bS(\d{1,2})\b/i) || str.match(/\b(?:season|saison)[ ._-]?(\d{1,2})\b/i);
    if (sm) return Number(sm[1]) === s ? 'pack' : 'other';
    if (/\b(complete|integrale|intégrale)\b/i.test(str)) return 'pack';
    return 'unknown';
}

module.exports = { INACTIVE_PROVIDERS, isSyncEntry, filterAndDedupe, episodeFit };
