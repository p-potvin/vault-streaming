// src/ipc/transcode.ipc.js — real-time down-transcode of a debrid stream so it
// plays smoothly on machines that struggle with 4K/HEVC/AV1 remuxes.
//
// The user's "Max Stream Quality" is a PLAYBACK ceiling: when the selected
// source exceeds it (e.g. a UHD remux with a 1080p ceiling), we pipe the RD URL
// through ffmpeg (h264_nvenc, fast preset) scaled to the ceiling and stream the
// resulting fragmented MP4 to the renderer's MediaSource — same chunk pattern as
// the RTX-VSR upscale path. If NVENC isn't available we fall back to libx264.
//
// Note: this does NOT reduce download bandwidth (RD still serves the full source);
// it moves the heavy 4K decode off Chromium's <video> and hands the player an
// easy, universally-decodable 1080p/720p H.264+AAC stream.

const child_process = require('child_process');
const utils = require('../utils');
const { mseCodecForCopy } = require('./audio-tracks.ipc');

let transcodeProcess = null;
let transcodeEvent = null;

// Cache the encoder decision (probing ffmpeg -encoders is a spawn we do once).
let _cachedEncoder = null;

function pickH264Encoder() {
    if (_cachedEncoder) return _cachedEncoder;
    try {
        const out = child_process.execFileSync(utils.getFFmpegPath(), ['-hide_banner', '-encoders'], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 8000,
        });
        _cachedEncoder = /\bh264_nvenc\b/.test(out) ? 'h264_nvenc' : 'libx264';
    } catch (e) {
        console.warn('[transcode] encoder probe failed, defaulting to libx264:', e.message);
        _cachedEncoder = 'libx264';
    }
    console.log('[transcode] using video encoder:', _cachedEncoder);
    return _cachedEncoder;
}

function buildArgs({ url, startTime, targetHeight, encoder, audioIndex = null, copyVideo = false }) {
    const nv = encoder === 'h264_nvenc';
    const args = [];
    // Fast input-seek (RD supports range requests). Placed before -i.
    if (startTime && Number(startTime) > 0) args.push('-ss', String(Number(startTime)));
    // NVDEC hardware decode for the (expensive) 4K decode when using NVENC.
    // Frames land in system memory so a plain CPU `scale` works — this avoids a
    // hard dependency on the scale_cuda filter across ffmpeg builds.
    if (nv && !copyVideo) args.push('-hwaccel', 'cuda');
    // Reconnect on transient network hiccups while pulling the remote source.
    args.push(
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-i', url,
    );

    // Explicit stream selection when switching audio track. Without -map, ffmpeg
    // picks the highest-channel audio, which is exactly the foreign-dub trap.
    if (audioIndex !== null && audioIndex !== undefined) {
        args.push('-map', '0:v:0', '-map', `0:a:${audioIndex}`);
    }

    if (copyVideo) {
        // Audio-only switch: the video is untouched, so this is a cheap remux
        // rather than a transcode.
        args.push('-c:v', 'copy');
    } else {
        args.push(
            // Scale to the ceiling height, keep aspect (even width for H.264).
            '-vf', `scale=-2:${targetHeight}`,
            '-c:v', encoder,
            '-preset', 'fast',
            // Pin profile/level so the renderer's MediaSource codec string is stable.
            '-profile:v', 'high',
            '-level', '4.1',
            '-pix_fmt', 'yuv420p',
        );
    }

    args.push(
        // Re-encode audio to AAC-LC (source is often EAC3/DTS — not MSE-playable).
        '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
        // Fragmented MP4 so it can be fed to MediaSource as it is produced.
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-f', 'mp4',
        'pipe:1'
    );
    return args;
}

function registerTranscodeIpc(ipcMain) {
    // The renderer feeds this codec string to MediaSource.addSourceBuffer.
    const MSE_CODEC = 'video/mp4; codecs="avc1.640029, mp4a.40.2"';

    ipcMain.handle('transcode-stream-start', async (event, { url, startTime = 0, targetHeight = 1080, audioIndex = null, videoInfo = null } = {}) => {
        if (!url || typeof url !== 'string') {
            return { success: false, error: 'No stream URL provided' };
        }

        // Switching audio track only? Then the video can be copied verbatim —
        // provided we can express its codec for MediaSource. If we can't, fall
        // back to the known-good H.264 re-encode below.
        const copyCodec = (audioIndex !== null && audioIndex !== undefined)
            ? mseCodecForCopy(videoInfo) : null;
        const copyVideo = !!copyCodec;

        // Kill any existing transcode before starting a new one.
        if (transcodeProcess) {
            try { transcodeProcess.kill('SIGKILL'); } catch (_) { try { transcodeProcess.kill(); } catch (__) {} }
            transcodeProcess = null;
        }
        transcodeEvent = event;

        const encoder = pickH264Encoder();
        const args = buildArgs({ url, startTime, targetHeight, encoder, audioIndex, copyVideo });
        const ffmpegPath = utils.getFFmpegPath();
        if (audioIndex !== null && audioIndex !== undefined) {
            console.log(`[transcode] audio-track switch -> a:${audioIndex} ` +
                `(video ${copyVideo ? 'copied' : 're-encoded: codec not MSE-expressible'})`);
        }
        console.log(`[transcode] spawning: ${ffmpegPath} ${args.join(' ')}`);

        const sendStatus = (type, data = {}) => {
            if (event.sender && !event.sender.isDestroyed()) {
                event.sender.send('transcode-status', { type, ...data });
            }
        };

        try {
            const proc = child_process.spawn(ffmpegPath, args, { windowsHide: true });
            transcodeProcess = proc;

            let chunkCount = 0;
            proc.stdout.on('data', (data) => {
                if (event.sender && !event.sender.isDestroyed()) {
                    chunkCount++;
                    event.sender.send('transcode-chunk', { chunk: chunkCount, buffer: data });
                }
            });

            let stderrTail = '';
            proc.stderr.on('data', (data) => {
                const str = data.toString();
                // Keep only the tail so a long run doesn't balloon memory.
                stderrTail = (stderrTail + str).slice(-4000);
                const m = str.match(/time=(\d+:\d+:\d+\.\d+)/);
                if (m) sendStatus('processing', { time: m[1] });
            });

            proc.on('close', (code) => {
                console.log(`[transcode] ffmpeg exited with code ${code}`);
                transcodeProcess = null;
                transcodeEvent = null;
                if (code === 0 || code === null) sendStatus('done');
                else sendStatus('error', { error: stderrTail.trim() || `ffmpeg exited with code ${code}` });
            });

            proc.on('error', (err) => {
                console.error('[transcode] process error:', err);
                sendStatus('error', { error: err.message });
            });

            return {
                success: true,
                encoder: copyVideo ? 'copy' : encoder,
                codec: copyCodec || MSE_CODEC,
                targetHeight,
                audioIndex,
                copiedVideo: copyVideo,
            };
        } catch (err) {
            console.error('[transcode] failed to start:', err);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('transcode-stream-stop', async () => {
        if (transcodeProcess) {
            try { transcodeProcess.kill('SIGKILL'); } catch (_) { try { transcodeProcess.kill(); } catch (__) {} }
            transcodeProcess = null;
            transcodeEvent = null;
        }
        return { success: true };
    });

    console.log('[transcode] IPC handlers registered (transcode-stream-start/stop).');
}

module.exports = { registerTranscodeIpc };
