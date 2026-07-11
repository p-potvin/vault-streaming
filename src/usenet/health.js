// src/usenet/health.js - Usenet NNTP health checks, completion verification, and password detection
const net = require('net');
const tls = require('tls');
const { fetchWithTimeout, EASYNEWS_HOST, EASYNEWS_PORT, EASYNEWS_SSL, EASYNEWS_USER, EASYNEWS_PASS } = require("./client");
const cache = require("./cache");

/**
 * Checks a list of message IDs against the NNTP server.
 * @returns {Promise<Object>} Map of messageId -> 'healthy'|'missing'|'error'
 */
function checkMessageIds(messageIds) {
    return new Promise((resolve, reject) => {
        if (!EASYNEWS_HOST || !EASYNEWS_USER || !EASYNEWS_PASS) {
            return reject(new Error('Easynews configuration is incomplete. Host, user, and password are required.'));
        }

        if (messageIds.length === 0) {
            return resolve({});
        }

        const socket = EASYNEWS_SSL 
            ? tls.connect({ host: EASYNEWS_HOST, port: EASYNEWS_PORT, rejectUnauthorized: false })
            : net.connect({ host: EASYNEWS_HOST, port: EASYNEWS_PORT });
        
        let buffer = '';
        let step = 'connect'; // connect -> auth_user -> auth_pass -> stats -> quit
        let messageIdx = 0;
        const results = {};
        let socketEnded = false;
        
        socket.setTimeout(10000); // 10 seconds timeout
        
        const write = (data) => {
            if (socket.destroyed || socketEnded) return;
            socket.write(data + '\r\n');
        };
        
        socket.on('data', (chunk) => {
            buffer += chunk.toString();
            while (buffer.includes('\n')) {
                const lineIdx = buffer.indexOf('\n');
                const line = buffer.substring(0, lineIdx).trim();
                buffer = buffer.substring(lineIdx + 1);
                
                const code = line.substring(0, 3);
                
                if (step === 'connect') {
                    if (code === '200' || code === '201') {
                        step = 'auth_user';
                        write(`AUTHINFO USER ${EASYNEWS_USER}`);
                    } else {
                        socket.destroy(new Error(`Bad greeting: ${line}`));
                    }
                } else if (step === 'auth_user') {
                    if (code === '381') {
                        step = 'auth_pass';
                        write(`AUTHINFO PASS ${EASYNEWS_PASS}`);
                    } else if (code === '281') {
                        step = 'stats';
                        sendNextStat();
                    } else {
                        socket.destroy(new Error(`User auth failed: ${line}`));
                    }
                } else if (step === 'auth_pass') {
                    if (code === '281') {
                        step = 'stats';
                        sendNextStat();
                    } else {
                        socket.destroy(new Error(`Password auth failed: ${line}`));
                    }
                } else if (step === 'stats') {
                    const currentId = messageIds[messageIdx - 1];
                    if (code === '223') {
                        results[currentId] = 'healthy';
                    } else if (code === '430') {
                        results[currentId] = 'missing';
                    } else {
                        results[currentId] = 'error';
                    }
                    
                    if (messageIdx < messageIds.length) {
                        sendNextStat();
                    } else {
                        step = 'quit';
                        write('QUIT');
                    }
                } else if (step === 'quit') {
                    socketEnded = true;
                    socket.end();
                }
            }
        });
        
        function sendNextStat() {
            if (messageIdx < messageIds.length) {
                let id = messageIds[messageIdx++];
                // Strip angle brackets if already present to prevent doubling
                id = id.replace(/^</, '').replace(/>$/, '');
                write(`STAT <${id}>`);
            }
        }
        
        socket.on('timeout', () => {
            socket.destroy(new Error('NNTP socket connection timed out'));
        });
        
        socket.on('error', (err) => {
            reject(err);
        });
        
        socket.on('close', () => {
            resolve(results);
        });
    });
}

/**
 * Checks if NZB file has password flags in file names or XML attributes.
 * @param {string} xmlString 
 * @returns {object} { isPassworded: boolean, reason: string }
 */
