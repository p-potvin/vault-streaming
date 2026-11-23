// tests/test_ask.js — the Ask bar: the parser (js/streaming/ask.js) and the catalog calls it turns into
// (src/raggae.js ask, src/tmdb.js askCards). `fetch` is replaced by a router: nothing reaches the live gateway.
//
//   node tests/test_ask.js

const assert = require('assert');

process.env.TMDB_BEARER_TOKEN = 'test-token';
process.env.RAGGAE_URL = 'http://raggae.test';

const { parseAsk, dropPart, isEmpty } = require('../js/streaming/ask');

// ---- the parser --------------------------------------------------------------------------------------------
function read(s) { const a = parseAsk(s); return { ...a.filters, look: a.look }; }

assert.deepStrictEqual(read('90s heist in Paris, french'),
    { genres: [], yearMin: 1990, yearMax: 1999, look: 'heist in Paris french' });
assert.deepStrictEqual(read('war films before 1980'),
    { genres: ['War'], mediaType: 'movie', yearMax: 1979, look: '' });
assert.deepStrictEqual(read('the war on drugs'), { genres: [], look: 'war on drugs' });   // "war" alone stays words
assert.deepStrictEqual(read('sci-fi movies 2014 "time travel"'),
    { genres: ['Sci-Fi'], mediaType: 'movie', yearMin: 2014, yearMax: 2014, look: 'time travel' });
assert.deepStrictEqual(read('séries policières depuis 2015'),
    { genres: ['Crime'], mediaType: 'tv', yearMin: 2015, look: '' });
assert.deepStrictEqual(read('comédie musicale des années 80'),            // one genre, not Comedy + Musical
    { genres: ['Musical'], yearMin: 1980, yearMax: 1989, look: '' });
assert.deepStrictEqual(read("film d'épouvante"), { genres: ['Horror'], mediaType: 'movie', look: '' });
assert.deepStrictEqual(read('comédies drôles'), { genres: ['Comedy'], look: '' });     // two words, one genre
assert.deepStrictEqual(read('after 2010 heist'), { genres: [], yearMin: 2010, look: 'heist' });
assert.deepStrictEqual(read('« la haine »'), { genres: [], look: 'la haine' });          // quotes kept as written
assert.strictEqual(read('television').mediaType, undefined);                             // "tv" inside a word
// review of #32: a filter word is cut where it stands, not inside an earlier word
assert.deepStrictEqual(read('extraction action movies'), { genres: ['Action'], mediaType: 'movie', look: 'extraction' });
// only joining words left: no question, the filters alone list titles
assert.deepStrictEqual(read('films de science fiction des années 90'),
    { genres: ['Sci-Fi'], mediaType: 'movie', yearMin: 1990, yearMax: 1999, look: '' });
// quoted words stay where they were typed
assert.strictEqual(read('movies like "Alien" but underwater').look, 'like Alien but underwater');

const asked = parseAsk('90s comedy series in Montreal');
assert.deepStrictEqual(asked.parts.map(p => p.key), ['genre:Comedy', 'kind', 'year', 'look']);
const noYear = dropPart(asked, 'year');
assert.strictEqual(noYear.filters.yearMin, undefined);
assert.deepStrictEqual(noYear.parts.map(p => p.key), ['genre:Comedy', 'kind', 'look']);
assert.strictEqual(dropPart(asked, 'look').look, '');
assert.ok(isEmpty(parseAsk('   ')));
assert.ok(isEmpty(['genre:Comedy', 'kind', 'year', 'look'].reduce(dropPart, asked)));

// ---- the catalog calls -----------------------------------------------------------------------------------------
const calls = [];
let answer = () => ({ results: [] });
global.fetch = async (url) => {
    calls.push(new URL(String(url)));
    const body = answer(new URL(String(url)));
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const raggae = require('../src/raggae');
const tmdb = require('../src/tmdb');

const item = (id, extra = {}) => ({ catalog_id: `imdb:${id}`, category: 'movie', title: id, year: 1995,
    genres: ['Crime', 'Drama'], votes: 5000, external_ids: { imdb: id }, ...extra });

(async () => {
    // words + meaning: hybrid search with the filters, a vote floor, the toolbar's kind
    answer = () => ({ results: [item('tt0113277'), item('tt0000001', { year: 1975 })] });
    let items = await raggae.ask({ look: 'heist in Paris', mediaType: 'movie', yearMin: 1990, yearMax: 1999,
        genres: ['Crime'] });
    let u = calls.at(-1);
    assert.strictEqual(u.pathname, '/v1/catalog/search');
    assert.strictEqual(u.searchParams.get('mode'), 'hybrid');
    assert.strictEqual(u.searchParams.get('q'), 'heist in Paris');
    assert.strictEqual(u.searchParams.get('category'), 'movie');
    assert.strictEqual(u.searchParams.get('year_min'), '1990');
    assert.strictEqual(u.searchParams.get('year_max'), '1999');
    assert.strictEqual(u.searchParams.get('genre'), 'Crime');
    assert.strictEqual(u.searchParams.get('min_votes'), '1250');   // films: under the gateway's 60k exact-scan set
    // an older gateway ignores the filters: the 1975 title is dropped here
    assert.deepStrictEqual(items.map(i => i.catalog_id), ['imdb:tt0113277']);

    // filters only: the most voted titles of that kind
    answer = () => ({ items: [item('tt0111161', { category: 'tv' })] });
    items = await raggae.ask({ mediaType: 'tv', genres: ['Drama', 'Crime'] });
    u = calls.at(-1);
    assert.strictEqual(u.pathname, '/v1/catalog/browse');
    assert.strictEqual(u.searchParams.get('category'), 'tv');
    assert.strictEqual(u.searchParams.get('sort'), 'votes');
    assert.strictEqual(u.searchParams.get('genre'), 'Drama,Crime');
    assert.strictEqual(u.searchParams.get('q'), null);
    assert.strictEqual(u.searchParams.get('min_votes'), '250');                                     // series
    assert.strictEqual(items.length, 1);

    // cards: shaped like every catalog row; posterless titles go last
    answer = () => ({ results: [item('tt1'), item('tt2', { poster_url: 'https://image.tmdb.org/t/p/w500/a.jpg' })] });
    const cards = await tmdb.askCards({ look: 'anything', mediaType: 'movie' });
    assert.strictEqual(cards.success, true);
    assert.deepStrictEqual(cards.results.map(c => c.imdb_id), ['tt2', 'tt1']);
    assert.strictEqual(cards.results[0].source, 'raggae');

    // the gateway does not answer: success false, so the grid says the catalog is down rather than "no results"
    answer = () => null;
    global.fetch = async (url) => { calls.push(new URL(String(url))); return { ok: false, status: 503, json: async () => ({}) }; };
    const down = await tmdb.askCards({ look: 'anything' });
    assert.strictEqual(down.success, false);

    console.log('✓ Ask bar: parser and catalog calls');
})().catch(err => { console.error(err); process.exit(1); });
