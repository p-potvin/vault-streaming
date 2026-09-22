/**
 * Enhancement dispatch and sidecar state.
 *
 * Each of the four AI context-menu actions maps to exactly one Python script.
 * They used to share a single entrypoint (audio_normalize.py), which meant
 * "Generate Subtitles" ran Demucs and a full GPU re-encode before it reached the
 * transcription step. Now each action starts only its own work.
 *
 * The `<video>.meta.json` sidecar is the single source of truth for what has
 * been applied to the enhanced copy. The Python scripts write it; this module
 * reads it so the context menu can show accurate checkboxes, and clears entries
 * on revert.
 */

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');
const utils = require('./utils');

/** Every user-facing enhancement, and the script that performs it. */
const ACTIONS = {
    'enhance-audio': { script: 'enhance_audio.py', key: 'audio', label: 'Enhance Audio' },
    'generate-subtitles': { script: 'generate_subtitles.py', key: 'subtitles', label: 'Generate Subtitles' },
    'translate-video': { script: 'translate_video.py', key: 'translation', label: 'Translate Video' },
    'enhance-video': { script: 'enhance_video.py', key: 'video', label: 'Enhance Video' },
};

/** Actions whose sidecar value is a list of language codes rather than a flag. */
const LIST_KEYS = new Set(['subtitles', 'translation']);

const PROGRESS_CHANNEL = 'normalize-progress';

/**
 * Resolve the Python that carries NeMo, Demucs and the heavy ASR dependencies.
 */
function getPythonExe() {
    return utils.getRobustPythonExe();
}

function scriptPath(script) {
    return utils.resolveScriptPath(script);
}

function sidecarPath(videoPath) {
    return `${videoPath}.meta.json`;
}

function blankEnhancements() {
    return { audio: false, video: false, subtitles: [], translation: [] };
}

/** Read a sidecar, normalising its shape. Never throws. */
function readSidecar(videoPath) {
    let meta = {};
    try {
        meta = JSON.parse(fs.readFileSync(sidecarPath(videoPath), 'utf8'));
    } catch (_) {
        meta = {};
    }
    if (!meta || typeof meta !== 'object') meta = {};

    const source = (meta.enhancements && typeof meta.enhancements === 'object') ? meta.enhancements : {};
    const enhancements = blankEnhancements();
    for (const key of Object.keys(enhancements)) {
        if (LIST_KEYS.has(key)) {
            enhancements[key] = Array.isArray(source[key]) ? source[key].map(String) : [];
        } else {
            enhancements[key] = !!source[key];
        }
    }
    meta.enhancements = enhancements;
    if (!meta.enhancementDetails || typeof meta.enhancementDetails !== 'object') {
        meta.enhancementDetails = {};
    }
    return meta;
}

function writeSidecar(videoPath, meta) {
    try {
        fs.writeFileSync(sidecarPath(videoPath), JSON.stringify(meta, null, 2), 'utf8');
        return true;
    } catch (err) {
        console.error('[enhancements] Failed to write sidecar:', err.message);
        return false;
    }
}

/**
 * Applied-enhancement summary for a video, for the context-menu builder.
 * An enhanced copy that no longer exists on disk reports as not applied, so the
 * menu never claims work the user has since deleted.
 */
function getState(videoPath) {
    const meta = readSidecar(videoPath);
    const enhanced = meta.enhancedPath;
    const copyMissing = enhanced && !fs.existsSync(enhanced);
    return {
        enhancedPath: copyMissing ? null : (enhanced || null),
        // audio and video live *in* the enhanced copy, so they die with it.
        audio: copyMissing ? false : !!meta.enhancements.audio,
        video: copyMissing ? false : !!meta.enhancements.video,
        // Subtitles are standalone sidecars; they survive the copy being removed.
        subtitles: meta.enhancements.subtitles,
        translation: meta.enhancements.translation,
    };
}

/**
 * Undo one enhancement (or all of them when `action` is omitted).
 *
 * Subtitle and translation reverts delete the SRT files the scripts recorded in
 * `enhancementDetails.<key>.outputs`. Audio and video reverts delete the
 * enhanced copy itself, since both are baked into that single file and cannot
 * be separated after the fact.
 */
