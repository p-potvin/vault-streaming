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
 * Batched Real-Debrid cache check.
 * RD's instantAvailability endpoint accepts many hashes per request, so one call
 * replaces the previous N-concurrent fetch storm that risked rate-limiting.
 * Returns a Set of lower-cased hashes that RD reports as cached.
 */
async function checkRDCachedBatch(hashes, apiKey) {
    const cached = new Set();
    if (!apiKey || !hashes || !hashes.length) return cached;

    const valid = [...new Set(hashes.filter(h => typeof h === 'string' && h.length >= 32).map(h => h.toLowerCase()))];
    const CHUNK = 40; // keep URL length sane

    for (let i = 0; i < valid.length; i += CHUNK) {
        const chunk = valid.slice(i, i + CHUNK);
        try {
            const res = await fetch(
                `https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${chunk.join('/')}`,
                { headers: { Authorization: `Bearer ${apiKey}` } }
            );
            if (!res.ok) continue;
            const data = await res.json();
            if (!data || typeof data !== 'object') continue;
            for (const h of chunk) {
                const entry = data[h] || data[h.toUpperCase()];
                if (entry && Array.isArray(entry.rd) && entry.rd.length > 0) {
                    cached.add(h);
                }
            }
            if (i + CHUNK < valid.length) await new Promise(r => setTimeout(r, 250));
        } catch (e) {
            console.warn('[RD] Batched cache check chunk failed:', e);
        }
    }
    return cached;
}

/**
 * Score a torrent entry by how well it matches the user's quality & language preferences.
 * Higher score = better match.
 */
function scoreTorrent(torrent, preferredQuality, preferredLang) {
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
    const maxQualityRank = QUALITY_RANK[preferredQuality] ?? 3;
    const tq = _detectQualityRank(text);

    if (tq === 0) {
        score -= 5;                                           // unknown / unparseable
    } else if (tq === maxQualityRank) {
        score += 100;                                         // perfect match for the ceiling
    } else if (tq < maxQualityRank) {
        score += tq * 15;                                     // lower than asked — still ok, the closer the better
    } else {
        score -= (tq - maxQualityRank) * 20;                  // exceeds the ceiling — costlier per step
    }

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

    // ── Size sanity (filter fake 4K, oversized remuxes for streaming) ───────
    const bytes = _parseSize(torrent.size);
    if (bytes > 0) {
        const GB = 1024 ** 3;
        if (tq === 4) {
            if (bytes < 6 * GB)  score -= 8;                  // probably a fake 4K upscale
            if (bytes > 80 * GB) score -= 12;                 // too large to stream comfortably
        } else if (tq === 3) {
            if (bytes < 1.2 * GB) score -= 6;
            if (bytes > 25 * GB)  score -= 8;
        } else if (tq === 2) {
            if (bytes < 500 * 1024 * 1024) score -= 4;
            if (bytes > 8 * GB)            score -= 4;
        }
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
    const quality = getPreferredQuality();
    const lang = getPreferredLang();
    return [...torrents].sort((a, b) => scoreTorrent(b, quality, lang) - scoreTorrent(a, quality, lang));
}
