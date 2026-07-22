// js/streaming/ranking.js — quality/language preferences + RD cache check + torrent scoring
// Part of the streaming feature, split out of the former monolithic js/streaming.js.

// ─── Stream preference getters ───────────────────────────────────────────────
/**
 * Read the user's stream quality preference from settings.
 * Returns one of: '2160p', '1080p', '720p'
 */
function getPreferredQuality() {
    const sel = el('settings-stream-quality');
    return sel ? sel.value : '1080p';
}

/**
 * Read the user's preferred stream language from settings.
 * Returns one of: 'en', 'fr', 'multi'
 */
function getPreferredLang() {
    const sel = el('settings-stream-lang');
    return sel ? sel.value : 'en';
}

// Quality hierarchy: higher index = better quality
const QUALITY_RANK = { '2160p': 4, '4k': 4, '1080p': 3, '720p': 2, '480p': 1, 'sd': 0 };

// Bad release types — strict word boundaries so "DTS" audio is NOT matched as "ts" telesync,
// and "camera/campaign" don't trigger the "cam" rule.
const BAD_RELEASE_RE = /\b(camrip|hdcam|hdts|telesync|telecine|screener|workprint|r5|dvdscr)\b|\bcam\b|\bts(?:rip)?\b/;

function _parseSize(sizeStr) {
    if (!sizeStr) return 0;
    const m = String(sizeStr).match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
    if (!m) return 0;
    const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
    return parseFloat(m[1]) * (mult[m[2].toUpperCase()] || 0);
}

function _detectQualityRank(text) {
    if (/\b(2160p?|4k|uhd)\b/.test(text)) return 4;
    if (/\b1080p?\b/.test(text)) return 3;
    if (/\b720p?\b/.test(text)) return 2;
    if (/\b480p?\b/.test(text)) return 1;
    return 0;
}

/**
 * DISABLED (VaultWares single-IP / Comet-only policy).
 *
 * This used to call api.real-debrid.com/torrents/instantAvailability directly
 * from the account's own IP — a ban risk, and pointless now that Real-Debrid
 * removed that endpoint (it always returns empty / triggers a grab). Comet
 * already flags cached streams server-side: search.js sets `cached:true` on any
 * result Comet returned a resolved `url` for. rd-flow.js reads that flag instead
 * of calling this. Kept as a no-op for signature compatibility.
 *
 * Do NOT restore a direct Real-Debrid call here.
 */
async function checkRDCachedBatch(hashes, apiKey) {
    return new Set();
}

/**
 * Score a torrent entry by how well it matches the user's quality & language preferences.
 * Higher score = better match.
 */
