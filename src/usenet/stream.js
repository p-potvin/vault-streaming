// src/usenet/stream.js - Integrates NzbDAV WebDAV streaming bridge
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');
const { fetchWithTimeout } = require("./client");

// We read configuration
let envConfig = {};
try {
    const envPaths = [
        path.join(__dirname, '..', '.env'),
        path.join(__dirname, '..', '..', '.env')
    ];
    for (const envPath of envPaths) {
        if (fs.existsSync(envPath)) {
            const envContent = fs.readFileSync(envPath, 'utf8');
            envContent.split(/\r?\n/).forEach(line => {
                const parts = line.split('=');
                if (parts.length >= 2) {
                    const key = parts[0].trim();
                    const value = parts.slice(1).join('=').trim();
                    if (key) {
                        if (!process.env[key]) {
                            process.env[key] = value;
                        }
                        envConfig[key] = process.env[key];
                    }
                }
            });
        }
    }
} catch (e) {}

const NZBDAV_URL = process.env.NZBDAV_URL || envConfig.NZBDAV_URL || '';
const NZBDAV_API_KEY = process.env.NZBDAV_API_KEY || envConfig.NZBDAV_API_KEY || '';
const NZBDAV_USER = process.env.NZBDAV_USER || envConfig.NZBDAV_USER || '';
const NZBDAV_PASS = process.env.NZBDAV_PASS || envConfig.NZBDAV_PASS || '';

/**
 * Initiates streaming for a Usenet NZB result using the NzbDAV bridge.
 */
async function streamUsenetNzb(event, { downloadUrl, title }) {
    if (!NZBDAV_URL) {
        return { success: false, error: 'NZBDAV_URL is not configured in .env' };
    }

    try {
        console.log(`[Usenet-Stream] Adding NZB to NzbDAV: ${title} (${downloadUrl})`);
        
        // 1. Add URL to SABnzbd API of NzbDAV
        let apiBase = NZBDAV_URL.replace(/\/$/, '');
        let addUrl = `${apiBase}/api?mode=addurl&name=${encodeURIComponent(downloadUrl)}&output=json`;
        if (NZBDAV_API_KEY) {
            addUrl += `&apikey=${NZBDAV_API_KEY}`;
        }
        
        let response = await fetchWithTimeout(addUrl, { method: 'GET' }, 10000);
        if (!response.ok) {
            // Try with /sabnzbd/api
            addUrl = `${apiBase}/sabnzbd/api?mode=addurl&name=${encodeURIComponent(downloadUrl)}&output=json`;
            if (NZBDAV_API_KEY) addUrl += `&apikey=${NZBDAV_API_KEY}`;
            response = await fetchWithTimeout(addUrl, { method: 'GET' }, 10000);
        }

        if (!response.ok) {
            throw new Error(`NzbDAV API returned HTTP ${response.status}`);
        }

        const data = await response.json();
        if (!data || (!data.status && !data.nzo_ids)) {
            throw new Error('NzbDAV API returned invalid addurl response');
        }

        const nzoId = data.nzo_ids && data.nzo_ids[0];
        console.log(`[Usenet-Stream] Added NZB to NzbDAV, NZO ID: ${nzoId}`);

        // Return immediately with the downloading state, just like RD flow
        return {
            success: true,
            downloading: true,
            status: 'downloading',
            progress: 0,
            nzoId: nzoId,
            title
        };

    } catch (err) {
        console.error('[Usenet-Stream] Error initiating SABnzbd download:', err);
        return {
            success: false,
            error: err.message || 'Failed to initiate Usenet download'
        };
    }
}

/**
 * Polls the SABnzbd queue/history for the status of an NZO ID.
 */
