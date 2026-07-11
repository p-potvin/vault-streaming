// crypto.ipc.js — routes AES-256 virtual filesystem crypto operations to core workers.

const cryptoHandlers = require('../crypto');

function registerCryptoIpc(ipcMain) {
    cryptoHandlers.registerCryptoHandlers(ipcMain);
}

module.exports = {
    registerCryptoIpc
};
