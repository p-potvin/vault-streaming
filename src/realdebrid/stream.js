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
const { fetchWithTimeout, cometUrl } = require("./client");
const { recordSelection, recordOutcome } = require("../telemetry/debrid-stats");

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

// Comet answers a failed playback with one of its status videos (comet/assets/status_videos/<KEY>.mp4), with no header
// naming the status: only the size tells them apart. Measured on our Comet, Fri 20 Nov 2026:
//   433,923 B = MEDIA_NOT_CACHED_YET: Real-Debrid accepted the torrent and is downloading it — asking again later works.
//   410,511 B = UNAVAILABLE_FOR_LEGAL_REASONS (Real-Debrid "infringing_file", HTTP 451: a copyright block on that
//               release), also SERVER_ERROR / DOWNLOAD_SERVER_ERROR / NO_SERVER / MAINTENANCE: refused, waiting is useless.
//               American Dad S06E14 and Family Guy S04E02 got this for every uncached release.
// Other sizes (or a new Comet with other videos) stay a plain placeholder: no wait, next source.
const STATUS_VIDEO_BYTES = { 433923: 'notCachedYet', 410511: 'refused' };
function placeholderKind(totalBytes) {
    return STATUS_VIDEO_BYTES[totalBytes] || 'unknown';
}

// Probe the resolved stream's real total size with ONE tiny GET range request
// to the COMET PROXY url (same origin the player hits — stays on Comet's IP,
// never touches the RD CDN directly). Returns total bytes, or null if unknown.
async function probeStreamBytes(url, timeoutMs = 12000) {
    try {
        const res = await fetchWithTimeout(url, { method: 'GET', headers: { Range: 'bytes=0-1' } }, timeoutMs);
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
    ipcMain.handle('rd-stream-torrent', async (event, { magnet, hash, url: givenUrl, name, cached: markedCached = true } = {}) => {
        // a saved source (watch history) is stored without the Comet config: put the current one back
        const url = cometUrl(givenUrl);
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
            // An uncached source makes Comet add it to Real-Debrid on this first hit: give it longer to answer.
            let totalBytes = await probeStreamBytes(streamUrl, markedCached ? 12000 : 20000);
            // A ⚡ source used to be trusted when its probe timed out; American Dad S06E14 (Fri 20 Nov 2026) then played
            // a Comet error video. Ask once more with a longer wait: a slow link generation answers by then.
            if (totalBytes === null && markedCached) {
                console.warn('[Comet] size probe timed out — probing once more');
                totalBytes = await probeStreamBytes(streamUrl, 25000);
            }
            if (totalBytes !== null && totalBytes < MIN_REAL_BYTES) {
                const kind = placeholderKind(totalBytes);
                console.warn(`[Comet] Placeholder detected (${totalBytes} B, ${kind}) — not playable now.`);
                // The single most useful signal for cutting a service: it
                // claimed a cache hit and served a stub.
                recordOutcome(name, 'placeholder');
                return {
                    success: false,
                    notCached: true,
                    placeholder: true,
                    notCachedYet: kind === 'notCachedYet',
                    refused: kind === 'refused',
                    error: kind === 'refused'
                        ? 'Real-Debrid refused this release (most often a copyright block). Trying the next source.'
                        : kind === 'notCachedYet'
                            ? 'Real-Debrid is downloading this release (not cached yet). Trying the next source.'
                            : 'Provider returned a placeholder (not actually cached). Trying the next source.'
                };
            }
            // A source Comet did not mark cached (⬇️) is often on Real-Debrid anyway, which is why it is tried at
            // all — but only a probe that answers proves it. One that errors or times out would hand the player a
            // link that never starts, so it moves on to the next source instead. A ⚡ source keeps the benefit of
            // the doubt (a probe hiccup should not block it).
            if (totalBytes === null && !markedCached) {
                console.warn('[Comet] Uncached source did not answer the size probe — trying the next one.');
                recordOutcome(name, 'failed');
                return {
                    success: false,
                    notCached: true,
                    placeholder: true,
                    error: 'Source did not answer (not on Real-Debrid yet). Trying the next source.'
                };
            }

            recordSelection(name);
            recordOutcome(name, 'played');
            _resolvedCache.set(dedupKey, { streamUrl, filename, ts: Date.now() });
            return { success: true, streamUrl, filename };
        } catch (e) {
            console.error('[Comet] Resolve failed:', e.message);
            recordOutcome(name, 'failed');
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

module.exports = { registerStreamHandlers, placeholderKind };
