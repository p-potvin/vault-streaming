const child_process = require('child_process');
const { execFile, spawn } = child_process;
const fs = require('fs');
const path = require('path');
const os = require('os');

// Helper to get system memory info on Windows
function getSystemMemoryInfo() {
    if (process.platform !== 'win32') {
        return { total: 0, free: 0, usedPercent: 0 };
    }

    try {
        // Use Windows WMI to get memory info
        const result = child_process.execSync('wmic OS get FreePhysicalMemory,TotalVisibleMemorySize /Value', { encoding: 'utf8' });
        const lines = result.trim().split('\n');
        let freeMem = 0, totalMem = 0;

        lines.forEach(line => {
            if (line.includes('FreePhysicalMemory')) {
                const match = line.match(/(\d+)/);
                if (match) freeMem = parseInt(match[1]);
            }
            if (line.includes('TotalVisibleMemorySize')) {
                const match = line.match(/(\d+)/);
                if (match) totalMem = parseInt(match[1]);
            }
        });

        if (totalMem > 0) {
            const used = totalMem - freeMem;
            const usedPercent = Math.round((used / totalMem) * 100);
            return { total: totalMem, free: freeMem, usedPercent, used };
        }
    } catch (e) {
        console.warn('[memory] Could not get Windows memory info:', e.message);
    }

    // Fallback: use Node.js os module (less accurate but works)
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const usedPercent = Math.round((used / total) * 100);
    return { total, free, used, usedPercent };
}

const activeSubprocesses = new Set();
const originalSpawn = child_process.spawn;
child_process.spawn = function () {
    const proc = originalSpawn.apply(this, arguments);
    activeSubprocesses.add(proc);
    const clean = () => { activeSubprocesses.delete(proc); };
    proc.on('close', clean);
    proc.on('exit', clean);
    proc.on('error', clean);
    return proc;
};

const originalExecFile = child_process.execFile;
child_process.execFile = function () {
    const proc = originalExecFile.apply(this, arguments);
    activeSubprocesses.add(proc);
    const clean = () => { activeSubprocesses.delete(proc); };
    proc.on('close', clean);
    proc.on('exit', clean);
    proc.on('error', clean);
    return proc;
};

const originalExec = child_process.exec;
child_process.exec = function () {
    const proc = originalExec.apply(this, arguments);
    activeSubprocesses.add(proc);
    const clean = () => { activeSubprocesses.delete(proc); };
    proc.on('close', clean);
    proc.on('exit', clean);
    proc.on('error', clean);
    return proc;
};

// On Windows proc.kill('SIGKILL') only signals the immediate child — any
// grandchild process (ffmpeg's helpers, Python's spawned workers) is left
// orphaned and shows up as "Vault Explorer is still running" zombies.
// taskkill /T /F walks the process tree and terminates every descendant.
function _killTree(proc) {
    if (!proc || !proc.pid || proc.killed) return;
    try {
        if (process.platform === 'win32') {
            originalSpawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
        } else {
            try { process.kill(-proc.pid, 'SIGKILL'); } catch (_) { proc.kill('SIGKILL'); }
        }
    } catch (e) {
        try { proc.kill('SIGKILL'); } catch (_) { }
    }
}

function killAllActiveSubprocesses() {
    console.log(`[main:cleanup] Killing ${activeSubprocesses.size} subprocess trees and ${activeFfmpegProcesses.size} FFmpeg trees...`);
    for (const proc of activeSubprocesses) _killTree(proc);
    activeSubprocesses.clear();
    for (const proc of activeFfmpegProcesses) _killTree(proc);
    activeFfmpegProcesses.clear();
    activeFfmpegCount = 0;
    ffmpegWaitQueue.length = 0;
}

function killAllFfmpegProcesses() {
    console.log(`[main:ffmpeg] Force killing ${activeFfmpegProcesses.size} FFmpeg process trees...`);
    for (const proc of activeFfmpegProcesses) {
        _killTree(proc);
        console.log(`[main:ffmpeg] Killed FFmpeg tree PID: ${proc.pid}`);
    }
    activeFfmpegProcesses.clear();
    activeFfmpegCount = 0;
    ffmpegWaitQueue.length = 0;
}

// Windows priority constants
const PRIORITY_BELOW_NORMAL = process.platform === 'win32' ? 16 : 0;

// Track all FFmpeg processes for cleanup
const activeFfmpegProcesses = new Set();

// Max concurrent FFmpeg threads
const MAX_FFMPEG_THREADS = 4;
let activeFfmpegCount = 0;
const ffmpegWaitQueue = [];

