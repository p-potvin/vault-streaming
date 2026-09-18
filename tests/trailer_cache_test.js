const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');

// Test with electron-shim
require('../web/electron-shim');
const { registerTrailerCacheIpc } = require('../src/ipc/trailer-cache.ipc');

console.log('=== TRAILER CACHE VERIFICATION TEST ===\n');

const handlers = new Map();
const mockIpcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: () => {},
    once: () => {}
};

registerTrailerCacheIpc(mockIpcMain);

assert.ok(handlers.has('trailer-cache:get'), 'trailer-cache:get must be registered');
assert.ok(handlers.has('trailer-cache:put'), 'trailer-cache:put must be registered');
console.log('[PASS] Handlers registered.\n');

const getHandler = handlers.get('trailer-cache:get');
const putHandler = handlers.get('trailer-cache:put');

async function run() {
    // 1. Test get on non-existent trailer
    const nonExistent = await getHandler({}, 'dummy_non_existent_id');
    assert.equal(nonExistent, null, 'Non-existent trailer must return null');
    console.log('[PASS] Non-existent trailer lookup returns null.\n');

    console.log('Trailer cache handler test completed successfully.');
}

run().catch((e) => {
    console.error('Test failed:', e);
    process.exit(1);
});
