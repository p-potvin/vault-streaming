// tests/test_web_devices.js — which device a web request belongs to (web/devices.js).
//
//   node tests/test_web_devices.js

const assert = require('assert');
const { deviceOf, isPerDevice } = require('../web/devices');

const req = (peer, realIp) => ({ socket: { remoteAddress: peer }, get: (h) => (h.toLowerCase() === 'x-real-ip' ? realIp : undefined) });
let failed = 0;
const test = (name, fn) => { try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); } };

test('greencloud forwards the viewer: its X-Real-IP is the device', () => {
    assert.strictEqual(deviceOf(req('100.73.93.84', '100.101.5.7')), '100.101.5.7');
    assert.strictEqual(deviceOf(req('::ffff:127.0.0.1', '100.101.5.7')), '100.101.5.7');
});
test('a tailnet peer reaching the server directly is its own device; its header is not trusted', () => {
    assert.strictEqual(deviceOf(req('100.90.1.2', '100.101.5.7')), '100.90.1.2');
});
test('this machine without a forwarded address, or a non-tailnet address, uses the shared data', () => {
    assert.strictEqual(deviceOf(req('127.0.0.1', undefined)), '');
    assert.strictEqual(deviceOf(req('100.73.93.84', '8.8.8.8')), '');
    assert.strictEqual(deviceOf(req('192.168.1.20', undefined)), '');
});
test('only settings and watch history are per device', () => {
    assert.ok(isPerDevice('get-settings') && isPerDevice('save-settings') && isPerDevice('watch-history:set-progress'));
    assert.ok(!isPerDevice('search-torrents') && !isPerDevice('moments:index-playback'));
});
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
