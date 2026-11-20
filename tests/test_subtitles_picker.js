// tests/test_subtitles_picker.js — which subtitle loads by default, and the main process's file handling.
// Offline: no OpenSubtitles or vault-raggae requests.
//
//   node tests/test_subtitles_picker.js

const assert = require('assert');

global.window = {};
const { preferredSubtitleLang, pickBestSubtitle, srtToVtt } = require('../js/player/subtitles');
const { _decodeSubtitle: decodeSubtitle, _cuesToVtt: cuesToVtt } = require('../src/ipc/subtitles.ipc');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('default language: the setting, "original" follows the stream language, "none" is none', () => {
    assert.strictEqual(preferredSubtitleLang({ defaultSubLang: 'en' }), 'en');
    assert.strictEqual(preferredSubtitleLang({ defaultSubLang: 'fr' }), 'fr');
    assert.strictEqual(preferredSubtitleLang({ defaultSubLang: 'qc' }), 'fr');
    assert.strictEqual(preferredSubtitleLang({ defaultSubLang: 'original', streamLang: 'fr' }), 'fr');
    assert.strictEqual(preferredSubtitleLang({ defaultSubLang: 'original', streamLang: 'multi' }), 'en');
    assert.strictEqual(preferredSubtitleLang({}), 'en');
    assert.strictEqual(preferredSubtitleLang({ defaultSubLang: 'und' }), null);
});

const R = (release, downloads, extra = {}) => ({ release, downloads, fileId: release, ...extra });

test('best subtitle: the same release group beats a more downloaded one', () => {
    const results = [
        R('The.Odyssey.2026.1080p.WEB-DL.DDP5.1.H.264-FLUX', 9000),
        R('The.Odyssey.2026.2160p.UHD.BluRay.REMUX.DV.HDR10-FraMeSToR', 1200),
    ];
    const pick = pickBestSubtitle(results, 'The.Odyssey.2026.2160p.UHD.BluRay.x265-FraMeSToR');
    assert.strictEqual(pick.release, results[1].release);
});

test('best subtitle: the same source (BluRay vs WEB) breaks a near tie', () => {
    const results = [R('Movie.2026.WEB-DL.1080p-AAA', 500), R('Movie.2026.BluRay.1080p-BBB', 450)];
    assert.strictEqual(pickBestSubtitle(results, 'Movie.2026.1080p.BluRay.x264-CCC').release, results[1].release);
});

test('best subtitle: machine translations last, hearing-impaired after plain', () => {
    const results = [R('A', 50000, { machineTranslated: true }), R('B', 900, { hearingImpaired: true }), R('C', 800)];
    assert.strictEqual(pickBestSubtitle(results, '').release, 'C');
    assert.strictEqual(pickBestSubtitle([R('A', 50000, { machineTranslated: true })], '').release, 'A', 'still better than nothing');
    assert.strictEqual(pickBestSubtitle([], 'x'), null);
});

test('best subtitle: a CAM/telesync subtitle loses to a proper release (unless a CAM plays)', () => {
    const results = [R('The.Odyssey.2026.1080p.CAM.x264-AAA', 73000), R('The.Odyssey.2026.TELESYNC.HEVC-BBB', 16000),
                     R('The.Odyssey.2026.MULTi.VFQ.UHD.BluRay-CCC', 521)];
    assert.strictEqual(pickBestSubtitle(results, 'The.Odyssey.2026.2160p.BluRay.REMUX-XYZ').release, results[2].release);
    assert.strictEqual(pickBestSubtitle(results, 'The.Odyssey.2026.CAM.x264-AAA').release, results[0].release);
});

test('decoding: UTF-8, UTF-8 with BOM, UTF-16 LE, Windows-1252', () => {
    const text = '1\n00:00:01,000 --> 00:00:02,000\nÇa va très bien, Hélène\n';
    assert.strictEqual(decodeSubtitle(Buffer.from(text, 'utf8')), text);
    assert.strictEqual(decodeSubtitle(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])), text);
    assert.strictEqual(decodeSubtitle(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])), text);
    assert.strictEqual(decodeSubtitle(Buffer.from(text, 'latin1')), text, 'a Windows-1252 file keeps its accents');
});

test('transcript cues -> WebVTT', () => {
    const vtt = cuesToVtt([{ start_ms: 1500, end_ms: 3200, text: 'Winter is coming.' },
                           { start_ms: 3661001, end_ms: 3661001, text: 'Short' }, { start_ms: 5, end_ms: 9, text: '  ' }]);
    assert.ok(vtt.startsWith('WEBVTT\n'));
    assert.ok(vtt.includes('00:00:01.500 --> 00:00:03.200\nWinter is coming.'));
    assert.ok(vtt.includes('01:01:01.001 --> 01:01:01.501\nShort'), 'a zero-length cue gets half a second');
    assert.ok(!/-->\s*\n\s*\n/.test(vtt), 'empty cues are dropped');
});

test('srt -> vtt keeps cues', () => {
    const vtt = srtToVtt('﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n');
    assert.ok(vtt.startsWith('WEBVTT'));
    assert.ok(vtt.includes('00:00:01.000 --> 00:00:02.500'));
});

(async () => {
    let failed = 0;
    for (const [name, fn] of tests) {
        try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
    }
    console.log(`${tests.length - failed}/${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
