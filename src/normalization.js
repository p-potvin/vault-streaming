const path = require('path');
const child_process = require('child_process');
const { spawn } = child_process;
const fs = require('fs');
const utils = require('./utils');

/**
 * Resolves the Python executable from the .venv,
 * which carries NeMo, Demucs, and the heavy ASR dependencies.
 * Falls back to getRobustPythonExe() if not found.
 */
function getPythonExe() {
    const candidates = [
        'C:\\Users\\Administrator\\Desktop\\Github Repos\\vault-explorer\\.venv\\Scripts\\python.exe',
        path.join(__dirname, '.venv', 'Scripts', 'python.exe'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) {
            console.log('Found python exe at: ', c);
            return c;
        }
    }
    return utils.getRobustPythonExe();
}

function registerNormalizationHandlers(ipcMain) {
    ipcMain.handle('normalize-audio', async (event, { videoPath, vaultRoot, transcribe, translateTo, volumeBoost = 1.5 }) => {
        console.log(`[main:normalize] Starting audio normalization for ${videoPath}`);
        return new Promise((resolve) => {
            const pythonScript = path.join("C:\\Users\\Administrator\\desktop\\github repos\\vault-explorer\\", 'python-scripts', 'audio_normalize.py');

            const pythonExe = getPythonExe();
            const parsedVolumeBoost = Number.parseFloat(volumeBoost);
            const normalizedVolumeBoost = Number.isFinite(parsedVolumeBoost)
                ? Math.min(2.5, Math.max(1, parsedVolumeBoost))
                : 1.5;

            const args = ['-u', pythonScript, videoPath];
            if (vaultRoot) {
                args.push(vaultRoot);
            }
            if (transcribe) {
                args.push('--transcribe');
            }
            if (translateTo) {
                args.push('--translate-to', translateTo);
            }
            args.push('--volume-boost', String(normalizedVolumeBoost));

            console.log(`[main:normalize] Spawning: ${pythonExe} ${args.join(' ')}`);
            const env = { ...process.env };
            env.PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION = 'python';
            const pyProc = spawn(pythonExe, args, { env, windowsHide: true });

            let outputData = '';
            let errorData = '';
            let latestStatus = null;
            let latestPath = null;
            let latestError = null;

            const handleLine = (line) => {
                if (line.includes('PROGRESS_UPDATE:')) {
                    try {
                        const jsonStr = line.substring(line.indexOf('PROGRESS_UPDATE:') + 16).trim();
                        const data = JSON.parse(jsonStr);
                        if (data && typeof data.percent === 'number' && data.label) {
                            if (event.sender && !event.sender.isDestroyed()) {
                                event.sender.send('normalize-progress', { videoPath, percent: data.percent, label: data.label });
                            }
                            return;
                        }
                    } catch (e) {
                        // ignore JSON parse errors
                    }
                }
                if (line.includes('JSON_STATUS:')) {
                    try {
                        const jsonStr = line.substring(line.indexOf('JSON_STATUS:') + 12).trim();
                        const data = JSON.parse(jsonStr);
                        if (data && data.status) {
                            latestStatus = data.status;
                            if (data.path) {
                                latestPath = data.path;
                            }
                            if (data.error) {
                                latestError = data.error;
                            }
                        }
                    } catch (e) {
                        // ignore JSON parse errors
                    }
                }
                const matches = line.match(/PROGRESS:\s*(\d+):(.*)/);
                if (matches && matches.length >= 3) {
                    const percent = parseInt(matches[1], 10);
                    const label = matches[2].trim();
                    if (event.sender && !event.sender.isDestroyed()) {
                        event.sender.send('normalize-progress', { videoPath, percent, label });
                    }
                }
            };

            const readline = require('readline');
            const rlStdout = readline.createInterface({ input: pyProc.stdout, terminal: false });
            const rlStderr = readline.createInterface({ input: pyProc.stderr, terminal: false });

            rlStdout.on('line', (line) => {
                outputData += line + '\n';
                handleLine(line);
                console.log(`[normalize:stdout] ${line.trim()}`);
            });

            rlStderr.on('line', (line) => {
                errorData += line + '\n';
                handleLine(line);
                console.log(`[normalize:stderr] ${line.trim()}`);
            });

            pyProc.on('error', (err) => {
                console.error(`[main:normalize] Spawn error:`, err);
                resolve({ success: false, status: 'FAILED', error: `Failed to start Python process: ${err.message}` });
            });

            pyProc.on('close', (code) => {
                console.log(`[main:normalize] Finished with code ${code}`);
                if (latestStatus === 'SUCCESS') {
                    resolve({ success: true, status: 'SUCCESS', path: latestPath, log: outputData });
                } else if (latestStatus === 'FAILED') {
                    resolve({ success: false, status: 'FAILED', error: latestError || 'Audio normalization pipeline failed.' });
                } else {
                    if (code === 0) {
                        resolve({ success: true, log: outputData });
                    } else {
                        const cleanErr = errorData.replace(/PROGRESS:\s*\d+:.*\n?/g, '').trim();
                        resolve({
                            success: false,
                            error: cleanErr || latestError || `Normalization process exited with error code ${code}`
                        });
                    }
                }
            });
        });
    });

    ipcMain.handle('run-asr-benchmark', async (_event, { forceSimulation }) => {
        console.log(`[main:benchmark] Starting ASR benchmark (forceSimulation: ${forceSimulation})`);
        return new Promise((resolve) => {
            const pythonScript = path.join(__dirname, '..', 'python-scripts', 'benchmark_asr.py');

            const pythonExe = getPythonExe();

            const args = ['-u', pythonScript];
            if (forceSimulation) {
                args.push('--force-simulation');
            } else {
                args.push('--native');
            }

            console.log(`[main:benchmark] Spawning: ${pythonExe} ${args.join(' ')}`);

            // Set up environment so Python can load from sibling directories
            const env = { ...process.env };
            env.PYTHONPATH = path.join(__dirname, '..');

            const pyProc = spawn(pythonExe, args, { env, windowsHide: true });

            let outputData = '';
            let errorData = '';

            pyProc.stdout.on('data', (data) => {
                outputData += data.toString();
            });

            pyProc.stderr.on('data', (data) => {
                errorData += data.toString();
            });

            pyProc.on('error', (err) => {
                console.error(`[main:benchmark] Spawn error:`, err);
                resolve({
                    success: false,
                    output: outputData,
                    error: `Failed to start Python process: ${err.message}`
                });
            });

            pyProc.on('close', (code) => {
                console.log(`[main:benchmark] Finished with code ${code}`);
                resolve({
                    success: code === 0,
                    output: outputData,
                    error: errorData
                });
            });
        });
    });
}

module.exports = { registerNormalizationHandlers };
