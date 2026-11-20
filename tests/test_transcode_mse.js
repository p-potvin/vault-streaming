// tests/test_transcode_mse.js
// Verifies MSE queue behavior, buffer slice cleanliness, and watermark flow control logic.

const assert = require('assert');

// 1. Verify buffer slicing cleanly handles pooled and unaligned Buffer/Uint8Array
function toCleanArrayBuffer(buf) {
    if (!buf) return null;
    if (buf instanceof ArrayBuffer) return buf;
    if (ArrayBuffer.isView(buf)) {
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
    if (buf && buf.buffer && typeof buf.byteOffset === 'number' && typeof buf.byteLength === 'number') {
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
    if (buf && buf.data && Array.isArray(buf.data)) {
        return new Uint8Array(buf.data).buffer;
    }
    return new Uint8Array(buf).buffer;
}

console.log('--- Test 1: Buffer Slicing & Offset Cleanliness ---');
const parentBuf = Buffer.alloc(100, 0xAA);
const sliceBuf = parentBuf.subarray(20, 30); // 10 bytes starting at byteOffset 20
sliceBuf.fill(0x55);

const cleaned = toCleanArrayBuffer(sliceBuf);
assert.strictEqual(cleaned.byteLength, 10, 'Cleaned buffer must be exactly 10 bytes');
const view = new Uint8Array(cleaned);
for (let i = 0; i < 10; i++) {
    assert.strictEqual(view[i], 0x55, `Byte ${i} must match the sliced contents`);
}
console.log('Passed Test 1: Sliced buffer extracted with exact bounds.');

console.log('--- Test 2: Queue Preserved on Append Failure (No Dropped Chunks) ---');
// Mock SourceBuffer
class MockSourceBuffer {
    constructor() {
        this.updating = false;
        this.appends = [];
        this.quotaHit = false;
    }
    appendBuffer(chunk) {
        if (this.quotaHit) {
            const err = new Error('Quota exceeded');
            err.name = 'QuotaExceededError';
            throw err;
        }
        this.appends.push(chunk);
    }
}

const sb = new MockSourceBuffer();
const queue = [Buffer.from('chunk1'), Buffer.from('chunk2'), Buffer.from('chunk3')];
let appending = false;

function flushMock() {
    if (sb.updating || appending || queue.length === 0) return;
    const chunk = queue[0];
    appending = true;
    try {
        sb.appendBuffer(chunk);
        queue.shift(); // ONLY shift if appendBuffer did not throw!
    } catch (e) {
        appending = false;
        if (e.name === 'QuotaExceededError') {
            // Emulate quota recovery without dropping chunk
            return;
        }
        throw e;
    }
    appending = false;
}

// Successful append of chunk 1
flushMock();
assert.strictEqual(sb.appends.length, 1);
assert.strictEqual(queue.length, 2);
assert.strictEqual(queue[0].toString(), 'chunk2');

// Quota error on chunk 2
sb.quotaHit = true;
flushMock();
// Chunk 2 MUST remain at queue[0], NOT be dropped!
assert.strictEqual(queue.length, 2, 'Queue must not lose chunk on QuotaExceededError');
assert.strictEqual(queue[0].toString(), 'chunk2', 'chunk2 must stay at head of queue');
assert.strictEqual(sb.appends.length, 1, 'SourceBuffer appends should still be 1');

// Now clear quota condition (eviction occurred)
sb.quotaHit = false;
flushMock();
assert.strictEqual(sb.appends.length, 2, 'chunk2 should now be appended');
assert.strictEqual(sb.appends[1].toString(), 'chunk2');
assert.strictEqual(queue.length, 1);
assert.strictEqual(queue[0].toString(), 'chunk3');

// Append chunk 3
flushMock();
assert.strictEqual(sb.appends.length, 3);
assert.strictEqual(sb.appends[2].toString(), 'chunk3');
assert.strictEqual(queue.length, 0);

console.log('Passed Test 2: Queue preserves chunks across QuotaExceeded errors with zero data loss.');

console.log('--- Test 3: Watermark Logic ---');
function decideWatermark(forwardBufferSec, queueLen) {
    if (forwardBufferSec > 35 || queueLen > 30) {
        return 'pause';
    } else if (forwardBufferSec < 18 && queueLen < 15) {
        return 'resume';
    }
    return 'keep';
}

assert.strictEqual(decideWatermark(40, 5), 'pause', 'Should pause when forward buffer > 35s');
assert.strictEqual(decideWatermark(10, 35), 'pause', 'Should pause when queue > 30');
assert.strictEqual(decideWatermark(10, 5), 'resume', 'Should resume when forward buffer < 18s and queue < 15');
assert.strictEqual(decideWatermark(25, 10), 'keep', 'Should maintain current state in hysteresis band');
console.log('Passed Test 3: Backpressure watermark logic matches specs.');

console.log('ALL TRANSCODE MSE TESTS PASSED!');
