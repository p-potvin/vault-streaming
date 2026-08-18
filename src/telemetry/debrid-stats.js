// src/telemetry/debrid-stats.js — per-debrid-service counters.
//
// This app fans out to AllDebrid, TorBox and Real-Debrid through Comet, and the
// only evidence about which of them is worth paying for was a console line that
// vanished on restart. These counters persist it.
//
// The four numbers that actually decide a cut:
//   offered      how much of the candidate list a service contributes at all
//   cached       how much of that it claims is ready to stream
//   selected     how often it actually wins the ranking
//   played / failed / placeholder   whether winning produced a working film
//
// `cached` on its own is the trap. A service can report a torrent cached, hand
// back a URL, then serve a few-MB "provider unavailable" clip — a real, playable
// video that raises no error. That shows up here as a high cache rate next to a
// high placeholder count, which is the profile worth dropping even though it
// looks generous.
//
// Keep in sync with vault-tv's `src/telemetry/debridStats.ts`.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const statsFile = () => path.join(app.getPath('userData'), 'debrid-stats.json');

// Two-letter codes Comet puts in the stream name, e.g. "[TB⚡] …", "[AD] …".
const PROVIDER_CODES = {
    rd: 'realdebrid',
    ad: 'alldebrid',
    tb: 'torbox',
    pm: 'premiumize',
    dl: 'debridlink',
    oc: 'offcloud',
    pk: 'putio',
};

function emptyProvider() {
    return { offered: 0, cached: 0, selected: 0, played: 0, failed: 0, placeholder: 0 };
}

/**
 * Which debrid service a Comet stream came from.
 *
 * Anchored to the bracketed prefix on purpose. The previous inline check used
 * bare `\bAD\b` / `RD\+?` substrings, which match ordinary release titles
 * (NORDiC, ADDiCT, HDR) and would file those results under the wrong service —
 * exactly the misattribution that makes the numbers useless for a decision.
 */
function detectDebridProvider(name) {
    const text = String(name || '').trim();
    if (!text) return 'unknown';

    // A plain torrent Comet could not hand to any debrid service. Distinct from
    // `unknown`, which means "we failed to attribute this" — counting the two
    // together would make every service look worse than it is.
    if (/^\[\s*torrent/i.test(text)) return 'torrent';

    const bracket = text.match(/^\[\s*([A-Za-z]{2})[^\]]*\]/);
    if (bracket) {
        const mapped = PROVIDER_CODES[bracket[1].toLowerCase()];
        if (mapped) return mapped;
    }

    if (/real-?debrid/i.test(text)) return 'realdebrid';
    if (/all-?debrid/i.test(text)) return 'alldebrid';
    if (/tor-?box/i.test(text)) return 'torbox';
    if (/premiumize/i.test(text)) return 'premiumize';
    if (/debrid-?link/i.test(text)) return 'debridlink';
    return 'unknown';
}

function load() {
    try {
        const raw = fs.readFileSync(statsFile(), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.providers) return parsed;
    } catch (_) {
        // Missing or corrupt: start fresh rather than throw into a playback path.
    }
    return { since: new Date().toISOString(), resolves: 0, providers: {} };
}

function save(snapshot) {
    try {
        fs.writeFileSync(statsFile(), JSON.stringify(snapshot, null, 2), 'utf8');
    } catch (e) {
        // Telemetry must never break playback.
        console.warn('[debrid-stats] failed to persist:', e.message);
    }
}

function bump(provider, field, by = 1) {
    const snapshot = load();
    const entry = snapshot.providers[provider] || emptyProvider();
    entry[field] += by;
    snapshot.providers[provider] = entry;
    save(snapshot);
}

/**
 * One search's worth of candidates: `[{ name, cached }]`.
 * Recorded before ranking so "offered" reflects what the service contributed,
 * not what survived our own filters.
 */
function recordResolve(candidates) {
    const snapshot = load();
    snapshot.resolves += 1;
    for (const candidate of candidates || []) {
        const provider = detectDebridProvider(candidate.name);
        const entry = snapshot.providers[provider] || emptyProvider();
        entry.offered += 1;
        if (candidate.cached) entry.cached += 1;
        snapshot.providers[provider] = entry;
    }
    save(snapshot);
}

function recordSelection(name) {
    bump(detectDebridProvider(name), 'selected');
}

/** outcome: 'played' | 'failed' | 'placeholder' */
function recordOutcome(name, outcome) {
    if (!['played', 'failed', 'placeholder'].includes(outcome)) return;
    bump(detectDebridProvider(name), outcome);
}

function getStats() {
    return load();
}

function resetStats() {
    save({ since: new Date().toISOString(), resolves: 0, providers: {} });
}

/**
 * Ranked worst-first, because the reason to read this is to decide what to drop.
 * A service with no attempted playbacks reports a 0 success rate rather than a
 * perfect one on a zero denominator.
 */
function summarize(snapshot = load()) {
    return Object.entries(snapshot.providers)
        .map(([provider, s]) => {
            const attempts = s.played + s.failed + s.placeholder;
            return {
                provider,
                ...s,
                cacheRate: s.offered > 0 ? s.cached / s.offered : 0,
                selectionRate: s.cached > 0 ? s.selected / s.cached : 0,
                successRate: attempts > 0 ? s.played / attempts : 0,
                placeholderRate: attempts > 0 ? s.placeholder / attempts : 0,
            };
        })
        .sort((a, b) => (a.successRate - b.successRate) || (b.offered - a.offered));
}

/** Human-readable table for the console — the fastest way to eyeball a decision. */
function formatReport(snapshot = load()) {
    const rows = summarize(snapshot);
    if (rows.length === 0) return '[debrid-stats] nothing recorded yet';
    const pct = (n) => `${Math.round(n * 100)}%`;
    const lines = rows.map((r) => {
        const attempts = r.played + r.failed + r.placeholder;
        return [
            r.provider.padEnd(12),
            `offered ${String(r.offered).padStart(5)}`,
            `cached ${pct(r.cacheRate).padStart(4)}`,
            `won ${String(r.selected).padStart(4)}`,
            `worked ${(attempts ? pct(r.successRate) : '—').padStart(4)}`,
            `stubs ${String(r.placeholder).padStart(3)}`,
        ].join('  ');
    });
    return [
        `[debrid-stats] since ${snapshot.since} over ${snapshot.resolves} search(es)`,
        ...lines,
    ].join('\n');
}

function registerDebridStatsIpc(ipcMain) {
    ipcMain.handle('debrid-stats-get', async () => ({ snapshot: getStats(), summary: summarize() }));
    ipcMain.handle('debrid-stats-report', async () => formatReport());
    ipcMain.handle('debrid-stats-reset', async () => { resetStats(); return { success: true }; });
}

module.exports = {
    detectDebridProvider,
    recordResolve,
    recordSelection,
    recordOutcome,
    getStats,
    resetStats,
    summarize,
    formatReport,
    registerDebridStatsIpc,
};