function revert(videoPath, action) {
    if (!fs.existsSync(videoPath)) {
        return { success: false, error: 'File not found' };
    }

    const key = action ? (ACTIONS[action] && ACTIONS[action].key) || action : null;
    if (action && !['audio', 'video', 'subtitles', 'translation'].includes(key)) {
        return { success: false, error: `Unknown enhancement: ${action}` };
    }

    const meta = readSidecar(videoPath);
    const keys = key ? [key] : ['audio', 'video', 'subtitles', 'translation'];
    const removed = [];

    try {
        for (const target of keys) {
            const detail = meta.enhancementDetails[target];

            if (LIST_KEYS.has(target)) {
                for (const file of (detail && detail.outputs) || []) {
                    if (fs.existsSync(file)) {
                        fs.unlinkSync(file);
                        removed.push(file);
                    }
                }
                meta.enhancements[target] = [];
            } else {
                meta.enhancements[target] = false;
            }
            delete meta.enhancementDetails[target];
        }

        // The enhanced copy carries both baked-in passes; drop it once neither
        // audio nor video enhancement is claimed any more.
        if (!meta.enhancements.audio && !meta.enhancements.video && meta.enhancedPath) {
            if (fs.existsSync(meta.enhancedPath)) {
                fs.unlinkSync(meta.enhancedPath);
                removed.push(meta.enhancedPath);
            }
            delete meta.enhancedPath;
        }

        writeSidecar(videoPath, meta);
        return { success: true, removed, state: getState(videoPath) };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/** Build the argv for an action from the renderer's options object. */
function buildArgs(action, opts) {
    const { videoPath, vaultRoot, output, skipExisting } = opts;
    const args = [videoPath];
    if (vaultRoot) args.push(vaultRoot);

    switch (action) {
        case 'enhance-audio': {
            const parsed = Number.parseFloat(opts.volumeBoost);
            const boost = Number.isFinite(parsed) ? Math.min(2.5, Math.max(1, parsed)) : 1.5;
            args.push('--volume-boost', String(boost));
            break;
        }
        case 'generate-subtitles':
            args.push('--language', opts.language || 'en');
            break;
        case 'translate-video':
            if (!opts.translateTo) throw new Error('translate-video requires a target language');
            args.push('--to', String(opts.translateTo));
            args.push('--from', String(opts.sourceLanguage || 'en'));
            break;
        case 'enhance-video':
            args.push('--quality', String(opts.quality || 'HIGH'));
            args.push('--scale', String(opts.scale || 2));
            args.push('--chroma', String(opts.chroma || 'yuv420p'));
            break;
        default:
            throw new Error(`Unknown enhancement action: ${action}`);
    }

    if (output) args.push('--output', output);
    if (skipExisting) args.push('--skip-existing');
    return args;
}

/**
 * Run one enhancement script, streaming its progress to the renderer.
 *
 * Resolves rather than rejects: the renderer treats a failed enhancement as a
 * toast, not an exception.
 */
function runAction(event, action, opts) {
    const definition = ACTIONS[action];
    if (!definition) {
        return Promise.resolve({ success: false, error: `Unknown enhancement action: ${action}` });
    }
    if (!opts || typeof opts.videoPath !== 'string' || !opts.videoPath) {
        return Promise.resolve({ success: false, error: 'No video path supplied' });
    }

    let args;
    try {
        args = buildArgs(action, opts);
    } catch (err) {
        return Promise.resolve({ success: false, error: err.message });
    }

    const pythonExe = getPythonExe();
    const script = scriptPath(definition.script);
    if (!fs.existsSync(script)) {
        return Promise.resolve({ success: false, error: `Enhancement script not found: ${script}` });
    }

    const { videoPath } = opts;
    console.log(`[enhancements:${action}] Spawning: ${pythonExe} -u ${script} ${args.join(' ')}`);

    return new Promise((resolve) => {
        const env = utils.getPythonEnv({ PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION: 'python' });
        const proc = spawn(pythonExe, ['-u', script, ...args], { env, windowsHide: true });

        let log = '';
        let errorLog = '';
        let status = null;
        let resultPath = null;
        let resultError = null;

        const handleLine = (line) => {
            const progressIndex = line.indexOf('PROGRESS_UPDATE:');
            if (progressIndex !== -1) {
                try {
                    const data = JSON.parse(line.slice(progressIndex + 'PROGRESS_UPDATE:'.length).trim());
                    if (data && typeof data.percent === 'number' && data.label) {
                        if (event && event.sender && !event.sender.isDestroyed()) {
                            event.sender.send(PROGRESS_CHANNEL, {
                                videoPath, action, percent: data.percent, label: data.label,
                            });
                        }
                        return;
                    }
                } catch (_) { /* not a progress line after all */ }
            }

            const statusIndex = line.indexOf('JSON_STATUS:');
            if (statusIndex !== -1) {
                try {
                    const data = JSON.parse(line.slice(statusIndex + 'JSON_STATUS:'.length).trim());
                    if (data && data.status) {
                        status = data.status;
                        if (data.path) resultPath = data.path;
                        if (data.error) resultError = data.error;
                    }
                } catch (_) { /* ignore */ }
            }
        };

        const attach = (stream, sink) => {
            readline.createInterface({ input: stream, terminal: false }).on('line', (line) => {
                sink(line);
                handleLine(line);
                console.log(`[enhancements:${action}] ${line.trim()}`);
            });
        };
        attach(proc.stdout, (line) => { log += `${line}\n`; });
        attach(proc.stderr, (line) => { errorLog += `${line}\n`; });

        proc.on('error', (err) => {
            resolve({ success: false, action, error: `Failed to start Python process: ${err.message}` });
        });

        proc.on('close', (code) => {
            console.log(`[enhancements:${action}] Finished with code ${code}`);
            if (status === 'SUCCESS') {
                resolve({
                    success: true, status: 'SUCCESS', action, path: resultPath,
                    state: getState(videoPath), log,
                });
                return;
            }
            if (status === 'FAILED' || code !== 0) {
                resolve({
                    success: false, status: 'FAILED', action,
                    error: resultError || errorLog.trim() || `${definition.label} exited with code ${code}`,
                });
                return;
            }
            resolve({ success: true, action, state: getState(videoPath), log });
        });
    });
}

module.exports = {
    ACTIONS,
    PROGRESS_CHANNEL,
    getPythonExe,
    getState,
    readSidecar,
    writeSidecar,
    revert,
    runAction,
    buildArgs,
};
