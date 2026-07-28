const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const { app } = require('electron');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const utils = require('./utils');

// The streaming ASR model (~2.5 GB) is NOT shipped in the installer. It's fetched
// on first use into userData/models/ (writable), the way apps download large
// runtime components after install. Dev machines may have it extracted in the repo.
//
// Engine: nvidia/nemotron-3.5-asr-streaming-0.6b (cache-aware streaming RNNT).
// The direct .nemo download below is only a *fast path* with a progress bar — if
// it fails (e.g. the asset is named differently in the repo), we fall through and
// let NeMo's from_pretrained() pull it from HF on the Python side instead.
const MODEL_REPO = 'nvidia/nemotron-3.5-asr-streaming-0.6b';
const TDT_NEMO_NAME = 'nemotron-3.5-asr-streaming-0.6b.nemo';
const TDT_URL = `https://huggingface.co/${MODEL_REPO}/resolve/main/${TDT_NEMO_NAME}?download=true`;

function userModelsDir() {
    return path.join(app.getPath('userData'), 'models');
}
function userNemoPath() {
    return path.join(userModelsDir(), TDT_NEMO_NAME);
}
function devExtractedDir() {
    const cfg = path.join(__dirname, '..', 'tools', 'models', 'nemotron-3.5-asr-streaming-0.6b', 'model_config.yaml');
    return fs.existsSync(cfg) ? path.dirname(cfg) : null;
}
function hfCacheNemo() {
    const base = path.join(os.homedir(), '.cache', 'huggingface', 'hub',
        `models--${MODEL_REPO.replace('/', '--')}`, 'snapshots');
    if (!fs.existsSync(base)) return null;
    for (const snap of fs.readdirSync(base)) {
        const dir = path.join(base, snap);
        try {
            for (const f of fs.readdirSync(dir)) if (f.endsWith('.nemo')) return path.join(dir, f);
        } catch (e) { /* ignore */ }
    }
    return null;
}
// True when the model is available somewhere the Python wrapper can load it.
function modelPresent() {
    return !!(devExtractedDir() || fs.existsSync(userNemoPath()) || hfCacheNemo());
}

let downloadPromise = null;
async function downloadModel() {
    const dest = userNemoPath();
    const tmp = dest + '.part';
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { /* ignore */ }

    console.log('[main:live-subs] downloading TDT model ->', dest);
    forward('live-subtitle-status', { status: 'downloading', percent: 0, receivedMB: 0, totalMB: 0 });

    const fetch = (await import('node-fetch')).default;
    const res = await fetch(TDT_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching model`);
    const total = Number(res.headers.get('content-length')) || 0;
    let received = 0;
    let lastPct = -1;
    const counter = new Transform({
        transform(chunk, enc, cb) {
            received += chunk.length;
            const pct = total ? Math.floor((received / total) * 100) : 0;
            if (pct !== lastPct) {
                lastPct = pct;
                forward('live-subtitle-status', {
                    status: 'downloading', percent: pct,
                    receivedMB: Math.floor(received / 1e6), totalMB: Math.floor(total / 1e6),
                });
            }
            cb(null, chunk);
        },
    });
    await pipeline(res.body, counter, fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
    console.log('[main:live-subs] model download complete');
    forward('live-subtitle-status', { status: 'downloaded' });
}

// Resolves once the model exists locally; downloads it (once) if missing.
// A failed direct download is NOT fatal: NeMo's from_pretrained() on the Python
// side can fetch the model from Hugging Face itself. We just lose the progress
// bar, so we report it as a warning and let the daemon proceed.
function ensureModel() {
    if (modelPresent()) return Promise.resolve(true);
    if (!downloadPromise) {
        downloadPromise = downloadModel().then(() => true).catch((e) => {
            downloadPromise = null;
            console.warn('[main:live-subs] direct model download failed; falling back to NeMo/HF:', e.message);
            forward('live-subtitle-status', {
                status: 'warn',
                message: 'Fetching the model via NeMo instead (first run may take a few minutes).',
            });
            return true;
        });
    }
    return downloadPromise;
}

// A single long-lived Python daemon holds the (slow-loading) ASR model warm for
// the whole app session. We spawn it once — ideally ~3s after the UI loads via
// warm-live-subtitles — then drive it with start/stop JSON commands over stdin.
let daemon = null;
let daemonReady = false;
let lastSender = null;      // renderer to route cues/status to
let cueCount = 0;

function getPythonExe() {
    const candidates = [
        'C:\\Users\\Administrator\\Desktop\\Github Repos\\vault-explorer\\.venv\\Scripts\\python.exe',
        path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return utils.getRobustPythonExe();
}

function forward(channel, payload) {
    if (lastSender && !lastSender.isDestroyed()) {
        lastSender.send(channel, payload);
    }
}

function handleLine(line) {
    const marks = {
        cue: 'SUBTITLE_CUE:',
        status: 'LIVE_STATUS:',
        done: 'JSON_STATUS:',
        daemon: 'DAEMON:',
    };
    if (line.includes(marks.cue)) {
        try {
            const cue = JSON.parse(line.slice(line.indexOf(marks.cue) + marks.cue.length).trim());
            cueCount++;
            if (!cue.partial) {
                console.log(`[live-subs] FINAL #${cue.index} [${cue.start}-${cue.end}] ${JSON.stringify(cue.text)}`);
            }
            forward('live-subtitle-cue', cue);
        } catch (e) { /* ignore */ }
        return;
    }
    if (line.includes(marks.status)) {
        try {
            const data = JSON.parse(line.slice(line.indexOf(marks.status) + marks.status.length).trim());
            console.log(`[live-subs] status: ${data.status} — ${data.message || ''}`);
            forward('live-subtitle-status', data);
        } catch (e) { /* ignore */ }
        return;
    }
    if (line.includes(marks.done)) {
        try {
            const data = JSON.parse(line.slice(line.indexOf(marks.done) + marks.done.length).trim());
            console.log(`[live-subs] final: ${data.status} (cues: ${data.cues})`);
            forward('live-subtitle-status', { final: true, ...data });
        } catch (e) { /* ignore */ }
        return;
    }
    if (line.includes(marks.daemon)) {
        try {
            const data = JSON.parse(line.slice(line.indexOf(marks.daemon) + marks.daemon.length).trim());
            daemonReady = !!data.ready;
            console.log(`[live-subs] daemon ready=${daemonReady}`);
        } catch (e) { /* ignore */ }
        return;
    }
}

