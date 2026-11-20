// src/app-log.js — everything the main process prints (and the renderer lines it forwards) also goes to a file:
// %APPDATA%\vault-streaming\logs\vault-streaming.log (the previous run kept as vault-streaming.1.log). The console
// window is a poor place to read errors: selecting text there pauses the app's output (QuickEdit) and Ctrl+C ends it.
//
// Secrets never reach the file or the console: a Comet URL embeds the debrid API keys as a base64 config segment
// (/eyJ…/), which is cut out of every line (redact()).

const fs = require('fs');
const path = require('path');
const util = require('util');

const MAX_BYTES = 20 * 1024 * 1024;   // a long session; rotated once at start-up

/** A line without secrets: Comet configs (/eyJ…), api keys and tokens in query strings. */
function redact(text) {
    return String(text)
        // up to the Comet route that follows the config (a base64 config may itself contain "/"), else to the next "/"
        .replace(/\/eyJ[A-Za-z0-9_\-+=/]*?(?=\/(?:stream|playback|manifest|configure)\/)/g, '/<config>')
        .replace(/\/eyJ[A-Za-z0-9_\-+=]{16,}/g, '/<config>')
        .replace(/([?&](?:api_?key|apikey|token|access_token|key)=)[^&\s"']+/gi, '$1<redacted>');
}

let stream = null;

function install(userDataDir) {
    if (stream) return;
    try {
        const dir = path.join(userDataDir, 'logs');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'vault-streaming.log');
        try {
            if (fs.existsSync(file)) fs.renameSync(file, path.join(dir, 'vault-streaming.1.log'));
        } catch (_) { /* in use: keep appending */ }
        stream = fs.createWriteStream(file, { flags: 'a' });
        stream.on('error', () => { stream = null; });
    } catch (_) {
        stream = null;
    }
    let written = 0;
    const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
    for (const level of ['log', 'info', 'warn', 'error']) {
        const original = console[level].bind(console);
        console[level] = (...args) => {
            const line = redact(util.format(...args));
            original(line);
            if (stream && written < MAX_BYTES) {
                const out = `${stamp()} ${level.toUpperCase().padEnd(5)} ${line}\n`;
                written += out.length;
                stream.write(out);
            }
        };
    }
}

module.exports = { install, redact };
