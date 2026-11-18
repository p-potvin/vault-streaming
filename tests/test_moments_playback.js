// tests/test_moments_playback.js — the hand-over of a played stream to vault-raggae's Moments (src/ipc/moments.ipc.js).
// `fetch` is a fake gateway: nothing reaches vault-raggae.
//
//   node tests/test_moments_playback.js

const assert = require('assert');

process.env.RAGGAE_URL = 'http://raggae.test';
const posted = [];
global.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.pathname === '/v1/catalog/xref/tmdb/tv/1396') return json({ catalog_id: 'imdb:tt0903747', category: 'tv' });
    if (u.pathname === '/v1/catalog/xref/tmdb/movie/603') return json({ catalog_id: 'imdb:tt0133093', category: 'movie' });
    if (u.pathname.startsWith('/v1/catalog/xref/')) return json({ detail: 'nope' }, 404);
    if (u.pathname === '/v1/moments/stream') {
        posted.push(JSON.parse(opts.body));
        return json({ key: posted[posted.length - 1].key, state: 'queued', position: posted.length });
    }
    return json({ error: 'no route' }, 404);
};

const h = {};
require('../src/ipc/moments.ipc').registerMomentsIpc({ handle: (c, f) => { h[c] = f; } });
const { _episodeSuffix } = require('../src/ipc/moments.ipc');

(async () => {
    const ep = await h['moments:index-playback']({}, { url: 'https://comet.test/play/abc', tmdbId: 1396, mediaType: 'tv',
        season: 1, episode: 2, audioIndex: 1, language: 'fr', languageSource: 'title', durationSec: 2900, title: 'Breaking Bad' });
    assert.deepStrictEqual(ep, { success: true, key: 'stream:imdb:tt0903747:s01e02', state: 'queued' });
    assert.deepStrictEqual(posted[0], { key: 'stream:imdb:tt0903747:s01e02', url: 'https://comet.test/play/abc',
        catalog_id: 'imdb:tt0903747', title: 'Breaking Bad', audio_index: 1, language: 'fr', language_source: 'title', duration: 2900 });

    const film = await h['moments:index-playback']({}, { url: 'https://comet.test/play/m', tmdbId: 603, mediaType: 'movie' });
    assert.strictEqual(film.key, 'stream:imdb:tt0133093');
    assert.strictEqual(posted[1].language, 'und', 'no reported language: und, the job detects');

    const unknown = await h['moments:index-playback']({}, { url: 'https://comet.test/play/u', tmdbId: 999, mediaType: 'movie' });
    assert.strictEqual(unknown.key, 'stream:tmdb:movie:999', 'a title the catalog lacks is keyed by its TMDB id');

    const local = await h['moments:index-playback']({}, { url: 'G:\\Movies\\a.mkv', tmdbId: 603 });
    assert.strictEqual(local.success, false);
    assert.match(local.skipped, /not a stream/);
    assert.strictEqual(posted.length, 3, 'library files are not handed over');
    assert.strictEqual(_episodeSuffix(10, 3), ':s10e03');
    assert.strictEqual(_episodeSuffix(null, 3), '');
    console.log('✓ a played stream is queued under its catalog key (episode included), with its track and language');
    console.log('\nALL MOMENTS PLAYBACK TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
