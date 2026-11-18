// tests/test_catalog_read_through.js — the catalog serves every detail; TMDB / KinoCheck are asked once to fill it;
// Discover and trending come from the catalog's lists; trailers are looked up and downloaded once.
// Self-contained: `fetch` is a router over an in-memory gateway (xref, raw_enrichment merge, lists), so nothing
// reaches the live gateway, TMDB, KinoCheck or YouTube. Trailers go to a temp dir.
//
//   node tests/test_catalog_read_through.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TMDB_BEARER_TOKEN = 'test-token';
process.env.RAGGAE_URL = 'http://raggae.test';
process.env.TRAILER_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-trailers-'));

// ---- an in-memory gateway --------------------------------------------------------------------------------------
const items = new Map();   // catalog_id -> item (with raw_enrichment)
const xref = new Map();    // "tmdb:movie:603" -> catalog_id
const lists = new Map();   // key -> [catalog_id]
const merge = (a, b) => (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b))
    ? Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(k => [k, k in b ? merge(a[k], b[k]) : a[k]]))
    : b;
function ingestOne(it) {
    const ext = it.external_ids || {};
    const cid = it.catalog_id || (ext.imdb ? `imdb:${ext.imdb}` : `tmdb:${it.category}:${ext.tmdb}`);
    const have = items.get(cid);
    const next = have ? { ...have } : { catalog_id: cid, category: it.category, title: it.title, source: it.source, external_ids: {} };
    for (const k of ['year', 'rating', 'votes', 'genres', 'overview', 'poster_url', 'release_date', 'runtime_mins']) {
        if (it[k] && (next[k] === undefined || next[k] === null || (Array.isArray(next[k]) && !next[k].length))) next[k] = it[k];
    }
    next.external_ids = { ...ext, ...next.external_ids };
    for (const [k, v] of Object.entries(next.external_ids)) if (v === null) delete next.external_ids[k];
    if (it.raw_enrichment) next.raw_enrichment = merge(next.raw_enrichment || {}, it.raw_enrichment);
    items.set(cid, next);
    if (next.external_ids.tmdb) xref.set(`tmdb:${next.category}:${next.external_ids.tmdb}`, cid);
    return { catalog_id: cid, created: !have };
}
const strip = (it, raw) => { if (!it) return it; const c = { ...it }; if (!raw) delete c.raw_enrichment; return c; };

const calls = [];
function json(body, status = 200) {
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}
let tmdbAnswers = {};
let kinoAnswers = {};
global.fetch = async (url, opts = {}) => {
    url = String(url);
    calls.push({ url, method: opts.method || 'GET' });
    const u = new URL(url);
    const raw = u.searchParams.get('raw') === 'true';
    if (u.host === 'raggae.test') {
        let m;
        if (u.pathname === '/v1/catalog/ingest') {
            const body = JSON.parse(opts.body);
            return json({ items: (body.items || [body]).map(ingestOne) });
        }
        if ((m = u.pathname.match(/^\/v1\/catalog\/xref\/tmdb\/(movie|tv)\/(\d+)$/))) {
            const cid = xref.get(`tmdb:${m[1]}:${m[2]}`) || (items.has(`tmdb:${m[1]}:${m[2]}`) ? `tmdb:${m[1]}:${m[2]}` : null);
            return cid ? json(strip(items.get(cid), raw)) : json({ detail: 'nope' }, 404);
        }
        if ((m = u.pathname.match(/^\/v1\/catalog\/lists\/(.+)$/))) {
            const key = decodeURIComponent(m[1]);
            if ((opts.method || 'GET') === 'POST') {
                const ids = JSON.parse(opts.body).catalog_ids.filter(id => items.has(id));
                lists.set(key, ids);
                return json({ key, count: ids.length });
            }
            const ids = lists.get(key) || [];
            const off = parseInt(u.searchParams.get('offset') || '0', 10);
            const lim = parseInt(u.searchParams.get('limit') || '100', 10);
            return json({ key, total: ids.length, items: ids.slice(off, off + lim).map(id => strip(items.get(id), raw)) });
        }
        if (u.pathname === '/v1/catalog/browse') return json({ items: [...items.values()].map(i => strip(i, false)) });
        if ((m = u.pathname.match(/^\/v1\/catalog\/(.+)$/))) {
            const it = items.get(decodeURIComponent(m[1]));
            return it ? json(strip(it, raw)) : json({ detail: 'nope' }, 404);
        }
        return json({ error: 'no route' }, 404);
    }
    if (u.host === 'api.themoviedb.org') {
        const key = u.pathname.replace('/3', '');
        return key in tmdbAnswers ? json(tmdbAnswers[key]) : json({ status_message: 'nope' }, 404);
    }
    if (u.host === 'api.kinocheck.com') {
        const id = u.searchParams.get('tmdb_id');
        return id in kinoAnswers ? json(kinoAnswers[id]) : json({}, 404);
    }
    return json({ error: `unexpected ${url}` }, 599);
};
const outside = () => calls.filter(c => !c.url.startsWith('http://raggae.test'));
const settle = () => new Promise(r => setTimeout(r, 20));

