// media.ipc.js — handles VSR upscaling subprocess wrappers, enhancements tracking, and ffprobe stream introspection.

const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const child_process = require('child_process');
const utils = require('../utils');
const raggae = require('../raggae');
const sidecarRecord = require('../sidecar-record');
const { cleanupTemp, promoteTempFile } = utils;

function getFullProbeMetadata(filePath) {
    return new Promise((resolve) => {
        child_process.execFile('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath], (err, stdout) => {
            if (err) {
                console.error('[media.ipc:ffprobe] Failed to probe:', err);
                resolve(null);
            } else {
                try {
                    resolve(JSON.parse(stdout.trim()));
                } catch (e) {
                    resolve(null);
                }
            }
        });
    });
}

function registerMediaIpc(ipcMain) {
    // RTX VSR Video Upscale (permanent enhancement → .thumbs folder)
    ipcMain.handle('upscale-video', async (event, opts) => {
        const filePath = typeof opts === 'string' ? opts : (opts && opts.path);
        const quality = (typeof opts === 'object' && opts.quality) ? opts.quality : 'HIGH';
        const scale = (typeof opts === 'object' && opts.scale) ? opts.scale : '2';
        const chroma = (typeof opts === 'object' && opts.chroma) ? opts.chroma : 'yuv420p';
        console.log('[media.ipc:upscale] RTX VSR requested for:', filePath, 'quality=', quality, 'scale=', scale);
        if (typeof filePath !== 'string') {
            console.error('[media.ipc:upscale] Invalid filePath (not a string):', filePath);
            return { success: false, error: 'Invalid file path' };
        }
        if (!fs.existsSync(filePath)) {
            console.error('[media.ipc:upscale] File does not exist:', filePath);
            return { success: false, error: 'File not found: ' + filePath };
        }

        const ext = path.extname(filePath);
        const dir = path.dirname(filePath);
        const name = path.basename(filePath);
        const baseName = path.basename(filePath, ext);
        const thumbsDir = path.join(dir, '.thumbs');
        const outputPath = path.join(thumbsDir, `${baseName}_enhanced${ext}`);

        // Ensure .thumbs directory exists
        if (!fs.existsSync(thumbsDir)) {
            fs.mkdirSync(thumbsDir, { recursive: true });
        }

        // Remove any stale temp file from a previous interrupted run.
        cleanupTemp(outputPath + '.tmp');

        // Skip redundant enhancement: the sidecar (any of its names) says the video pass already ran
        if (fs.existsSync(outputPath)) {
            const meta = sidecarRecord.read(filePath).record;
            if (meta.enhancements && meta.enhancements.video === true) {
                console.log('[media.ipc:upscale] Skipping redundant enhancement (already in .thumbs):', filePath);
                return { success: true, path: outputPath, skipped: true };
            }
        }

        const pythonPath = utils.getRobustPythonExe();
        const scriptPath = utils.resolveScriptPath('rtx_vsr_stream.py');

        if (!fs.existsSync(pythonPath)) {
            console.error('[media.ipc:upscale] Python interpreter not found:', pythonPath);
            return { success: false, error: 'Python interpreter not found (.venv missing)' };
        }
        if (!fs.existsSync(scriptPath)) {
            console.error('[media.ipc:upscale] RTX VSR script not found:', scriptPath);
            return { success: false, error: 'Enhancement script not found' };
        }

        return new Promise((resolve) => {
            const args = [
                scriptPath,
                'enhance',
                filePath,
                outputPath,
                '--quality', quality,
                '--scale', scale,
                '--chroma', chroma,
            ];

            console.log(`[media.ipc:upscale] Spawning: ${pythonPath} ${args.join(' ')}`);
            const env = utils.getPythonEnv();
            const proc = child_process.spawn(pythonPath, args, { env, windowsHide: true });

            let errorData = '';
            let stdoutBuffer = '';
            let stderrBuffer = '';

            proc.stdout.on('data', (data) => {
                const str = data.toString();
                stdoutBuffer += str;
                let lines = stdoutBuffer.split(/\r?\n/);
                stdoutBuffer = lines.pop();
                for (const line of lines) {
                    console.log(`[media.ipc:upscale:stdout] ${line.trim()}`);
                }
            });

            proc.stderr.on('data', (data) => {
                const str = data.toString();
                errorData += str;
                stderrBuffer += str;
                let lines = stderrBuffer.split(/\r?\n/);
                stderrBuffer = lines.pop();
                for (const line of lines) {
                    console.log(`[media.ipc:upscale:stderr] ${line.trim()}`);
                }
            });

            proc.on('close', (code) => {
                if (stdoutBuffer.trim()) console.log(`[media.ipc:upscale:stdout] ${stdoutBuffer.trim()}`);
                if (stderrBuffer.trim()) console.log(`[media.ipc:upscale:stderr] ${stderrBuffer.trim()}`);
                console.log(`[media.ipc:upscale] Finished with code ${code}`);

                if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
                    try {
                        let meta = {};
                        if (fs.existsSync(metaPath)) {
                            try {
                                meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                            } catch (e) {}
                        }
                        if (!meta.enhancements) {
                            meta.enhancements = { audio: false, video: false, subtitles: [], translation: [] };
                        }
                        meta.enhancements.video = true;
                        meta.enhancedPath = outputPath;
                        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
                    } catch (e) {}
                    resolve({ success: true, path: outputPath });
                } else {
                    resolve({ success: false, error: errorData.trim() || `RTX VSR exited with code ${code}` });
                }
            });
        });
    });


    // Get File Properties. The sidecar follows the shared v2 record (vault-raggae app/files/records/record.py,
    // vault-explorer src/sidecar-record.js): found under any of its four names (src/sidecar-names.js, a stem name only
    // when no other media file shares the stem), the ffprobe fields read from its root, written back only through
    // sidecarRecord.update (this app's keys only, the rest of the record as it is on disk, atomic, canonical
    // <file.ext>.json for a new one). name / path / size / dates come from the file itself, never from the sidecar.
    const PROBE_KEYS = ['duration', 'bitrate', 'width', 'height', 'codec', 'fps', 'hasVideo',
        'audioCodec', 'channels', 'sampleRate', 'hasAudio'];
    const VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.ts', '.wmv', '.m4v'];

    ipcMain.handle('get-file-properties', async (_event, filePath) => {
        if (typeof filePath !== 'string' || !fs.existsSync(filePath)) {
            return { success: false, error: 'File not found' };
        }
        try {
            const stats = fs.statSync(filePath);
            const ext = path.extname(filePath).toLowerCase();
            const record = sidecarRecord.read(filePath).record;
            const props = {
                name: path.basename(filePath),
                path: filePath,
                size: stats.size,
                created: stats.birthtime,
                modified: stats.mtime,
                type: ext,
                width: null, height: null, duration: null, codec: null, bitrate: null, fps: null,
                audioCodec: null, channels: null, sampleRate: null, hasAudio: false, hasVideo: false,
                enhancements: { audio: false, video: false, subtitles: [], translation: [] },
            };
            for (const k of PROBE_KEYS) {
                if (record[k] !== undefined && record[k] !== null) props[k] = record[k];
            }
            if (record.enhancements && typeof record.enhancements === 'object') {
                props.enhancements = { ...props.enhancements, ...record.enhancements };
            }

            // Probe when the sidecar has no probe yet (a record vault-raggae wrote has only its envelope)
            if (VIDEO_EXTS.includes(ext) && record.hasVideo === undefined && !record.duration) {
                const probeData = await getFullProbeMetadata(filePath);
                if (probeData) {
                    const probed = {};
                    if (probeData.format) {
                        probed.duration = parseFloat(probeData.format.duration) || null;
                        probed.bitrate = parseInt(probeData.format.bit_rate) || null;
                    }
                    if (Array.isArray(probeData.streams)) {
                        const v = probeData.streams.find(s => s.codec_type === 'video');
                        probed.hasVideo = !!v;
                        if (v) {
                            probed.width = v.width || null;
                            probed.height = v.height || null;
                            probed.codec = v.codec_name || null;
                            if (v.r_frame_rate) {
                                const parts = v.r_frame_rate.split('/');
                                probed.fps = parts.length === 2 && parseFloat(parts[1]) > 0
                                    ? Math.round((parseFloat(parts[0]) / parseFloat(parts[1])) * 100) / 100
                                    : (parseFloat(v.r_frame_rate) || null);
                            }
                        }
                        const a = probeData.streams.find(s => s.codec_type === 'audio');
                        probed.hasAudio = !!a;
                        if (a) {
                            probed.audioCodec = a.codec_name || null;
                            probed.channels = a.channels || null;
                            probed.sampleRate = parseInt(a.sample_rate) || null;
                        }
                    }
                    Object.assign(props, probed);
                    sidecarRecord.update(filePath, probed);       // owned keys only; never fatal
                }
            }

            // What vault-raggae's media index knows (id, fingerprints, the matched scene / catalog file). Its file
            // facts sit under `catalog_file`; they only fill what the sidecar and the probe left empty.
            const indexed = await raggae.byPath(filePath);
            if (indexed) {
                props.raggae = {
                    vwId: indexed.vw_id || null,
                    fingerprints: indexed.fingerprints || {},
                    scene: indexed.scene || null,
                    identities: indexed.identities || [],
                };
                const cf = indexed.catalog_file || {};
                for (const [k, src] of [['duration', 'duration'], ['width', 'width'], ['height', 'height'],
                    ['codec', 'vcodec'], ['audioCodec', 'acodec'], ['fps', 'fps'], ['bitrate', 'bitrate']]) {
                    if ((props[k] === null || props[k] === undefined) && cf[src]) props[k] = cf[src];
                }
            }

            return { success: true, properties: props };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // vault-raggae gateway IPC handlers
    ipcMain.handle('raggae-resolve', async (_event, data) => {
        try {
            return await raggae.resolve(data);
        } catch (err) {
            return { error: err.message };
        }
    });

    ipcMain.handle('raggae-by-path', async (_event, filePath) => {
        try {
            return await raggae.byPath(filePath);
        } catch (err) {
            return null;
        }
    });

    ipcMain.handle('raggae-search', async (_event, data) => {
        try {
            const opts = data && typeof data === 'object' ? data : {};
            const query = typeof data === 'string' ? data : (opts.query || opts.q || '');
            // films and series only unless a category is asked for (the catalog also holds music, books, scenes)
            return opts.category ? await raggae.search(query, opts) : await raggae.searchTitles(query, opts);
        } catch (err) {
            return [];
        }
    });

    ipcMain.handle('raggae-health', async () => {
        return await raggae.health();
    });

    ipcMain.handle('raggae-ingest', async (_event, items) => {
        try {
            return await raggae.ingest(items);
        } catch (err) {
            return { error: err.message };
        }
    });

    // Streaming Upscale (Real-time AI upscaling with MediaSource)
    let upscaleStreamProcess = null;
    let upscaleStreamEvent = null;

    ipcMain.handle('upscale-stream-start', async (event, { videoPath, startTime, quality, scale, bitrate, chroma }) => {
        console.log('[media.ipc:upscale-stream] Starting RTX VSR real-time stream for:', videoPath, 'from time:', startTime);

        // Kill any existing process
        if (upscaleStreamProcess) {
            try { upscaleStreamProcess.kill('SIGKILL'); } catch(e) {}
            upscaleStreamProcess = null;
        }
        upscaleStreamEvent = event;

        if (typeof videoPath !== 'string' || !fs.existsSync(videoPath)) {
            return { success: false, error: 'File not found' };
        }

        const pythonPath = utils.getRobustPythonExe();
        const scriptPath = utils.resolveScriptPath('rtx_vsr_stream.py');

        const args = [
            scriptPath,
            'stream',
            videoPath,
            '--start-time', String(startTime || 0),
            '--quality', quality || 'HIGH',
            '--scale', scale || '2',
            '--bitrate', bitrate || '12M',
            '--chroma', chroma || 'yuv420p',
        ];

        console.log(`[media.ipc:upscale-stream] Spawning: ${pythonPath} ${args.join(' ')}`);

        try {
            const env = utils.getPythonEnv({ PYTHONUNBUFFERED: '1' });
            const proc = child_process.spawn(pythonPath, args, {
                windowsHide: true,
                // Ensure binary stdout is not mangled
                env,
            });
            upscaleStreamProcess = proc;

            const sendStatus = (type, data = {}) => {
                if (event.sender && !event.sender.isDestroyed()) {
                    event.sender.send('upscale-status', { type, ...data });
                }
            };

            // Send initial status with source dimensions
            const probe = await getFullProbeMetadata(videoPath);
            let srcW = 0, srcH = 0;
            if (probe && Array.isArray(probe.streams)) {
                const vStream = probe.streams.find(s => s.codec_type === 'video');
                if (vStream) {
                    srcW = vStream.width || 0;
                    srcH = vStream.height || 0;
                }
            }
            sendStatus('init', {
                width: srcW,
                height: srcH,
                fps: probe && probe.streams ? 30 : 0,
                label: 'RTX VSR initializing…',
            });

            let frameCount = 0;

            // Forward MP4 chunks from Python stdout to renderer
            proc.stdout.on('data', (data) => {
                if (event.sender && !event.sender.isDestroyed()) {
                    frameCount++;
                    // Send the chunk as a Node Buffer (will be serialized to ArrayBuffer)
                    event.sender.send('upscale-chunk', {
                        chunk: frameCount,
                        buffer: data,
                    });
                }
            });

            let stderrBuffer = '';
            proc.stderr.on('data', (data) => {
                const str = data.toString();
                stderrBuffer += str;
                // Log VSR progress lines to console
                const lines = str.split(/\r?\n/);
                for (const line of lines) {
                    if (line.trim()) {
                        console.log(`[rtx-vsr] ${line.trim()}`);
                    }
                }
                // Report processing status based on frame count in stderr
                const match = str.match(/Processed (\d+) frames/);
                if (match) {
                    const frames = parseInt(match[1], 10);
                    sendStatus('processing', { chunk: frames, label: `RTX VSR · ${frames} frames` });
                }
            });

            proc.on('close', (code) => {
                console.log(`[media.ipc:upscale-stream] RTX VSR stream exited with code ${code}`);
                upscaleStreamProcess = null;
                upscaleStreamEvent = null;
                if (code === 0 || code === null) {
                    sendStatus('done');
                } else {
                    sendStatus('chunk-error', { error: stderrBuffer.trim() || `RTX VSR exited with code ${code}` });
                }
            });

            proc.on('error', (err) => {
                console.error('[media.ipc:upscale-stream] Process error:', err);
                sendStatus('chunk-error', { error: err.message });
            });

            return { success: true };
        } catch (err) {
            console.error('[media.ipc:upscale-stream] Failed to start:', err);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('upscale-stream-stop', async () => {
        console.log('[media.ipc:upscale-stream] Stopping RTX VSR stream...');

        if (upscaleStreamProcess) {
            try {
                // On Windows SIGKILL doesn't exist; use kill() which terminates the tree
                upscaleStreamProcess.kill('SIGKILL');
            } catch(e) {
                try { upscaleStreamProcess.kill(); } catch(e2) {}
            }
            upscaleStreamProcess = null;
            upscaleStreamEvent = null;
        }

        return { success: true };
    });

    // ---------------------------------------------------------------------------
    // YouTube direct stream extraction (replaces fragile iframe embedding)
    // Uses yt-dlp to get the actual video file URL, bypassing all embedding
    // restrictions, CORS issues, and error 152/150/101.
    // ---------------------------------------------------------------------------
    const ytUrlCache = new Map();

    ipcMain.handle('extract-youtube-url', async (_event, videoId) => {
        if (!videoId || typeof videoId !== 'string') {
            return { success: false, error: 'Invalid video ID' };
        }
        if (ytUrlCache.has(videoId)) {
            console.log(`[media.ipc:youtube] Returning cached stream URL for ${videoId}`);
            return { success: true, url: ytUrlCache.get(videoId) };
        }
        const ytDlp = 'yt-dlp';
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        // Request progressive combined formats (22 for 720p, 18 for 360p) for native <video> tag playback
        const args = ['--format', '22/18/best', '--no-playlist', '--no-warnings', '--no-check-certificates', '--extractor-args', 'youtube:player_client=android,web', '--get-url', url];
        console.log(`[media.ipc:youtube] Extracting stream URL via yt-dlp for ${videoId}`);
        return new Promise((resolve) => {
            const proc = child_process.spawn(ytDlp, args, {
                windowsHide: true,
                env: { ...process.env },
            });
            let stdout = '';
            let stderr = '';
            proc.stdout.on('data', (d) => { stdout += d.toString(); });
            proc.stderr.on('data', (d) => { stderr += d.toString(); });
            proc.on('close', (code) => {
                const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
                const streamUrl = lines[lines.length - 1];
                if (code === 0 && streamUrl && streamUrl.startsWith('http')) {
                    console.log(`[media.ipc:youtube] Extracted stream URL for ${videoId}`);
                    if (ytUrlCache.size > 100) {
                        const firstKey = ytUrlCache.keys().next().value;
                        ytUrlCache.delete(firstKey);
                    }
                    ytUrlCache.set(videoId, streamUrl);
                    resolve({ success: true, url: streamUrl });
                } else {
                    console.warn(`[media.ipc:youtube] yt-dlp failed for ${videoId}:`, stderr.trim() || `exit ${code}`);
                    resolve({ success: false, error: stderr.trim() || `yt-dlp exited ${code}` });
                }
            });
            proc.on('error', (err) => {
                console.error(`[media.ipc:youtube] yt-dlp spawn error:`, err.message);
                resolve({ success: false, error: err.message });
            });
        });
    });

    // ---------------------------------------------------------------------------
    // AI Image Enhancement — RealESRGAN super-resolution (ncnn-vulkan)
    // ---------------------------------------------------------------------------
    function resolveToolPath(...segments) {
        const devPath = path.join(__dirname, '..', '..', 'tools', ...segments);
        const prodPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'tools', ...segments);
        if (fs.existsSync(devPath)) return devPath;
        if (fs.existsSync(prodPath)) return prodPath;
        return null;
    }

    ipcMain.handle('enhance-image-realesrgan', async (_event, filePath) => {
        if (typeof filePath !== 'string' || !fs.existsSync(filePath)) {
            return { success: false, error: 'File not found' };
        }

        const ext = path.extname(filePath);
        const baseName = path.basename(filePath, ext);
        const dir = path.dirname(filePath);
        const thumbsDir = path.join(dir, '.thumbs');
        const outputPath = path.join(thumbsDir, `${baseName}_realesrgan${ext}`);
        const tempPath = outputPath + '.tmp';

        if (fs.existsSync(outputPath)) {
            cleanupTemp(tempPath);
            return { success: true, path: outputPath, skipped: true };
        }

        if (!fs.existsSync(thumbsDir)) {
            fs.mkdirSync(thumbsDir, { recursive: true });
        }
        cleanupTemp(tempPath);

        const toolPath = resolveToolPath('realesrgan-ncnn-vulkan.exe');
        if (!toolPath) {
            return { success: false, error: 'RealESRGAN binary not found in tools/' };
        }

        const toolsDir = path.dirname(toolPath);
        const modelsDir = path.join(toolsDir, 'models');
        if (!fs.existsSync(path.join(modelsDir, 'realesrgan-x4plus.bin'))) {
            return { success: false, error: 'RealESRGAN model not found at tools/models/realesrgan-x4plus.bin' };
        }

        // Check for any .safetensors or Nomos model in the same models directory
        let modelName = 'realesrgan-x4plus';
        try {
            const files = fs.readdirSync(modelsDir);
            const safetensorsFile = files.find(f => f.endsWith('.safetensors'));
            const nomosFile = files.find(f => /Nomos/i.test(f) && f.endsWith('.bin'));
            if (safetensorsFile) {
                modelName = path.basename(safetensorsFile, '.safetensors');
                console.log('[media.ipc:realesrgan] Found .safetensors model:', modelName);
            } else if (nomosFile) {
                modelName = path.basename(nomosFile, '.bin');
                console.log('[media.ipc:realesrgan] Found Nomos model:', modelName);
            }
        } catch (e) {
            console.warn('[media.ipc:realesrgan] Could not scan models directory:', e.message);
        }

        try {
            await new Promise((resolve, reject) => {
                const args = ['-i', filePath, '-o', tempPath, '-n', modelName, '-g', '0', '-m', modelsDir];
                const proc = child_process.spawn(toolPath, args, { cwd: toolsDir, windowsHide: true });
                let stderr = '';
                proc.stderr.on('data', (d) => { stderr += d.toString(); });
                proc.on('close', (code) => {
                    if (code === 0 && fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0) {
                        resolve();
                    } else {
                        reject(new Error(stderr.trim() || `realesrgan exited with code ${code}`));
                    }
                });
                proc.on('error', reject);
            });
            if (!promoteTempFile(tempPath, outputPath)) {
                return { success: false, error: 'Failed to promote RealESRGAN temp output to final path' };
            }
            return { success: true, path: outputPath };
        } catch (e) {
            cleanupTemp(tempPath);
            return { success: false, error: e.message };
        }
    });

    // ---------------------------------------------------------------------------
    // AI Image Enhancement — ImageMagick effects (denoise, edge-detect)
    // ---------------------------------------------------------------------------
    ipcMain.handle('enhance-image-magick', async (_event, { path: filePath, operation }) => {
        if (typeof filePath !== 'string' || !fs.existsSync(filePath)) {
            return { success: false, error: 'File not found' };
        }
        if (!operation || typeof operation !== 'string') {
            return { success: false, error: 'Missing operation parameter' };
        }

        const ext = path.extname(filePath);
        const baseName = path.basename(filePath, ext);
        const dir = path.dirname(filePath);
        const thumbsDir = path.join(dir, '.thumbs');
        const opLabel = operation === 'edge' ? 'edge' : 'denoise';
        const outputPath = path.join(thumbsDir, `${baseName}_${opLabel}${ext}`);
        const tempPath = outputPath + '.tmp';

        if (fs.existsSync(outputPath)) {
            cleanupTemp(tempPath);
            return { success: true, path: outputPath, skipped: true };
        }

        if (!fs.existsSync(thumbsDir)) {
            fs.mkdirSync(thumbsDir, { recursive: true });
        }
        cleanupTemp(tempPath);

        let magickArgs;
        if (operation === 'denoise') {
            magickArgs = [filePath, '-statistic', 'Median', '3', tempPath];
        } else if (operation === 'edge') {
            magickArgs = [filePath, '-edge', '1', tempPath];
        } else {
            return { success: false, error: `Unknown operation: ${operation}` };
        }

        try {
            await new Promise((resolve, reject) => {
                const proc = child_process.spawn('magick', magickArgs, { windowsHide: true });
                let stderr = '';
                proc.stderr.on('data', (d) => { stderr += d.toString(); });
                proc.on('close', (code) => {
                    if (code === 0 && fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0) {
                        resolve();
                    } else {
                        reject(new Error(stderr.trim() || `magick exited with code ${code}`));
                    }
                });
                proc.on('error', reject);
            });
            if (!promoteTempFile(tempPath, outputPath)) {
                return { success: false, error: 'Failed to promote ImageMagick temp output to final path' };
            }
            return { success: true, path: outputPath };
        } catch (e) {
            cleanupTemp(tempPath);
            return { success: false, error: e.message };
        }
    });

}

module.exports = {
    registerMediaIpc
};
