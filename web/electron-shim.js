// web/electron-shim.js — headless stand-in for the `electron` module.
//
// Everything under src/ is written for the Electron main process and pulls
// `app`, `shell`, `clipboard`, `dialog`, `Menu` and `BrowserWindow` off the
// `electron` module. Forking those files for the web build would guarantee
// drift, so instead we intercept `require('electron')` and hand back this
// object. The surface below is exactly what src/ touches — nothing more.
//
// Install this BEFORE requiring anything from src/.

const Module = require('module');
const path = require('path');
const os = require('os');

const home = os.homedir();
const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');

// Deliberately the SAME directory the desktop app uses (Electron derives it from
// package.json "name"). The web client therefore shares settings, watch history
// and caches with the installed app rather than starting from a blank slate.
const USER_DATA = process.env.VW_WEB_USERDATA || path.join(appData, 'vault-streaming');

const PATHS = {
    home,
    appData,
    userData: USER_DATA,
    temp: os.tmpdir(),
    desktop: path.join(home, 'Desktop'),
    documents: path.join(home, 'Documents'),
    downloads: path.join(home, 'Downloads'),
    music: path.join(home, 'Music'),
    pictures: path.join(home, 'Pictures'),
    videos: path.join(home, 'Videos'),
    logs: path.join(USER_DATA, 'logs'),
    exe: process.execPath,
    module: process.execPath,
};

// Host-bound actions (open a file manager, write the system clipboard, pop a
// native menu) would act on the SERVER machine, not the viewer's. That is almost
// never what someone hitting this from another device wants, so they no-op and
// report it. The browser shim handles the ones that have a web equivalent.
function unsupported(what) {
    console.warn(`[web:electron-shim] ${what} is not available in the web client (host-bound action).`);
}

const app = {
    getPath(name) {
        const p = PATHS[name];
        if (!p) throw new Error(`[web:electron-shim] Unknown app.getPath('${name}')`);
        return p;
    },
    getName: () => 'vault-streaming',
    getVersion: () => {
        try { return require('../package.json').version; } catch (_) { return '0.0.0'; }
    },
    getAppPath: () => path.join(__dirname, '..'),
    isPackaged: false,
    on() { return app; },
    once() { return app; },
    whenReady: () => Promise.resolve(),
    quit() { unsupported('app.quit()'); },
    setPath(name, p) { PATHS[name] = p; },
};

const shell = {
    async openExternal(url) {
        // The browser opens external links itself (see openExternalURL in the
        // client shim); opening a browser tab on the server would be wrong.
        unsupported(`shell.openExternal(${String(url).slice(0, 80)})`);
        return undefined;
    },
    async openPath() { unsupported('shell.openPath()'); return 'Not available in the web client'; },
    showItemInFolder() { unsupported('shell.showItemInFolder()'); },
    beep() { },
};

const clipboard = {
    writeText() { unsupported('clipboard.writeText()'); },
    readText: () => '',
};

const dialog = {
    async showOpenDialog() { return { canceled: true, filePaths: [] }; },
    async showSaveDialog() { return { canceled: true, filePath: undefined }; },
    async showMessageBox() { return { response: 0, checkboxChecked: false }; },
    showErrorBox() { },
};

// Menu.popup() in the desktop app resolves a promise when the user clicks an
// item. Here nothing can ever be clicked, so popup() must NOT silently hang the
// caller — the bridge intercepts 'show-context-menu' before it reaches this.
const Menu = {
    buildFromTemplate: (template) => ({
        items: template,
        popup() { unsupported('Menu.popup()'); },
        closePopup() { },
    }),
    setApplicationMenu() { },
};

const BrowserWindow = {
    getAllWindows: () => [],
    getFocusedWindow: () => null,
    fromWebContents: () => null,
};

const electronShim = {
    app,
    shell,
    clipboard,
    dialog,
    Menu,
    BrowserWindow,
    ipcMain: null,        // supplied by ipc-bridge.js
    session: { defaultSession: { webRequest: { onBeforeSendHeaders() { }, onHeadersReceived() { } } } },
    components: { whenReady: () => Promise.resolve() },
    contextBridge: { exposeInMainWorld() { } },
    ipcRenderer: null,
    Tray: class { setToolTip() { } setContextMenu() { } on() { } },
};

let installed = false;
function install() {
    if (installed) return electronShim;
    const origLoad = Module._load;
    Module._load = function (request, ...rest) {
        if (request === 'electron') return electronShim;
        return origLoad.call(this, request, ...rest);
    };
    installed = true;
    return electronShim;
}

module.exports = { install, electronShim, USER_DATA, PATHS };
