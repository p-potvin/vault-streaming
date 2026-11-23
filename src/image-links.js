// src/image-links.js — every picture comes from vault-raggae's local copies first (operator, Mon 23 Nov 2026: TMDB is
// to be cut off, apart from the data backfill scripts).
//
// The catalog keeps TMDB's URLs as data (poster_url, poster_path…); the gateway keeps the files: GET /v1/img?u=<url>
// serves the kept copy (any size kept of that file) and asks TMDB only for a picture it never kept, once. So a TMDB
// picture URL is never loaded as is; it is turned into a gateway request at the edge:
//   - the desktop window: main.js redirects every image.tmdb.org request to the gateway (gatewayImage);
//   - web and iOS clients cannot reach the gateway (it listens on this PC): web/server.js rewrites the picture links
//     in its answers to its own /api/img and /api/artwork routes (toWebLinks), which proxy to the gateway, and
//     rewrites them back in what clients send (fromWebLinks), so stored data keeps the canonical URLs.

const { RAGGAE_URL } = require('./raggae');

const TMDB_PICTURE = /^https:\/\/image\.tmdb\.org\/t\/p\//;
const TMDB_PICTURE_IN_TEXT = /https:\/\/image\.tmdb\.org\/t\/p\/[A-Za-z0-9_/.-]+/g;
// a client may send a link back absolute (the page's origin in front, e.g. an <img>.src): the origin goes too
const WEB_ORIGIN = String.raw`(?:https?://(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d+)?)?`;
const WEB_IMG_IN_TEXT = new RegExp(String.raw`${WEB_ORIGIN}/api/img\?u=([A-Za-z0-9%._~-]+)`, 'g');
const WEB_ARTWORK_IN_TEXT = new RegExp(String.raw`${WEB_ORIGIN}/api/artwork/`, 'g');
const ARTWORK = `${RAGGAE_URL}/v1/artwork/`;

/** The gateway URL serving a TMDB picture from its kept copy (other URLs unchanged). */
function gatewayImage(url) {
    return typeof url === 'string' && TMDB_PICTURE.test(url) ? `${RAGGAE_URL}/v1/img?u=${encodeURIComponent(url)}` : url;
}

/** JSON text for a web / iOS client: TMDB pictures and gateway artwork become this server's own routes. */
function toWebLinks(json) {
    if (typeof json !== 'string') return json;
    return json.replace(TMDB_PICTURE_IN_TEXT, m => `/api/img?u=${encodeURIComponent(m)}`).split(ARTWORK).join('/api/artwork/');
}

/** The reverse, for what a web / iOS client sends back (a library entry saved with its poster, say). */
function fromWebLinks(json) {
    if (typeof json !== 'string') return json;
    return json.replace(WEB_IMG_IN_TEXT, (whole, enc) => {
        let url;
        try { url = decodeURIComponent(enc); } catch (_) { return whole; }
        return TMDB_PICTURE.test(url) && !/["\\\s]/.test(url) ? url : whole;
    }).replace(WEB_ARTWORK_IN_TEXT, ARTWORK);
}

module.exports = { gatewayImage, toWebLinks, fromWebLinks, TMDB_PICTURE };
