// tests/test_series_resume.js — offline checks for opening a series on the episode to resume (or the next one).
//
//   node tests/test_series_resume.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// The watch history's IPC handlers on a throwaway folder (never the operator's real history).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-series-'));
const handlers = {};
require('../src/watch-history').registerWatchHistoryHandlers(
    { handle: (name, fn) => { handlers[name] = (arg) => fn(null, arg); } },
    { getPath: () => dir });

// The picker lives in the renderer module; load it with a minimal DOM.
global.window = {};
global.document = { addEventListener() {}, getElementById: () => null };
global.el = () => null;
const src = fs.readFileSync(path.join(__dirname, '../js/streaming/details-modal.js'), 'utf8').replace(/\r\n/g, '\n');
const grab = (n) => { const i = src.indexOf(`function ${n}(`); return src.slice(i, src.indexOf('\n}\n', i) + 3); };
const { _pickResumeTarget } = new Function(`${grab('_epKey')}${grab('_pickResumeTarget')} return { _pickResumeTarget };`)();
const seasons = [{ season_number: 2, episode_count: 2 }, { season_number: 1, episode_count: 3 }];
const ep = (season, episode, completed) => ({ season, episode, completed, positionSec: 600 });

test('show progress: every episode of the show, most recent first, the id matched as a string', async () => {
    await handlers['watch-history:set-progress']({ mediaType: 'tv', tmdbId: 1399, title: 'Show', season: 1, episode: 1,
                                                   positionSec: 2900, durationSec: 3000 });
    await handlers['watch-history:set-progress']({ mediaType: 'tv', tmdbId: 1399, title: 'Show', season: 1, episode: 2,
                                                   positionSec: 760, durationSec: 3000 });
    await handlers['watch-history:set-progress']({ mediaType: 'tv', tmdbId: 7, title: 'Other', season: 1, episode: 1,
                                                   positionSec: 100, durationSec: 3000 });
    await handlers['watch-history:set-progress']({ mediaType: 'movie', tmdbId: 1399, title: 'Film',
                                                   positionSec: 100, durationSec: 3000 });
    const res = await handlers['watch-history:show-progress']({ tmdbId: '1399', title: 'Show' });
    assert.deepStrictEqual(res.items.map(i => `s${i.season}e${i.episode}`).sort(), ['s1e1', 's1e2']);
    assert.ok(res.items.find(i => i.episode === 1).completed, '97 % watched = finished');
    const latest = await handlers['watch-history:get-progress']({ mediaType: 'tv', tmdbId: '1399', title: 'nope' });
    assert.ok(latest && latest.tmdbId === 1399, 'a string id finds the show saved with a number');
});

test('show progress: a show saved without its id is found by its title', async () => {
    await handlers['watch-history:set-progress']({ mediaType: 'tv', tmdbId: null, title: 'No Id', season: 2, episode: 3,
                                                   positionSec: 50, durationSec: 3000 });
    const res = await handlers['watch-history:show-progress']({ tmdbId: 555, title: 'No Id' });
    assert.strictEqual(res.items.length, 1);
});

test('watched at N %: 95 % by default, the saved setting otherwise (clamped to 50–100)', async () => {
    const save = (pct) => handlers['watch-history:set-progress']({ mediaType: 'movie', tmdbId: 42, title: 'Film 42',
                                                                    positionSec: pct * 60, durationSec: 6000 });
    const done = async () => (await handlers['watch-history:get-progress']({ mediaType: 'movie', tmdbId: 42 })).completed;
    await save(93); assert.strictEqual(await done(), false, '93 % < 95 % default');
    await save(95); assert.strictEqual(await done(), true);
    const settings = path.join(dir, 'vault-settings.json');
    fs.writeFileSync(settings, JSON.stringify({ watchedAtPercent: 80 }));
    await save(85); assert.strictEqual(await done(), true, '85 % >= 80 %');
    await new Promise(r => setTimeout(r, 20));
    fs.writeFileSync(settings, JSON.stringify({ watchedAtPercent: 400 }));   // clamped to 100
    await save(99); assert.strictEqual(await done(), false, '99 % < 100 %');
    fs.rmSync(settings);
});

test('target: an unfinished last episode is resumed where it stopped', () => {
    assert.deepStrictEqual(_pickResumeTarget([ep(1, 2, false)], seasons),
        { kind: 'resume', season: 1, episode: 2, positionSec: 600 });
});

test('target: after a finished episode, the next one (same season, then episode 1 of the next season)', () => {
    assert.deepStrictEqual(_pickResumeTarget([ep(1, 2, true)], seasons), { kind: 'next', season: 1, episode: 3 });
    assert.deepStrictEqual(_pickResumeTarget([ep(1, 3, true)], seasons), { kind: 'next', season: 2, episode: 1 });
});

test('target: a rewatch of an older episode does not send the show back to episodes seen since', () => {
    assert.deepStrictEqual(_pickResumeTarget([ep(1, 1, true), ep(1, 2, true), ep(1, 3, true)], seasons),
        { kind: 'next', season: 2, episode: 1 });
});

test('target: nothing to offer when nothing was watched or the last episode of the show is finished', () => {
    assert.strictEqual(_pickResumeTarget([], seasons), null);
    assert.strictEqual(_pickResumeTarget([ep(2, 2, true)], seasons), null);
});

(async () => {
    let failed = 0;
    for (const [name, fn] of tests) {
        try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
    }
    console.log(`${tests.length - failed}/${tests.length} passed`);
    require('../src/watch-history').flushNow();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
})();
