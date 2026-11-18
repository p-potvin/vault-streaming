// tests/test_audio_language.js — the audio-track language: what the stream reports (tag, then title) wins; speech
// detection is asked for only when no reported track matches the preference. Needs ffmpeg (builds a small mkv);
// does not need nemo-speech (the detection channel itself is exercised live, not here).
//
//   node tests/test_audio_language.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const utils = require('../src/utils');
const { normLang, langFromTitle, registerAudioTracksIpc } = require('../src/ipc/audio-tracks.ipc');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('tags: ISO 639-2 B/T, 639-1, BCP 47 and names map to 639-1; junk is und', () => {
    const cases = { fre: 'fr', fra: 'fr', 'fr-CA': 'fr', French: 'fr', eng: 'en', rus: 'ru', ukr: 'uk', nob: 'no',
                    heb: 'he', gre: 'el', rum: 'ro', fil: 'tl', und: 'und', '': 'und', xyz: 'und', mul: 'multi' };
    for (const [tag, want] of Object.entries(cases)) assert.strictEqual(normLang(tag), want, tag);
});

test('titles: release words and native names, Unicode included; no false hits inside words', () => {
    const cases = { 'VFQ 5.1': 'fr', 'TrueFrench AC3': 'fr', 'Français': 'fr', 'Rus Dub [MVO]': 'ru', 'Русский': 'ru',
                    'Українська 2.0': 'uk', 'Ελληνικά': 'el', 'Español Latino': 'es', 'English 5.1': 'en' };
    for (const [title, want] of Object.entries(cases)) assert.strictEqual(langFromTitle(title), want, title);
    for (const title of ['VO', 'Commentary', 'Trust', 'Prussian Blue', '']) assert.strictEqual(langFromTitle(title), null, title);
});

test('probe: a tag wins, an untagged track is named by its title, the rest asks for detection', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-lang-'));
    const file = path.join(dir, 'tracks.mkv');
    execFileSync(utils.getFFmpegPath(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:s=64x64:d=2',
        '-f', 'lavfi', '-i', 'sine=d=2', '-f', 'lavfi', '-i', 'sine=d=2', '-f', 'lavfi', '-i', 'sine=d=2',
        '-map', '0', '-map', '1', '-map', '2', '-map', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
        '-metadata:s:a:0', 'language=rus', '-metadata:s:a:1', 'language=und', '-metadata:s:a:1', 'title=VFQ 5.1',
        '-metadata:s:a:2', 'language=und', '-disposition:a:0', 'default', file], { windowsHide: true });
    const h = {};
    registerAudioTracksIpc({ handle: (c, f) => { h[c] = f; } });
    return (async () => {
        const fr = await h['probe-audio-tracks']({}, { url: file, preferredLang: 'fr' });
        assert.deepStrictEqual(fr.tracks.map(t => [t.lang, t.langSource]), [['ru', 'tag'], ['fr', 'title'], ['und', 'none']]);
        assert.strictEqual(fr.chosenAudioIndex, 1, 'the title-named French track plays');
        assert.strictEqual(fr.needsDetection, false, 'a reported match: no detection');
        const de = await h['probe-audio-tracks']({}, { url: file, preferredLang: 'de' });
        assert.strictEqual(de.needsDetection, true, 'no reported German track, one unnamed: detection');
        assert.deepStrictEqual(de.undetermined, [2]);
        assert.strictEqual(de.chosenAudioIndex, 0, 'until detection says otherwise, the default plays');
        fs.rmSync(dir, { recursive: true, force: true });
    })();
});

(async () => {
    let failed = 0;
    for (const [name, fn] of tests) {
        try {
            await fn();
            console.log(`✓ ${name}`);
        } catch (e) {
            failed++;
            console.error(`✗ ${name}\n  ${e.stack}`);
        }
    }
    if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
    console.log('\nALL AUDIO LANGUAGE TESTS PASSED');
})();
