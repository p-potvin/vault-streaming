// media.ipc.js — handles VSR upscaling subprocess wrappers, enhancements tracking, and ffprobe stream introspection.

const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const child_process = require('child_process');
const utils = require('../utils');
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
        const metaPath = filePath + '.meta.json';

        // Ensure .thumbs directory exists
        if (!fs.existsSync(thumbsDir)) {
            fs.mkdirSync(thumbsDir, { recursive: true });
        }

        // Remove any stale temp file from a previous interrupted run.
        cleanupTemp(outputPath + '.tmp');

        // Skip redundant enhancement: check sidecar metadata
        if (fs.existsSync(metaPath) && fs.existsSync(outputPath)) {
            try {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                if (meta.enhancements && meta.enhancements.video === true) {
                    console.log('[media.ipc:upscale] Skipping redundant enhancement (already in .thumbs):', filePath);
                    return { success: true, path: outputPath, skipped: true };
                }
            } catch (e) {}
        }

        const pythonPath = process.platform === 'win32'
            ? path.join(__dirname, '..', '..', '.venv', 'Scripts', 'python.exe')
            : path.join(__dirname, '..', '..', '.venv', 'bin', 'python');
        const scriptPath = path.join(__dirname, '..', '..', 'python-scripts', 'rtx_vsr_stream.py');

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
            const proc = child_process.spawn(pythonPath, args, { windowsHide: true });

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

    // Revert Enhancements
    ipcMain.handle('revert-enhancements', async (_event, filePath) => {
        if (typeof filePath !== 'string' || !fs.existsSync(filePath)) {
            return { success: false, error: 'File not found' };
        }
        const dir = path.dirname(filePath);
        const ext = path.extname(filePath);
        const baseName = path.basename(filePath, ext);
        const enhancedFile = path.join(dir, '.thumbs', `${baseName}_enhanced${ext}`);
        const metaPath = filePath + '.meta.json';

        try {
            if (fs.existsSync(enhancedFile)) {
                fs.unlinkSync(enhancedFile);
            }
            if (fs.existsSync(metaPath)) {
                try {
                    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                    meta.enhancements = { audio: false, video: false, subtitles: [], translation: [] };
                    delete meta.enhancedPath;
                    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
                } catch (e) {}
            }
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // Get File Properties
    ipcMain.handle('get-file-properties', async (_event, filePath) => {
        if (typeof filePath !== 'string' || !fs.existsSync(filePath)) {
            return { success: false, error: 'File not found' };
        }
        const metaPath = filePath + '.meta.json';
        try {
            const stats = fs.statSync(filePath);
            const ext = path.extname(filePath).toLowerCase();

            // 1. Check if sidecar metadata already exists
            if (fs.existsSync(metaPath)) {
                try {
                    const cached = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                    // Refresh size and mod times
                    cached.size = stats.size;
                    cached.modified = stats.mtime;
                    return { success: true, properties: cached };
                } catch (cacheErr) {
                    console.error('[media.ipc:properties] Cache read error, re-probing:', cacheErr.message);
                }
            }

            // 2. Fetch fresh properties
            const baseProps = {
                name: path.basename(filePath),
                path: filePath,
                size: stats.size,
                created: stats.birthtime,
                modified: stats.mtime,
                type: ext,
                width: null,
                height: null,
                duration: null,
                codec: null,
                bitrate: null,
                audioCodec: null,
                channels: null,
                sampleRate: null,
                fps: null,
                hasAudio: false,
                hasVideo: false,
                enhancements: { audio: false, video: false, subtitles: [], translation: [] }
            };

            if (['.mp4', '.mkv', '.avi', '.mov', '.webm', '.ts', '.wmv'].includes(ext)) {
                const probeData = await getFullProbeMetadata(filePath);
                if (probeData) {
                    if (probeData.format) {
                        baseProps.duration = parseFloat(probeData.format.duration) || null;
                        baseProps.bitrate = parseInt(probeData.format.bit_rate) || null;
                    }
                    if (Array.isArray(probeData.streams)) {
                        const videoStream = probeData.streams.find(s => s.codec_type === 'video');
                        baseProps.hasVideo = !!videoStream;
                        if (videoStream) {
                            baseProps.width = videoStream.width || null;
                            baseProps.height = videoStream.height || null;
                            baseProps.codec = videoStream.codec_name || null;
                            if (videoStream.r_frame_rate) {
                                const parts = videoStream.r_frame_rate.split('/');
                                if (parts.length === 2 && parseFloat(parts[1]) > 0) {
                                    baseProps.fps = Math.round((parseFloat(parts[0]) / parseFloat(parts[1])) * 100) / 100;
                                } else {
                                    baseProps.fps = parseFloat(videoStream.r_frame_rate) || null;
                                }
                            }
                        }
                        const audioStream = probeData.streams.find(s => s.codec_type === 'audio');
                        baseProps.hasAudio = !!audioStream;
                        if (audioStream) {
                            baseProps.audioCodec = audioStream.codec_name || null;
                            baseProps.channels = audioStream.channels || null;
                            baseProps.sampleRate = parseInt(audioStream.sample_rate) || null;
                        }
                    }

                    // Save sidecar metadata
                    try {
                        fs.writeFileSync(metaPath, JSON.stringify(baseProps, null, 2), 'utf8');
                        console.log('[media.ipc:properties] Saved sidecar metadata:', metaPath);
                    } catch (saveErr) {
                        console.error('[media.ipc:properties] Failed to save sidecar metadata:', saveErr.message);
                    }
                }
            }

            return { success: true, properties: baseProps };
        } catch (e) {
            return { success: false, error: e.message };
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

        const pythonPath = process.platform === 'win32'
            ? path.join(__dirname, '..', '..', '.venv', 'Scripts', 'python.exe')
            : path.join(__dirname, '..', '..', '.venv', 'bin', 'python');
        const scriptPath = path.join(__dirname, '..', '..', 'python-scripts', 'rtx_vsr_stream.py');

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
            const proc = child_process.spawn(pythonPath, args, {
                windowsHide: true,
                // Ensure binary stdout is not mangled
                env: { ...process.env, PYTHONUNBUFFERED: '1' },
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
