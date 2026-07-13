// src/realdebrid/client.js - shared HTTP helper, .env loading, API tokens, and RD cache check

const fs = require('fs');
const path = require('path');

// Helper function to fetch with timeout
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

// Load environment variables from .env if process.env doesn't have it
let envConfig = {};
try {
    const envPath = path.join(__dirname, '..', '.env');
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
} catch (e) {
    console.error('[Real-Debrid] Failed to load .env file:', e);
}

const RD_TOKEN = process.env.REAL_DEBRID_API_TOKEN || envConfig.REAL_DEBRID_API_TOKEN;
const TMDB_BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN || envConfig.TMDB_BEARER_TOKEN;

function loadCometStreamBase() {
    let raw = process.env.COMET_STREAM_BASE || envConfig.COMET_STREAM_BASE || '';
    if (!raw) {
        try {
            const accessPath = path.join(__dirname, '..', '..', '..', '.access', 'comet_config.txt');
            if (fs.existsSync(accessPath)) {
                raw = fs.readFileSync(accessPath, 'utf8').trim().split(/\r?\n/)[0].trim();
            }
        } catch (e) {
            console.error('[Comet] Failed to read .access/comet_config.txt:', e.message);
        }
    }
    if (!raw) return '';
    return raw.replace(/\/manifest\.json\/*$/i, '').replace(/\/+$/, '');
}

const COMET_STREAM_BASE = loadCometStreamBase();

// DISABLED: this used to call api.real-debrid.com/instantAvailability directly
// from the account IP — a policy violation and a ban risk. Comet already tags
// cached streams (they carry a resolved url), so this is a no-op kept only for
// API compatibility. Do NOT restore the direct Real-Debrid call.
async function checkRealDebridCache(torrentList) {
    return torrentList;
}

module.exports = { fetchWithTimeout, checkRealDebridCache, RD_TOKEN, TMDB_BEARER_TOKEN, COMET_STREAM_BASE };
