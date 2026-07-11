// src/realdebrid/index.js - aggregates Real-Debrid IPC handlers (search, stream, proxy)
require("./client"); // ensure .env side-effects load even if no handler references them
const { registerSearchHandlers } = require("./search");
const { registerStreamHandlers } = require("./stream");
const { registerProxyHandlers } = require("./proxy-handlers");

function registerRealDebridHandlers(ipcMain) {
    registerSearchHandlers(ipcMain);
    registerStreamHandlers(ipcMain);
    registerProxyHandlers(ipcMain);
}

module.exports = { registerRealDebridHandlers };