function runLowPriorityProcess(command, args) {
    return new Promise((resolve, reject) => {
        // Queue system for limiting concurrent FFmpeg processes
        if (command.toLowerCase().includes('ffmpeg') || command.toLowerCase().includes('ffprobe')) {
            // Check system memory before starting FFmpeg to prevent crashes
            const memInfo = getSystemMemoryInfo();
            if (memInfo.usedPercent > 80) {
                const errMsg = `Aborting FFmpeg process: System memory usage at ${memInfo.usedPercent}% (threshold: 80%)`;
                console.warn('[ffmpeg] ' + errMsg);

                // Kill all existing FFmpeg processes to free up memory
                killAllFfmpegProcesses();

                reject(new Error(errMsg));
                return;
            }

            // TODO: Future enhancement - use GPU acceleration (NVENC/QSV/AMF) when available
            // This would require detecting GPU hardware and modifying ffmpeg command arguments

            if (activeFfmpegCount >= MAX_FFMPEG_THREADS) {
                // Add to wait queue
                ffmpegWaitQueue.push({ command, args, resolve, reject });
                return;
            }
            activeFfmpegCount++;
        }

        // Auto-resolve full path if command is ffmpeg or ffprobe and they aren't on PATH
        let execCmd = command;
        if (command === 'ffmpeg') {
            execCmd = getFFmpegPath();
        } else if (command === 'ffprobe') {
            execCmd = getFFmpegPath().replace('ffmpeg.exe', 'ffprobe.exe').replace('ffmpeg', 'ffprobe');
        }

        const child = spawn(execCmd, args, { windowsHide: true });

        // Track FFmpeg processes
        if (command.toLowerCase().includes('ffmpeg') || command.toLowerCase().includes('ffprobe')) {
            activeFfmpegProcesses.add(child);
        }

        // Set priority to BELOW NORMAL
        try {
            if (process.platform === 'win32') {
                // Use below-normal priority (16) for better performance than idle (19)
                os.setPriority(child.pid, PRIORITY_BELOW_NORMAL);
            } else {
                // On Unix-like systems, use nice value
                child.unref(); // Allow process to exit if parent exits
            }
        } catch (e) {
            console.log("Failed to set process priority:", e.message);
        }

        let stderr = '';
        child.stderr.on('data', (data) => { stderr += data.toString(); });

        const cleanup = () => {
            if (command.toLowerCase().includes('ffmpeg') || command.toLowerCase().includes('ffprobe')) {
                activeFfmpegProcesses.delete(child);
                activeFfmpegCount--;
                // Process next in queue if available
                if (ffmpegWaitQueue.length > 0 && activeFfmpegCount < MAX_FFMPEG_THREADS) {
                    const next = ffmpegWaitQueue.shift();
                    runLowPriorityProcess(next.command, next.args).then(next.resolve).catch(next.reject);
                }
            }
        };

        child.on('close', (code) => {
            cleanup();
            if (code === 0) resolve();
            else reject(new Error(`Command ${command} failed with exit code ${code}. Stderr: ${stderr}`));
        });
        child.on('exit', () => {
            cleanup();
        });
        child.on('error', (err) => {
            cleanup();
            reject(err);
        });

        // Add timeout to prevent hanging processes (30 minutes max)
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`Command ${command} timed out after 30 minutes`));
            try {
                child.kill('SIGKILL');
            } catch (e) { }
        }, 30 * 60 * 1000);

        // Clear timeout on successful completion
        const clearTimeoutOnSuccess = () => clearTimeout(timeout);
        child.on('close', clearTimeoutOnSuccess);
        child.on('exit', clearTimeoutOnSuccess);
        child.on('error', clearTimeoutOnSuccess);
    });
}

function getVideoDuration(videoPath) {
    return new Promise((resolve) => {
        const ffprobe = getFFmpegPath().replace('ffmpeg.exe', 'ffprobe.exe').replace('ffmpeg', 'ffprobe');
        execFile(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath], (err, stdout) => {
            if (err) resolve(0);
            else {
                const dur = parseFloat(stdout.trim());
                resolve(isNaN(dur) ? 0 : dur);
            }
        });
    });
}

function checkAudioStream(videoPath) {
    return new Promise((resolve) => {
        const ffprobe = getFFmpegPath().replace('ffmpeg.exe', 'ffprobe.exe').replace('ffmpeg', 'ffprobe');
        execFile(ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath], (_err, stdout) => {
            resolve(!!stdout.trim());
        });
    });
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

