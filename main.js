const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, Tray, session, components } = require('electron');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;

// Load environment variables at early startup
function loadEnv() {
    const envPaths = [
        path.join(process.cwd(), '.env'),
        path.join(path.dirname(process.execPath), '.env'),
        process.resourcesPath ? path.join(process.resourcesPath, '.env') : null,
        path.join(__dirname, '.env'),
        path.join(__dirname, '..', '.env')
    ].filter(Boolean);
    for (const envPath of envPaths) {
        try {
            if (fs.existsSync(envPath)) {
                console.log('[ENV] Loading environment variables from:', envPath);
                const envContent = fs.readFileSync(envPath, 'utf8');
                envContent.split(/\r?\n/).forEach(line => {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) return;
                    const parts = line.split('=');
                    if (parts.length >= 2) {
                        const key = parts[0].trim();
                        const value = parts.slice(1).join('=').trim();
                        if (key && !process.env[key]) {
                            process.env[key] = value;
                        }
                    }
                });
                break;
            }
        } catch (e) {
            console.error('[ENV] Failed to load .env from:', envPath, e);
        }
    }
}
loadEnv();

// Windows identity. Without these the app reports itself as "Electron":
// notifications, taskbar grouping and jump lists all key off the AppUserModelID,
// and app.getName() feeds the About panel and crash reports.
// NOTE: the Task Manager *image name* comes from the executable, so in dev it
// stays electron.exe no matter what — only a packaged build (electron-builder
// productName "Vault Streaming") renames the process itself.
app.setName('Vault Streaming');
if (process.platform === 'win32') {
    app.setAppUserModelId('com.vaultwares.vaultstreaming');
    // The taskbar jump list otherwise inherits the Electron binary's own tasks
    // and shows "Electron" as its heading in a dev run. An empty user-task list
    // removes that section; the heading itself comes from the exe's version info,
    // so a packaged build is what fully rebrands it.
    try { app.setUserTasks([]); } catch (e) { /* not fatal */ }
}
// Keep reading/writing the settings folder the app has always used; setName()
// would otherwise move userData to %APPDATA%\Vault Streaming and orphan
// vault-settings.json and the watch history.
app.setPath('userData', path.join(app.getPath('appData'), 'vault-streaming'));

// Import modular files
const utils = require('./src/utils');

const child_process = require('child_process');
const { execFile } = child_process;
const tmdbHandlers = require('./src/tmdb');
const realDebridHandlers = require('./src/realdebrid');
const watchHistoryHandlers = require('./src/watch-history');
const liveSubtitlesHandlers = require('./src/live-subtitles');
// usenet disabled — VaultWares single-IP/Comet-only policy


let mainWindow;
let tray = null;
let splashWindow = null;
let splashShownAt = 0;

