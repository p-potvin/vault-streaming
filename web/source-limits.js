// web/source-limits.js — cap what the web client is allowed to play.
//
// The desktop app hands a source straight to Electron's decoder, so its only
// real cost is bandwidth. The web client transcodes instead, and the cost of
// that lands on whatever machine runs the server. A UHD remux is the pathological
// case: 4K HEVC decode plus an H.264 encode, per viewer, for the length of a film.
//
// Two limits, because size alone is the wrong proxy for encoder load:
//
//   * size   — bounds the debrid pull (the source is fetched in full, twice over
//              if live subtitles are running).
//   * height — bounds the decode. Measured across 9,267 cached sources, 98 of
//              the 1,512 2160p ones were under 5 GB, so a size cap alone still
//              lets 4K through to the encoder.
//
// Applied only here, on the web path. The desktop client keeps the full list.

const DEFAULT_MAX_GB = 5;
const DEFAULT_MAX_HEIGHT = 1080;

function maxGB() {
    const v = parseFloat(process.env.VW_WEB_MAX_SOURCE_GB);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_GB;
}

function maxHeight() {
    const v = parseInt(process.env.VW_WEB_MAX_HEIGHT, 10);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_HEIGHT;
}

// "76.2 GB" / "980 MB" / "1.2 TB" -> gigabytes. null when unparseable.
function sizeToGB(size) {
    const m = /([\d.]+)\s*(TB|GB|MB|KB)/i.exec(String(size == null ? '' : size));
    if (!m) return null;
    const value = parseFloat(m[1]);
    if (!Number.isFinite(value)) return null;
    switch (m[2].toUpperCase()) {
        case 'TB': return value * 1024;
        case 'GB': return value;
        case 'MB': return value / 1024;
        default: return value / (1024 * 1024);
    }
}

// Resolution from the quality tag, falling back to the release name in the URL.
// Returns null when nothing identifies it — an unknown source is judged on size
// alone rather than being dropped on a guess.
function heightOf(torrent) {
    const fields = [torrent && torrent.quality, torrent && torrent.name];
    try {
        const n = new URL(torrent.url).searchParams.get('torrent_name');
        if (n) fields.push(decodeURIComponent(n));
    } catch (_) { /* not a parseable url */ }

    const hay = fields.filter(Boolean).join(' ').toLowerCase();
    if (/\b(2160p?|4k|uhd)\b/.test(hay)) return 2160;
    if (/\b(1440p)\b/.test(hay)) return 1440;
    if (/\b(1080p?|fhd)\b/.test(hay)) return 1080;
    if (/\b(720p?)\b/.test(hay)) return 720;
    if (/\b(576p?|480p?|360p?)\b/.test(hay)) return 480;
    return null;
}

function allows(torrent) {
    const gb = sizeToGB(torrent && torrent.size);
    if (gb !== null && gb > maxGB()) return false;
    const h = heightOf(torrent);
    if (h !== null && h > maxHeight()) return false;
    return true;
}

// Filter a `search-torrents` result in place of the original. Returns a new
// object; never mutates what the handler produced.
function limitSearchResult(result) {
    if (!result || !Array.isArray(result.torrents)) return result;

    const kept = result.torrents.filter(allows);
    const dropped = result.torrents.length - kept.length;
    if (dropped > 0) {
        console.log(`[web:limits] ${dropped}/${result.torrents.length} sources over ` +
            `${maxGB()}GB / ${maxHeight()}p — ${kept.length} offered`);
    }

    // A title whose every source is oversized would otherwise look like "nothing
    // found", which sends you hunting for a debrid fault that isn't there.
    if (kept.length === 0 && result.torrents.length > 0) {
        return {
            ...result,
            torrents: [],
            success: false,
            error: `All ${result.torrents.length} available sources exceed the web client's ` +
                `limit (${maxGB()} GB / ${maxHeight()}p). Play this one from the desktop app.`,
            limitedOut: result.torrents.length,
        };
    }

    return { ...result, torrents: kept, limitedOut: dropped };
}

module.exports = { limitSearchResult, allows, sizeToGB, heightOf, maxGB, maxHeight };
