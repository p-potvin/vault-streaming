// src/realdebrid/stream.js — Comet-only stream resolution.
//
// VaultWares policy (STRICT — the account is at ban risk): every magnet
// resolution and stream-URL fetch goes through Comet, which handles Real-Debrid
// server-side on a rotating IP. This client NEVER calls api.real-debrid.com
// directly (no addMagnet / selectFiles / unrestrict / info polling), so it can't
// grab a torrent from the account's own IP and can't create duplicate grabs.
//
// A stream is playable iff Comet returned a resolved `url` for it (search.js
// sets `cached:true` for those). We follow that Comet url to the final media
// location. Resolved urls are cached by hash so repeated plays don't re-hit
// Comet's resolver for the same content.
const { fetchWithTimeout } = require("./client");

const _inFlightMagnets = new Set();
const _resolvedCache = new Map(); // hash/url -> { streamUrl, filename, ts }
const RESOLVED_TTL_MS = 30 * 60 * 1000; // 30 min

async function resolveCometUrl(url) {
    // With PROXY_DEBRID_STREAM enabled server-side, Comet's `url` IS the playable
    // endpoint: Comet proxies the debrid stream through its VPN (Mullvad) so all
    // traffic stays on ONE IP. We must hand this URL straight to the player and
    // let it issue GET range requests. Do NOT HEAD it (the proxy route only
    // serves GET — HEAD returns 405) and do NOT follow it to the RD CDN (that
    // would hit Real-Debrid from the user's own IP and break the single-IP
    // guarantee). The player/browser handles any redirect natively.
    return { streamUrl: url, filename: (url.split('/').pop() || 'stream.mp4').split('?')[0] };
}

// A real movie/episode is always well over this; a debrid "provider unavailable"
// placeholder clip is a few MB. Used to catch streams a provider flagged cached
// but can't actually serve (RD's optimistic URLs since instantAvailability died).
const MIN_REAL_BYTES = 50 * 1024 * 1024; // 50 MB

// Probe the resolved stream's real total size with ONE tiny GET range request
// to the COMET PROXY url (same origin the player hits — stays on Comet's IP,
// never touches the RD CDN directly). Returns total bytes, or null if unknown.
async function probeStreamBytes(url) {
    try {
        const res = await fetchWithTimeout(url, { method: 'GET', headers: { Range: 'bytes=0-1' } }, 12000);
        // 206 → Content-Range: "bytes 0-1/<total>"; 200 → Content-Length is total.
        const cr = res.headers.get('content-range');
        if (cr) {
            const total = parseInt((cr.split('/')[1] || '').trim(), 10);
            if (Number.isFinite(total) && total > 0) return total;
        }
        const cl = res.headers.get('content-length');
        if (res.status === 200 && cl) {
            const total = parseInt(cl, 10);
            if (Number.isFinite(total) && total > 0) return total;
        }
        return null;
    } catch (e) {
        // Network hiccup on the probe shouldn't block playback — treat as unknown.
        console.warn('[Comet] size probe failed (allowing stream):', e.message);
        return null;
    }
}

function registerStreamHandlers(ipcMain) {
    ipcMain.handle('rd-stream-torrent', async (event, { magnet, hash, url } = {}) => {
        const dedupKey = (hash || url || magnet || '').toLowerCase().trim();

        // Only a Comet-resolved url is playable. No url = not cached/available;
        // we refuse rather than fall back to a direct Real-Debrid grab.
        if (!url) {
            return {
                success: false,
                error: 'This source is not available through Comet (no resolved link). Pick a ⚡ cached result.',
                notCached: true
            };
        }

        // Serve from cache — avoids re-resolving the same content repeatedly.
        const cached = _resolvedCache.get(dedupKey);
        if (cached && (Date.now() - cached.ts) < RESOLVED_TTL_MS) {
            console.log('[Comet] Serving cached resolved link for', dedupKey.slice(0, 16));
            return { success: true, streamUrl: cached.streamUrl, filename: cached.filename, cached: true };
        }

        if (_inFlightMagnets.has(dedupKey)) {
            return { success: false, error: 'Duplicate in-flight resolve request', dedup: true };
        }
        _inFlightMagnets.add(dedupKey);
        try {
            console.log('[Comet] Resolving stream url…');
            const { streamUrl, filename } = await resolveCometUrl(url);

            // Verify it's a real file, not a provider "unavailable" placeholder.
            // A provider can flag a torrent cached (Comet returns a url) yet serve
            // a tiny placeholder when actually hit — since RD killed the
            // instantAvailability check. Reject placeholder-sized streams so the
            // caller can fall back to the next ranked source.
            const totalBytes = await probeStreamBytes(streamUrl);
            if (totalBytes !== null && totalBytes < MIN_REAL_BYTES) {
                console.warn(`[Comet] Placeholder detected (${(totalBytes / 1048576).toFixed(1)} MB) — not actually cached.`);
                return {
                    success: false,
                    notCached: true,
                    placeholder: true,
                    error: 'Provider returned a placeholder (not actually cached). Trying the next source.'
                };
            }

            _resolvedCache.set(dedupKey, { streamUrl, filename, ts: Date.now() });
            return { success: true, streamUrl, filename };
        } catch (e) {
            console.error('[Comet] Resolve failed:', e.message);
            return { success: false, error: e.message };
        } finally {
            _inFlightMagnets.delete(dedupKey);
        }
    });

    // Legacy polling channel — under Comet-only resolution there is no
    // client-side torrent to poll (Comet manages downloads server-side).
    ipcMain.handle('rd-torrent-status', async () => {
        return { success: false, error: 'Torrent status polling is disabled (Comet manages resolution server-side).' };
    });
}

module.exports = { registerStreamHandlers };
