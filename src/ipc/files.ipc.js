// files.ipc.js — minimal file helpers for Vault Streaming.
// The full vault-explorer module handled local-vault file management; the
// streaming client only needs safeOpenFile (used by system.ipc's open handlers).

const path = require('path');
const fs = require('fs');
const child_process = require('child_process');
const { shell } = require('electron');

function safeOpenFile(filePath) {
    if (typeof filePath !== 'string' || !fs.existsSync(filePath)) {
        return Promise.reject(new Error('File not found'));
    }
    const safePath = path.normalize(path.resolve(filePath));
    return shell.openPath(safePath).then(err => {
        if (err) {
            console.error('[files.ipc:open] shell.openPath failed, falling back to start command:', err);
            return new Promise((resolve, reject) => {
                const escapedPath = `"${safePath.replace(/"/g, '""')}"`;
                child_process.exec(`start "" ${escapedPath}`, (execErr) => {
                    if (execErr) reject(execErr);
                    else resolve();
                });
            });
        }
    });
}

module.exports = { safeOpenFile };
