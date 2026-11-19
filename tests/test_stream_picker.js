// tests/test_stream_picker.js — which sources a play tries, and in what order.
// The fixture is Comet's real answer for Game of Thrones S01E01 (Thu 19 Nov 2026), links redacted: 71 entries, of
// which the old picker spent its 5 attempts on link-less torrents and the same torrent twice (RD + AllDebrid).
//
//   node tests/test_stream_picker.js

const assert = require('assert');
const path = require('path');

global.window = { appSettings: { streamLang: 'en' } };
global.el = () => null;
const { filterAndDedupe, episodeFit, isSyncEntry } = require('../src/realdebrid/candidates');
const { rankTorrents, buildPlayQueue, pickDeepbridSource, PLAY_QUEUE_MAX } = require('../js/streaming/ranking');
const raw = require(path.join(__dirname, 'fixtures', 'comet_got_s01e01.json'));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// What search.js hands the renderer, then what rd-flow.js does with it.
function pipeline(list, season = 1, episode = 1) {
    const torrents = filterAndDedupe(list).map(t => ({ ...t, magnet: t.hash ? `magnet:?xt=urn:btih:${t.hash}` : '', fit: episodeFit(`${t.desc} ${t.name}`, season, episode),
                                                       isRDCached: !!t.cached }));
    const ranked = rankTorrents(torrents);
    return { torrents, ranked, queue: buildPlayQueue(ranked) };
}

test('episode fit: single episode, ranges, season packs, other episodes', () => {
    const cases = [
        ['Game.of.Thrones.S01E01.Winter.Is.Coming.1080p', 'exact'],
        ['Game of Thrones S01 E01 1080p BluRay', 'exact'],
        ['Game of Thrones S01e01 L Inverno', 'exact'],
        ['Show 1x01 HDTV', 'exact'],
        ['Show S01E01-1080p', 'exact'],
        ['Game.of.Thrones.S01E01-10.BD1080P', 'pack'],
        ['Game Of Thrones 2011 S1E01-E05 Blu-Ray', 'pack'],
        ['Game of Thrones S01 E01-10 BluRay', 'pack'],
        ['Game of Thrones (2011) S01EP(01-10) [720p', 'pack'],
        ['Game.Of.Thrones.S01E01-02.UHDRip.2160p', 'pack'],
        ['Game of Thrones S01 Complete 1080p', 'pack'],
        ['Game of Thrones Season 1 1080p', 'pack'],
        ['Game.of.Thrones.S01E02.1080p', 'other'],
        ['Game.of.Thrones.S02E01.1080p', 'other'],
        ['Game of Thrones S02 1080p', 'other'],
        ['Game of Thrones 1080p BluRay', 'unknown'],
    ];
    for (const [text, want] of cases) assert.strictEqual(episodeFit(text, 1, 1), want, text);
    assert.strictEqual(episodeFit('Anything at all', null, null), 'exact', 'films always fit');
});

test('candidates: no sync actions, no AllDebrid/TorBox, one entry per torrent', () => {
    const { torrents } = pipeline(raw);
    assert.strictEqual(raw.length, 71);
    assert.ok(raw.some(isSyncEntry), 'the fixture has Comet Sync entries');
    assert.ok(!torrents.some(isSyncEntry), 'sync entries are not streams');
    assert.ok(!torrents.some(t => /^\[(AD|TB)/.test(t.name)), 'lapsed services are dropped');
    const hashes = torrents.map(t => t.hash);
    assert.strictEqual(new Set(hashes).size, hashes.length, 'one entry per hash');
    assert.strictEqual(torrents.length, 23, '23 distinct torrents');
    // a torrent listed both as [TORRENT🧲] and [RD…] keeps the Real-Debrid copy (it has a link)
    const ep = torrents.find(t => t.hash.startsWith('6c3fcaa6'));
    assert.ok(ep.url && ep.cached && ep.name.startsWith('[RD⚡]'));
});

test('play queue: cached first, then single episodes, packs last; every entry has a link', () => {
    const { queue } = pipeline(raw);
    assert.strictEqual(queue.length, PLAY_QUEUE_MAX);
    assert.ok(queue.every(t => t.url), 'no link-less attempts');
    assert.strictEqual(new Set(queue.map(t => t.hash)).size, queue.length, 'no duplicate attempts');
    assert.ok(queue[0].cached, 'the cached episode is tried first');
    assert.ok(queue.every(t => t.fit !== 'other'));
    // all 8 tries are the episode itself: there are enough single-episode releases to fill the queue
    assert.ok(queue.every(t => t.fit === 'exact'), queue.map(t => `${t.fit} ${t.desc}`).join('\n'));
});

test('play queue: an uncached pack only comes after every uncached single episode', () => {
    const { ranked } = pipeline(raw);
    const all = buildPlayQueue(ranked, { max: Infinity });
    const firstPack = all.findIndex(t => t.fit === 'pack');
    const lastExact = all.map(t => t.fit).lastIndexOf('exact');
    assert.ok(firstPack > lastExact, `pack at ${firstPack}, last episode at ${lastExact}`);
});

test('play queue: a manual pick goes first, once', () => {
    const { ranked } = pipeline(raw);
    const pick = ranked.find(t => t.fit === 'pack' && t.url);
    const q = buildPlayQueue(ranked, { pick });
    assert.strictEqual(q[0], pick);
    assert.strictEqual(q.filter(t => t.hash === pick.hash).length, 1);
});

test('play queue: without a cached copy the first try is a single episode, not a 30 GB pack', () => {
    const uncached = raw.map(t => ({ ...t, cached: false }));
    const { queue } = pipeline(uncached);
    assert.strictEqual(queue[0].fit, 'exact');
});

test('ranking: unknown seeders cost nothing', () => {
    const { scoreTorrent } = require('../js/streaming/ranking');
    const base = { quality: '1080p', desc: 'Show S01E01 1080p WEB-DL', size: '2 GB' };
    assert.strictEqual(scoreTorrent({ ...base, seeds: '—' }, 'en'), scoreTorrent({ ...base, seeds: undefined }, 'en'));
    assert.ok(scoreTorrent({ ...base, seeds: '0' }, 'en') < scoreTorrent({ ...base, seeds: '—' }, 'en'));
});

test('Deepbrid: a single episode before a pack; a link-less manual pick wins', () => {
    const { ranked } = pipeline(raw);
    assert.notStrictEqual(pickDeepbridSource(ranked).fit, 'pack');
    const bare = { magnet: 'magnet:?xt=urn:btih:abc', hash: 'abc', url: null, desc: 'Show S01E01', fit: 'exact' };
    assert.strictEqual(pickDeepbridSource(ranked, { pick: bare }), bare);
});

(async () => {
    let failed = 0;
    for (const [name, fn] of tests) {
        try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
    }
    console.log(`${tests.length - failed}/${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
