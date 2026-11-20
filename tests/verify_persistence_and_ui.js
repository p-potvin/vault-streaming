const { chromium } = require('playwright');
const assert = require('assert').strict;
const path = require('path');

async function testPersistenceAndUI() {
    console.log('=== REAL PERSISTENCE & UI STATE VERIFICATION ===\n');

    const token = process.env.VW_WEB_TOKEN || '';   // the web server's token (web/server.js), never in the repo
    const browser = await chromium.launch({
        headless: true,
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    const clientUrl = `http://127.0.0.1:8722/?token=${token}`;
    console.log(`[Browser] Navigating to ${clientUrl}...`);
    await page.goto(clientUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // 1. Write state to watch-history via real API
    console.log('[Step 1] Writing watch history progress for test item...');
    const testItem = {
        mediaType: 'movie',
        tmdbId: 999999,
        title: 'Vault Streaming Test Title',
        positionSec: 1850,
        durationSec: 7200,
        poster: 'https://image.tmdb.org/t/p/w500/qJ2tW6WMUDux911r6m7haRef0WH.jpg',
        year: '2026'
    };

    const writeResult = await page.evaluate(async (item) => {
        return await window.electronAPI.setWatchProgress(item);
    }, testItem);
    console.log('[Step 1] setWatchProgress result:', writeResult);

    // 2. State persistence verification: subsequent fetch/read
    console.log('[Step 2] Performing subsequent read to verify persistence on disk/server...');
    const readBack = await page.evaluate(async (item) => {
        return await window.electronAPI.getWatchProgress({
            mediaType: item.mediaType,
            tmdbId: item.tmdbId,
            title: item.title
        });
    }, testItem);
    console.log('[Step 2] getWatchProgress readback:', readBack);
    assert.ok(readBack, 'Readback must return persistent progress record');
    assert.equal(readBack.positionSec, 1850, 'Persisted positionSec must match written value (1850)');
    assert.equal(readBack.durationSec, 7200, 'Persisted durationSec must match written value (7200)');
    console.log('[PASS] State persistence verified: write followed by independent read succeeded.');

    // 3. UI verification: Render Watch History tab with the item present
    console.log('\n[Step 3] Rendering Watch History tab with persisted item...');
    await page.evaluate(async () => {
        const tabBtn = document.querySelector('[data-tab="history"]') || document.getElementById('tab-history');
        if (tabBtn) tabBtn.click();
        if (typeof window.renderWatchHistoryTab === 'function') {
            await window.renderWatchHistoryTab();
        }
    });
    await page.waitForTimeout(1000);

    const cardCount = await page.evaluate(() => {
        const cards = document.querySelectorAll('#history-grid .file-card');
        return cards.length;
    });
    console.log(`[Step 3] History grid contains ${cardCount} card(s).`);
    assert.ok(cardCount >= 1, 'History tab must display rendered cards');

    // 4. Capture targeted visual proof artifact
    const artifactDir = path.resolve('C:\\Users\\Administrator\\.gemini\\antigravity\\brain\\8dd645a2-97d6-4e91-955c-7064c4b5cb81');
    const proofPath = path.join(artifactDir, 'watch_history_persistence_proof.png');
    await page.screenshot({ path: proofPath });
    console.log(`[PASS] Captured targeted visual proof to ${proofPath}`);

    // 5. Clean up test item and verify deletion persistence
    console.log('\n[Step 5] Cleaning up test item and verifying removal persistence...');
    await page.evaluate(async (item) => {
        await window.electronAPI.removeWatchHistory({ tmdbId: item.tmdbId, mediaType: item.mediaType });
    }, testItem);

    const postDeleteRead = await page.evaluate(async (item) => {
        return await window.electronAPI.getWatchProgress({
            mediaType: item.mediaType,
            tmdbId: item.tmdbId,
            title: item.title
        });
    }, testItem);
    console.log('[Step 5] Post-deletion readback:', postDeleteRead);
    assert.equal(postDeleteRead, null, 'Deleted item must no longer exist in watch history');
    console.log('[PASS] Deletion state persistence verified.');

    await browser.close();
    console.log('\n=== ALL STATE PERSISTENCE & UI GATES VERIFIED SUCCESSFULLY ===');
}

testPersistenceAndUI().catch(err => {
    console.error('Verification failed:', err);
    process.exit(1);
});