async function getUsenetStatus(event, nzoId) {
    if (!NZBDAV_URL) return { success: false, error: 'NZBDAV_URL missing' };
    
    try {
        let apiBase = NZBDAV_URL.replace(/\/$/, '');
        let queueUrl = `${apiBase}/api?mode=queue&output=json`;
        if (NZBDAV_API_KEY) queueUrl += `&apikey=${NZBDAV_API_KEY}`;
        
        let qRes = await fetchWithTimeout(queueUrl, {}, 5000);
        if (!qRes.ok) {
            queueUrl = `${apiBase}/sabnzbd/api?mode=queue&output=json`;
            if (NZBDAV_API_KEY) queueUrl += `&apikey=${NZBDAV_API_KEY}`;
            qRes = await fetchWithTimeout(queueUrl, {}, 5000);
        }

        if (qRes.ok) {
            const qData = await qRes.json();
            const queue = qData.queue || {};
            const slots = queue.slots || [];
            const matchedSlot = slots.find(slot => slot.nzo_id === nzoId);
            
            if (matchedSlot) {
                return {
                    success: true,
                    status: matchedSlot.status === 'Paused' ? 'paused' : 'downloading',
                    progress: parseFloat(matchedSlot.percentage || 0),
                    speed: parseFloat((matchedSlot.mb || 0) * 1024 * 1024) / (parseFloat(matchedSlot.timeleft || 1) * 60 || 1), // Approximate bytes/sec if needed, though SABnzbd provides speed globally
                    mbleft: matchedSlot.mbleft,
                    mb: matchedSlot.mb,
                    filename: matchedSlot.filename
                };
            }
        }
        
        // Not in queue, check history
        let historyUrl = `${apiBase}/api?mode=history&output=json`;
        if (NZBDAV_API_KEY) historyUrl += `&apikey=${NZBDAV_API_KEY}`;
        let hRes = await fetchWithTimeout(historyUrl, {}, 5000);
        if (!hRes.ok) {
            historyUrl = `${apiBase}/sabnzbd/api?mode=history&output=json`;
            if (NZBDAV_API_KEY) historyUrl += `&apikey=${NZBDAV_API_KEY}`;
            hRes = await fetchWithTimeout(historyUrl, {}, 5000);
        }
        
        if (hRes.ok) {
            const hData = await hRes.json();
            const history = hData.history || {};
            const slots = history.slots || [];
            const matchedSlot = slots.find(slot => slot.nzo_id === nzoId);
            
            if (matchedSlot) {
                if (matchedSlot.status === 'Completed') {
                    return {
                        success: true,
                        status: 'downloaded',
                        progress: 100,
                        filename: matchedSlot.name
                    };
                } else if (matchedSlot.status === 'Failed') {
                    return {
                        success: false,
                        status: 'error',
                        error: matchedSlot.fail_message || 'SABnzbd download failed'
                    };
                }
            }
        }
        
        return { success: true, status: 'unknown', progress: 0 };
    } catch (e) {
        console.error('[Usenet-Stream] Error polling status:', e);
        return { success: false, error: e.message };
    }
}

/**
 * Once completed, fetches the WebDAV URL for the extracted file.
 */