const handlers = {};
const tmdb = require('../src/tmdb');
tmdb.registerTmdbHandlers({ handle: (ch, fn) => { handlers[ch] = fn; } });
const trailers = require('../src/trailers');
require('../src/ipc/trailer-cache.ipc').registerTrailerCacheIpc({ handle: (ch, fn) => { handlers[ch] = fn; } });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- details ---------------------------------------------------------------------------------------------------
test('movie details: a catalog miss asks TMDB once; both answers are served from the catalog', async () => {
    items.set('imdb:tt0133093', { catalog_id: 'imdb:tt0133093', category: 'movie', title: 'The Matrix', year: 1999,
                                  rating: 8.7, votes: 2294151, genres: ['Action', 'Sci-Fi'], external_ids: {} });
    tmdbAnswers['/movie/603'] = { id: 603, title: 'The Matrix', imdb_id: 'tt0133093', release_date: '1999-03-30',
        overview: 'Neo.', vote_average: 8.2, vote_count: 26000, runtime: 136, poster_path: '/p.jpg', backdrop_path: '/b.jpg',
        genres: [{ id: 28, name: 'Action' }], videos: { results: [{ key: 'vKQi3bBA1y8', site: 'YouTube', type: 'Trailer', official: true }] } };
    calls.length = 0;
    const first = await handlers['get-tmdb-movie']({}, { id: 603, language: 'en-US' });
    assert.strictEqual(first.source, 'raggae');
    assert.strictEqual(first.data.title, 'The Matrix');
    assert.strictEqual(first.data.vote_average, 8.7, 'the catalog rating wins');
    assert.strictEqual(first.data.backdrop, 'https://image.tmdb.org/t/p/w1280/b.jpg');
    assert.strictEqual(first.data.videos.results[0].key, 'vKQi3bBA1y8');
    assert.strictEqual(outside().length, 1, 'one TMDB request');
    assert.strictEqual(items.get('imdb:tt0133093').external_ids.tmdb, 603, 'landed on the IMDb item');
    calls.length = 0;
    const second = await handlers['get-tmdb-movie']({}, { id: 603, language: 'en-US' });
    assert.strictEqual(second.source, 'raggae');
    assert.strictEqual(outside().length, 0, 'served from the catalog, no TMDB request');
    assert.deepStrictEqual(second.data.genres, first.data.genres);
});

test('another UI language is its own TMDB copy; the English overview is not overwritten', async () => {
    tmdbAnswers['/movie/603'] = { ...tmdbAnswers['/movie/603'], overview: 'Néo.', title: 'Matrix' };
    calls.length = 0;
    const fr = await handlers['get-tmdb-movie']({}, { id: 603, language: 'fr-CA' });
    assert.strictEqual(fr.data.overview, 'Néo.');
    assert.strictEqual(fr.data.title, 'Matrix');
    assert.strictEqual(outside().length, 1);
    assert.strictEqual(items.get('imdb:tt0133093').overview, 'Neo.', 'the catalog overview stays English');
});

test('tv details and seasons are read through and kept on the series item', async () => {
    tmdbAnswers['/tv/1396'] = { id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20', vote_average: 8.9,
        external_ids: { imdb_id: 'tt0903747' }, seasons: [{ season_number: 1, name: 'Season 1', episode_count: 7 }],
        videos: { results: [] } };
    tmdbAnswers['/tv/1396/season/1'] = { name: 'Season 1', episodes: [{ episode_number: 1, name: 'Pilot', vote_average: 8.3 }] };
    calls.length = 0;
    const tv = await handlers['get-tmdb-tv']({}, { id: 1396, language: 'en-US' });
    assert.strictEqual(tv.source, 'raggae');
    assert.strictEqual(tv.data.seasons[0].episode_count, 7);
    assert.strictEqual(tv.data.external_ids.imdb_id, 'tt0903747');
    const s1 = await handlers['get-tmdb-tv-season']({}, { id: 1396, seasonNumber: 1, language: 'en-US' });
    assert.strictEqual(s1.source, 'raggae');
    assert.strictEqual(s1.data.episodes[0].name, 'Pilot');
    assert.strictEqual(outside().length, 2);
    calls.length = 0;
    const again = await handlers['get-tmdb-tv-season']({}, { id: 1396, seasonNumber: 1, language: 'en-US' });
    assert.strictEqual(again.data.episodes[0].name, 'Pilot');
    assert.strictEqual(outside().length, 0, 'season served from the catalog');
    assert.ok(items.get('imdb:tt0903747').raw_enrichment.tmdb['en-US'].seasons, 'the season list survived the season merge');
});

