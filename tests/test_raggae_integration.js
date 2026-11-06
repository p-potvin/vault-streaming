// tests/test_raggae_integration.js — the local catalog first, TMDB / OMDb after, and the sidecar contract.
// Self-contained: `fetch` is replaced by a router, so nothing reaches the live gateway, TMDB or OMDb, and nothing is
// written to the real catalog (an earlier version ingested a made-up film into G:\Catalogs\vw-catalog.db).
//
//   node tests/test_raggae_integration.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TMDB_BEARER_TOKEN = 'test-token';
process.env.OMDB_API_KEY = 'test-omdb-key';
process.env.RAGGAE_URL = 'http://raggae.test';

// ---- the fake network ------------------------------------------------------------------------------------------
const calls = [];
let routes = [];
function json(body, status = 200) {
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}
global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null,
                 headers: opts.headers || {} });
    for (const [match, answer] of routes) {
        if (match(String(url), opts)) return typeof answer === 'function' ? answer(String(url), opts) : answer;
    }
    return json({ error: 'no route' }, 404);
};
const has = s => url => url.includes(s);
const settle = () => new Promise(r => setTimeout(r, 20));      // fire-and-forget ingests
const ingested = () => calls.filter(c => c.url.includes('/v1/catalog/ingest')).flatMap(c => c.body.items);

const raggae = require('../src/raggae');
const handlers = {};
require('../src/tmdb').registerTmdbHandlers({ handle: (ch, fn) => { handlers[ch] = fn; } });
const { _internals } = require('../src/tmdb');

function item(id, title, category, extra = {}) {
    return { catalog_id: `imdb:${id}`, title, category, year: 1999, votes: 0, genres: ['Drama'],
             external_ids: { imdb: id }, ...extra };
}

async function run(name, fn) {
    calls.length = 0;
    routes = [];
    raggae.markOnline();
    _internals.localSearchCache.clear();
    _internals.tmdbIdCache.clear();
    await fn();
    console.log(`✓ ${name}`);
}

