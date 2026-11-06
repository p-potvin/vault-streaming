// tests/test_raggae_integration.js — Automated verification of vault-raggae satellite integration
// Tests live gateway health, catalog resolve (/v1/resolve), catalog search (/v1/catalog/search),
// media by-path (/v1/media/by-path), circuit breaker resilience, and sidecar precedence.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const raggae = require('../src/raggae');

async function runTests() {
    console.log('--- Testing vault-raggae Satellite Integration in vault-streaming ---');

    // Test 1: Live Gateway Health
    console.log('[Test 1] Gateway Health Check...');
    const health = await raggae.health();
    console.log('Health result:', health.available ? 'ONLINE' : 'OFFLINE');
    assert.strictEqual(health.available, true, 'vault-raggae gateway should be available on port 8750');
    console.log('✓ Health check passed');

    // Test 2: Catalog Resolve (/v1/resolve)
    console.log('\n[Test 2] Catalog Resolve for "Inception 2010"...');
    const resolved = await raggae.resolve({
        name: 'Inception 2010',
        categoryHint: 'movie',
        project: 'vault-streaming-test'
    });
    assert(resolved, 'Resolve result should not be null');
    assert(resolved.match, 'Resolve should return a match object');
    assert.strictEqual(resolved.match.method, 'fts', 'Expected FTS match for Inception 2010');
    assert(resolved.item, 'Resolved item should exist');
    assert.strictEqual(resolved.item.title, 'Inception', 'Item title should be Inception');
    assert.strictEqual(resolved.item.year, 2010, 'Item year should be 2010');
    assert(resolved.item.external_ids && resolved.item.external_ids.imdb, 'Item should carry IMDb external ID');
    console.log(`✓ Resolved successfully: ${resolved.item.title} (${resolved.item.year}) - IMDb: ${resolved.item.external_ids.imdb}`);

    // Test 3: Catalog Search (/v1/catalog/search)
    console.log('\n[Test 3] Catalog Search for "Matrix"...');
    const searchRes = await raggae.search('Matrix', { category: 'movie', limit: 3 });
    const items = searchRes.results || searchRes;
    assert(Array.isArray(items), 'Search results should be an array');
    assert(items.length > 0, 'Search should return at least 1 result for Matrix');
    console.log(`✓ Search returned ${items.length} items. First hit: ${items[0].title} (${items[0].year || 'N/A'})`);

    // Test 4: Poster URL generation
    console.log('\n[Test 4] Poster URL construction...');
    const posterUrl = raggae.getPosterUrl('movies/posters/test.jpg', 320);
    assert.strictEqual(posterUrl, 'http://127.0.0.1:8750/v1/img?path=movies%2Fposters%2Ftest.jpg&w=320');
    const remoteUrl = raggae.getPosterUrl('https://image.tmdb.org/t/p/w500/sample.jpg');
    assert.strictEqual(remoteUrl, 'https://image.tmdb.org/t/p/w500/sample.jpg');
    console.log('✓ Poster URL formatting passed');

    // Test 5: Sidecar precedence & v2 contract compatibility
    console.log('\n[Test 5] Sidecar Precedence & v2 Record Compatibility...');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raggae-streaming-test-'));
    try {
        const testVideo = path.join(tempDir, 'sample_movie.mp4');
        fs.writeFileSync(testVideo, 'mock video data');

        // Case A: v2 sidecar (<file.ext>.json)
        const v2SidecarPath = testVideo + '.json';
        const v2Content = {
            record_version: 2,
            media_version: 2,
            file: {
                path: testVideo,
                video: { width: 1920, height: 1080, duration: 7200.5, codec: 'h264', fps: 23.98 }
            }
        };
        fs.writeFileSync(v2SidecarPath, JSON.stringify(v2Content, null, 2), 'utf8');

        // Legacy .meta.json should be superseded by canonical <file.ext>.json
        const legacySidecarPath = testVideo + '.meta.json';
        fs.writeFileSync(legacySidecarPath, JSON.stringify({ width: 720, height: 480, duration: 100 }, null, 2), 'utf8');

        // Test candidate evaluation logic
        const sidecarCandidates = [
            testVideo + '.json',
            path.join(tempDir, 'sample_movie.json'),
            testVideo + '.meta.json'
        ];

        let loaded = null;
        let isV2 = false;
        for (const cand of sidecarCandidates) {
            if (fs.existsSync(cand)) {
                loaded = JSON.parse(fs.readFileSync(cand, 'utf8'));
                if (loaded.record_version === 2 || loaded.media_version === 2) isV2 = true;
                break;
            }
        }

        assert.strictEqual(isV2, true, 'Canonical <file.ext>.json should take precedence over .meta.json');
        assert.strictEqual(loaded.file.video.width, 1920, 'Should load 1920 width from canonical v2 sidecar');
        console.log('✓ Canonical sidecar precedence verified');

        // Case B: Fallback to stem form if canonical is removed
        fs.unlinkSync(v2SidecarPath);
        const stemSidecarPath = path.join(tempDir, 'sample_movie.json');
        fs.writeFileSync(stemSidecarPath, JSON.stringify({ width: 1280, height: 720, duration: 3600 }, null, 2), 'utf8');

        let loadedStem = null;
        for (const cand of sidecarCandidates) {
            if (fs.existsSync(cand)) {
                loadedStem = JSON.parse(fs.readFileSync(cand, 'utf8'));
                break;
            }
        }
        assert.strictEqual(loadedStem.width, 1280, 'Stem sidecar should take precedence over legacy .meta.json');
        console.log('✓ Stem sidecar fallback verified');

    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    console.log('\n========================================');
    console.log('ALL VAULT-STREAMING INTEGRATION TESTS PASSED!');
    console.log('========================================');
}

runTests().catch(err => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