test('unknown everywhere: a plain failure, no made-up "Offline Fallback" title', async () => {
    const r = await handlers['get-tmdb-movie']({}, { id: 999999, language: 'en-US' });
    assert.strictEqual(r.success, false);
});

// ---- Discover / trending ---------------------------------------------------------------------------------------
test('discover reads the stored list, filters it locally, and never calls TMDB', async () => {
    items.set('imdb:tt1', { catalog_id: 'imdb:tt1', category: 'movie', title: 'Old Western', year: 1965, rating: 7.9,
                            genres: ['Western'], external_ids: { tmdb: 11 }, raw_enrichment: { tmdb: { meta: { origin_country: ['US'] } } } });
    items.set('imdb:tt2', { catalog_id: 'imdb:tt2', category: 'movie', title: 'New Drama', year: 2023, rating: 6.1,
                            genres: ['Drama'], external_ids: { tmdb: 12 }, raw_enrichment: { tmdb: { meta: { origin_country: ['FR'] } } } });
    lists.set('vs:discover:movie:8:CA', ['imdb:tt2', 'imdb:tt1', 'imdb:tt0133093']);
    calls.length = 0;
    const all = await handlers['discover-tmdb']({}, { providerId: '8', mediaType: 'movie', watchRegion: 'CA' });
    assert.deepStrictEqual(all.results.map(r => r.title), ['New Drama', 'Old Western', 'The Matrix']);
    const western = await handlers['discover-tmdb']({}, { providerId: '8', mediaType: 'movie', watchRegion: 'CA', withGenres: 'wes' });
    assert.deepStrictEqual(western.results.map(r => r.title), ['Old Western']);
    const sixties = await handlers['discover-tmdb']({}, { providerId: '8', mediaType: 'movie', watchRegion: 'CA', decade: '1960' });
    assert.deepStrictEqual(sixties.results.map(r => r.title), ['Old Western']);
    const french = await handlers['discover-tmdb']({}, { providerId: '8', mediaType: 'movie', watchRegion: 'CA', region: 'FR' });
    assert.deepStrictEqual(french.results.map(r => r.title), ['New Drama']);
    const topRated = await handlers['discover-tmdb']({}, { providerId: '8', mediaType: 'movie', watchRegion: 'CA', sort: 'vote_average.desc' });
    assert.strictEqual(topRated.results[0].title, 'The Matrix');
    assert.strictEqual(all.results[0].id, 12, 'cards carry the TMDB id the rest of the app uses');
    assert.strictEqual(outside().length, 0);
});

test('trending reads its list; with no list it falls back to the catalog browse', async () => {
    lists.set('vs:trending:all:day', ['imdb:tt0903747', 'imdb:tt0133093']);
    const r = await handlers['search-tmdb']({}, { query: '', page: 1 });
    assert.deepStrictEqual(r.results.map(c => c.title), ['Breaking Bad', 'The Matrix']);
    assert.strictEqual(r.results[0].media_type, 'tv');
    const none = await handlers['discover-tmdb']({}, { providerId: '337', mediaType: 'tv', watchRegion: 'JP' });
    assert.strictEqual(none.list, false);
});

// ---- trailers --------------------------------------------------------------------------------------------------
test('trailer key: KinoCheck once, then index + catalog; a miss is remembered', async () => {
    kinoAnswers['603'] = { trailer: { youtube_video_id: 'm8e-FF8MsqU', title: 'The Matrix trailer' } };
    calls.length = 0;
    const first = await trailers.resolveKey({ id: 603, mediaType: 'movie', language: 'en-US' });
    // KinoCheck is skipped when no key file exists on this machine; TMDB's catalog copy then answers
    assert.ok(first.success && ['m8e-FF8MsqU', 'vKQi3bBA1y8'].includes(first.key), JSON.stringify(first));
    await settle();
    const onItem = items.get('imdb:tt0133093').raw_enrichment.trailer['en-US'];
    assert.strictEqual(onItem.youtube_id, first.key, 'the key is kept on the catalog item');
    calls.length = 0;
    const second = await trailers.resolveKey({ id: 603, mediaType: 'movie', language: 'en-US' });
    assert.strictEqual(second.key, first.key);
    assert.strictEqual(second.cached, true);
    assert.strictEqual(outside().length, 0, 'no outside request the second time');

    const miss = await trailers.resolveKey({ id: 424242, mediaType: 'movie', language: 'en-US' });
    assert.strictEqual(miss.success, false);
    calls.length = 0;
    const missAgain = await trailers.resolveKey({ id: 424242, mediaType: 'movie', language: 'en-US' });
    assert.strictEqual(missAgain.cached, true);
    assert.strictEqual(outside().length, 0, 'a miss is not asked again within the week');
});

