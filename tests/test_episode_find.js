// tests/test_episode_find.js — find an episode by scene (src/raggae.js episodesByScene, vault-raggae
// GET /v1/pictures/episodes/{id}). `fetch` is replaced by a router: nothing reaches the live gateway.
//   node tests/test_episode_find.js

const assert = require('assert');

const calls = [];
let answer = () => null;
global.fetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u);
    const body = answer(u);
    if (body === null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const raggae = require('../src/raggae');

(async () => {
    // the card's TMDB id -> the catalog item -> its episodes; stills asked at w300
    answer = (u) => {
        if (u.pathname === '/v1/catalog/xref/tmdb/tv/1396') return { catalog_id: 'imdb:tt0903747' };
        if (u.pathname === '/v1/pictures/episodes/imdb:tt0903747') {
            return { hits: [
                { season: 2, episode: 9, name: '4 Days Out', overview: 'The RV.', air_date: '2009-05-03',
                  url: 'https://image.tmdb.org/t/p/w780/abc.jpg', score: 0.71 },
                { season: 3, episode: 6, name: 'Sunset', url: null },
                { season: 'x', episode: 1 },
            ] };
        }
        return null;
    };
    let res = await raggae.episodesByScene({ tmdbId: '1396', query: '  the RV in the desert  ' });
    let u = calls.at(-1);
    assert.strictEqual(u.pathname, '/v1/pictures/episodes/imdb:tt0903747');
    assert.strictEqual(u.searchParams.get('q'), 'the RV in the desert');
    assert.strictEqual(u.searchParams.get('k'), '6');
    assert.strictEqual(res.success, true);
    assert.deepStrictEqual(res.hits.map(h => `${h.season}x${h.episode}`), ['2x9', '3x6']);   // a bad row dropped
    assert.strictEqual(res.hits[0].still, 'https://image.tmdb.org/t/p/w300/abc.jpg');
    assert.strictEqual(res.hits[0].airDate, '2009-05-03');
    assert.strictEqual(res.hits[1].still, null);

    // web / iOS clients get the still through web/server.js's /api/img (the gateway's kept copy), never from TMDB
    const { toWebLinks } = require('../src/image-links');
    const web = JSON.parse(toWebLinks(JSON.stringify(res)));
    assert.strictEqual(web.hits[0].still,
        `/api/img?u=${encodeURIComponent('https://image.tmdb.org/t/p/w300/abc.jpg')}`);

    // the card's own catalog id goes straight to the route; an IMDb id is the last guess
    calls.length = 0;
    await raggae.episodesByScene({ catalogId: 'imdb:tt0903747', tmdbId: '1396', query: 'boat' });
    assert.deepStrictEqual(calls.map(c => c.pathname), ['/v1/pictures/episodes/imdb:tt0903747']);
    calls.length = 0;
    answer = (u) => (u.pathname === '/v1/pictures/episodes/imdb:tt0386676' ? { hits: [] } : null);
    res = await raggae.episodesByScene({ tmdbId: '2316', imdbId: 'tt0386676', query: 'dinner party' });
    assert.deepStrictEqual(calls.map(c => c.pathname),
        ['/v1/catalog/xref/tmdb/tv/2316', '/v1/pictures/episodes/imdb:tt0386676']);
    assert.deepStrictEqual(res, { success: true, hits: [] });

    // nothing asked, or no id at all: no request
    calls.length = 0;
    assert.deepStrictEqual(await raggae.episodesByScene({ tmdbId: '1', query: '   ' }), { success: true, hits: [] });
    assert.strictEqual(calls.length, 0);

    // the gateway says no (an older gateway without the route, a hidden title): success false
    answer = () => null;
    res = await raggae.episodesByScene({ catalogId: 'imdb:tt0903747', query: 'boat' });
    assert.strictEqual(res.success, false);

    console.log('✓ Find an episode by scene: catalog calls');
})().catch(err => { console.error(err); process.exit(1); });
