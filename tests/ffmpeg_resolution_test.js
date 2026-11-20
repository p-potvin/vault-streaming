const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const utils = require('../src/utils');

console.log('=== FFMPEG/FFPROBE RESOLUTION TEST ===\n');

// Test 1: Service environment simulation (os.homedir returns LocalSystem systemprofile)
const origHomedir = os.homedir;
try {
    os.homedir = () => 'C:\\Windows\\system32\\config\\systemprofile';
    delete process.env.VW_FFMPEG_PATH;
    delete process.env.FFMPEG_PATH;
    delete process.env.VW_FFPROBE_PATH;
    delete process.env.FFPROBE_PATH;

    const ffmpeg = utils.getFFmpegPath();
    console.log('[Test 1] Under LocalSystem homedir, getFFmpegPath returned:', ffmpeg);
    assert.notEqual(ffmpeg, 'ffmpeg', 'getFFmpegPath should not fall back to bare "ffmpeg" when running as a service');
    assert.ok(fs.existsSync(ffmpeg), `Resolved ffmpeg must exist on disk: ${ffmpeg}`);

    assert.ok(typeof utils.getFFprobePath === 'function', 'utils.getFFprobePath must be a function');
    const ffprobe = utils.getFFprobePath();
    console.log('[Test 1] Under LocalSystem homedir, getFFprobePath returned:', ffprobe);
    assert.notEqual(ffprobe, 'ffprobe', 'getFFprobePath should not fall back to bare "ffprobe" when running as a service');
    assert.ok(fs.existsSync(ffprobe), `Resolved ffprobe must exist on disk: ${ffprobe}`);
    console.log('[PASS] Test 1: Service environment resolution succeeded.\n');
} finally {
    os.homedir = origHomedir;
}

// Test 2: Environment variable overrides
process.env.VW_FFMPEG_PATH = 'C:\\custom\\test\\ffmpeg.exe';
process.env.VW_FFPROBE_PATH = 'C:\\custom\\test\\ffprobe.exe';
// Mock existsSync for custom test path
const origExistsSync = fs.existsSync;
fs.existsSync = (p) => {
    if (p === 'C:\\custom\\test\\ffmpeg.exe' || p === 'C:\\custom\\test\\ffprobe.exe') return true;
    return origExistsSync(p);
};
try {
    assert.equal(utils.getFFmpegPath(), 'C:\\custom\\test\\ffmpeg.exe', 'VW_FFMPEG_PATH should override ffmpeg path');
    assert.equal(utils.getFFprobePath(), 'C:\\custom\\test\\ffprobe.exe', 'VW_FFPROBE_PATH should override ffprobe path');
    console.log('[PASS] Test 2: Environment variable overrides honored.\n');
} finally {
    fs.existsSync = origExistsSync;
    delete process.env.VW_FFMPEG_PATH;
    delete process.env.VW_FFPROBE_PATH;
}

console.log('All ffmpeg/ffprobe resolution tests passed successfully.');