function checkNzbPasswordAndSpam(xmlString) {
    // 1. Extract subject fields
    const subjects = [];
    const subjectRegex = /subject="([^"]+)"/g;
    let match;
    while ((match = subjectRegex.exec(xmlString)) !== null) {
        subjects.push(match[1]);
    }

    // Common password indicator patterns
    const passwordPatterns = [
        /\b(password|pass|pw|code)\b.*?\.(txt|url|html?|png|jpg|jpeg)/i,
        /visit.*?(for|get).*?password/i,
        /password.*?required/i,
        /passworded/i
    ];

    for (const sub of subjects) {
        for (const pattern of passwordPatterns) {
            if (pattern.test(sub)) {
                return { isPassworded: true, reason: `Password indicator in file name: ${sub}` };
            }
        }
    }

    // 2. Check for spam/malware files (e.g. .exe / .scr / .zip inside video posts)
    let exeCount = 0;
    let scrapCount = 0;
    for (const sub of subjects) {
        if (/\.(exe|scr|bat|lnk|vbs|msi)/i.test(sub)) exeCount++;
        scrapCount++;
    }

    if (exeCount > 0 && scrapCount > 0 && exeCount / scrapCount > 0.5) {
        return { isPassworded: true, reason: 'NZB contains high percentage of executable files (likely malware/spam)' };
    }

    return { isPassworded: false };
}

/**
 * Runs a health check on an NZB download link.
 * @param {string} downloadUrl 
 * @param {string} [guid] Optional unique cache identifier
 * @returns {Promise<object>} Status result
 */
async function verifyNzbHealth(downloadUrl, guid) {
    const cacheKey = guid || downloadUrl;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
        console.log(`[Usenet-Health] Fetching NZB: ${downloadUrl}`);
        const res = await fetchWithTimeout(downloadUrl, {}, 12000);
        if (!res.ok) {
            throw new Error(`Failed to fetch NZB file: HTTP ${res.status}`);
        }
        
        const xmlString = await res.text();
        
        // 1. Password and Malware Check
        const pwCheck = checkNzbPasswordAndSpam(xmlString);
        if (pwCheck.isPassworded) {
            const verdict = {
                health: 'unhealthy',
                isPassworded: true,
                completionPercent: 0,
                reason: pwCheck.reason
            };
            cache.set(cacheKey, verdict);
            return verdict;
        }

        // 2. Extract segment message IDs
        const segmentRegex = /<segment[^>]*>([^<]+)<\/segment>/g;
        const allSegments = [];
        let segMatch;
        while ((segMatch = segmentRegex.exec(xmlString)) !== null) {
            allSegments.push(segMatch[1].trim());
        }

        if (allSegments.length === 0) {
            const verdict = {
                health: 'unhealthy',
                isPassworded: false,
                completionPercent: 0,
                reason: 'NZB file contains no message segments'
            };
            cache.set(cacheKey, verdict);
            return verdict;
        }

        // Sample up to 6 segments: start, middle, end
        const samples = [];
        const count = allSegments.length;
        if (count <= 6) {
            samples.push(...allSegments);
        } else {
            samples.push(allSegments[0]);
            samples.push(allSegments[Math.floor(count * 0.2)]);
            samples.push(allSegments[Math.floor(count * 0.4)]);
            samples.push(allSegments[Math.floor(count * 0.6)]);
            samples.push(allSegments[Math.floor(count * 0.8)]);
            samples.push(allSegments[count - 1]);
        }

        console.log(`[Usenet-Health] Querying NNTP for ${samples.length} message IDs`);
        const stats = await checkMessageIds(samples);

        let availableCount = 0;
        for (const s of samples) {
            if (stats[s] === 'healthy') {
                availableCount++;
            }
        }

        const completion = (availableCount / samples.length) * 100;
        const isHealthy = completion >= 80; // 80% completion sample or better

        const verdict = {
            health: isHealthy ? 'healthy' : 'unhealthy',
            isPassworded: false,
            completionPercent: Math.round(completion),
            reason: isHealthy ? 'High segment completion on provider' : `Low completion: ${availableCount}/${samples.length} segments found`
        };

        cache.set(cacheKey, verdict);
        return verdict;

    } catch (e) {
        console.error('[Usenet-Health] Health check execution error:', e.message);
        return {
            health: 'unknown',
            isPassworded: false,
            completionPercent: 0,
            reason: `Health verification failed: ${e.message}`
        };
    }
}

function registerUsenetHealthHandlers(ipcMain) {
    ipcMain.handle('verify-usenet-health', async (event, { downloadUrl, guid }) => {
        return await verifyNzbHealth(downloadUrl, guid);
    });
}

module.exports = {
    checkMessageIds,
    checkNzbPasswordAndSpam,
    verifyNzbHealth,
    registerUsenetHealthHandlers
};

