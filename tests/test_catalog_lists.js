// tests/test_catalog_lists.js — catalog lists and TMDB type handling in src/tmdb.js, offline (TMDB and the vault-raggae
// gateway are stubbed; nothing leaves the machine).
//
//   node tests/test_catalog_lists.js

const assert = require('assert');
const raggae = require('../src/raggae');

// ── stubs ────────────────────────────────────────────────────────────────────
const fetched = [];
let tmdbRoutes = {};                      // url prefix (no query) -> JSON body; anything else 404s
global.fetch = async url => {
    const bare = String(url).replace(/\?.*$/, '');
    fetched.push(bare.replace('https://api.themoviedb.org/3', ''));
    const key = Object.keys(tmdbRoutes).find(k => bare.endsWith(k));
    return key ? { ok: true, status: 200, json: async () => tmdbRoutes[key] }
        : { ok: false, status: 404, json: async () => ({}) };
};
const ingested = [];
raggae.ingest = async items => {
    const list = Array.isArray(items) ? items : [items];
    ingested.push(...list);
    return { items: list.map(i => ({ catalog_id: i.catalog_id || 'imdb:tt0' })) };
};
let catalogItem = null;
raggae.getItem = async () => catalogItem;
raggae.byExternal = async () => catalogItem;
raggae.getList = async () => null;

const tmdb = require('../src/tmdb');
const handlers = {};
tmdb.registerTmdbHandlers({ handle: (name, fn) => { handlers[name] = fn; } });

const row = (n, poster, extra = {}) => ({
    catalog_id: `imdb:tt${n}`, category: 'movie', title: `Title ${n}`, year: 2000, votes: 5000,
    poster_url: poster ? `https://image.tmdb.org/t/p/w780/${n}.jpg` : null, external_ids: { imdb: `tt${n}` }, ...extra,
});

(async () => {
    // 1. A stretch of posterless rows does not end the list: page 1 is filled from later rows, page 2 follows it
    const rows = [...Array.from({ length: 60 }, (_, i) => row(1000 + i, false)), ...Array.from({ length: 50 }, (_, i) => row(2000 + i, true))];
    raggae.browse = async ({ offset, limit }) => rows.slice(offset, offset + limit);
    const p1 = await tmdb._internals.discoverFromCatalog({ providerId: 'all', mediaType: 'movie', page: 1, withGenres: 'all', sort: 'vote_average.desc', watchRegion: 'CA' });
    const p2 = await tmdb._internals.discoverFromCatalog({ providerId: 'all', mediaType: 'movie', page: 2, withGenres: 'all', sort: 'vote_average.desc', watchRegion: 'CA' });
    assert.strictEqual(p1.results.length, 20, 'page 1 is full despite 60 posterless rows first');
    assert.strictEqual(p2.results.length, 20, 'page 2 is full');
    const ids = [...p1.results, ...p2.results].map(c => c.catalog_id);
    assert.strictEqual(new Set(ids).size, 40, 'no title on both pages');
    assert.ok(ids.every(id => Number(id.slice(7)) >= 2000), 'no posterless title');
    console.log('✓ discover fills pages past posterless rows, pages do not overlap');

    // 2. A numeric id whose catalog item says tmdb_type movie is fetched as /movie/, not /tv/
    catalogItem = { ...row(3001, true), category: 'tv', external_ids: { imdb: 'tt3001', tmdb: 123, tmdb_type: 'movie' } };
    tmdbRoutes = { '/movie/123': { id: 123, title: 'A special', release_date: '2021-01-01' }, '/tv/123': { id: 123, name: 'Another show' } };
    fetched.length = 0;
    const special = await tmdb.readThroughDetails('123', 'tv', 'fr-FR');
    assert.deepStrictEqual(fetched, ['/movie/123'], 'fetched as its stored type only');
    assert.ok(special && special.success);
    console.log('✓ a numeric id is fetched as the catalog item\'s stored tmdb_type');

    // 3. An untyped stored id that 404s: /find decides. Same number of the other type: taken. Another id: not taken.
    catalogItem = { ...row(3002, true), category: 'tv', external_ids: { imdb: 'tt3002', tmdb: 456 } };
    tmdbRoutes = { '/find/tt3002': { movie_results: [{ id: 456, title: 'A special' }], tv_results: [] }, '/movie/456': { id: 456, title: 'A special' } };
    fetched.length = 0;
    await tmdb.readThroughDetails('imdb:tt3002', 'tv', 'en-US');
    assert.deepStrictEqual(fetched, ['/tv/456', '/find/tt3002', '/movie/456']);
    catalogItem = { ...row(3003, true), category: 'tv', external_ids: { imdb: 'tt3003', tmdb: 789 } };
    tmdbRoutes = { '/find/tt3003': { movie_results: [{ id: 999, title: 'Other' }], tv_results: [] }, '/movie/999': { id: 999, title: 'Other' } };
    fetched.length = 0;
    await tmdb.readThroughDetails('imdb:tt3003', 'tv', 'en-US');
    assert.deepStrictEqual(fetched, ['/tv/789', '/find/tt3003'], 'a different id from /find is not fetched');
    console.log('✓ an untyped stored id is re-checked with /find, and only the same number is taken');

    // 4. Search: a posterless local hit shown on page 1 is not repeated when TMDB returns it on page 2
    catalogItem = null;
    raggae.searchTitles = async () => [row(4001, true, { title: 'Example', votes: 700 }), row(4002, false, { title: 'Example Bare', year: 2001, votes: 700 })];
    tmdbRoutes = { '/search/multi': { results: [{ id: 77, media_type: 'movie', title: 'Example Bare', release_date: '2001-05-01', poster_path: null }] } };
    const s1 = await handlers['search-tmdb'](null, { query: 'example', page: 1 });
    const s2 = await handlers['search-tmdb'](null, { query: 'example', page: 2 });
    const shown1 = s1.results.map(c => `${c.title}|${c.year}`);
    const shown2 = s2.results.map(c => `${c.title}|${c.year}`);
    assert.ok(shown1.includes('Example Bare|2001'), 'page 1 shows the posterless hit (last)');
    assert.ok(!shown2.includes('Example Bare|2001'), 'page 2 does not repeat it');
    console.log('✓ search does not repeat a posterless local hit on later pages');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
