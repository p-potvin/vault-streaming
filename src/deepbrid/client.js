// src/deepbrid/client.js — Deepbrid (https://www.deepbrid.com/api-docs), the fallback when Real-Debrid fails.
//
// Requests go through the proxy tunnel when one is configured, else directly (operator, Wed 18 Nov 2026: the tunnel
// is not needed for Deepbrid for now). Real-Debrid's direct calls keep their tunnel-only rule.
//
// API (v1, base https://www.deepbrid.com/api/v1, key as `Authorization: Bearer`; 250 requests/min premium):
//   POST /generate/link   link=<hoster or torrent file link>  -> { error: 0, link, filename, size: "1.50 GB" }
//   POST /torrents/add    magnet=<magnet>                      -> the torrent id (response shape undocumented)
//   GET  /torrents/info?id=<id>  -> { status, progress, links: [...] }; links appear once status is "downloaded";
//                                   final statuses: error, dead, magnet_error, virus
// There is no instant-availability call: a magnet Deepbrid does not have is downloaded server-side, and is reported
// as "downloading" here after a short bounded wait.
//
// Key: DEEPBRID_API_TOKEN (.env) or the .access store (deepbrid_api_token.txt); never logged.

const fs = require('fs');
const path = require('path');
const { makeProxiedRequest } = require('../realdebrid/proxy');

const API = 'https://www.deepbrid.com/api/v1';
const ACCESS_FILE = path.join(__dirname, '..', '..', '..', '.access', 'deepbrid_api_token.txt');
const POLL_ATTEMPTS = 8;        // a cached magnet is "downloaded" at once; anything slower is not cached
const POLL_INTERVAL_MS = 2000;
const FINAL = new Set(['error', 'dead', 'magnet_error', 'virus']);

let _token;
function token() {
    if (_token !== undefined) return _token;
    _token = (process.env.DEEPBRID_API_TOKEN || '').trim();
    if (!_token) {
        try { _token = fs.readFileSync(ACCESS_FILE, 'utf8').trim().split(/\r?\n/)[0].trim(); } catch (_) { _token = ''; }
    }
    return _token;
}

function configured() {
    return !!token();
}

/** "1.50 GB" -> bytes (0 when unknown). */
function parseSize(s) {
    const m = String(s || '').match(/([\d.]+)\s*([KMGT]?B)/i);
    if (!m) return 0;
    const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[m[2].toUpperCase()] || 1;
    return Math.round(parseFloat(m[1]) * mult);
}

async function api(method, route, { form, proxy } = {}) {
    const headers = { Authorization: `Bearer ${token()}`, Accept: 'application/json' };
    const opts = { method, headers };
    if (form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        opts.body = new URLSearchParams(form).toString();
    }
    // an empty proxy means a direct request (makeProxiedRequest falls back to fetch)
    const res = await makeProxiedRequest(`${API}${route}`, opts, (proxy && String(proxy).trim()) || undefined);
    let data = null;
    try { data = await res.json(); } catch (_) { }
    if (res.status === 429) throw new Error('Deepbrid rate limit reached (429)');
    if (!res.ok) throw new Error((data && data.message) || `Deepbrid HTTP ${res.status}`);
    return data;
}

/** A hoster / torrent-file link -> { success, download, filename, filesize }. One request. */
async function unrestrictLink(link, proxy) {
    if (!configured()) return { success: false, notConfigured: true, error: 'Deepbrid API key is not configured' };
    const d = await api('POST', '/generate/link', { form: { link }, proxy });
    if (!d || d.error !== 0 || !d.link) {
        return { success: false, error: (d && d.message) || 'Deepbrid did not return a link' };
    }
    return { success: true, provider: 'deepbrid', download: d.link, filename: d.filename || null, filesize: parseSize(d.size) };
}

function torrentIdOf(d) {
    if (!d) return null;
    const v = d.id || d.torrent_id || (d.data && (d.data.id || d.data.torrent_id));
    return v ? String(v) : null;
}

const _inFlight = new Map(); // hash/magnet (+ episode) -> Promise
const MAX_EPISODE_LINKS = 40;    // a season pack: at most this many files are unrestricted to find the episode

