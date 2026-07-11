// src/realdebrid/stream.js - Real-Debrid magnet unrestrict workflow and status polling
const { fetchWithTimeout, RD_TOKEN } = require("./client");

// Track in-flight addMagnet operations to prevent duplicate concurrent calls
const _inFlightMagnets = new Set();

function registerStreamHandlers(ipcMain) {
    ipcMain.handle('rd-stream-torrent', async (event, { magnet, hash, url }) => {
        let dedupKey = '';
        try {
            if (!RD_TOKEN) {
                return { success: false, error: 'Real-Debrid API token is not configured in .env' };
            }

            // Quick bypass: If a pre-resolved Torrentio Real-Debrid link is available, resolve it directly!
            if (url) {
                console.log(`[Real-Debrid] Resolving pre-debrided stream redirect: ${url}`);
                try {
                    const redirectRes = await fetchWithTimeout(url, { method: 'HEAD', redirect: 'manual' }, 10000);
                    const location = redirectRes.headers.get('location');
                    if (location) {
                        console.log(`[Real-Debrid] Pre-debrided redirect resolved successfully: ${location}`);
                        return {
                            success: true,
                            streamUrl: location,
                            filename: location.split('/').pop() || 'stream.mp4'
                        };
                    }
                } catch (e) {
                    console.error('[Real-Debrid] Failed to follow Torrentio redirect, falling back to magnet flow:', e);
                }
            }

            const dedupKey = (hash || magnet).toLowerCase().trim();
            if (_inFlightMagnets.has(dedupKey)) {
                console.warn(`[Real-Debrid] Skipping duplicate in-flight magnet: ${dedupKey.slice(0, 16)}...`);
                return { success: false, error: 'Duplicate in-flight magnet request', dedup: true };
            }
            _inFlightMagnets.add(dedupKey);

            console.log('[Real-Debrid] Adding magnet...');
            // Step 1: Add Magnet to Real-Debrid
            const addRes = await fetchWithTimeout('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${RD_TOKEN}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({ magnet })
            });

            if (!addRes.ok) {
                const errText = await addRes.text();
                let parsedError = null;
                try {
                    parsedError = JSON.parse(errText);
                } catch(e) {}
                if (parsedError && parsedError.error) {
                    return { success: false, error: parsedError.error, errorCode: parsedError.error_code, rawError: errText };
                }
                return { success: false, error: `Failed to add magnet: ${errText}` };
            }

            const addData = await addRes.json();
            const torrentId = addData.id;
            console.log(`[Real-Debrid] Magnet added. ID: ${torrentId}`);

            // Step 2: Get torrent info to select largest/video file
            const infoRes = await fetchWithTimeout(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, {
                headers: { Authorization: `Bearer ${RD_TOKEN}` }
            });

            if (!infoRes.ok) {
                return { success: false, error: 'Failed to retrieve torrent info' };
            }

            const infoData = await infoRes.json();
            
            // Step 3: Select files (largest video file index)
            // Let's identify the files. Real-Debrid maps file IDs (1-indexed).
            let targetFiles = 'all';
            if (infoData.files && infoData.files.length > 0) {
                // Find largest video file ID
                const videoFiles = infoData.files.filter(f => f.path.match(/\.(mp4|mkv|avi|webm)$/i));
                if (videoFiles.length > 0) {
                    const largestVideo = videoFiles.reduce((prev, current) => (prev.bytes > current.bytes) ? prev : current);
                    targetFiles = largestVideo.id;
                }
            }

            console.log(`[Real-Debrid] Selecting files: ${targetFiles}`);
            const selectRes = await fetchWithTimeout(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${RD_TOKEN}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({ files: targetFiles })
            });

            if (!selectRes.ok) {
                return { success: false, error: 'Failed to select torrent files' };
            }

            // Step 4: Wait/poll for the direct links to become available
            console.log('[Real-Debrid] Polling torrent details for direct links...');
            let links = [];
            let attempts = 0;
            let finalInfo = null;
            while (attempts < 6) {
                const checkRes = await fetchWithTimeout(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, {
                    headers: { Authorization: `Bearer ${RD_TOKEN}` }
                });
                if (checkRes.ok) {
                    const checkData = await checkRes.json();
                    finalInfo = checkData;
                    if (checkData.links && checkData.links.length > 0) {
                        links = checkData.links;
                        break;
                    }
                    // If it is dead or failed, stop polling early
                    if (checkData.status === 'dead' || checkData.status === 'error' || checkData.status === 'magnet_error') {
                        break;
                    }
                }
                attempts++;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            if (links.length === 0) {
                if (finalInfo && (finalInfo.status === 'downloading' || finalInfo.status === 'queued' || finalInfo.status === 'waiting_files_selection' || finalInfo.status === 'magnet_conversion')) {
                    console.log(`[Real-Debrid] Torrent is not yet cached but is downloading. Progress: ${finalInfo.progress}%, Speed: ${finalInfo.speed} B/s`);
                    return {
                        success: true,
                        downloading: true,
                        torrentId: torrentId,
                        status: finalInfo.status,
                        progress: finalInfo.progress || 0,
                        speed: finalInfo.speed || 0,
                        seeders: finalInfo.seeders || 0
                    };
                }
                return { success: false, error: 'Torrent link selection is currently downloading (not cached on Real-Debrid).' };
            }

            // Step 5: Unrestrict (debrid) the first direct link
            console.log(`[Real-Debrid] Unrestricting link: ${links[0]}`);
            const unrestrictRes = await fetchWithTimeout('https://api.real-debrid.com/rest/1.0/unrestrict/link', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${RD_TOKEN}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({ link: links[0] })
            });

            if (!unrestrictRes.ok) {
                const errText = await unrestrictRes.text();
                let parsedError = null;
                try {
                    parsedError = JSON.parse(errText);
                } catch(e) {}
                if (parsedError && parsedError.error) {
                    return { success: false, error: parsedError.error, errorCode: parsedError.error_code, rawError: errText };
                }
                return { success: false, error: `Failed to unrestrict link: ${errText}` };
            }

            const unrestrictData = await unrestrictRes.json();
            console.log('[Real-Debrid] Unrestricting succeeded. Direct stream link:', unrestrictData.download);

            return {
                success: true,
                streamUrl: unrestrictData.download,
                filename: unrestrictData.filename
            };
        } catch (e) {
            console.error('[Real-Debrid] Workflow Error:', e);
            return { success: false, error: e.message };
        } finally {
            if (dedupKey) _inFlightMagnets.delete(dedupKey);
        }
    });

    ipcMain.handle('rd-torrent-status', async (event, torrentId) => {
        try {
            if (!RD_TOKEN) {
                return { success: false, error: 'Real-Debrid API token is not configured in .env' };
            }
            const res = await fetchWithTimeout(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, {
                headers: { Authorization: `Bearer ${RD_TOKEN}` }
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return {
                success: true,
                status: data.status,
                progress: data.progress || 0,
                speed: data.speed || 0,
                seeders: data.seeders || 0,
                links: data.links || []
            };
        } catch (err) {
            console.error('[Real-Debrid] Status fetch failed:', err);
            return { success: false, error: err.message };
        }
    });
}

module.exports = { registerStreamHandlers };
