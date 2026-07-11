// src/realdebrid/proxy.js - HTTP CONNECT proxy tunnelling and proxied file downloader
const fs = require("fs");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const { fetchWithTimeout } = require("./client");

function parseProxyString(proxyStr) {
    if (!proxyStr) return null;
    let proxyNormalized = proxyStr.trim();
    if (!/^https?:\/\//i.test(proxyNormalized)) {
        proxyNormalized = 'http://' + proxyNormalized;
    }
    try {
        const proxyUrl = new URL(proxyNormalized);
        const host = proxyUrl.hostname;
        const port = parseInt(proxyUrl.port, 10) || 80;
        let authHeader = null;
        if (proxyUrl.username && proxyUrl.password) {
            authHeader = 'Basic ' + Buffer.from(decodeURIComponent(proxyUrl.username) + ':' + decodeURIComponent(proxyUrl.password)).toString('base64');
        }
        return { host, port, authHeader };
    } catch (e) {
        console.error('[Real-Debrid] Failed to parse proxy string:', proxyStr, e);
        return null;
    }
}

function makeProxiedRequest(url, options = {}, proxyStr) {
    if (!proxyStr) {
        return fetchWithTimeout(url, options);
    }
    const proxyConfig = parseProxyString(proxyStr);
    if (!proxyConfig) {
        return Promise.reject(new Error('Invalid proxy address format'));
    }
    return new Promise((resolve, reject) => {
        try {
            const urlObj = new URL(url);
            const connectHeaders = {};
            if (proxyConfig.authHeader) {
                connectHeaders['Proxy-Authorization'] = proxyConfig.authHeader;
            }
            
            const req = http.request({
                host: proxyConfig.host,
                port: proxyConfig.port,
                method: 'CONNECT',
                path: `${urlObj.hostname}:${urlObj.port || 443}`,
                headers: connectHeaders
            });
            
            req.on('connect', (res, socket, socketHead) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Proxy CONNECT failed with status: ${res.statusCode}`));
                    return;
                }
                const headers = options.headers || {};
                let bodyData = options.body;
                if (bodyData && typeof bodyData.toString === 'function') {
                    bodyData = bodyData.toString();
                    if (!headers['Content-Type'] && !headers['content-type']) {
                        headers['Content-Type'] = 'application/x-www-form-urlencoded';
                    }
                }
                
                const requestOptions = {
                    hostname: urlObj.hostname,
                    port: urlObj.port || 443,
                    path: urlObj.pathname + urlObj.search,
                    method: options.method || 'GET',
                    headers: headers,
                    createConnection: () => socket
                };
                
                const clientReq = https.request(requestOptions, (clientRes) => {
                    let bodyChunks = [];
                    clientRes.on('data', chunk => bodyChunks.push(chunk));
                    clientRes.on('end', () => {
                        const bodyBuffer = Buffer.concat(bodyChunks);
                        const bodyString = bodyBuffer.toString('utf8');
                        resolve({
                            ok: clientRes.statusCode >= 200 && clientRes.statusCode < 300,
                            status: clientRes.statusCode,
                            text: async () => bodyString,
                            json: async () => JSON.parse(bodyString)
                        });
                    });
                });
                
                clientReq.on('error', (err) => {
                    reject(err);
                });
                
                if (bodyData) {
                    clientReq.write(bodyData);
                }
                clientReq.end();
            });
            
            req.on('error', (err) => {
                reject(new Error(`Proxy connection error: ${err.message}`));
            });
            
            req.end();
        } catch (e) {
            reject(e);
        }
    });
}

function downloadFileWithProxy(downloadUrl, destPath, proxyStr, onProgress) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(downloadUrl);
        const fileStream = fs.createWriteStream(destPath);
        
        let req;
        
        const handleResponse = (res) => {
            if (res.statusCode !== 200) {
                fileStream.close();
                try { fs.unlinkSync(destPath); } catch(_) {}
                return reject(new Error(`Server returned status code: ${res.statusCode}`));
            }
            
            const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
            let downloadedBytes = 0;
            let lastUpdate = Date.now();
            let lastBytes = 0;
            
            res.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                fileStream.write(chunk);
                
                const now = Date.now();
                if (now - lastUpdate >= 300) {
                    const elapsed = (now - lastUpdate) / 1000;
                    const speed = elapsed > 0 ? (downloadedBytes - lastBytes) / elapsed : 0;
                    
                    onProgress({
                        progress: totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 0,
                        speed,
                        bytesDownloaded: downloadedBytes,
                        totalBytes,
                        status: 'Downloading'
                    });
                    
                    lastUpdate = now;
                    lastBytes = downloadedBytes;
                }
            });
            
            res.on('end', () => {
                fileStream.end();
                onProgress({
                    progress: 100,
                    speed: 0,
                    bytesDownloaded: downloadedBytes,
                    totalBytes,
                    status: 'Completed'
                });
                resolve();
            });
        };
 
        if (proxyStr) {
            const proxyConfig = parseProxyString(proxyStr);
            if (!proxyConfig) {
                fileStream.close();
                try { fs.unlinkSync(destPath); } catch(_) {}
                return reject(new Error('Invalid proxy address format'));
            }
            const connectHeaders = {};
            if (proxyConfig.authHeader) {
                connectHeaders['Proxy-Authorization'] = proxyConfig.authHeader;
            }
            
            req = http.request({
                host: proxyConfig.host,
                port: proxyConfig.port,
                method: 'CONNECT',
                path: `${urlObj.hostname}:${urlObj.port || 443}`,
                headers: connectHeaders
            });
            
            req.on('connect', (res, socket, socketHead) => {
                if (res.statusCode !== 200) {
                    fileStream.close();
                    try { fs.unlinkSync(destPath); } catch(_) {}
                    reject(new Error(`Proxy CONNECT failed with status: ${res.statusCode}`));
                    return;
                }
                const clientReq = https.request({
                    hostname: urlObj.hostname,
                    port: urlObj.port || 443,
                    path: urlObj.pathname + urlObj.search,
                    method: 'GET',
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                    createConnection: () => socket
                }, handleResponse);
                
                clientReq.on('error', (err) => {
                    fileStream.close();
                    try { fs.unlinkSync(destPath); } catch(_) {}
                    reject(err);
                });
                clientReq.end();
            });
            
            req.on('error', (err) => {
                fileStream.close();
                try { fs.unlinkSync(destPath); } catch(_) {}
                reject(err);
            });
            req.end();
        } else {
            https.get(downloadUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, handleResponse)
                .on('error', (err) => {
                    fileStream.close();
                    try { fs.unlinkSync(destPath); } catch(_) {}
                    reject(err);
                });
        }
    });
}

module.exports = { parseProxyString, makeProxiedRequest, downloadFileWithProxy };