class PriorityQueue {
    constructor() {
        this.queue = [];
        this.running = false;
    }
    push(task) {
        this.queue.push(task);
        this.runNext();
    }
    async runNext() {
        if (this.running || this.queue.length === 0) return;
        this.running = true;
        const task = this.queue.shift();
        try {
            await task();
        } catch (e) {
            console.error("Queue task error:", e);
        }
        this.running = false;
        this.runNext();
    }
}

function getRobustPythonExe() {
    const fs = require('fs');
    const path = require('path');

    let pythonExe = 'python';
    const searchBases = [];

    // 1. vault-explorer venv first (has PyTorch + NeMo + Parakeet)
    searchBases.push('C:\\Users\\Administrator\\Desktop\\Github Repos\\vault-explorer\\.venv');

    // 2. Relative paths based on sibling structures
    let baseDir = __dirname;
    searchBases.push(path.join(baseDir, '..', '..', 'vault-explorer', '.venv'));

    // 3. Fallback to local venvs
    searchBases.push('C:\\Users\\Administrator\\Desktop\\Github Repos\\vault-explorer\\.venv');
    searchBases.push('C:\\Users\\Administrator\\Desktop\\Github Repos\\vault-explorer\\venv');
    searchBases.push(path.join(baseDir, '..', '.venv'));
    searchBases.push(path.join(baseDir, '..', 'venv'));
    searchBases.push(path.join(baseDir, '..', '..', '.venv'));

    if (baseDir.includes('app.asar')) {
        const cleanBase = baseDir.substring(0, baseDir.indexOf('app.asar'));
        searchBases.push(path.join(cleanBase, '..', 'vault-explorer', '.venv'));
        searchBases.push(path.join(cleanBase, '.venv'));
        searchBases.push(path.join(cleanBase, 'venv'));
        searchBases.push(path.join(cleanBase, '..', '.venv'));
        searchBases.push(path.join(cleanBase, '..', 'venv'));
        searchBases.push(path.join(cleanBase, '..', '..', '.venv'));
        searchBases.push(path.join(cleanBase, '..', '..', 'venv'));
    }

    // 4. Search and return the first match
    for (const vPath of searchBases) {
        if (process.platform === 'win32') {
            const winPath = path.join(vPath, 'Scripts', 'python.exe');
            if (fs.existsSync(winPath)) {
                return winPath;
            }
        } else {
            const unixPath = path.join(vPath, 'bin', 'python');
            if (fs.existsSync(unixPath)) {
                return unixPath;
            }
        }
    }

    return pythonExe;
}

function getFFmpegPath() {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    const homeDir = os.homedir();
    const searchPaths = [
        // WinGet shims (common on modern Windows installs)
        path.join(homeDir, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
        // Standard install locations
        'C:\\ffmpeg\\bin\\ffmpeg.exe',
        'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
        'C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe',
        path.join(process.env['ProgramW6432'] || 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'ffmpeg', 'bin', 'ffmpeg.exe'),
        // Scoop / Chocolatey common paths
        path.join(homeDir, 'scoop', 'shims', 'ffmpeg.exe'),
        path.join('C:\\ProgramData', 'chocolatey', 'bin', 'ffmpeg.exe'),
        // Portable / local project paths
        path.join(process.cwd(), 'ffmpeg.exe'),
        path.join(process.cwd(), 'bin', 'ffmpeg.exe'),
        path.join(__dirname, '..', 'ffmpeg.exe'),
        path.join(__dirname, '..', 'bin', 'ffmpeg.exe'),
    ];

    for (const p of searchPaths) {
        if (fs.existsSync(p)) {
            return p;
        }
    }

    // Fallback: rely on PATH resolution (execFile will find it)
    return 'ffmpeg';
}

function cleanupTemp(tempPath) {
    try {
        if (fs.existsSync(tempPath)) {
            fs.rmSync(tempPath, { force: true });
        }
    } catch (e) {
        // ignore
    }
}

function promoteTempFile(tempPath, finalPath) {
    try {
        if (fs.existsSync(finalPath)) {
            fs.rmSync(finalPath, { force: true });
        }
        fs.renameSync(tempPath, finalPath);
        return true;
    } catch (e) {
        console.error('[utils:promote] Failed to promote temp file:', e.message);
        cleanupTemp(tempPath);
        return false;
    }
}

module.exports = {
    activeSubprocesses,
    killAllActiveSubprocesses,
    runLowPriorityProcess,
    getVideoDuration,
    checkAudioStream,
    formatBytes,
    PriorityQueue,
    getRobustPythonExe,
    getFFmpegPath,
    getSystemMemoryInfo,
    cleanupTemp,
    promoteTempFile
};