test('trailer file: an existing local copy is served without yt-dlp, as file:// and /trailers/', async () => {
    const id = 'vKQi3bBA1y8';
    fs.writeFileSync(path.join(process.env.TRAILER_CACHE_DIR, `${id}.mp4`), Buffer.alloc(1024));
    const r = await handlers['trailer-cache:get']({}, id);
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.cached, true);
    assert.ok(r.fileUrl.startsWith('file:///'));
    assert.strictEqual(r.httpPath, `/trailers/${id}.mp4`);
    const bad = await handlers['trailer-cache:get']({}, '../../etc/passwd');
    assert.strictEqual(bad.success, false, 'only YouTube ids');
    const stats = await handlers['trailer-cache:stats']();
    assert.strictEqual(stats.files, 1);
});

test('a failed download is remembered for a day (YouTube is not asked again)', async () => {
    const idx = path.join(process.env.TRAILER_CACHE_DIR, 'index.json');
    const j = JSON.parse(fs.readFileSync(idx, 'utf8'));
    j.downloads.AAAAAAAAAAA = { failed_at: new Date().toISOString(), error: 'HTTP 403' };
    fs.writeFileSync(idx, JSON.stringify(j));
    const r = await trailers.ensureFile('AAAAAAAAAAA');
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.cachedFailure, true);
});

// ---- Deepbrid --------------------------------------------------------------------------------------------------
test('Deepbrid: works without the tunnel (direct), magnet -> poll -> link; sizes parsed', async () => {
    process.env.DEEPBRID_API_TOKEN = 'test-deepbrid';
    const deepbrid = require('../src/deepbrid/client');
    const realFetch = global.fetch;
    const seen = [];
    global.fetch = async (url, opts = {}) => {
        url = String(url);
        seen.push({ url, auth: (opts.headers || {}).Authorization, body: opts.body });
        if (url.endsWith('/generate/link')) return json({ error: 0, link: 'https://premium-dl.deepbrid.test/d/x', filename: 'x.mkv', size: '1.50 GB' });
        if (url.endsWith('/torrents/add')) return json({ error: 0, id: '14648' });
        if (url.includes('/torrents/info?id=14648')) return json({ error: 0, status: 'downloaded', progress: 100, links: ['https://www.deepbrid.test/mytorrents?torrent=14648&file=a'] });
        return json({ error: 404 }, 404);
    };
    try {
        const r = await deepbrid.unrestrictLink('https://hoster.test/file', '');
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.download, 'https://premium-dl.deepbrid.test/d/x');
        assert.strictEqual(r.filesize, Math.round(1.5 * 1024 ** 3));
        assert.strictEqual(seen[0].auth, 'Bearer test-deepbrid');
        seen.length = 0;
        const m = await deepbrid.unrestrictMagnet('magnet:?xt=urn:btih:abc', '', 'abc');
        assert.strictEqual(m.success, true);
        assert.deepStrictEqual(seen.map(s => new URL(s.url).pathname), ['/api/v1/torrents/add', '/api/v1/torrents/info', '/api/v1/generate/link']);
    } finally {
        global.fetch = realFetch;
    }
    assert.strictEqual(deepbrid._parseSize('1.50 GB'), Math.round(1.5 * 1024 ** 3));
    assert.strictEqual(deepbrid._parseSize('n/a'), 0);
});

(async () => {
    let failed = 0;
    for (const [name, fn] of tests) {
        try {
            await fn();
            console.log(`✓ ${name}`);
        } catch (e) {
            failed++;
            console.error(`✗ ${name}\n  ${e.stack}`);
        }
    }
    fs.rmSync(process.env.TRAILER_CACHE_DIR, { recursive: true, force: true });
    if (failed) {
        console.error(`\n${failed} FAILED`);
        process.exit(1);
    }
    console.log('\nALL CATALOG READ-THROUGH TESTS PASSED');
})();
