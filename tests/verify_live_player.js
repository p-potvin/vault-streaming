const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const assert = require('assert').strict;

async function verifyLivePlayback() {
    console.log('=== REAL CONDITIONS VERIFICATION: LIVE WEB SERVER & VIDEO PLAYER ===\n');

    // 1. Verify live service health via HTTP
    const token = process.env.VW_WEB_TOKEN || '';   // the web server's token (web/server.js), never in the repo
    const healthUrl = `http://127.0.0.1:8722/api/health`;
    const healthRes = await fetch(healthUrl, { headers: { 'x-vw-token': token } });
    assert.equal(healthRes.status, 200, 'Health endpoint must return 200');
    const healthData = await healthRes.json();
    assert.equal(healthData.ok, true, 'Service health must be true');
    console.log('[PASS] Live server is running and healthy on 127.0.0.1:8722');
    console.log(`[PASS] Registered IPC channels: ${healthData.channels}`);

    // Subsequent read to verify state persistence
    const healthRes2 = await fetch(healthUrl, { headers: { 'x-vw-token': token } });
    const healthData2 = await healthRes2.json();
    assert.equal(healthData2.channels, healthData.channels, 'IPC channels must persist consistently across calls');

    // 2. Fetch a real stream from Comet
    const { COMET_STREAM_BASE } = require('../src/realdebrid/client');
    const cometQueryUrl = `${COMET_STREAM_BASE}/stream/movie/tt6386748.json`;
    console.log('[Comet] Fetching real stream for verification from:', cometQueryUrl.replace(/\/eyJ[^/]+/, '/<config>'));
    const cometRes = await fetch(cometQueryUrl);
    const cometData = await cometRes.json();
    assert.ok(Array.isArray(cometData.streams) && cometData.streams.length > 0, 'Comet must return stream results');
    
    // Pick the 1080p stream
    const targetStream = cometData.streams.find(s => s.url && s.name.includes('1080p')) || cometData.streams.find(s => s.url);
    assert.ok(targetStream && targetStream.url, 'Valid playable stream must exist');
    console.log(`[PASS] Selected real stream: ${targetStream.name}`);

    // 3. Launch real browser to verify web player UI and video playback in real conditions
    console.log('\n[Browser] Launching Chrome to test live web player UI...');
    const browser = await chromium.launch({
        headless: true,
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    const clientUrl = `http://127.0.0.1:8722/?token=${token}`;
    console.log(`[Browser] Navigating to ${clientUrl.replace(/token=[^&]*/, "token=<redacted>")}...`);
    await page.goto(clientUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    // Verify UI has loaded
    const title = await page.title();
    console.log(`[PASS] Web app loaded, document title: "${title}"`);

    // 4. Test transcode URL directly in the page context's <video> element
    const transcodeUrl = `http://127.0.0.1:8722/api/transcode?mode=transcode&src=${encodeURIComponent(targetStream.url)}`;
    console.log('\n[Player] Injecting stream into live <video id="video-player"> and testing playback...');

    const playbackResult = await page.evaluate(async (url) => {
        return new Promise((resolve) => {
            const vp = document.getElementById('video-player');
            if (!vp) {
                return resolve({ success: false, error: 'video-player element not found in DOM' });
            }

            // Reveal modal to simulate active player
            const modal = document.getElementById('video-modal');
            if (modal) modal.style.display = 'flex';

            let resolved = false;
            const finish = (result) => {
                if (resolved) return;
                resolved = true;
                resolve(result);
            };

            const timer = setTimeout(() => {
                finish({
                    success: false,
                    timeout: true,
                    readyState: vp.readyState,
                    error: vp.error ? { code: vp.error.code, message: vp.error.message } : null
                });
            }, 25000);

            vp.addEventListener('error', () => {
                clearTimeout(timer);
                finish({
                    success: false,
                    error: vp.error ? { code: vp.error.code, message: vp.error.message } : 'Unknown video error',
                    readyState: vp.readyState
                });
            }, { once: true });

            vp.addEventListener('loadedmetadata', () => {
                clearTimeout(timer);
                finish({
                    success: true,
                    duration: vp.duration,
                    videoWidth: vp.videoWidth,
                    videoHeight: vp.videoHeight,
                    readyState: vp.readyState
                });
            }, { once: true });

            vp.src = url;
            vp.play().catch(() => {});
        });
    }, transcodeUrl);

    console.log('Playback test evaluation result:', playbackResult);
    assert.equal(playbackResult.success, true, `Playback must succeed without error (got: ${JSON.stringify(playbackResult)})`);
    assert.ok(playbackResult.readyState >= 1, 'Video readyState must be >= HAVE_METADATA');
    assert.ok(playbackResult.videoHeight > 0, `Video height must be > 0 (got: ${playbackResult.videoHeight})`);
    console.log(`[PASS] Video loaded metadata successfully: ${playbackResult.videoWidth}x${playbackResult.videoHeight}, duration: ${playbackResult.duration}s`);

    // Wait 2 seconds for video frames to render
    await page.waitForTimeout(2000);

    // 5. Capture visual proof of the video player playing
    const screenshotDir = path.resolve('C:\\Users\\Administrator\\.gemini\\antigravity\\brain\\8dd645a2-97d6-4e91-955c-7064c4b5cb81');
    fs.mkdirSync(screenshotDir, { recursive: true });
    const screenshotPath = path.join(screenshotDir, 'live_player_proof.png');
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`[PASS] Targeted visual proof captured at: ${screenshotPath}`);

    await browser.close();
    console.log('\n=== REAL CONDITIONS VERIFICATION COMPLETED SUCCESSFULLY ===');
}

verifyLivePlayback().catch(err => {
    console.error('Live playback verification failed:', err);
    process.exit(1);
});
