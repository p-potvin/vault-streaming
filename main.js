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

// Clip Handler for video clipping
function registerClipHandler(ipcMain) {
    ipcMain.handle('clipVideo', async (event, { inputPath, outputFormat, startTime, duration, quality }) => {
        try {
            console.log('[main:clip] Clipping video:', { inputPath, outputFormat, startTime, duration, quality });

            const isRemoteUrl = /^https?:\/\//i.test(inputPath);
            let safeInputPath;
            let fileName;

            if (isRemoteUrl) {
                safeInputPath = inputPath;
                try {
                    const u = new URL(inputPath);
                    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || 'remote');
                    fileName = path.basename(last, path.extname(last)).replace(/[\\/:*?"<>|]/g, '_') || 'remote';
                } catch (_) {
                    fileName = 'remote';
                }
                console.log('[main:clip] Remote input detected, passing URL directly to ffmpeg');
            } else {
                safeInputPath = decodeURIComponent(inputPath).replace(/^file:\/\/\//, '');
                safeInputPath = path.normalize(safeInputPath);

                if (!fs.existsSync(safeInputPath)) {
                    return { success: false, error: `Input file not found: ${safeInputPath}` };
                }

                const stat = fs.statSync(safeInputPath);
                console.log('[main:clip] Input file size:', (stat.size / (1024 * 1024)).toFixed(2), 'MB');
                fileName = path.basename(safeInputPath, path.extname(safeInputPath));
            }
            const ext = outputFormat === 'gif' ? 'gif' : outputFormat;
            const outputName = `${fileName}_clip_${Date.now()}.${ext}`;
            
            // Default output to user's Videos folder or Desktop
            let outputDir;
            try {
                outputDir = app.getPath('videos');
                if (!fs.existsSync(outputDir)) throw new Error('videos dir missing');
            } catch (_) {
                outputDir = app.getPath('desktop');
            }
            const outputPath = path.join(outputDir, outputName);
            
            // Build -vf filter chain — collect filters, join at end
            const vfFilters = [];
            
            // Format-specific video filters
            if (outputFormat === 'gif') {
                vfFilters.push('fps=15', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
            }
            
            // Quality/scale filters
            if (quality !== 'original') {
                const scaleMap = { '1080p': '1920:-2', '720p': '1280:-2', '480p': '854:-2' };
                if (scaleMap[quality]) vfFilters.push(`scale=${scaleMap[quality]}`);
            }
            
            // Build ffmpeg args — put -ss BEFORE -i for fast input seeking
            const ffmpegArgs = [
                '-ss', String(startTime),
                '-i', safeInputPath,
                '-t', String(duration)
            ];
            
            // Output format specific codec options
            if (outputFormat === 'webm') {
                ffmpegArgs.push('-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0');
                ffmpegArgs.push('-c:a', 'libopus', '-b:a', '128k');
            } else if (outputFormat === 'mp4') {
                ffmpegArgs.push('-c:v', 'libx264', '-crf', '23', '-preset', 'fast');
                ffmpegArgs.push('-c:a', 'aac', '-b:a', '192k');
            } else if (outputFormat === 'gif') {
                ffmpegArgs.push('-f', 'gif');
            }
            
            // Apply combined -vf chain (single flag, avoids conflicts)
            if (vfFilters.length > 0) {
                ffmpegArgs.push('-vf', vfFilters.join(','));
            }
            
            // Force overwrite + output
            ffmpegArgs.push('-y', outputPath);
            
            // Resolve ffmpeg executable
            const ffmpegPath = utils.getFFmpegPath();
            console.log('[main:clip] Using ffmpeg at:', ffmpegPath);
            console.log('[main:clip] ffmpeg args:', ffmpegArgs.join(' '));
            
            // Run ffmpeg (remote inputs must not set cwd to the URL path)
            const ffmpegProc = execFile(ffmpegPath, ffmpegArgs, {
                cwd: isRemoteUrl ? outputDir : path.dirname(safeInputPath),
                windowsHide: true
            });
            
            // Track progress — ffmpeg logs to stderr, not stdout
            let stderrData = '';
            
            if (ffmpegProc.stdout) {
                ffmpegProc.stdout.on('data', () => {});
            }
            
            ffmpegProc.stderr.on('data', (data) => {
                stderrData += data.toString();
                // ffmpeg progress lines include time= in stderr
                const timeMatch = stderrData.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
                if (timeMatch && event.sender && !event.sender.isDestroyed()) {
                    event.sender.send('clip-progress', { currentTime: timeMatch[1] });
                }
            });
            
            // Wait for completion
            await new Promise((resolve, reject) => {
                ffmpegProc.on('close', (code) => {
                    if (code === 0) {
                        console.log('[main:clip] Clipping completed successfully');
                        resolve();
                    } else {
                        console.error('[main:clip] ffmpeg failed with code:', code);
                        console.error('[main:clip] stderr (last 500 chars):', stderrData.slice(-500));
                        reject(new Error(`ffmpeg exited with code ${code}: ${stderrData.slice(-200)}`));
                    }
                });
                ffmpegProc.on('error', (err) => {
                    console.error('[main:clip] ffmpeg spawn error:', err);
                    reject(err);
                });
            });
            
            // Verify output exists
            if (!fs.existsSync(outputPath)) {
                return { success: false, error: 'Output file was not created' };
            }
            
            const outputStat = fs.statSync(outputPath);
            const outputSizeMB = outputStat.size / (1024 * 1024);
            console.log('[main:clip] Output file size:', outputSizeMB.toFixed(2), 'MB');
            
            return {
                success: true,
                outputPath: outputPath,
                outputSize: outputStat.size
            };
            
        } catch (error) {
            console.error('[main:clip] Error:', error);
            return { success: false, error: error.message };
        }
    });
}

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


registerSystemIpc(ipcMain, settingsPath, loadSettings, saveSettings);
registerMediaIpc(ipcMain);
registerSubtitlesIpc(ipcMain);
registerTranscodeIpc(ipcMain);

// Register Modular Handlers
tmdbHandlers.registerTmdbHandlers(ipcMain);
realDebridHandlers.registerRealDebridHandlers(ipcMain);
watchHistoryHandlers.registerWatchHistoryHandlers(ipcMain, app);
liveSubtitlesHandlers.registerLiveSubtitlesHandlers(ipcMain);

// Register Clip Handler
registerClipHandler(ipcMain);
