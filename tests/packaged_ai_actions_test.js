const assert = require('assert').strict;
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const utils = require('../src/utils');
const enhancements = require('../src/enhancements');

console.log('=== VAULT STREAMING PACKAGED AI ACTIONS VERIFICATION ===\n');

// 1. Verify Script Path Resolution in Dev & ASAR Unpacked modes
console.log('[Test 1] Testing Script Path Resolution...');
const scripts = [
    'enhance_audio.py',
    'generate_subtitles.py',
    'translate_video.py',
    'enhance_video.py',
    'live_subtitles.py',
    'benchmark_asr.py',
    'rtx_vsr_stream.py'
];

for (const script of scripts) {
    const resolved = utils.resolveScriptPath(script);
    console.log(`  -> ${script} => ${resolved}`);
    assert.ok(fs.existsSync(resolved), `Script ${script} does not exist at resolved path: ${resolved}`);
    assert.doesNotMatch(resolved, /app\.asar[/\\]python-scripts/, `Script ${script} must not resolve inside app.asar virtual filesystem`);
}
console.log('[PASS] All Python scripts resolve to real disk paths.\n');

// 2. Verify Python Interpreter Resolution
console.log('[Test 2] Testing Python Interpreter Resolution...');
const pythonExe = utils.getRobustPythonExe();
console.log(`  -> Resolved Python: ${pythonExe}`);
assert.ok(fs.existsSync(pythonExe), `Python executable not found at: ${pythonExe}`);

const pyVer = spawnSync(pythonExe, ['-c', 'import sys; print(sys.version)'], { encoding: 'utf8' });
assert.equal(pyVer.status, 0, `Failed to execute python interpreter: ${pyVer.stderr}`);
console.log(`  -> Python Version: ${pyVer.stdout.trim().split('\n')[0]}`);
console.log('[PASS] Python interpreter verified.\n');

// 3. Verify Python Environment Builder (PYTHONPATH, PATH, Encodings)
console.log('[Test 3] Testing Python Environment Builder...');
const env = utils.getPythonEnv();
assert.ok(env.PYTHONPATH, 'PYTHONPATH must be populated');
assert.ok(env.PATH, 'PATH must be populated');
assert.equal(env.PYTHONUTF8, '1', 'PYTHONUTF8 must be set to 1');
assert.equal(env.PYTHONIOENCODING, 'utf-8', 'PYTHONIOENCODING must be utf-8');
assert.ok(env.VAULT_MODEL_DIR, 'VAULT_MODEL_DIR must be defined');

console.log(`  -> PYTHONPATH: ${env.PYTHONPATH}`);
console.log(`  -> VAULT_MODEL_DIR: ${env.VAULT_MODEL_DIR}`);
console.log(`  -> VW_MODEL_STORE: ${env.VW_MODEL_STORE}`);
console.log('[PASS] Python environment builder verified.\n');

// 4. Verify Module Imports through vw_media and vault_streaming
console.log('[Test 4] Testing Module Imports from resolved environment...');
const importCheckCode = `
import sys
from vw_media import asr, media, state, enhanced, subtitles, progress, telemetry
from vault_streaming import parakeet_wrapper
print("IMPORTS_SUCCESSFUL")
`;

const importRes = spawnSync(pythonExe, ['-c', importCheckCode], {
    env,
    encoding: 'utf8'
});
console.log(`  -> Output: ${importRes.stdout.trim()}`);
if (importRes.status !== 0) {
    console.error(`  -> Import Error: ${importRes.stderr}`);
}
assert.equal(importRes.status, 0, `Module import test failed: ${importRes.stderr}`);
assert.match(importRes.stdout, /IMPORTS_SUCCESSFUL/, 'Imports did not report success');
console.log('[PASS] Module imports verified (vw_media & vault_streaming accessible).\n');

// 5. Test CLI help for all enhancement scripts
console.log('[Test 5] Testing CLI Help for all enhancement scripts...');
const cliScripts = [
    'enhance_audio.py',
    'generate_subtitles.py',
    'translate_video.py',
    'enhance_video.py',
    'benchmark_asr.py'
];

for (const s of cliScripts) {
    const sPath = utils.resolveScriptPath(s);
    const res = spawnSync(pythonExe, [sPath, '--help'], {
        env,
        encoding: 'utf8'
    });
    assert.equal(res.status, 0, `CLI --help failed for ${s}: ${res.stderr}`);
    console.log(`  -> ${s} --help [PASS]`);
}
console.log('[PASS] All enhancement script CLI interfaces verified.\n');

console.log('======================================================');
console.log(' VAULT STREAMING AI ACTIONS VERIFICATION PASSED       ');
console.log('======================================================\n');