// Branded splash shown while the main window boots (TMDB, AI warmup, etc.).
function createSplash() {
    splashWindow = new BrowserWindow({
        width: 420, height: 320,
        frame: false, transparent: true, resizable: false,
        center: true, alwaysOnTop: true, skipTaskbar: true, show: false,
        icon: path.join(__dirname, 'build', 'icon.ico'),
        webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    splashWindow.loadFile('splash.html');
    splashWindow.once('ready-to-show', () => { splashWindow && splashWindow.show(); });
    splashShownAt = Date.now();
}

// Close the splash and reveal the main window, guaranteeing a minimum on-screen
// time so the animation is never a jarring one-frame flash.
let splashFinished = false;
function finishSplash() {
    if (splashFinished) return;
    splashFinished = true;
    const MIN_MS = 3000;
    const wait = Math.max(0, MIN_MS - (Date.now() - splashShownAt));
    setTimeout(() => {
        if (splashWindow && !splashWindow.isDestroyed()) { splashWindow.close(); splashWindow = null; }
        if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
    }, wait);
}
let isQuitting = false;

// Windows process cleanup helpers
function getProcessName() {
    return path.basename(process.execPath);
}

function killAllOwnProcesses(includeSelf = true) {
    // Kill only processes with OUR OWN executable image name. Never run in dev:
    // there the image is electron.exe, shared with every other Electron app on
    // the machine (this previously hardcoded vault-explorer.exe, so launching
    // Vault Streaming would kill a running Vault Explorer).
    const execName = getProcessName();
    const lower = execName.toLowerCase();
    if (process.platform !== 'win32' || lower === 'electron.exe' || !lower.startsWith('vault')) return;

    if (includeSelf) {
        try {
            child_process.spawn('taskkill', ['/F', '/IM', execName], {
                detached: true,
                windowsHide: true,
                stdio: 'ignore'
            }).unref();
        } catch (err) {
            console.error('[cleanup] Failed to spawn self-killing taskkill:', err);
        }
        return;
    }

    // Kill sibling processes of the SAME app except the current PID
    const baseName = execName.replace(/\.exe$/i, '');
    const currentPid = process.pid;
    try {
        child_process.spawn('powershell.exe', [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
            `Get-Process -Name '${baseName}' -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne ${currentPid} } | Stop-Process -Force -ErrorAction SilentlyContinue`
        ], {
            detached: true,
            windowsHide: true,
            stdio: 'ignore'
        }).unref();
    } catch (err) {
        console.error('[cleanup] Failed to kill sibling processes:', err);
    }
}

function performFullAppCleanup() {
    console.log('[main:cleanup] Full app cleanup requested');
    try { liveSubtitlesHandlers.shutdownLiveSubtitles(); } catch (e) { /* noop */ }
    try { watchHistoryHandlers.flushNow(); } catch (e) { /* noop */ }
    // NOTE: the old killNodeProcesses() nuked EVERY node.exe on the machine —
    // removed. utils.killAllActiveSubprocesses() already kills our own tracked
    // subprocess trees.
    utils.killAllActiveSubprocesses();
    killAllOwnProcesses(true);
}

async function cleanupStaleTempFiles(vaultPath) {
    // Remove any .tmp files left behind by a previous crash or kill. These are
    // intentionally disposable: the atomic-write logic only renames them to the
    // final output on success, so a leftover .tmp is always safe to delete.
    const subDirs = ['.thumbs', '.enhanced'];
    for (const sub of subDirs) {
        const dir = path.join(vaultPath, sub);
        if (!fs.existsSync(dir)) continue;
        try {
            const entries = await fsPromises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isFile() && entry.name.endsWith('.tmp')) {
                    const tmpPath = path.join(dir, entry.name);
                    try {
                        await fsPromises.unlink(tmpPath);
                        console.log('[main:cleanup] Removed stale temp file:', tmpPath);
                    } catch (e) {
                        console.warn('[main:cleanup] Could not remove stale temp file:', tmpPath, e.message);
                    }
                }
            }
        } catch (e) {
            console.warn('[main:cleanup] Failed to scan for stale temp files in', dir, e.message);
        }
    }
}

async function cleanupAllVaultTempFiles() {
    const settings = loadSettings();
    const folders = settings.folders || [];
    for (const folder of folders) {
        if (!folder || !folder.path) continue;
        await cleanupStaleTempFiles(folder.path);
    }
}

function createTray() {
    if (tray) return;
    const trayIconPath = path.join(__dirname, 'build', 'icon.ico');
    if (fs.existsSync(trayIconPath)) {
        tray = new Tray(trayIconPath);
        const contextMenu = Menu.buildFromTemplate([
            { label: 'Show Vault Explorer', click: () => { mainWindow.show(); } },
            { type: 'separator' },
            { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
        ]);
        tray.setToolTip('Vault Explorer');
        tray.setContextMenu(contextMenu);
        tray.on('double-click', () => {
            mainWindow.show();
        });
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200, height: 800,
        show: false, // revealed by finishSplash() once ready (see splash flow)
        icon: path.join(__dirname, 'build', 'icon.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: true,
            autoplayPolicy: 'no-user-gesture-required'
        },
        autoHideMenuBar: true,
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#2f3241', symbolColor: '#B07CFF' }
    });
    mainWindow.maximize();

    // Reveal once the renderer has painted; the splash enforces a min display time.
    mainWindow.once('ready-to-show', finishSplash);

    // YouTube Referer & Origin overrides to fix Error 152/153/4 (domain embedding restrictions)
    // Apply to ALL sessions to cover iframe requests
    const youtubeUrls = ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*', '*://*.googlevideo.com/*'];

    session.defaultSession.webRequest.onBeforeSendHeaders(
        { urls: youtubeUrls },
        (details, callback) => {
            const headers = details.requestHeaders || {};
            // Clean up any casing variations of Referer and Origin
            for (const key of Object.keys(headers)) {
                const lowerKey = key.toLowerCase();
                if (lowerKey === 'referer' || lowerKey === 'origin') {
                    delete headers[key];
                }
            }
            // Set required YouTube headers to spoof a request from YouTube itself
            headers['Referer'] = 'https://www.youtube.com/';
            headers['Origin'] = 'https://www.youtube.com';
            headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
            callback({ cancel: false, requestHeaders: headers });
        }
    );

    // Bypass frame blocking restrictions on YouTube trailer embedding
    session.defaultSession.webRequest.onHeadersReceived(
        { urls: youtubeUrls },
        (details, callback) => {
            const responseHeaders = details.responseHeaders || {};
            // Remove security headers that block iframe embedding case-insensitively
            for (const key of Object.keys(responseHeaders)) {
                const lowerKey = key.toLowerCase();
                if (lowerKey === 'x-frame-options' || lowerKey === 'content-security-policy' || lowerKey === 'x-content-security-policy') {
                    delete responseHeaders[key];
                }
            }
            callback({ cancel: false, responseHeaders });
        }
    );

    mainWindow.loadFile('index.html');

    mainWindow.on('close', (e) => {
        if (!isQuitting) {
            const settings = loadSettings();
            if (settings.minimizeToTray) {
                e.preventDefault();
                mainWindow.webContents.send('app-hidden');
                mainWindow.hide();
                return;
            }
        }
        performFullAppCleanup();
    });

    // Only create the tray icon when the user has opted into tray behavior.
    if (loadSettings().minimizeToTray) createTray();
}

