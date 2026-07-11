// src/realdebrid/proxy-handlers.js - proxy-aware unrestrict, download, and proxy test handlers
const path = require("path");
const { RD_TOKEN } = require("./client");
const { makeProxiedRequest, downloadFileWithProxy } = require("./proxy");

function registerProxyHandlers(ipcMain) {
    ipcMain.handle('rd-unrestrict-url', async (event, { link, proxy }) => {
        try {
            if (!RD_TOKEN) {
                return { success: false, error: 'Real-Debrid API token is not configured in .env' };
            }

            if (link.startsWith('magnet:')) {
                console.log('[Real-Debrid] Processing magnet for unrestrict...');
                const addRes = await makeProxiedRequest('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${RD_TOKEN}` },
                    body: new URLSearchParams({ magnet: link })
                }, proxy);

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

                const infoRes = await makeProxiedRequest(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, {
                    headers: { Authorization: `Bearer ${RD_TOKEN}` }
                }, proxy);

                if (!infoRes.ok) return { success: false, error: 'Failed to retrieve torrent info' };
                const infoData = await infoRes.json();
                
                let targetFiles = 'all';
                if (infoData.files && infoData.files.length > 0) {
                    const videoFiles = infoData.files.filter(f => f.path.match(/\.(mp4|mkv|avi|webm)$/i));
                    if (videoFiles.length > 0) {
                        const largestVideo = videoFiles.reduce((prev, current) => (prev.bytes > current.bytes) ? prev : current);
                        targetFiles = largestVideo.id;
                    }
                }

                const selectRes = await makeProxiedRequest(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${RD_TOKEN}` },
                    body: new URLSearchParams({ files: targetFiles })
                }, proxy);

                if (!selectRes.ok) return { success: false, error: 'Failed to select torrent files' };

                let links = [];
                let attempts = 0;
                let finalInfo = null;
                while (attempts < 10) {
                    const checkRes = await makeProxiedRequest(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, {
                        headers: { Authorization: `Bearer ${RD_TOKEN}` }
                    }, proxy);
                    finalInfo = await checkRes.json();
                    if (finalInfo.links && finalInfo.links.length > 0) {
                        links = finalInfo.links;
                        break;
                    }
                    attempts++;
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

                if (links.length === 0) {
                    return { success: false, error: 'Torrent is currently downloading on Real-Debrid (not cached).' };
                }

                const unrestrictRes = await makeProxiedRequest('https://api.real-debrid.com/rest/1.0/unrestrict/link', {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${RD_TOKEN}` },
                    body: new URLSearchParams({ link: links[0] })
                }, proxy);

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
                return {
                    success: true,
                    download: unrestrictData.download,
                    filename: unrestrictData.filename,
                    filesize: finalInfo ? finalInfo.bytes : (unrestrictData.filesize || 0),
                    isMagnet: true
                };
            }

            console.log('[Real-Debrid] Unrestricting standard link...');
            const unrestrictRes = await makeProxiedRequest('https://api.real-debrid.com/rest/1.0/unrestrict/link', {
                method: 'POST',
                headers: { Authorization: `Bearer ${RD_TOKEN}` },
                body: new URLSearchParams({ link: link })
            }, proxy);

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
            return {
                success: true,
                download: unrestrictData.download,
                filename: unrestrictData.filename,
                filesize: unrestrictData.filesize || 0,
                isMagnet: false
            };
        } catch (e) {
            console.error('[Real-Debrid] Proxy-aware unrestrict error:', e);
            return { success: false, error: e.message };
        }
    });

    // 4. Secure Proxy Tunnel Stream Downloader
    ipcMain.handle('rd-download-file', async (event, { downloadUrl, filename, proxy }) => {
        try {
            const { app } = require('electron');
            const downloadsDir = app.getPath('downloads');
            const destPath = path.join(downloadsDir, filename);

            console.log(`[Real-Debrid] Initiating proxy-aware download: ${filename} to ${destPath}`);

            // Download file
            await downloadFileWithProxy(downloadUrl, destPath, proxy, (progressData) => {
                event.sender.send('rd-download-progress', progressData);
            });

            return { success: true, destPath };
        } catch (e) {
            console.error('[Real-Debrid] Proxy-aware download error:', e);
            event.sender.send('rd-download-progress', {
                progress: 0,
                speed: 0,
                bytesDownloaded: 0,
                totalBytes: 0,
                status: 'Failed',
                error: e.message
            });
            return { success: false, error: e.message };
        }
    });

    // 5. Test Proxy Tunnel Connection
    ipcMain.handle('rd-test-proxy', async (event, proxy) => {
        try {
            if (!proxy) {
                return { success: false, error: 'Proxy address is empty' };
            }
            console.log(`[Real-Debrid] Testing proxy tunnel connection to: ${proxy}`);
            const startTime = Date.now();
            
            const testRes = await makeProxiedRequest('https://api.real-debrid.com/rest/1.0/time', {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            }, proxy);

            const latency = Date.now() - startTime;
            if (testRes.ok) {
                console.log(`[Real-Debrid] Proxy test successful! Latency: ${latency}ms`);
                return { success: true, latency };
            } else {
                return { success: false, error: `Proxy returned status ${testRes.status}` };
            }
        } catch (e) {
            console.error('[Real-Debrid] Proxy test failed:', e);
            return { success: false, error: e.message };
        }
    });
}

module.exports = { registerProxyHandlers };
