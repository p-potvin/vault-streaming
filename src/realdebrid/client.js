// src/realdebrid/client.js - shared HTTP helper, .env loading, API tokens, and RD cache check

const fs = require('fs');
const path = require('path');

// Helper function to fetch with timeout
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response;
    } catch (err) {
        clearTimeout(timeoutId);
        throw err;
    }
}

// Load environment variables from .env if process.env doesn't have it
let envConfig = {};
try {
    const envPaths = [
        path.join(process.cwd(), '.env'),
        path.join(path.dirname(process.execPath), '.env'),
        process.resourcesPath ? path.join(process.resourcesPath, '.env') : null,
        path.join(__dirname, '.env'),
        path.join(__dirname, '..', '.env'),
        path.join(__dirname, '..', '..', '.env')
    ].filter(Boolean);
    for (const envPath of envPaths) {
        if (fs.existsSync(envPath)) {
            const envContent = fs.readFileSync(envPath, 'utf8');
            envContent.split(/\r?\n/).forEach(line => {
                const parts = line.split('=');
                if (parts.length >= 2) {
                    const key = parts[0].trim();
                    const value = parts.slice(1).join('=').trim();
                    if (key) {
                        if (!process.env[key]) {
                            process.env[key] = value;
                        }
                        envConfig[key] = process.env[key];
                    }
                }
            });
            break;
        }
    }
} catch (e) {
    console.error('[Real-Debrid] Failed to load .env file:', e);
}

const RD_TOKEN = process.env.REAL_DEBRID_API_TOKEN || envConfig.REAL_DEBRID_API_TOKEN;
const TMDB_BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN || envConfig.TMDB_BEARER_TOKEN;

function loadCometStreamBase() {
    let raw = process.env.COMET_STREAM_BASE || envConfig.COMET_STREAM_BASE || '';
    if (!raw) {
        try {
            const accessPath = path.join(__dirname, '..', '..', '..', '.access', 'comet_config.txt');
            if (fs.existsSync(accessPath)) {
                raw = fs.readFileSync(accessPath, 'utf8').trim().split(/\r?\n/)[0].trim();
            }
        } catch (e) {
            console.error('[Comet] Failed to read .access/comet_config.txt:', e.message);
        }
    }
    if (!raw) return '';
    return keepUntaggedReleases(raw.replace(/\/manifest\.json\/*$/i, '').replace(/\/+$/, ''));
}

/**
 * Clear `languages.required` in the Comet config of a base URL (the base64 JSON path segment).
 *
 * With required = ["multi","en","fr"], Comet drops every release that names no language, which is how most English
 * releases are named. Measured Fri 20 Nov 2026 on American Dad S06E14: 7 streams (2 torrents, none cached, both
 * tagged "ENG"/"Eng") instead of 15, and the one Real-Debrid already had cached was among those dropped. Popular
 * cartoons never played. `allowed` and `preferred` stay as configured (preferred still ranks multi/en/fr first).
 * Returns the base unchanged when it holds no readable config or nothing is required.
 */
function keepUntaggedReleases(base) {
    try {
        const u = new URL(base);
        const segs = u.pathname.split('/');
        const i = segs.findIndex(s => s.startsWith('eyJ'));
        if (i < 0) return base;
        const cfg = JSON.parse(Buffer.from(segs[i], 'base64').toString('utf8'));
        if (!cfg || !cfg.languages || !Array.isArray(cfg.languages.required) || !cfg.languages.required.length) return base;
        cfg.languages = { ...cfg.languages, required: [] };
        // Comet decodes standard base64 from a path segment, so the encoding must not contain "/": trailing
        // whitespace (valid JSON) changes the last characters until it does not.
        const json = JSON.stringify(cfg);
        for (let pad = 0; pad < 6; pad++) {
            const enc = Buffer.from(json + ' '.repeat(pad), 'utf8').toString('base64');
            if (!enc.includes('/')) {
                segs[i] = enc;
                console.log('[Comet] config: language requirement cleared (releases without a language tag are kept)');
                return `${u.origin}${segs.join('/')}`;
            }
        }
    } catch (_) { /* not a config we can read: use it as given */ }
    return base;
}

const COMET_STREAM_BASE = loadCometStreamBase();

// DISABLED: this used to call api.real-debrid.com/instantAvailability directly
// from the account IP — a policy violation and a ban risk. Comet already tags
// cached streams (they carry a resolved url), so this is a no-op kept only for
// API compatibility. Do NOT restore the direct Real-Debrid call.
async function checkRealDebridCache(torrentList) {
    return torrentList;
}

/**
 * A Comet URL without its config segment — the base64 JSON that holds the debrid API keys: "comet:/playback/…".
 * What is written to disk (watch history, the last source of a title); cometUrl() puts the current config back.
 * Anything that is not a Comet URL is returned unchanged.
 */
function cometPath(url) {
    const s = String(url || '');
    if (!s || s.startsWith('comet:')) return s;
    if (COMET_STREAM_BASE && s.startsWith(COMET_STREAM_BASE + '/')) return 'comet:' + s.slice(COMET_STREAM_BASE.length);
    const m = s.match(/^https?:\/\/[^/]+\/eyJ[A-Za-z0-9_\-+=/]*?(\/(?:playback|stream)\/.*)$/);
    return m ? 'comet:' + m[1] : s;
}

/** The playable URL of a cometPath() (with the config Comet is configured with now). */
function cometUrl(p) {
    const s = String(p || '');
    return s.startsWith('comet:') && COMET_STREAM_BASE ? COMET_STREAM_BASE + s.slice('comet:'.length) : s;
}

module.exports = { fetchWithTimeout, checkRealDebridCache, RD_TOKEN, TMDB_BEARER_TOKEN, COMET_STREAM_BASE, cometPath, cometUrl,
                   keepUntaggedReleases };
