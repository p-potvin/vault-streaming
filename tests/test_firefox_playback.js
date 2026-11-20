// tests/test_firefox_playback.js
const { firefox } = require('playwright');

async function testFirefox() {
    console.log('Testing Firefox with local video tag...');
    // We launch firefox
    const browser = await firefox.launch({
        headless: true,
        executablePath: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    });
    const page = await browser.newPage();
    page.on('console', msg => console.log('Firefox console:', msg.text()));

    const testUrl = `http://127.0.0.1:8722/api/transcode?mode=transcode&src=https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4`;

    await page.setContent(`
        <html><body>
        <video id="v" src="${testUrl}" autoplay muted controls></video>
        </body></html>
    `);

    const result = await page.evaluate(async () => {
        const v = document.getElementById('v');
        return new Promise((resolve) => {
            v.addEventListener('loadedmetadata', () => {
                resolve({ success: true, width: v.videoWidth, height: v.videoHeight, duration: v.duration });
            });
            v.addEventListener('error', (e) => {
                resolve({ success: false, error: v.error ? v.error.message : 'unknown', code: v.error ? v.error.code : 0 });
            });
            setTimeout(() => {
                resolve({ success: false, timeout: true, readyState: v.readyState, error: v.error ? v.error.message : null });
            }, 8000);
        });
    });

    console.log('Firefox test result:', result);
    await browser.close();
}

testFirefox().catch(console.error);
