const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function capture() {
    console.log('--- Capturing Vault Streaming Settings Visual Proof via Chromium ---');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    // Inject mock electronAPI
    await page.addInitScript(() => {
        window.electronAPI = {
            getSettings: async () => ({ aiSeparate: true, defaultLang: 'en', streamQuality: '1080p', streamLang: 'en' }),
            saveSettings: async (s) => true,
            openDirectory: async () => 'C:\\Media',
            getTrendingMovies: async () => ({ results: [] }),
            getTrendingShows: async () => ({ results: [] }),
            getMovieGenres: async () => ({ genres: [] }),
            getShowGenres: async () => ({ genres: [] }),
            onLiveSubtitleCue: () => {},
            offLiveSubtitleCue: () => {},
            onLiveSubtitleStatus: () => {},
            offLiveSubtitleStatus: () => {},
        };
    });

    const indexPath = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
    await page.goto(indexPath);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);

    // Open settings modal
    await page.click('#settings-trigger');
    await page.waitForSelector('#settings-panel', { state: 'visible' });

    const sepRow = page.locator('#settings-ai-separate');
    await sepRow.waitFor({ state: 'visible' });
    console.log('[PASS] #settings-ai-separate is visible in settings modal');

    const screenshotPath = 'C:\\Users\\Administrator\\.gemini\\antigravity-ide\\brain\\ee944685-963e-46b2-b55b-01b221549c47\\vault_streaming_ai_separate_setting.png';
    await page.locator('#settings-panel').screenshot({ path: screenshotPath });
    console.log(`[PASS] Captured visual proof at: ${screenshotPath}`);

    await browser.close();
}

capture().catch(err => {
    console.error('Capture failed:', err);
    process.exit(1);
});
