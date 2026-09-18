const assert = require('assert').strict;
const { EventEmitter } = require('events');
const { registerNormalizationHandlers } = require('../src/normalization');
const enhancements = require('../src/enhancements');

console.log('=== VAULT STREAMING WEB & NORMALIZATION IPC TEST ===\n');

// Mock IPC Main
const handlers = new Map();
const mockIpcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: () => {},
    once: () => {},
};

registerNormalizationHandlers(mockIpcMain);

// Verify registered channels
const expectedChannels = [
    'enhance-audio',
    'generate-subtitles',
    'translate-video',
    'enhance-video',
    'normalize-audio',
    'get-enhancement-state',
    'revert-enhancements',
    'revert-enhancement-target',
    'run-asr-benchmark'
];

console.log('[Test 1] Verifying Registered IPC Channels...');
for (const ch of expectedChannels) {
    assert.ok(handlers.has(ch), `Missing handler for channel: ${ch}`);
    console.log(`  -> Channel registered: ${ch}`);
}
console.log('[PASS] All normalization and enhancement channels registered.\n');

// Test ASR Benchmark Simulation
console.log('[Test 2] Testing run-asr-benchmark simulation mode...');
const mockEvent = { sender: { send: (ch, data) => {} } };
const benchHandler = handlers.get('run-asr-benchmark');

benchHandler(mockEvent, { forceSimulation: true }).then((res) => {
    assert.ok(res, 'Benchmark result should exist');
    assert.ok(res.success || res.status === 'COMPLETED' || res.status === 'OK' || res.rtfx !== undefined, 'Benchmark must return success status');
    console.log('  -> Simulation benchmark result:', JSON.stringify(res));
    console.log('[PASS] Benchmark simulation verified.\n');

    // Test get-enhancement-state on dummy path
    console.log('[Test 3] Testing get-enhancement-state on mock video...');
    const stateHandler = handlers.get('get-enhancement-state');
    return stateHandler(mockEvent, 'C:\\dummy\\sample.mp4');
}).then((stateRes) => {
    assert.ok(stateRes.success, 'get-enhancement-state must succeed');
    assert.ok(stateRes.state, 'state must be returned');
    assert.equal(typeof stateRes.state.audio, 'boolean');
    assert.equal(typeof stateRes.state.video, 'boolean');
    assert.ok(Array.isArray(stateRes.state.subtitles));
    assert.ok(Array.isArray(stateRes.state.translation));
    console.log('  -> Mock enhancement state:', JSON.stringify(stateRes.state));
    console.log('[PASS] get-enhancement-state verified.\n');

    console.log('======================================================');
    console.log(' ALL WEB & NORMALIZATION IPC TESTS PASSED             ');
    console.log('======================================================\n');
}).catch((err) => {
    console.error('Test Failed:', err);
    process.exit(1);
});