async function finalizeUsenetStream(event, { nzoId, folderName, title }) {
    try {
        if (!folderName) {
            folderName = title || 'Unknown';
            console.log(`[Usenet-Stream] No folder name provided, falling back to title: ${folderName}`);
        }

        console.log(`[Usenet-Stream] Finalizing WebDAV stream for folder: ${folderName}`);

        // 3. Perform PROPFIND on the WebDAV directory to find files
        // WebDAV URL configuration
        const webdavBase = NZBDAV_URL;
        let webdavFolderUrl = `${webdavBase}/${encodeURIComponent(folderName)}`;
        
        // Add authentication headers if configured
        const headers = {
            'Depth': '1',
            'Content-Type': 'application/xml'
        };
        if (NZBDAV_USER && NZBDAV_PASS) {
            const auth = Buffer.from(`${NZBDAV_USER}:${NZBDAV_PASS}`).toString('base64');
            headers['Authorization'] = `Basic ${auth}`;
        }

        let propfindRes = await fetchWithTimeout(webdavFolderUrl, {
            method: 'PROPFIND',
            headers
        }, 10000);

        if (!propfindRes.ok) {
            // Try with /dav prefix
            webdavFolderUrl = `${webdavBase}/dav/${encodeURIComponent(folderName)}`;
            propfindRes = await fetchWithTimeout(webdavFolderUrl, {
                method: 'PROPFIND',
                headers
            }, 10000);
        }

        if (!propfindRes.ok) {
            throw new Error(`WebDAV PROPFIND failed: HTTP ${propfindRes.status}`);
        }

        const xmlText = await propfindRes.text();
        
        // Extract all file paths from the XML response
        const hrefs = [];
        const hrefRegex = /<[a-zA-Z0-9:]*href[^>]*>([^<]+)<\/[a-zA-Z0-9:]*href>/g;
        let match;
        while ((match = hrefRegex.exec(xmlText)) !== null) {
            hrefs.push(decodeURIComponent(match[1]));
        }

        // Find the largest video file
        const videoExtensions = ['.mkv', '.mp4', '.avi', '.ts', '.mov', '.m4v'];
        const videoFiles = hrefs.filter(href => {
            const lower = href.toLowerCase();
            return videoExtensions.some(ext => lower.endsWith(ext));
        });

        if (videoFiles.length === 0) {
            throw new Error('No video files found inside the NZB folder');
        }

        // Sort video files or pick the first one (usually the main file)
        // If there are multiple, choose the one containing the folder name or the largest
        // Since we don't have sizes directly without parsing full XML nodes, we can pick the first video file
        // or one that doesn't look like a sample.
        const mainVideo = videoFiles.find(href => !href.toLowerCase().includes('sample')) || videoFiles[0];
        
        // Construct stream URL
        // If the href is absolute or relative, resolve it
        let streamUrl = '';
        if (mainVideo.startsWith('http://') || mainVideo.startsWith('https://')) {
            streamUrl = mainVideo;
        } else {
            // Build absolute URL from webdavFolderUrl
            const parsedBase = new URL(webdavBase);
            streamUrl = `${parsedBase.protocol}//${parsedBase.host}${mainVideo}`;
        }

        // Inject username and password into the stream URL if present
        if (NZBDAV_USER && NZBDAV_PASS) {
            const urlObj = new URL(streamUrl);
            urlObj.username = NZBDAV_USER;
            urlObj.password = NZBDAV_PASS;
            streamUrl = urlObj.toString();
        }

        console.log(`[Usenet-Stream] Successfully resolved stream URL: ${streamUrl}`);
        return {
            success: true,
            streamUrl,
            title,
            nzoId,
            folderName
        };

    } catch (err) {
        console.error('[Usenet-Stream] Error generating stream:', err);
        return {
            success: false,
            error: err.message || 'Failed to generate Usenet stream URL'
        };
    }
}

/**
 * Moves completed Usenet download folder to Google Drive immediately using rclone over SSH.
 */
async function moveUsenetToDrive(event, { folderName, nzoId }) {
    if (!folderName) {
        return { success: false, error: 'Folder name is required' };
    }

    return new Promise((resolve) => {
        const sshKeyPath = path.join(os.homedir(), '.ssh', 'tube-site-vps');
        const escapedFolder = folderName.replace(/"/g, '\\"');
        // Command moves directory contents to Google Drive under 'usenet' subfolder and deletes empty source directories
        const command = `ssh -o StrictHostKeyChecking=no -i "${sshKeyPath}" ubuntu@100.67.25.118 "sudo rclone move \\"/srv/vw-media/data/downloads/usenet/complete/${escapedFolder}\\" \\"gdrive:VaultWares/media/usenet/${escapedFolder}\\" --delete-empty-src-dirs && sudo rm -rf \\"/srv/vw-media/data/downloads/usenet/complete/${escapedFolder}\\""`;

        console.log(`[Usenet-Stream] Triggering immediate move to Drive for: ${folderName}`);
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`[Usenet-Stream] Failed to move Usenet folder to Google Drive: ${stderr || error.message}`);
                resolve({ success: false, error: stderr || error.message });
            } else {
                console.log(`[Usenet-Stream] Successfully moved Usenet folder to Google Drive: ${stdout}`);
                resolve({ success: true });
            }
        });
    });
}

function registerUsenetStreamHandlers(ipcMain) {
    ipcMain.handle('stream-usenet-nzb', async (event, params) => {
        return await streamUsenetNzb(event, params);
    });
    ipcMain.handle('get-usenet-status', async (event, nzoId) => {
        return await getUsenetStatus(event, nzoId);
    });
    ipcMain.handle('finalize-usenet-stream', async (event, params) => {
        return await finalizeUsenetStream(event, params);
    });
    ipcMain.handle('move-usenet-to-drive', async (event, params) => {
        return await moveUsenetToDrive(event, params);
    });
}

module.exports = {
    streamUsenetNzb,
    getUsenetStatus,
    finalizeUsenetStream,
    moveUsenetToDrive,
    registerUsenetStreamHandlers
};
