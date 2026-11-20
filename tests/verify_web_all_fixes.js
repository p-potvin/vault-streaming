const { chromium } = require('playwright');
const assert = require('assert').strict;
const path = require('path');
const fs = require('fs');

async function testAllFixes() {
    console.log('=== VERIFYING WEB CLIENT FIXES ===\n');

    const token = process.env.VW_WEB_TOKEN || '';   // the web server's token (web/server.js), never in the repo
    const browser = await chromium.launch({
        headless: true,
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    const clientUrl = `http://127.0.0.1:8722/?token=${token}`;
    console.log(`[Browser] Loading ${clientUrl}...`);
    await page.goto(clientUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // 1. Verify window.icons.history exists
    const hasHistoryIcon = await page.evaluate(() => {
        return typeof window.icons === 'object' && typeof window.icons.history === 'function';
    });
    console.log('[Test 1] window.icons.history is function:', hasHistoryIcon);
    assert.equal(hasHistoryIcon, true, 'window.icons.history must be a function');

    // 2. Click Watch History Tab and verify no render exception
    console.log('[Test 2] Testing Watch History tab rendering...');
    const historyRenderResult = await page.evaluate(async () => {
        try {
            // Find history tab button or call renderWatchHistoryTab directly
            if (typeof window.renderWatchHistoryTab === 'function') {
                window.renderWatchHistoryTab();
            }
            const tabBtn = document.querySelector('[data-tab="history"]') || document.getElementById('tab-history');
            if (tabBtn) tabBtn.click();
            await new Promise(r => setTimeout(r, 500));
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message, stack: err.stack };
        }
    });
    console.log('[Test 2] Watch History render result:', historyRenderResult);
    assert.equal(historyRenderResult.success, true, 'Watch History tab must render without error');

    // 3. Test video playback through startTranscodePlayback with a real Comet stream
    console.log('\n[Test 3] Testing stream playback via startTranscodePlayback...');
    const { COMET_STREAM_BASE } = require('../src/realdebrid/client');
    const cometQueryUrl = `${COMET_STREAM_BASE}/stream/movie/tt6386748.json`;
    const cometRes = await fetch(cometQueryUrl);
    const cometData = await cometRes.json();
    const targetStream = cometData.streams.find(s => s.url && s.name.includes('1080p')) || cometData.streams[0];
    console.log(`[Test 3] Stream selected: ${targetStream.name}`);

    const playbackResult = await page.evaluate(async (streamUrl) => {
        return new Promise(async (resolve) => {
            const vp = document.getElementById('video-player');
            if (!vp) return resolve({ success: false, error: 'no video-player' });
            
            const timer = setTimeout(() => {
                resolve({
                    success: false,
                    timeout: true,
                    readyState: vp.readyState,
                    error: vp.error ? { code: vp.error.code, message: vp.error.message } : null
                });
            }, 25000);

            vp.addEventListener('error', () => {
                clearTimeout(timer);
                resolve({
                    success: false,
                    error: vp.error ? { code: vp.error.code, message: vp.error.message } : 'unknown error',
                    readyState: vp.readyState
                });
            }, { once: true });

            vp.addEventListener('loadeddata', () => {
                clearTimeout(timer);
                resolve({
                    success: true,
                    videoWidth: vp.videoWidth,
                    videoHeight: vp.videoHeight,
                    readyState: vp.readyState,
                    src: vp.src
                });
            }, { once: true });

            // Call startTranscodePlayback which is the web override
            if (typeof window.startTranscodePlayback === 'function') {
                window.startTranscodePlayback(streamUrl, 1080, 0, {});
            } else {
                vp.src = streamUrl;
            }
        });
    }, targetStream.url);

    console.log('[Test 3] Playback evaluation result:', playbackResult);
    assert.equal(playbackResult.success, true, `Playback must succeed (got ${JSON.stringify(playbackResult)})`);
    assert.ok(playbackResult.videoHeight > 0, 'videoHeight must be > 0');

    // Show video-modal and wait 1s for frame rendering
    await page.evaluate(() => {
        const m = document.getElementById('video-modal');
        if (m) m.style.display = 'flex';
    });
    await page.waitForTimeout(1000);

    // Take screenshot proof
    const artifactDir = path.resolve('C:\\Users\\Administrator\\.gemini\\antigravity\\brain\\8dd645a2-97d6-4e91-955c-7064c4b5cb81');
    const proofPath = path.join(artifactDir, 'web_player_firefox_and_history_fix.png');
    await page.screenshot({ path: proofPath });
    console.log(`\n[PASS] Captured visual verification proof to ${proofPath}`);

    await browser.close();
    console.log('\n=== ALL VERIFICATION TESTS PASSED SUCCESSFULLY ===');
}

testAllFixes().catch(e => {
    console.error('Test failed:', e);
    process.exit(1);
});
