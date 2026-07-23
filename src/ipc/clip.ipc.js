// clip.ipc.js — video clipping via ffmpeg (mp4/webm/gif extraction from a start time + duration)

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const utils = require('../utils');

function registerClipIpc(ipcMain) {
    ipcMain.handle('clipVideo', async (event, { inputPath, outputFormat, startTime, duration, quality }) => {
        try {
            console.log('[clip] Clipping video:', { inputPath, outputFormat, startTime, duration, quality });

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
            const ext = outputFormat === 'gif' ? 'gif' : outputFormat;
            const outputName = `${fileName}_clip_${Date.now()}.${ext}`;

            let outputDir;
            try {
                outputDir = app.getPath('videos');
                if (!fs.existsSync(outputDir)) throw new Error('videos dir missing');
            } catch (_) {
                outputDir = app.getPath('desktop');
            }
            const outputPath = path.join(outputDir, outputName);

            const vfFilters = [];
            if (outputFormat === 'gif') {
                vfFilters.push('fps=15', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
            }
            if (quality !== 'original') {
                const scaleMap = { '1080p': '1920:-2', '720p': '1280:-2', '480p': '854:-2' };
                if (scaleMap[quality]) vfFilters.push(`scale=${scaleMap[quality]}`);
            }

            const ffmpegArgs = [
                '-ss', String(startTime),
                '-i', safeInputPath,
                '-t', String(duration)
            ];

            if (outputFormat === 'webm') {
                ffmpegArgs.push('-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0');
                ffmpegArgs.push('-c:a', 'libopus', '-b:a', '128k');
            } else if (outputFormat === 'mp4') {
                ffmpegArgs.push('-c:v', 'libx264', '-crf', '23', '-preset', 'fast');
                ffmpegArgs.push('-c:a', 'aac', '-b:a', '192k');
            } else if (outputFormat === 'gif') {
                ffmpegArgs.push('-f', 'gif');
            }

            if (vfFilters.length > 0) {
                ffmpegArgs.push('-vf', vfFilters.join(','));
            }

            ffmpegArgs.push('-y', outputPath);

            const ffmpegPath = utils.getFFmpegPath();
            console.log('[clip] Using ffmpeg at:', ffmpegPath);
            console.log('[clip] ffmpeg args:', ffmpegArgs.join(' '));

            const ffmpegProc = execFile(ffmpegPath, ffmpegArgs, {
                cwd: isRemoteUrl ? outputDir : path.dirname(safeInputPath),
                windowsHide: true
            });

            let stderrData = '';

            if (ffmpegProc.stdout) {
                ffmpegProc.stdout.on('data', () => { });
            }

            ffmpegProc.stderr.on('data', (data) => {
                stderrData += data.toString();
                const timeMatch = stderrData.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
                if (timeMatch && event.sender && !event.sender.isDestroyed()) {
                    event.sender.send('clip-progress', { currentTime: timeMatch[1] });
                }
            });

            await new Promise((resolve, reject) => {
                ffmpegProc.on('close', (code) => {
                    if (code === 0) {
                        console.log('[clip] Clipping completed successfully');
                        resolve();
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
        }
    });
}

module.exports = { registerClipIpc };
