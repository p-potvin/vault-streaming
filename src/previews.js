const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');
const utils = require('./utils');

let totalBatchCount = 0;
let completedBatchCount = 0;

const backgroundFfmpegQueue = new utils.PriorityQueue();
const activeQueuePaths = new Set();
const benchmarkPath = path.join(__dirname, '..', 'BENCHMARKS.md');

function writeBenchmark(entry) {
    const header = `| Timestamp | Video Name | Size | Duration | Thumb Time | WebM Time | Status \n| --- | --- | --- | --- | --- | --- | --- |`;
    if (!fs.existsSync(benchmarkPath)) {
        fs.writeFileSync(benchmarkPath, header, 'utf8');
    }
    const row = `\n| ${new Date().toISOString()} | ${entry.name} | ${entry.size} | ${entry.duration.toFixed(1)}s | ${entry.thumbTime ? entry.thumbTime.toFixed(0) + 'ms' : 'N/A'} | ${entry.webmTime ? entry.webmTime.toFixed(0) + 'ms' : 'N/A'} | ${entry.status} |`;
    fs.appendFileSync(benchmarkPath, row, 'utf8');
}

async function generateThumbAndPreview(videoPath, thumbPath, hoverWebmPath, sender = null, force = false) {
    const activeWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const finalSender = sender || (activeWindow ? activeWindow.webContents : null);
    
    if (finalSender && !finalSender.isDestroyed()) {
        finalSender.send('generate-webm-progress', {
            videoPath,
            percent: 5,
            label: `Initiating preview...`
        });
    }

    const duration = await utils.getVideoDuration(videoPath);
    const hasAudio = await utils.checkAudioStream(videoPath);

    console.log(`[main:preview] Input: ${videoPath} -> thumb: ${thumbPath}, webm: ${hoverWebmPath}, force=${force}`);

    const bothExist = fs.existsSync(thumbPath) && fs.existsSync(hoverWebmPath);
    if (bothExist && !force) {
        console.log(`[main:preview] Skipping: both thumbnail and preview exist for ${videoPath}`);
        if (finalSender && !finalSender.isDestroyed()) {
            finalSender.send('generate-webm-progress', {
                videoPath,
                percent: 100,
                label: `Completed!`,
                thumbnail: thumbPath,
                hoverWebm: hoverWebmPath
            });
        }
        return;
    }

    // Atomic-write strategy: ffmpeg writes to .tmp paths so a failed run
    // can NEVER destroy a pre-existing thumbnail or webm preview. Only at
    // the very end do we rename .tmp -> final. Any prior versions stay
    // intact until the rename succeeds, and on failure we clean up the
    // temp files only.
    const thumbWritePath = thumbPath + '.tmp';
    const webmWritePath = hoverWebmPath + '.tmp';
    try { if (fs.existsSync(thumbWritePath)) fs.unlinkSync(thumbWritePath); } catch(e) {}
    try { if (fs.existsSync(webmWritePath)) fs.unlinkSync(webmWritePath); } catch(e) {}

    let thumbStart = Date.now();
    let thumbTimeMs = null;
    const middleTime = duration > 0 ? (duration / 2).toFixed(2) : '5.00';
    try {
        await utils.runLowPriorityProcess('ffmpeg', [
            '-y',
            '-ss', middleTime,
            '-i', videoPath,
            '-vf', "select='eq(pict_type,I)'",
            '-vframes', '1',
            '-q:v', '2',
            '-f', 'image2',
            thumbWritePath,
            '-loglevel', 'error'
        ]);
        if (!fs.existsSync(thumbWritePath)) {
            console.log(`[main:preview] Keyframe select produced no file, falling back to simple frame capture at ${middleTime}`);
            await utils.runLowPriorityProcess('ffmpeg', [
                '-y',
                '-ss', middleTime,
                '-i', videoPath,
                '-vframes', '1',
                '-q:v', '2',
                '-f', 'image2',
                thumbWritePath,
                '-loglevel', 'error'
            ]);
        }
        thumbTimeMs = Date.now() - thumbStart;
    } catch (e) {
        console.error("Failed to generate keyframe thumbnail:", e.message);
        try {
            await utils.runLowPriorityProcess('ffmpeg', [
                '-y',
                '-ss', middleTime,
                '-i', videoPath,
                '-vframes', '1',
                '-q:v', '2',
                '-f', 'image2',
                thumbWritePath,
                '-loglevel', 'error'
            ]);
            thumbTimeMs = Date.now() - thumbStart;
        } catch(err) {
            console.error("Fallback thumbnail generation also failed:", err.message);
        }
    }

    let webmStart = Date.now();
    let webmTimeMs = null;
    try {
        console.log(`[main:webm-preview] Generating preview: ${path.basename(videoPath)}`);

        // Use runLowPriorityProcess which handles priority, thread limiting, and cleanup
        const runFfmpegPromise = (args) => {
            return utils.runLowPriorityProcess('ffmpeg', args);
        };

        if (duration <= 100) {
            if (finalSender && !finalSender.isDestroyed()) {
                finalSender.send('generate-webm-progress', {
                    videoPath,
                    percent: 50,
                    label: `Creating preview...`
                });
            }
            let success = false;
            if (hasAudio) {
                try {
                    await runFfmpegPromise([
                        '-y',
                        '-threads', '2',
                        '-i', videoPath,
                        '-vf', 'scale=320:-2',
                        '-c:v', 'libvpx',
                        '-b:v', '1M',
                        '-speed', '4',
                        '-ac', '2',
                        '-c:a', 'libvorbis',
                        '-b:a', '64k',
                        '-f', 'webm',
                        webmWritePath,
                        '-loglevel', 'error'
                    ]);
                    success = true;
                } catch (e) {
                    console.warn(`[main:webm-preview] VP8 + Vorbis failed, falling back to silent VP8:`, e.message);
                }
            }
            if (!success) {
                await runFfmpegPromise([
                    '-y',
                    '-threads', '2',
                    '-i', videoPath,
                    '-vf', 'scale=320:-2',
                    '-c:v', 'libvpx',
                    '-b:v', '1M',
                    '-speed', '4',
                    '-an',
                    '-f', 'webm',
                    webmWritePath,
                    '-loglevel', 'error'
                ]);
            }
        } else {
            const numClips = 8; // 8 clips for compact size & faster processing
            const interval = duration / numClips;
            const clipDuration = 3.0; // 3 seconds each, total 24s preview
            
            if (finalSender && !finalSender.isDestroyed()) {
                finalSender.send('generate-webm-progress', {
                    videoPath,
                    percent: 40,
                    label: `Compiling preview...`
                });
            }

            let success = false;
            if (hasAudio) {
                try {
                    const audioArgs = ['-y', '-threads', '2'];
                    let filterStr = '';
                    for (let i = 0; i < numClips; i++) {
                        const seekTime = interval * i;
                        audioArgs.push('-ss', seekTime.toFixed(2), '-t', clipDuration.toFixed(2), '-i', videoPath);
                        filterStr += `[${i}:v][${i}:a]`;
                    }
                    filterStr += `concat=n=${numClips}:v=1:a=1[outv][outa];[outv]scale=320:-2[outv_scaled]`;
                    audioArgs.push('-filter_complex', filterStr);
                    audioArgs.push('-map', '[outv_scaled]', '-map', '[outa]');
                    audioArgs.push(
                        '-c:v', 'libvpx',
                        '-b:v', '1M',
                        '-speed', '4',
                        '-ac', '2',
                        '-c:a', 'libvorbis',
                        '-b:a', '64k'
                    );
                    audioArgs.push('-f', 'webm', webmWritePath, '-loglevel', 'error');
                    
                    await runFfmpegPromise(audioArgs);
                    success = true;
                } catch (e) {
                    console.warn(`[main:webm-preview] Multi-clip with Vorbis audio failed, falling back to silent VP8:`, e.message);
                }
            }

            if (!success) {
                try {
                    const silentArgs = ['-y', '-threads', '2'];
                    let filterStr = '';
                    for (let i = 0; i < numClips; i++) {
                        const seekTime = interval * i;
                        silentArgs.push('-ss', seekTime.toFixed(2), '-t', clipDuration.toFixed(2), '-i', videoPath);
                        filterStr += `[${i}:v]`;
                    }
                    filterStr += `concat=n=${numClips}:v=1:a=0[outv];[outv]scale=320:-2[outv_scaled]`;
                    silentArgs.push('-filter_complex', filterStr);
                    silentArgs.push('-map', '[outv_scaled]');
                    silentArgs.push(
                        '-c:v', 'libvpx',
                        '-b:v', '1M',
                        '-speed', '4',
                        '-an'
                    );
                    silentArgs.push('-f', 'webm', webmWritePath, '-loglevel', 'error');

                    await runFfmpegPromise(silentArgs);
                    success = true;
                } catch (e) {
                    console.warn(`[main:webm-preview] Multi-clip concat failed, falling back to single-clip preview:`, e.message);
                }
            }

            // Last-resort fallback: a single continuous clip from ~30% in. The
            // 8-clip concat filter is fragile on live-captured / variable-format
            // MP4s (broken timestamps, open-GOP), which is why those previews
            // failed every cycle. A single-segment encode has no concat graph to
            // trip over and almost always succeeds.
            if (!success) {
                const seek = Math.max(1, duration * 0.3);
                await runFfmpegPromise([
                    '-y',
                    '-threads', '2',
                    '-ss', seek.toFixed(2),
                    '-t', '8',
                    '-i', videoPath,
                    '-an',
                    '-vf', 'scale=320:-2',
                    '-c:v', 'libvpx',
                    '-b:v', '1M',
                    '-speed', '4',
                    '-f', 'webm',
                    webmWritePath,
                    '-loglevel', 'error'
                ]);
            }
        }
        
        webmTimeMs = Date.now() - webmStart;

        // Atomic-commit: only promote temp files to their final names if BOTH
        // were created successfully. If either is missing, leave the existing
        // originals untouched and clean up the orphan temp.
        const thumbTmpOk = fs.existsSync(thumbWritePath);
        const webmTmpOk = fs.existsSync(webmWritePath);
        if (thumbTmpOk && webmTmpOk) {
            try { fs.renameSync(thumbWritePath, thumbPath); } catch(e) { throw new Error(`thumb rename failed: ${e.message}`); }
            try { fs.renameSync(webmWritePath, hoverWebmPath); } catch(e) { throw new Error(`webm rename failed: ${e.message}`); }
        } else {
            console.warn(`[preview] Partial output (thumb=${thumbTmpOk} webm=${webmTmpOk}). Keeping originals; discarding temp.`);
            try { if (fs.existsSync(thumbWritePath)) fs.unlinkSync(thumbWritePath); } catch(_) {}
            try { if (fs.existsSync(webmWritePath)) fs.unlinkSync(webmWritePath); } catch(_) {}
            throw new Error('FFmpeg produced incomplete output (originals preserved)');
        }

        // Final sanity check: ensure the renamed files actually exist
        if (!fs.existsSync(thumbPath) || !fs.existsSync(hoverWebmPath)) {
            throw new Error(`Atomic rename succeeded but final preview files are missing: thumb=${thumbPath}, webm=${hoverWebmPath}`);
        }

        if (finalSender && !finalSender.isDestroyed()) {
            finalSender.send('generate-webm-progress', {
                videoPath,
                percent: 100,
                label: `Preview completed!`,
                thumbnail: thumbPath,
                hoverWebm: hoverWebmPath
            });
        }

        try {
            writeBenchmark({
                name: path.basename(videoPath),
                size: utils.formatBytes(fs.statSync(videoPath).size),
                duration,
                thumbTime: thumbTimeMs,
                webmTime: webmTimeMs,
                status: 'SUCCESS'
            });
        } catch(e) {}
    } catch (e) {
        console.error("Failed to generate WebM preview:", e.message);
        // Discard any partial temp output so we don't leave orphan .tmp files.
        try { if (fs.existsSync(thumbWritePath)) fs.unlinkSync(thumbWritePath); } catch(_) {}
        try { if (fs.existsSync(webmWritePath)) fs.unlinkSync(webmWritePath); } catch(_) {}
        // Tell the renderer the job is over so the toolbar spinner clears.
        // Without a terminal event the spinner sat at the last reported %
        // forever, masking the failure.
        if (finalSender && !finalSender.isDestroyed()) {
            finalSender.send('generate-webm-progress', {
                videoPath,
                percent: 100,
                label: 'Preview failed',
                error: e.message || 'FFmpeg error'
            });
        }
        try {
            writeBenchmark({
                name: path.basename(videoPath),
                size: utils.formatBytes(fs.statSync(videoPath).size),
                duration,
                thumbTime: thumbTimeMs,
                webmTime: webmTimeMs,
                status: 'FAILED'
            });
        } catch(e) {}
        // Re-throw so the IPC handler returns success=false to the renderer.
        throw e;
    }
}