app.whenReady().then(async () => {
    try {
        // Clean up any orphaned vault-explorer processes from a previous bad exit
        killAllOwnProcesses(false);

        // wait for Widevine CDM installation to finish
        // this is from the castlabs branch of electron
        await components.whenReady();

        createSplash();
        createWindow();
        // Safety net: never let a missed 'ready-to-show' strand the app on the splash.
        setTimeout(finishSplash, 8000);
        app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

        // Remove leftover .tmp files from previous crashes/kills in the background.
        // This runs after the window is created so startup is never blocked by I/O.
        cleanupAllVaultTempFiles().catch(err => {
            console.warn('[main:cleanup] Startup temp-file cleanup failed:', err.message);
        });
    } catch (err) {
        console.error('[main:startup] App initialization failed:', err);
        // Proceed to launch or gracefully show error UI if Widevine/process cleanup fails
        createWindow();
    }
})
    .catch(err => {
        console.error('[main:fatal] app.whenReady rejected:', err);
    });

app.on('before-quit', () => {
    isQuitting = true;
    performFullAppCleanup();
});
app.on('window-all-closed', () => {
    performFullAppCleanup();
    if (process.platform !== 'darwin') app.quit();
});

// Native fullscreen toggle for the player. Document fullscreen alone leaves
// the OS window resizable, which paints resize cursors at the screen edges.
ipcMain.handle('set-window-fullscreen', (_e, on) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    mainWindow.setFullScreen(!!on);
    return mainWindow.isFullScreen();
});

// Automatic clean exit subprocess killing hooks
app.on('will-quit', performFullAppCleanup);
process.on('exit', performFullAppCleanup);

// Load / Save Settings
const settingsPath = path.join(app.getPath('userData'), 'vault-settings.json');
function loadSettings() {
    try {
        if (fs.existsSync(settingsPath)) {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            if (settings.mutePreviews === undefined) {
                settings.mutePreviews = false;
            }
            settings.tmdbBearerToken = process.env.TMDB_BEARER_TOKEN;
            return settings;
        }
    } catch (e) { }
    return { folders: [], mutePreviews: false, tmdbBearerToken: process.env.TMDB_BEARER_TOKEN };
}
async function saveSettings(settings) {
    try {
        await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error('[saveSettings] Failed to save settings:', e);
        return false;
    }
}

// Register Split IPC Handlers

const { registerSystemIpc } = require('./src/ipc/system.ipc');
const { registerMediaIpc } = require('./src/ipc/media.ipc');
const { registerSubtitlesIpc } = require('./src/ipc/subtitles.ipc');
const { registerTranscodeIpc } = require('./src/ipc/transcode.ipc');
const { registerClipIpc } = require('./src/ipc/clip.ipc');
const { registerTrailerCacheIpc } = require('./src/ipc/trailer-cache.ipc');
const { registerAudioTracksIpc } = require('./src/ipc/audio-tracks.ipc');
const { registerDebridStatsIpc } = require('./src/telemetry/debrid-stats');


registerSystemIpc(ipcMain, settingsPath, loadSettings, saveSettings);
registerMediaIpc(ipcMain);
registerSubtitlesIpc(ipcMain, settingsPath, loadSettings);
registerTranscodeIpc(ipcMain);
registerClipIpc(ipcMain);
registerTrailerCacheIpc(ipcMain);
registerAudioTracksIpc(ipcMain);
registerDebridStatsIpc(ipcMain);

// Register Modular Handlers
tmdbHandlers.registerTmdbHandlers(ipcMain);
realDebridHandlers.registerRealDebridHandlers(ipcMain);
watchHistoryHandlers.registerWatchHistoryHandlers(ipcMain, app);
liveSubtitlesHandlers.registerLiveSubtitlesHandlers(ipcMain);