/** True when a file name is season `season`, episode `episode` (S01E02, 1x02, S01.E02). */
function isEpisode(filename, season, episode) {
    const s = Number(season);
    const e = Number(episode);
    const name = String(filename || '');
    // S01E02, S01.E02, S01E01-E03 / S01E01E02 / S01E01-03 (multi-episode files), 1x02
    const m = name.match(/S(\d{1,2})[ ._-]?E(\d{1,3})(?:-?E(\d{1,3})|-(\d{1,3}))?/i) || name.match(/\b(\d{1,2})x(\d{1,3})\b/i);
    if (!m) return false;
    const from = Number(m[2]);
    const to = m[3] ? Number(m[3]) : (m[4] ? Number(m[4]) : from);
    return Number(m[1]) === s && e >= from && e <= to;
}

/** A video file, not a sample / subtitle / nfo. */
function isVideo(filename) {
    return /\.(mkv|mp4|avi|m4v|webm|ts)$/i.test(String(filename || '')) && !/\bsample\b/i.test(String(filename || ''));
}

/**
 * A magnet -> { success, download, filename, filesize } when Deepbrid has it (cached), else { success: false,
 * downloading: true } once the bounded wait ends (Deepbrid keeps downloading it server-side).
 * `want` ({ season, episode }) picks that episode's file out of a season pack; no match is a failure, never another
 * episode. Without it the largest video file is used.
 * `torrentId` (from an earlier { downloading: true } answer) polls that torrent instead of adding the magnet again,
 * so a retry while Deepbrid downloads never submits it twice.
 */
function unrestrictMagnet(magnet, proxy, dedupKey, want = null, torrentId = null) {
    const ep = want && want.season != null && want.episode != null ? want : null;
    const key = `${(dedupKey || magnet || '').toLowerCase()}${ep ? `:${ep.season}:${ep.episode}` : ''}`;
    if (_inFlight.has(key)) return _inFlight.get(key);
    const job = (async () => {
        if (!configured()) return { success: false, notConfigured: true, error: 'Deepbrid API key is not configured' };
        let id = torrentId ? String(torrentId) : null;
        if (!id) {
            const added = await api('POST', '/torrents/add', { form: { magnet }, proxy });
            id = torrentIdOf(added);
            if (!id) return { success: false, error: (added && added.message) || 'Deepbrid did not return a torrent id' };
        }
        let info = null;
        for (let i = 0; i < POLL_ATTEMPTS; i++) {
            info = await api('GET', `/torrents/info?id=${encodeURIComponent(id)}`, { proxy });
            const status = info && info.status;
            if (FINAL.has(status)) return { success: false, error: `Deepbrid torrent ${status}` };
            if (status === 'downloaded' && Array.isArray(info.links) && info.links.length) break;
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        }
        if (!info || info.status !== 'downloaded' || !Array.isArray(info.links) || !info.links.length) {
            return { success: false, downloading: true, torrentId: id, progress: (info && info.progress) || 0,
                     error: 'Not cached on Deepbrid (it is downloading the torrent; try again later).' };
        }
        if (info.links.length === 1 && !ep) {
            const out = await unrestrictLink(info.links[0], proxy);
            if (out.success && !out.filename) out.filename = info.filename || null;
            return { ...out, torrentId: id };
        }
        // several files (a season pack, extras, samples): the links carry no names, so they are unrestricted one by one
        // (bounded) until the wanted episode, or for a film the largest video, is found
        let best = null;
        for (const link of info.links.slice(0, MAX_EPISODE_LINKS)) {
            const out = await unrestrictLink(link, proxy);
            if (!out.success || !isVideo(out.filename)) continue;
            if (ep) {
                if (isEpisode(out.filename, ep.season, ep.episode)) return { ...out, torrentId: id };
            } else if (!best || out.filesize > best.filesize) {
                best = out;
            }
        }
        if (best) return { ...best, torrentId: id };
        return { success: false, torrentId: id,
                 error: ep ? `Deepbrid: no file for S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')} in this torrent`
                           : 'Deepbrid: no video file in this torrent' };
    })().finally(() => _inFlight.delete(key));
    _inFlight.set(key, job);
    return job;
}

module.exports = { configured, unrestrictLink, unrestrictMagnet, _parseSize: parseSize, _isEpisode: isEpisode };