function schedulePreviewGeneration(videoPath, thumbPath, hoverWebmPath) {
    if (activeQueuePaths.has(videoPath)) return;
    activeQueuePaths.add(videoPath);
    
    backgroundFfmpegQueue.push(async () => {
        try {
            await generateThumbAndPreview(videoPath, thumbPath, hoverWebmPath);
        } catch (e) {
            console.error(`Preview generation failed for ${videoPath}:`, e.message);
        } finally {
            activeQueuePaths.delete(videoPath);
            completedBatchCount++;
            const activeWin = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (activeWin && !activeWin.webContents.isDestroyed()) {
                activeWin.webContents.send('generate-webm-progress', {
                    isBatchProgress: true,
                    total: totalBatchCount,
                    completed: completedBatchCount
                });
            }
            if (completedBatchCount >= totalBatchCount) {
                // Send one final completion event with the actual totals before resetting
                if (activeWin && !activeWin.webContents.isDestroyed()) {
                    activeWin.webContents.send('generate-webm-progress', {
                        isBatchComplete: true,
                        total: totalBatchCount,
                        completed: completedBatchCount
                    });
                }
                totalBatchCount = 0;
                completedBatchCount = 0;
            }
        }
    });
}


function registerPreviewHandlers(ipcMain) {
    ipcMain.handle('generate-webm', async (event, videoPath, vaultRoot) => {
        if (typeof videoPath !== 'string' || !videoPath) {
            return { success: false, error: 'Missing video path' };
        }
        if (!fs.existsSync(videoPath)) {
            console.error('[main:generate-webm] Input video does not exist:', videoPath);
            return { success: false, error: 'Video not found: ' + videoPath };
        }
        const ext = path.extname(videoPath);
        const base = path.basename(videoPath, ext);
        const thumbsDir = path.join(path.dirname(videoPath), '.thumbs');
        if (!fs.existsSync(thumbsDir)) {
            fs.mkdirSync(thumbsDir, { recursive: true });
        }
        const thumbPath = path.join(thumbsDir, `${base}.jpg`);
        const webmPath = path.join(thumbsDir, `${base}.webm`);

        console.log(`[main:generate-webm] Manual extraction requested for: ${base}`);
        try {
            await generateThumbAndPreview(videoPath, thumbPath, webmPath, event.sender, true);
            const success = fs.existsSync(thumbPath) && fs.existsSync(webmPath);
            if (success) {
                return { success: true, thumbnail: thumbPath, hoverWebm: webmPath };
            } else {
                return { success: false, error: 'FFmpeg failed to create thumbnail or preview webm.' };
            }
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('schedule-idle-previews', (event, items) => {
        if (!items || items.length === 0) return false;
        
        // Skip automatic preview scheduling for cloud-backed directories to prevent freezing and crashes
        const firstPath = (items[0] && items[0].path) ? items[0].path.toLowerCase() : '';
        if (firstPath.includes('icloud photos') || firstPath.includes('onedrive') || 
            firstPath.includes('icloud drive') || firstPath.includes('dropbox') || 
            firstPath.includes('google drive') || firstPath.includes('creative cloud')) {
            console.log(`[main:previews] Skipping background preview scheduling for cloud-backed folder: ${path.dirname(items[0].path)}`);
            return false;
        }

        // Limit the active processing batch size to prevent locking the main thread or exhausting process limits
        const candidateItems = items.slice(0, 80);
        let added = 0;
        
        for (const item of candidateItems) {
            try {
                if (item.type === 'video') {
                    const ext = path.extname(item.path);
                    const base = path.basename(item.path, ext);
                    const thumbsDir = path.join(path.dirname(item.path), '.thumbs');
                    if (!fs.existsSync(thumbsDir)) {
                        try { fs.mkdirSync(thumbsDir, { recursive: true }); } catch(e) {}
                    }
                    const thumbPath = path.join(thumbsDir, `${base}.jpg`);
                    const webmPath = path.join(thumbsDir, `${base}.webm`);
                    if (!fs.existsSync(thumbPath) || !fs.existsSync(webmPath)) {
                        if (!activeQueuePaths.has(item.path)) {
                            added++;
                            schedulePreviewGeneration(item.path, thumbPath, webmPath);
                        }
                    }
                }
            } catch (e) {
                console.error('[main:previews] Failed to schedule item preview:', item.path, e.message);
            }
        }
        if (added > 0) {
            totalBatchCount += added;
            const activeWin = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (activeWin && !activeWin.webContents.isDestroyed()) {
                activeWin.webContents.send('generate-webm-progress', {
                    isBatchStart: true,
                    total: totalBatchCount,
                    completed: completedBatchCount
                });
            }
        }
        return true;
    });

    // Idle auto-generation batch: unlike schedule-idle-previews (fire-and-forget
    // into the background queue), this awaits each of the (up to 10) targeted
    // videos and returns a per-file success summary. The renderer's idle runner
    // uses that summary to (a) refresh ONLY these cards and (b) stop generating
    // the moment a whole batch produces nothing — instead of re-spamming the
    // same unprocessable files every cycle.
    ipcMain.handle('generate-idle-preview-batch', async (event, items) => {
        const empty = { succeeded: 0, failed: 0, skipped: false, results: [] };
        if (!Array.isArray(items) || items.length === 0) return empty;

        // Reuse the cloud-backed skip guard.
        const firstPath = (items[0] && items[0].path) ? items[0].path.toLowerCase() : '';
        if (firstPath.includes('icloud photos') || firstPath.includes('onedrive') ||
            firstPath.includes('icloud drive') || firstPath.includes('dropbox') ||
            firstPath.includes('google drive') || firstPath.includes('creative cloud')) {
            console.log(`[main:previews] Skipping idle batch for cloud-backed folder: ${path.dirname(items[0].path)}`);
            return { ...empty, skipped: true };
        }

        const batch = items.slice(0, 10).filter(i => i && i.type === 'video' && i.path);
        const results = [];
        let succeeded = 0;
        let failed = 0;

        for (const item of batch) {
            const ext = path.extname(item.path);
            const base = path.basename(item.path, ext);
            const thumbsDir = path.join(path.dirname(item.path), '.thumbs');
            const thumbPath = path.join(thumbsDir, `${base}.jpg`);
            const webmPath = path.join(thumbsDir, `${base}.webm`);

            if (!fs.existsSync(item.path)) {
                console.warn(`[main:previews] idle skip (source missing): ${base}`);
                failed++;
                results.push({ path: item.path, success: false, reason: 'source-missing' });
                continue;
            }
            // Already generated — count as success so the card can refresh, no re-encode.
            if (fs.existsSync(thumbPath) && fs.existsSync(webmPath)) {
                console.log(`[main:previews] idle already-exists: ${base}`);
                succeeded++;
                results.push({ path: item.path, success: true, thumbnail: thumbPath, hoverWebm: webmPath });
                continue;
            }

            try {
                if (!fs.existsSync(thumbsDir)) fs.mkdirSync(thumbsDir, { recursive: true });
                console.log(`[main:previews] idle generating: ${base}`);
                await generateThumbAndPreview(item.path, thumbPath, webmPath, event.sender, false);
                const ok = fs.existsSync(thumbPath) && fs.existsSync(webmPath);
                if (ok) {
                    console.log(`[main:previews] idle OK: ${base}`);
                    succeeded++;
                    results.push({ path: item.path, success: true, thumbnail: thumbPath, hoverWebm: webmPath });
                } else {
                    console.warn(`[main:previews] idle incomplete output: ${base}`);
                    failed++;
                    results.push({ path: item.path, success: false, reason: 'incomplete-output' });
                }
            } catch (e) {
                console.error(`[main:previews] idle FAILED: ${base} — ${e.message}`);
                failed++;
                results.push({ path: item.path, success: false, reason: e.message });
            }
        }

        console.log(`[main:previews] Idle batch done — ${succeeded} ok, ${failed} failed of ${batch.length}.`);
        return { succeeded, failed, skipped: false, results };
    });
}

const activeImageEnhanceQueue = new Set();

async function enhanceImageThumbnail(imagePath, sender) {
    const ext = path.extname(imagePath).toLowerCase();
    const base = path.basename(imagePath, ext);
    const dir  = path.dirname(imagePath);
    const thumbsDir = path.join(dir, '.thumbs');
    const outPath = path.join(thumbsDir, `${base}_enhanced.jpg`);
    const tempPath = outPath + '.tmp';

    if (fs.existsSync(outPath)) {
        utils.cleanupTemp(tempPath);
        if (sender && !sender.isDestroyed()) {
            sender.send('image-enhanced', { original: imagePath, enhanced: outPath });
        }
        return;
    }

    try {
        if (!fs.existsSync(thumbsDir)) {
            fs.mkdirSync(thumbsDir, { recursive: true });
        }
    } catch (e) {
        console.error(`[previews:enhance] Failed to create .thumbs dir: ${e.message}`);
        return;
    }
    utils.cleanupTemp(tempPath);

    // ImageMagick pipeline: adaptive-sharpen → saturation +20% → sigmoidal contrast
    const args = [
        imagePath,
        '-adaptive-sharpen', '1.25x0.75',
        '-modulate', '100,120',
        '-sigmoidal-contrast', '3x50%',
        '-quality', '88',
        tempPath
    ];

    try {
        await utils.runLowPriorityProcess('magick', args);
        if (fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0) {
            if (utils.promoteTempFile(tempPath, outPath) && sender && !sender.isDestroyed()) {
                sender.send('image-enhanced', { original: imagePath, enhanced: outPath });
            }
        }
    } catch (e) {
        utils.cleanupTemp(tempPath);
        console.warn(`[previews:enhance] magick failed for ${base}: ${e.message}. Is ImageMagick installed?`);
    }
}

function registerImageEnhanceHandler(ipcMain) {
    ipcMain.handle('enhance-image-thumbnails', async (event, imagePaths) => {
        if (!Array.isArray(imagePaths) || imagePaths.length === 0) return false;
        const candidates = imagePaths.slice(0, 60); // cap batch size
        for (const p of candidates) {
            if (activeImageEnhanceQueue.has(p)) continue;
            activeImageEnhanceQueue.add(p);
            backgroundFfmpegQueue.push(async () => {
                try {
                    await enhanceImageThumbnail(p, event.sender);
                } catch (e) {
                    console.error('[previews:enhance] Queue error:', e.message);
                } finally {
                    activeImageEnhanceQueue.delete(p);
                }
            });
        }
        return true;
    });
}

module.exports = {
    generateThumbAndPreview,
    schedulePreviewGeneration,
    registerPreviewHandlers,
    registerImageEnhanceHandler
};
