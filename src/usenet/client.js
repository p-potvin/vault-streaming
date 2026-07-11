// src/usenet/client.js - Shared Usenet configuration and fetch utilities
const fs = require('fs');
const path = require('path');

let envConfig = {};
try {
    const envPaths = [
        path.join(process.cwd(), '.env'),
        path.join(path.dirname(process.execPath), '.env'),
        process.resourcesPath ? path.join(process.resourcesPath, '.env') : null,
        path.join(__dirname, '.env'),
        path.join(__dirname, '..', '.env'),
        path.join(__dirname, '..', '..', '.env')
    ].filter(Boolean);
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
            break;
        }
    }
} catch (e) {
    console.error('[usenet-client] Failed to load .env file:', e);
}

// Load Easynews config
let easynewsConfig = {};
try {
    const easyPath = 'C:\\Users\\Administrator\\Desktop\\Prom-King\\.access\\easynews_config.txt';
    if (fs.existsSync(easyPath)) {
        const easyContent = fs.readFileSync(easyPath, 'utf8');
        easyContent.split(/\r?\n/).forEach(line => {
            const parts = line.split('=');
            if (parts.length >= 2) {
                const key = parts[0].trim();
                const value = parts.slice(1).join('=').trim();
                if (key) {
                    easynewsConfig[key] = value;
                }
            }
        });
    }
} catch (e) {
    console.error('[usenet-client] Failed to load easynews_config.txt:', e.message);
}

const PROWLARR_URL = process.env.PROWLARR_URL || envConfig.PROWLARR_URL || 'http://localhost:9696';
const PROWLARR_API_KEY = process.env.PROWLARR_API_KEY || envConfig.PROWLARR_API_KEY || '';
const NZBDAV_URL = process.env.NZBDAV_URL || envConfig.NZBDAV_URL || '';
const TMDB_BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN || envConfig.TMDB_BEARER_TOKEN;

// Easynews
const EASYNEWS_HOST = process.env.EASYNEWS_HOST || envConfig.EASYNEWS_HOST || easynewsConfig.EASYNEWS_URL || 'news.easynews.com';
const EASYNEWS_SSL = (process.env.EASYNEWS_SSL || envConfig.EASYNEWS_SSL || easynewsConfig.EASY_NEWS_SSL || '1') === '1';
const EASYNEWS_PORT = parseInt(process.env.EASYNEWS_PORT || envConfig.EASYNEWS_PORT || (EASYNEWS_SSL ? '563' : '119'), 10);
const EASYNEWS_USER = process.env.EASYNEWS_USER || envConfig.EASYNEWS_USER || easynewsConfig.EASYNEWS_USERNAME || '';
const EASYNEWS_PASS = process.env.EASYNEWS_PASS || envConfig.EASYNEWS_PASS || easynewsConfig.EASYNEWS_PASSWORD || '';

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response;
    } catch (err) {
        clearTimeout(timeoutId);
        throw err;
    }
}

module.exports = {
    fetchWithTimeout,
    PROWLARR_URL,
    PROWLARR_API_KEY,
    NZBDAV_URL,
    TMDB_BEARER_TOKEN,
    EASYNEWS_HOST,
    EASYNEWS_PORT,
    EASYNEWS_SSL,
    EASYNEWS_USER,
    EASYNEWS_PASS
};

