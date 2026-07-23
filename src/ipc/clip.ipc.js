// clip.ipc.js — video clipping via ffmpeg (mp4/webm/gif extraction from a start time + duration)

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const utils = require('../utils');

const ALLOWED_FORMATS = new Set(['mp4', 'webm', 'gif']);
const ALLOWED_QUALITIES = new Set(['original', '1080p', '720p', '480p']);
const SCALE_MAP = { '1080p': '1920:-2', '720p': '1280:-2', '480p': '854:-2' };

// In-flight clip processes, so a 'clip-cancel' can tear them down and app-quit
// cleanup (via utils) doesn't leave orphaned ffmpeg trees.
const activeClips = new Set();

function registerClipIpc(ipcMain) {
    ipcMain.handle('clip-cancel', () => {
        let killed = 0;
        for (const proc of activeClips) {
            proc.__cancelled = true;
            try { proc.kill(); killed++; } catch (_) { /* already gone */ }
        }
        return { cancelled: killed };
    });

    ipcMain.handle('clipVideo', async (event, { inputPath, outputFormat, startTime, duration, quality }) => {
        let ffmpegProc = null;
        try {
            console.log('[clip] Clipping video:', { inputPath, outputFormat, startTime, duration, quality });

            // ── Input validation ────────────────────────────────────────────
            if (typeof inputPath !== 'string' || !inputPath.trim()) {
                return { success: false, error: 'No input source provided' };
            }
            if (!ALLOWED_FORMATS.has(outputFormat)) {
                return { success: false, error: `Unsupported output format: ${outputFormat}` };
            }
            const q = ALLOWED_QUALITIES.has(quality) ? quality : 'original';
            const start = Number(startTime);
            const dur = Number(duration);
            if (!Number.isFinite(start) || start < 0) {
                return { success: false, error: `Invalid start time: ${startTime}` };
            }
            if (!Number.isFinite(dur) || dur <= 0) {
                return { success: false, error: `Invalid duration: ${duration}` };
            }

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
                console.log('[clip] Remote input detected, passing URL directly to ffmpeg');
            } else {
                safeInputPath = decodeURIComponent(inputPath).replace(/^file:\/\/\//, '');
                safeInputPath = path.normalize(safeInputPath);

                if (!fs.existsSync(safeInputPath)) {
                    return { success: false, error: `Input file not found: ${safeInputPath}` };
                }

                const stat = fs.statSync(safeInputPath);
                console.log('[clip] Input file size:', (stat.size / (1024 * 1024)).toFixed(2), 'MB');
                fileName = path.basename(safeInputPath, path.extname(safeInputPath));
            }

            const ext = outputFormat;
            const outputName = `${fileName}_clip_${Date.now()}.${ext}`;

            let outputDir;
            try {
                outputDir = app.getPath('videos');
                if (!fs.existsSync(outputDir)) throw new Error('videos dir missing');
            } catch (_) {
                outputDir = app.getPath('desktop');
            }
            const outputPath = path.join(outputDir, outputName);

            // ── Build the video filter chain ────────────────────────────────
            // For GIF we build a palettegen/paletteuse graph for far better
            // quality than ffmpeg's default 256-colour quantizer, folding the
            // quality downscale into the same chain (no redundant second scale).
            let vfChain = '';
            if (outputFormat === 'gif') {
                const scale = (q !== 'original' && SCALE_MAP[q])
                    ? SCALE_MAP[q]
                    : 'trunc(iw/2)*2:trunc(ih/2)*2';
                vfChain = `fps=15,scale=${scale}:flags=lanczos,split[s0][s1];`
                    + `[s0]palettegen=stats_mode=diff[p];`
                    + `[s1][p]paletteuse=dither=bayer:bayer_scale=3`;
            } else if (q !== 'original' && SCALE_MAP[q]) {
                vfChain = `scale=${SCALE_MAP[q]}`;
            }

            const ffmpegArgs = [
                '-ss', String(start),
                '-i', safeInputPath,
                '-t', String(dur)
            ];

            if (outputFormat === 'webm') {
                // VP9: enable row multithreading + a realtime-ish speed so a
                // short clip encodes in seconds rather than minutes.
                ffmpegArgs.push('-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0',
                    '-row-mt', '1', '-cpu-used', '2', '-deadline', 'good', '-pix_fmt', 'yuv420p');
                ffmpegArgs.push('-c:a', 'libopus', '-b:a', '128k');
            } else if (outputFormat === 'mp4') {
                ffmpegArgs.push('-c:v', 'libx264', '-crf', '23', '-preset', 'fast', '-pix_fmt', 'yuv420p');
                ffmpegArgs.push('-c:a', 'aac', '-b:a', '192k');
            } else if (outputFormat === 'gif') {
                ffmpegArgs.push('-f', 'gif');
            }

            if (vfChain) {
                ffmpegArgs.push('-vf', vfChain);
            }

            ffmpegArgs.push('-y', outputPath);

            const ffmpegPath = utils.getFFmpegPath();
            console.log('[clip] Using ffmpeg at:', ffmpegPath);
            console.log('[clip] ffmpeg args:', ffmpegArgs.join(' '));

            ffmpegProc = execFile(ffmpegPath, ffmpegArgs, {
                cwd: isRemoteUrl ? outputDir : path.dirname(safeInputPath),
                windowsHide: true
            });
            activeClips.add(ffmpegProc);
            utils.registerFfmpegProcess(ffmpegProc);

            let stderrData = '';

            if (ffmpegProc.stdout) {
                ffmpegProc.stdout.on('data', () => { });
            }

            ffmpegProc.stderr.on('data', (data) => {
                const chunk = data.toString();
                // Parse progress from THIS chunk only. ffmpeg overwrites its
                // status line with \r, so the newest time= lives in the latest
                // chunk; scanning the whole accumulated buffer would always
                // re-report the first timestamp (and be O(n^2)).
                const matches = chunk.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/g);
                if (matches && event.sender && !event.sender.isDestroyed()) {
                    const currentTime = matches[matches.length - 1].slice(5);
                    event.sender.send('clip-progress', { currentTime });
                }
                // Retain only a bounded tail for post-failure diagnostics.
                stderrData = (stderrData + chunk).slice(-4000);
            });

            const cancelled = await new Promise((resolve, reject) => {
                ffmpegProc.on('close', (code) => {
                    if (ffmpegProc.__cancelled) {
                        console.log('[clip] Clipping cancelled by user');
                        resolve(true);
                    } else if (code === 0) {
                        console.log('[clip] Clipping completed successfully');
                        resolve(false);
                    } else {
                        console.error('[clip] ffmpeg failed with code:', code);
                        console.error('[clip] stderr (last 500 chars):', stderrData.slice(-500));
                        reject(new Error(`ffmpeg exited with code ${code}: ${stderrData.slice(-200)}`));
                    }
                });
                ffmpegProc.on('error', (err) => {
                    console.error('[clip] ffmpeg spawn error:', err);
                    reject(err);
                });
            });

            if (cancelled) {
                try { if (fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true }); } catch (_) { }
                return { success: false, cancelled: true, error: 'Clip cancelled' };
            }

            if (!fs.existsSync(outputPath)) {
                return { success: false, error: 'Output file was not created' };
            }

            const outputStat = fs.statSync(outputPath);
            const outputSizeMB = outputStat.size / (1024 * 1024);
            console.log('[clip] Output file size:', outputSizeMB.toFixed(2), 'MB');

            return {
                success: true,
                outputPath: outputPath,
                outputSize: outputStat.size
            };

        } catch (error) {
            console.error('[clip] Error:', error);
            return { success: false, error: error.message };
        } finally {
            if (ffmpegProc) {
                activeClips.delete(ffmpegProc);
                utils.unregisterFfmpegProcess(ffmpegProc);
            }
        }
    });
}

module.exports = { registerClipIpc };
