// tests/test_playback_fixes.js — offline checks for the Fri 20 Nov 2026 playback fixes.
//
//   node tests/test_playback_fixes.js

const assert = require('assert');

const { mseCodecForCopy } = require('../src/ipc/audio-tracks.ipc');
const { redact } = require('../src/app-log');
const { cometPath, cometUrl, COMET_STREAM_BASE } = require('../src/realdebrid/client');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('HEVC copy: Main 10 is labelled 2.4 (it was always 1.6, so 10-bit HDR failed mid-play)', () => {
    assert.strictEqual(mseCodecForCopy({ codec: 'hevc', profile: 'Main 10', level: 153, pixFmt: 'yuv420p10le' }),
        'video/mp4; codecs="hvc1.2.4.L153.B0, mp4a.40.2"');
    assert.strictEqual(mseCodecForCopy({ codec: 'hevc', profile: 'Main', level: 120, pixFmt: 'yuv420p' }),
        'video/mp4; codecs="hvc1.1.6.L120.B0, mp4a.40.2"');
    assert.strictEqual(mseCodecForCopy({ codec: 'hevc', profile: 'Rext', level: 153 }), null, 'no dependable mapping');
});

test('HEVC copy: Dolby Vision profile 7 / 5 is re-encoded, profile 8 (HDR10 base) may be copied', () => {
    assert.strictEqual(mseCodecForCopy({ codec: 'hevc', profile: 'Main 10', level: 153, dvProfile: 7 }), null);
    assert.strictEqual(mseCodecForCopy({ codec: 'hevc', profile: 'Main 10', level: 153, dvProfile: 5 }), null);
    assert.ok(mseCodecForCopy({ codec: 'hevc', profile: 'Main 10', level: 153, dvProfile: 8 }));
});

test('log lines: the Comet config (debrid keys) never reaches the console or the log file', () => {
    const line = '-i http://100.67.25.118:5173/eyJhYmNk/ZWZn+aGlqa2xtbm9wcXJzdHU=/playback/3b5/0/0/n/n?x=1&apikey=SECRET -map';
    const out = redact(line);
    assert.ok(!/eyJ|SECRET/.test(out), out);
    assert.ok(out.includes('/<config>/playback/3b5/0/0/n/n'));
    assert.strictEqual(redact('[Comet] Fetching: http://h:5173/eyJabcdefghijklmnopqrstuv/stream/movie/tt1.json'),
        '[Comet] Fetching: http://h:5173/<config>/stream/movie/tt1.json');
});

test('saved links: stored without the config, restored with the current one', () => {
    const p = cometPath('http://100.67.25.118:5173/eyJhYmNkZWZnaGlqa2xtbm9w/playback/abc/0/0/n/n?torrent_name=X.mkv');
    assert.strictEqual(p, 'comet:/playback/abc/0/0/n/n?torrent_name=X.mkv');
    assert.strictEqual(cometPath(p), p, 'idempotent');
    assert.strictEqual(cometPath('https://cdn.example/x.mp4'), 'https://cdn.example/x.mp4', 'other links untouched');
    if (COMET_STREAM_BASE) assert.strictEqual(cometUrl(p), `${COMET_STREAM_BASE}/playback/abc/0/0/n/n?torrent_name=X.mkv`);
});

test('start tab: discover by default; the removed "files" tab means discover', () => {
    global.window = {};
    global.document = { getElementById: () => null, querySelectorAll: () => [], body: { classList: { add() {}, remove() {} } } };
    require('../js/navigation/tabs.js');
    assert.strictEqual(window.startTabOf({}), 'discover');
    assert.strictEqual(window.startTabOf({ defaultHomeTab: 'files' }), 'discover');
    assert.strictEqual(window.startTabOf({ defaultHomeTab: 'history' }), 'history');
    assert.strictEqual(window.startTabOf({ defaultHomeTab: 'library' }), 'library');
});

(async () => {
    let failed = 0;
    for (const [name, fn] of tests) {
        try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
    }
    console.log(`${tests.length - failed}/${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