function scoreTorrent(torrent, preferredLang) {
    let score = 0;

    const text = `${torrent.quality || ''} ${torrent.desc || ''} ${torrent.type || ''}`.toLowerCase();

    // ── Usenet / Real-Debrid verified cache (HIGHEST priority) ──────────────
    if (torrent.isUsenet) {
        if (torrent.health === 'healthy') {
            score += 10000;
        } else if (torrent.cached) {
            score += 1000;
        } else if (torrent.health === 'unhealthy' || torrent.isPassworded) {
            score -= 100000;
        }
    } else {
        if (torrent.isRDCached)   score += 10000;
        else if (torrent.cached)  score += 1000;
    }

    // ── Reject bad release types (HEAVY penalty) ────────────────────────────
    if (BAD_RELEASE_RE.test(text)) score -= 10000;

    // ── Quality scoring ─────────────────────────────────────────────────────
    // The user's "Max Stream Quality" is now enforced at PLAYBACK by transcoding,
    // NOT by torrent selection. So we simply prefer the highest available quality:
    // the best cached UHD is the ideal source, and we downscale it on play if it
    // exceeds the ceiling. (preferredQuality is intentionally no longer consulted.)
    const tq = _detectQualityRank(text);
    if (tq === 0) score -= 5;                                 // unknown / unparseable
    else score += tq * 25;                                    // 480→25 · 720→50 · 1080→75 · 4K→100

    // ── Source tier ─────────────────────────────────────────────────────────
    if      (/\bremux\b/.test(text))       score += 18;
    else if (/\bblu-?ray\b/.test(text))    score += 12;
    else if (/\bweb-?dl\b/.test(text))     score += 9;
    else if (/\bwebrip\b/.test(text))      score += 5;
    else if (/\bhdtv\b/.test(text))        score += 2;
    else if (/\bdvdrip\b/.test(text))      score -= 5;

    // ── Codec (HEVC/AV1 compress better at same quality) ────────────────────
    if      (/\bav1\b/.test(text))                  score += 7;
    else if (/\b(x ?265|h\.?265|hevc)\b/.test(text)) score += 6;
    else if (/\b(x ?264|h\.?264|avc)\b/.test(text)) score += 2;

    // ── HDR / Dolby Vision tier ─────────────────────────────────────────────
    if      (/\b(dolby[\s.\-]?vision|dovi)\b/.test(text) || /\bdv\b/.test(text)) score += 6;
    if      (/\bhdr10\+/.test(text)) score += 5;
    else if (/\bhdr\b/.test(text))   score += 3;

    // ── Premium audio (small bonus) ─────────────────────────────────────────
    if (/\b(atmos|truehd|dts-?hd|dts-?x)\b/.test(text)) score += 3;

    // ── Language scoring (regex with boundaries — no "vf"-in-"flavor" hits) ─
    const isFR    = /\b(vf|vff|vfq|vfi|french|truefrench)\b/.test(text);
    const isMulti = /\b(multi|dual|vostfr)\b/.test(text);

    if (preferredLang === 'fr') {
        if (isFR)               score += 40;
        if (isMulti)            score += 20;
        if (!isFR && !isMulti)  score -= 25;                  // English-only release
    } else if (preferredLang === 'multi') {
        if (isMulti) score += 35;
        if (isFR)    score += 10;
    } else { // English
        if (/\btruefrench\b/.test(text)) score -= 30;
        if (isFR && !isMulti)            score -= 20;
    }

    // ── Seeder health (log curve, sharp penalty for dead torrents) ──────────
    if (!torrent.isUsenet) {
        const seeds = parseInt(torrent.seeds, 10) || 0;
        if      (seeds === 0) score -= 30;
        else if (seeds < 5)   score -= 10;
        else                  score += Math.min(15, Math.log2(seeds + 1) * 2);
    }

    // ── Size sanity (quality integrity only) ────────────────────────────────
    // We intentionally DO NOT penalize large files: Real-Debrid/Comet handle the
    // cache, so a big UHD remux streams just as easily as a small encode and is
    // often the reliably-cached one. Downscaling for bandwidth is handled by the
    // optional transcode-to-1080p path, not by biasing selection here.
    // The only remaining size check flags suspiciously *tiny* "4K"/"1080p" files
    // that are almost certainly mislabeled upscales — a quality signal, not a cap.
    const bytes = _parseSize(torrent.size);
    if (bytes > 0) {
        const GB = 1024 ** 3;
        if (tq === 4 && bytes < 6 * GB)        score -= 8;    // probable fake 4K upscale
        else if (tq === 3 && bytes < 1.2 * GB) score -= 6;    // suspiciously small "1080p"
    }

    // ── Encoder reputation (small touch) ────────────────────────────────────
    if (/\b(yify|yts)\b/.test(text)) score -= 4;              // over-compressed
    if (/-(framestor|hdb|don|cmrg|kralimarko|tigole|qxr|psa|ntb|ggez|hone)\b/.test(text)) score += 3;

    return score;
}

/**
 * Sort and optionally filter a torrent list by user preferences.
 * Returns a new sorted array.
 */
function rankTorrents(torrents) {
    const lang = getPreferredLang();
    return [...torrents].sort((a, b) => scoreTorrent(b, lang) - scoreTorrent(a, lang));
}