(async () => {
    await run('an HTTP error does not trip the circuit breaker; a network failure does', async () => {
        routes = [[has('/v1/catalog/search'), json({ error: 'busy' }, 503)]];
        assert.deepStrictEqual(await raggae.search('x', { category: 'movie' }), []);
        assert.strictEqual(raggae.isOffline(), false);
        global.fetchBackup = global.fetch;
        global.fetch = async () => { throw new TypeError('fetch failed'); };
        assert.deepStrictEqual(await raggae.search('x'), []);
        assert.strictEqual(raggae.isOffline(), true);
        global.fetch = global.fetchBackup;
        raggae.markOnline();
        routes = [[has('/v1/media/by-path'), json({ detail: 'not in the media index' }, 404)]];
        assert.strictEqual(await raggae.byPath('C:\\x.mp4'), null);
        assert.strictEqual(raggae.isOffline(), false);
        assert.ok(calls.every(c => c.headers['X-VW-Project'] === 'vault-streaming'), 'every call names the project');
    });

    await run('local search asks for films and series only, exact titles then votes first', async () => {
        routes = [[has('/v1/catalog/search'), url => json({ results: url.includes('category=tv')
            ? [item('tt9', 'The Matrix Show', 'tv', { votes: 50 })]
            : [item('tt1', 'Rifftrax: The Matrix', 'movie', { votes: 28 }), item('tt0133093', 'The Matrix', 'movie', { votes: 2000000 })] })]];
        const hits = await raggae.searchTitles('the matrix');
        const cats = calls.map(c => new URL(c.url).searchParams.get('category')).sort();
        assert.deepStrictEqual(cats, ['movie', 'tv'], 'no music / book / adult search');
        assert.deepStrictEqual(hits.map(h => h.catalog_id), ['imdb:tt0133093', 'imdb:tt9', 'imdb:tt1']);
    });

    await run('enough local hits: TMDB is not asked; cards carry the IMDb id for the TMDB handlers', async () => {
        routes = [[has('/v1/catalog/search'), url => json({ results: url.includes('category=movie')
            ? [item('tt0133093', 'The Matrix', 'movie', { votes: 2000000 })] : [] })]];
        const r = await handlers['search-tmdb'](null, { query: 'the matrix' });
        assert.strictEqual(r.source, 'raggae');
        assert.strictEqual(r.results[0].id, 'tt0133093');
        assert.strictEqual(r.results[0].media_type, 'movie');
        assert.ok(!calls.some(c => c.url.includes('themoviedb.org')), 'no TMDB call');
        // Load more: TMDB page 1, without the title page 1 already showed
        routes.push([has('api.themoviedb.org/3/search/multi'), json({ results: [
            { id: 603, media_type: 'movie', title: 'The Matrix', release_date: '1999-03-31' },
            { id: 604, media_type: 'movie', title: 'The Matrix Reloaded', release_date: '2003-05-15' }] })]);
        const p2 = await handlers['search-tmdb'](null, { query: 'the matrix', page: 2 });
        assert.deepStrictEqual(p2.results.map(x => x.id), [604]);
        assert.ok(calls.some(c => c.url.includes('search/multi') && c.url.includes('page=1')));
        assert.strictEqual(calls.filter(c => c.url.includes('/v1/catalog/search')).length, 2, 'local hits cached');
    });

    await run('thin local answer: TMDB fills in after it; TMDB search hits are not ingested', async () => {
        routes = [
            [has('/v1/catalog/search'), url => json({ results: url.includes('category=movie')
                ? [item('tt5', 'Obscure Film', 'movie', { votes: 12, year: 2001 })] : [] })],
            [has('api.themoviedb.org/3/search/multi'), json({ results: [
                { id: 1, media_type: 'movie', title: 'Obscure Film', release_date: '2001-01-01' },
                { id: 2, media_type: 'tv', name: 'Obscure Show', first_air_date: '2010-01-01' },
                { id: 3, media_type: 'person', name: 'Someone' }] })],
        ];
        const r = await handlers['search-tmdb'](null, { query: 'obscure' });
        assert.strictEqual(r.source, 'raggae+tmdb');
        assert.deepStrictEqual(r.results.map(x => [x.source, x.id]), [['raggae', 'tt5'], ['tmdb', 2]]);
        await settle();
        assert.deepStrictEqual(ingested(), [], 'TMDB hits have no IMDb id: no tmdb: duplicates');
    });

    await run('OMDb fallback ingests real facts only, keyed on the IMDb id; the key is not logged', async () => {
        const logs = [];
        const log = console.log;
        console.log = (...a) => logs.push(a.join(' '));
        routes = [
            [has('/v1/catalog/search'), json({ results: [] })],
            [has('api.themoviedb.org'), json({ results: [] })],
            [has('omdbapi.com'), json({ Response: 'True', Search: [
                { Title: 'A Series', Year: '2015', imdbID: 'tt7', Type: 'series', Poster: 'https://m.media-amazon.com/p.jpg' },
                { Title: 'A Game', Year: '2016', imdbID: 'tt8', Type: 'game', Poster: 'N/A' }] })],
            [has('/v1/catalog/ingest'), json({ saved: true })],
        ];
        const r = await handlers['search-tmdb'](null, { query: 'a series' });
        console.log = log;
        assert.strictEqual(r.source, 'omdb');
        assert.deepStrictEqual(r.results.map(x => x.id), ['tt7'], 'games are not titles to stream');
        await settle();
        const sent = ingested();
        assert.deepStrictEqual(sent, [{ category: 'tv', title: 'A Series', year: 2015, poster_url: 'https://m.media-amazon.com/p.jpg',
                                        external_ids: { imdb: 'tt7' }, source: 'omdb' }]);
        assert.ok(calls.some(c => c.url.startsWith('https://www.omdbapi.com/')), 'https');
        assert.ok(!logs.join('\n').includes('test-omdb-key') && logs.join('\n').includes('apikey=***'));
    });

    await run('movie details for an IMDb id: mapped through TMDB /find, ingested on the IMDb item', async () => {
        routes = [
            [has('/3/find/tt0133093'), json({ movie_results: [{ id: 603, title: 'The Matrix' }], tv_results: [] })],
            [has('/3/movie/603'), json({ id: 603, imdb_id: 'tt0133093', title: 'The Matrix', release_date: '1999-03-31',
                                          overview: 'Neo.', genres: [{ name: 'Action' }], videos: { results: [{ key: 'k' }] } })],
            [has('/v1/catalog/ingest'), json({ saved: true })],
        ];
        const r = await handlers['get-tmdb-movie'](null, { id: 'tt0133093' });
        assert.strictEqual(r.data.id, 603);
        await settle();
        const sent = ingested();
        assert.ok(sent.every(i => i.external_ids.imdb === 'tt0133093' && i.category === 'movie'), JSON.stringify(sent));
        // a second open does not ask /find again
        await handlers['get-tmdb-movie'](null, { id: 'tt0133093' });
        assert.strictEqual(calls.filter(c => c.url.includes('/3/find/')).length, 1);
    });

    await run('a title TMDB cannot give comes from the catalog in the TMDB shape', async () => {
        routes = [
            [has('/3/find/'), json({ movie_results: [], tv_results: [] })],
            [has('/v1/catalog/imdb:tt42'), json(item('tt42', 'Local Only', 'tv', { overview: 'Only here.' }))],
        ];
        const r = await handlers['get-tmdb-tv'](null, { id: 'tt42' });
        assert.strictEqual(r.source, 'raggae');
        assert.strictEqual(r.data.name, 'Local Only');
        assert.strictEqual(r.data.overview, 'Only here.');
    });

    await run('TV details ask TMDB for the IMDb id, so the ingest lands on the IMDb item', async () => {
        routes = [
            [has('/3/tv/1396'), url => json({ id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20',
                                                external_ids: url.includes('external_ids') ? { imdb_id: 'tt0903747' } : {} })],
            [has('/v1/catalog/ingest'), json({ saved: true })],
        ];
        await handlers['get-tmdb-tv'](null, { id: 1396 });
        await settle();
        assert.deepStrictEqual(ingested()[0].external_ids, { tmdb: 1396, imdb: 'tt0903747' });
    });

    await run('details by IMDb id read that exact item; a bare title is resolved with its year', async () => {
        routes = [[has('/v1/catalog/imdb:tt1160419'), json(item('tt1160419', 'Dune', 'movie', {
            year: 2021, cast_or_credits: ['Denis Villeneuve (director)', 'Timothée Chalamet'] }))],
                  [has('/v1/resolve'), json({ item: item('tt0087182', 'Dune', 'movie', { year: 1984 }) })]];
        const byId = await handlers['get-omdb-details'](null, { imdbId: 'tt1160419', title: 'Dune' });
        assert.strictEqual(byId.data.year, '2021');
        assert.strictEqual(byId.data.director, 'Denis Villeneuve');
        assert.ok(!calls.some(c => c.url.includes('/v1/resolve')), 'no title guess when the id is known');
        await handlers['get-omdb-details'](null, { title: 'Dune', year: '1984' });
        const resolveBody = calls.find(c => c.url.includes('/v1/resolve')).body;
        assert.strictEqual(resolveBody.name, 'Dune 1984');
    });

    await run('properties follow the sidecar contract', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-props-'));
        try {
            const props = {};
            require('../src/ipc/media.ipc').registerMediaIpc({ handle: (ch, fn) => { props[ch] = fn; } });
            const get = p => props['get-file-properties'](null, p);
            routes = [[has('/v1/media/by-path'), json({ vw_id: '01ABC', fingerprints: { oshash: 'h' },
                                                        catalog_file: { duration: 50, fps: 30 } })]];

            // a v2 record: its root ffprobe keys are read, the file facts come from the file, nothing is written
            const v = path.join(dir, 'clip.mp4');
            fs.writeFileSync(v, 'not a real video');
            const rec = { schema: 2, vw: { id: '01ABC', kind: 'video' }, master: { basename: 'clip.mp4' },
                          duration: 12.5, width: 1920, height: 1080, hasVideo: true, codec: 'h264' };
            fs.writeFileSync(v + '.json', JSON.stringify(rec));
            const r = await get(v);
            assert.strictEqual(r.properties.width, 1920);
            assert.strictEqual(r.properties.duration, 12.5);
            assert.strictEqual(r.properties.fps, 30, 'media index catalog_file fills what is missing');
            assert.strictEqual(r.properties.raggae.vwId, '01ABC');
            assert.deepStrictEqual(JSON.parse(fs.readFileSync(v + '.json', 'utf8')), rec, 'sidecar untouched');

            // a stem sidecar shared with a poster belongs to no one: never read as the video's
            const w = path.join(dir, 'movie.mp4');
            fs.writeFileSync(w, 'x');
            fs.writeFileSync(path.join(dir, 'movie.jpg'), 'x');
            fs.writeFileSync(path.join(dir, 'movie.json'), JSON.stringify({ width: 999 }));
            const r2 = await get(w);
            assert.notStrictEqual(r2.properties.width, 999);
            assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'movie.json'), 'utf8')), { width: 999 });
            assert.ok(!fs.existsSync(w + '.meta.json'), 'no legacy .meta.json written');

            // a real video with no sidecar: probed, and the probe saved as a v2 record under the canonical name
            const real = path.join(dir, 'real.mp4');
            const made = require('child_process').spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
                'testsrc=size=320x240:rate=25:duration=1', '-pix_fmt', 'yuv420p', '-y', real]);
            if (made.status === 0) {
                const r3 = await get(real);
                assert.strictEqual(r3.properties.width, 320);
                const saved = JSON.parse(fs.readFileSync(real + '.json', 'utf8'));
                assert.strictEqual(saved.schema, 2);
                assert.strictEqual(saved.vw.kind, 'video');
                assert.strictEqual(saved.width, 320);
                assert.ok(!('path' in saved) && !('name' in saved), 'file facts are not stored');
                assert.ok(!fs.existsSync(real + '.meta.json'));
            } else {
                console.log('  (ffmpeg not available: the probe-and-save case was skipped)');
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    console.log('\nALL VAULT-STREAMING RAGGAE INTEGRATION TESTS PASSED');
})().catch(err => {
    console.error('✗ FAILED:', err);
    process.exit(1);
});
