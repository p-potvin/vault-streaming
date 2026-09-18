const path = require('path');
const { spawn } = require('child_process');
const enhancements = require('./enhancements');

/**
 * Registers one IPC channel per enhancement action.
 *
 * Previously a single `normalize-audio` channel served four menu items via
 * boolean flags, so every one of them ran the whole audio pipeline. Each action
 * now has its own channel and its own script.
 *
 * `normalize-audio` is kept as an alias for `enhance-audio` so any caller that
 * still uses the old channel keeps working — but it no longer accepts the
 * `transcribe` / `translateTo` flags, because folding those back in is exactly
 * the coupling this split removes.
 */
function registerNormalizationHandlers(ipcMain) {
    for (const action of Object.keys(enhancements.ACTIONS)) {
        ipcMain.handle(action, (event, opts) => enhancements.runAction(event, action, opts || {}));
    }

    // Legacy alias.
    ipcMain.handle('normalize-audio', (event, opts = {}) => {
        if (opts.transcribe || opts.translateTo) {
            console.warn(
                '[normalize-audio] Ignoring transcribe/translateTo: use the generate-subtitles '
                + 'and translate-video channels instead.');
        }
        return enhancements.runAction(event, 'enhance-audio', opts);
    });

    ipcMain.handle('get-enhancement-state', async (_event, videoPath) => {
        if (typeof videoPath !== 'string' || !videoPath) {
            return { success: false, error: 'No video path supplied' };
        }
        return { success: true, state: enhancements.getState(videoPath) };
    });

    ipcMain.handle('revert-enhancements', async (_event, videoPath) => {
        if (typeof videoPath !== 'string' || !videoPath) {
            return { success: false, error: 'No video path supplied' };
        }
        return enhancements.revert(videoPath);
    });

    ipcMain.handle('revert-enhancement-target', async (_event, { videoPath, target }) => {
        if (typeof videoPath !== 'string' || !videoPath) {
            return { success: false, error: 'No video path supplied' };
        }
        return enhancements.revert(videoPath, target);
    });

    ipcMain.handle('run-asr-benchmark', async (_event, { forceSimulation } = {}) => {
        console.log(`[main:benchmark] Starting ASR benchmark (forceSimulation: ${forceSimulation})`);
        return new Promise((resolve) => {
            const utils = require('./utils');
            const pythonScript = utils.resolveScriptPath('benchmark_asr.py');
            const args = ['-u', pythonScript, forceSimulation ? '--force-simulation' : '--native'];

            const env = utils.getPythonEnv();
            const pyProc = spawn(enhancements.getPythonExe(), args, { env, windowsHide: true });

            let outputData = '';
            let errorData = '';

            pyProc.stdout.on('data', (data) => { outputData += data.toString(); });
            pyProc.stderr.on('data', (data) => { errorData += data.toString(); });

            pyProc.on('error', (err) => {
                resolve({ success: false, output: outputData, error: `Failed to start Python process: ${err.message}` });
            });

            pyProc.on('close', (code) => {
                resolve({ success: code === 0, output: outputData, error: errorData });
            });
        });
    });
}

module.exports = { registerNormalizationHandlers };
