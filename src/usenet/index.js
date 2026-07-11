// src/usenet/index.js - Aggregates Usenet IPC handlers (search, health, streaming)
const { init } = require("./cache");
const { registerUsenetSearchHandlers } = require("./search");
const { registerUsenetHealthHandlers } = require("./health");
const { registerUsenetStreamHandlers } = require("./stream");

function registerUsenetHandlers(ipcMain, app) {
    init(app);
    registerUsenetSearchHandlers(ipcMain);
    registerUsenetHealthHandlers(ipcMain);
    registerUsenetStreamHandlers(ipcMain);
    
    // Register streaming mode getter
    ipcMain.handle('get-streaming-mode', () => {
        return process.env.STREAMING_MODE || 'torrent-only';
    });
}

module.exports = { registerUsenetHandlers };