function ensureDaemon() {
    if (daemon) return;
    const script = path.join(__dirname, '..', 'python-scripts', 'live_subtitles.py');
    const pythonExe = getPythonExe();
    const env = { ...process.env };
    env.PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION = 'python';
    env.PYTHONPATH = path.join(__dirname, '..');
    // Force UTF-8 stdio so multilingual cue text can't trip a cp1252 error or
    // garble the JSON on the pipe.
    env.PYTHONUTF8 = '1';
    env.PYTHONIOENCODING = 'utf-8';
    // Tell the wrapper where a downloaded .nemo lives (checked before HF cache).
    env.VAULT_MODEL_DIR = userModelsDir();

    console.log('[main:live-subs] warming daemon (loading model)...');
    daemon = spawn(pythonExe, ['-u', script, '--daemon'], { env, windowsHide: true });
    daemonReady = false;

    const rlOut = readline.createInterface({ input: daemon.stdout, terminal: false });
    const rlErr = readline.createInterface({ input: daemon.stderr, terminal: false });
    rlOut.on('line', handleLine);
    rlErr.on('line', (line) => { if (line.trim()) console.log(`[live-subs:stderr] ${line.trim()}`); });

    daemon.on('error', (err) => {
        console.error('[main:live-subs] daemon spawn error:', err);
        forward('live-subtitle-status', { final: true, status: 'FAILED', error: err.message });
    });
    daemon.on('close', (code) => {
        console.log(`[main:live-subs] daemon exited (code ${code})`);
        daemon = null;
        daemonReady = false;
    });
}

function sendCmd(obj) {
    ensureDaemon();
    try {
        if (daemon && daemon.stdin.writable) {
            daemon.stdin.write(JSON.stringify(obj) + '\n');
            return true;
        }
    } catch (e) {
        console.error('[main:live-subs] sendCmd failed:', e.message);
    }
    return false;
}

function registerLiveSubtitlesHandlers(ipcMain) {
    // Called ~3s after the UI loads. Only preloads if the model is already on
    // disk — we don't kick off a 2.5 GB download on every launch, only when the
    // user actually invokes live subtitles (see start).
    ipcMain.handle('warm-live-subtitles', async (event) => {
        lastSender = event.sender;
        if (modelPresent()) ensureDaemon();
        return { success: true, ready: daemonReady, modelPresent: modelPresent() };
    });

    ipcMain.handle('start-live-subtitles', async (event, { videoPath, langs, volumeBoost, startTime, translateTo, writeSrt, audioIndex } = {}) => {
        // Vault Streaming plays remote (Comet/RD) URLs, so http(s) sources are
        // allowed here (ffmpeg reads them). SRT is opt-in and only meaningful for
        // a local file — see the python daemon.
        if (!videoPath) {
            return { success: false, error: 'No playback source for live subtitles.' };
        }
        lastSender = event.sender;
        try {
            await ensureModel();
        } catch (e) {
            return { success: false, error: 'Model download failed: ' + e.message };
        }
        cueCount = 0;
        const parsedBoost = Number.parseFloat(volumeBoost);
        const ok = sendCmd({
            cmd: 'start',
            videoPath,
            langs: Array.isArray(langs) && langs.length ? langs : ['en'],
            volumeBoost: Number.isFinite(parsedBoost) ? Math.min(2.5, Math.max(1, parsedBoost)) : 1.5,
            start: Math.max(0, Number.parseFloat(startTime) || 0),
            translateTo: translateTo || null,
            writeSrt: !!writeSrt,
            // Which audio track ASR should listen to — matches what the player
            // is actually playing (see the audio-track picker).
            audioIndex: Number.isInteger(audioIndex) && audioIndex >= 0 ? audioIndex : 0,
        });
        return { success: ok, ready: daemonReady };
    });

    ipcMain.handle('stop-live-subtitles', async () => {
        const ok = sendCmd({ cmd: 'stop' });
        return { success: ok };
    });
}

// Cleanly shut the daemon down on app quit.
function shutdownLiveSubtitles() {
    if (daemon) {
        try { daemon.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n'); } catch (e) { /* noop */ }
        try { daemon.kill(); } catch (e) { /* noop */ }
        daemon = null;
    }
}

module.exports = { registerLiveSubtitlesHandlers, shutdownLiveSubtitles };
