// tests/test_who_is_this.js — who is this on the paused frame (src/raggae.js facesWho, src/ipc/moments.ipc.js
// whoIsThis; vault-raggae POST /v1/faces/who). `fetch` is replaced by a router: nothing reaches the live gateway.
//   node tests/test_who_is_this.js

const assert = require('assert');

const calls = [];
let answer = () => null;
global.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ u, init });
    const body = answer(u, init);
    if (body === null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const raggae = require('../src/raggae');
const { whoIsThis } = require('../src/ipc/moments.ipc');

const T = 'https://image.tmdb.org/t/p/h632/pacino.jpg';

(async () => {
    answer = (u) => {
        if (u.pathname === '/v1/catalog/xref/tmdb/movie/238') return { catalog_id: 'imdb:tt0068646' };
        if (u.pathname === '/v1/faces/who') {
            return { width: 1920, height: 1080, cast_linked: 3, faces: [
                { bbox: [100, 50, 300, 300], best: { name: 'Al Pacino', character: 'Michael Corleone', in_cast: true,
                  match: false, score: 0.47, img: `/v1/img?u=${encodeURIComponent(T)}` } },
                { bbox: [900, 60, 1000, 200], best: null },
                { bbox: [1, 2, 3] },
            ] };
        }
        return null;
    };

    // the window's canvas frame: posted as JPEG bytes, with the title's catalog id
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    let res = await whoIsThis({ image: `data:image/jpeg;base64,${jpeg.toString('base64')}`, tmdbId: '238',
                                mediaType: 'movie' });
    const post = calls.find(c => c.u.pathname === '/v1/faces/who');
    assert.ok(post, 'posted to /v1/faces/who');
    assert.strictEqual(post.init.method, 'POST');
    assert.strictEqual(post.init.headers['Content-Type'], 'image/jpeg');
    assert.deepStrictEqual(Buffer.from(post.init.body), jpeg);
    assert.strictEqual(post.u.searchParams.get('title'), 'imdb:tt0068646');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.castLinked, 3);
    assert.strictEqual(res.faces.length, 2);                                  // the 3-number box dropped
    assert.deepStrictEqual(res.faces[0], {
        bbox: [100, 50, 300, 300], name: 'Al Pacino', character: 'Michael Corleone', inCast: true, match: false,
        score: 0.47, picture: 'https://image.tmdb.org/t/p/w185/pacino.jpg',
    });
    assert.strictEqual(res.faces[1].name, null);

    // no frame (no canvas image, no http source): nothing is posted
    calls.length = 0;
    res = await whoIsThis({ url: 'blob:abc', t: 10, tmdbId: '238', mediaType: 'movie' });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.error, 'no-frame');
    assert.ok(!calls.some(c => c.u.pathname === '/v1/faces/who'));

    // a gateway from before 0.42.0 has no such route
    answer = () => null;
    res = await raggae.facesWho(jpeg);
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.error, 'not-live');
    assert.strictEqual(calls.at(-1).u.searchParams.get('title'), null);

    // a picture link from elsewhere is not shown
    assert.strictEqual(raggae._profilePicture('/v1/img?u=https%3A%2F%2Fexample.com%2Fx.jpg'), null);
    assert.strictEqual(raggae._profilePicture(null), null);

    console.log('test_who_is_this: ok');
})().catch((e) => { console.error(e); process.exit(1); });
