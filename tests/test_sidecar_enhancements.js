// Enhancement state: the Python enhancers (python-scripts/vw_media/state.py) and the context menu
// (src/enhancements.js) share one sidecar, the v2 record <file.ext>.json, and keep what other tools put in it.
//   node tests/test_sidecar_enhancements.js
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const enhancements = require('../src/enhancements');

const PY = path.join(__dirname, '..', 'python-scripts');
function py(code) {
    const r = spawnSync('python', ['-c', `import sys, json; from vw_media import state\n${code}`], { cwd: PY, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    return r.stdout.trim();
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-enh-'));
try {
    const video = path.join(dir, 'clip.mp4');
    const enhanced = path.join(dir, 'clip_enhanced.mp4');
    fs.writeFileSync(video, 'v');
    fs.writeFileSync(enhanced, 'e');
    fs.writeFileSync(video + '.json', JSON.stringify({ schema: 2, vw: { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }, duration: 9 }));

    py(`state.mark(${JSON.stringify(video)}, 'audio', enhanced_path=${JSON.stringify(enhanced)})`);
    const s = enhancements.getState(video);
    assert.strictEqual(s.audio, true, 'the menu sees what Python recorded');
    assert.strictEqual(s.enhancedPath, enhanced);
    console.log('✓ Python records, the menu reads the same sidecar');

    const r = enhancements.revert(video, 'audio');
    assert.ok(r.success, r.error);
    const back = JSON.parse(py(`print(json.dumps(state.summary(${JSON.stringify(video)})))`));
    assert.strictEqual(back.audio, false);
    assert.strictEqual(back.enhancedPath, null, 'the revert removed enhancedPath from the file');
    const rec = JSON.parse(fs.readFileSync(video + '.json', 'utf8'));
    assert.strictEqual(rec.vw.id, '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    assert.strictEqual(rec.duration, 9);
    assert.ok(!fs.existsSync(video + '.meta.json'), 'no .meta.json');
    console.log('✓ a revert from the menu reaches the file Python reads; other keys kept');
    console.log('\nALL SIDECAR ENHANCEMENT TESTS PASSED');
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
