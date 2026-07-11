// upscale.js — coordinates real-time AI upscale mode (Real-ESRGAN/CUDA) with MediaSource buffer stitching.

let upscaleActive   = false;
let upscaleMS       = null;
let upscaleSB       = null;
let upscaleQueue    = [];
let upscaleAppending = false;
let upscaleOrigSrc  = '';
let upscaleOrigTime = 0;
let upscaleChunkCount = 0;
let upscaleVpErrorHandler = null;

// Tear down upscaling on failure: show one clear error, revert to the original
// video, drop the badge, and reset the toggle button so it isn't stuck "active".
function endUpscaleWithError(msg) {
    window.showToast(msg, 'error');
    stopUpscaleMode();
    upscaleActive = false;
    const btn = el('btn-upscale');
    if (btn) btn.classList.remove('active');
}

function isUpscaleActive() {
    return upscaleActive;
}

function setUpscaleActive(val) {
    upscaleActive = val;
}

function upscaleFlushQueue() {
    if (upscaleAppending || upscaleQueue.length === 0 || !upscaleSB) return;
    if (upscaleSB.updating) return;
    upscaleAppending = true;
    try {
        upscaleSB.appendBuffer(upscaleQueue.shift());
    } catch(e) {
        upscaleAppending = false;
    }
}

function upscaleSetStatus(txt, color) {
    const badge = el('upscale-badge');
    if (badge) { badge.textContent = txt; badge.style.background = color || 'rgba(0,0,0,0.65)'; }
}

async function startUpscaleMode() {
    const vp = el('video-player');
    if (!vp) return;
    if (!vp.src || !vp.src.startsWith('file://')) {
        window.showToast('Upscaling requires a local video file', 'error'); return;
    }
    upscaleOrigSrc  = vp.src;
    upscaleOrigTime = vp.currentTime;
    upscaleChunkCount = 0;
    upscaleQueue    = [];
    upscaleAppending = false;

    let badge = el('upscale-badge');
    if (!badge) {
        badge = document.createElement('div');
        badge.id = 'upscale-badge';
        badge.style.cssText = 'position:absolute;top:52px;left:12px;z-index:210;padding:3px 8px;border-radius:4px;font-size:10px;font-family:var(--font-body);font-weight:700;letter-spacing:0.06em;color:#fff;pointer-events:none;background:rgba(0,0,0,0.65);';
        el('video-modal').appendChild(badge);
    }
    upscaleSetStatus('⬆ RTX VSR  ·  initializing…', '#1a1a2e');

    let rawPath = decodeURIComponent(upscaleOrigSrc.replace(/^file:\/\/\//, '').replace(/\//g, '\\'));
    rawPath = rawPath.replace(/^([A-Za-z])%3A/, '$1:');

    window.electronAPI.offUpscaleChunk();
    window.electronAPI.offUpscaleStatus();

    window.electronAPI.onUpscaleStatus(({ type, chunk, chunkStart, fps, width, height, duration, error }) => {
        if (type === 'init') {
            upscaleSetStatus(`⬆ RTX VSR  ·  ${width}×${height} → ${width*2}×${height*2}  ·  buffering…`, '#0d1117');
        } else if (type === 'processing') {
            upscaleSetStatus(`⬆ RTX VSR  ·  ${chunk} frames  ·  buffering…`, '#0d1117');
        } else if (type === 'done') {
            // "done" with zero chunks means the encoder produced nothing (e.g.
            // RTX VSR SDK unavailable). endOfStream() here would throw the
            // DEMUXER "endOfStream before HAVE_METADATA" error — so fail cleanly.
            if (upscaleChunkCount === 0) {
                endUpscaleWithError('Upscaler produced no video — RTX VSR may be unavailable on this machine.');
                return;
            }
            upscaleSetStatus('⬆ RTX VSR  ·  complete', '#155724');
            if (upscaleMS && upscaleMS.readyState === 'open') {
                try { upscaleMS.endOfStream(); } catch(_) {}
            }
            // Auto-dismiss the badge so it doesn't linger as a fake "success".
            setTimeout(() => { const b = el('upscale-badge'); if (b) b.remove(); }, 4000);
        } else if (type === 'chunk-error') {
            const detail = error ? String(error).split(/\r?\n/).filter(Boolean).pop() : 'unknown';
            console.warn('[upscale] chunk error:', error || chunk);
            endUpscaleWithError('RTX VSR failed: ' + detail);
        }
    });

    // A MediaSource/demuxer failure surfaces on the <video> element — catch it
    // so we revert to the original source instead of stranding a broken stream.
    upscaleVpErrorHandler = () => {
        if (!upscaleActive) return;
        endUpscaleWithError('Playback error during upscaling (stream could not be demuxed).');
    };
    vp.addEventListener('error', upscaleVpErrorHandler);

    window.electronAPI.onUpscaleChunk(({ chunk, buffer }) => {
        upscaleChunkCount++;
        upscaleSetStatus(`⬆ RTX VSR  ·  buf ${upscaleChunkCount} chunk(s)`, '#0d3349');
        const ab = buffer instanceof ArrayBuffer ? buffer : buffer.buffer || Buffer.from(buffer).buffer;
        upscaleQueue.push(ab);
        upscaleFlushQueue();
    });

    upscaleMS = new MediaSource();
    const msUrl = URL.createObjectURL(upscaleMS);

    upscaleMS.addEventListener('sourceopen', () => {
        try {
            upscaleSB = upscaleMS.addSourceBuffer('video/mp4; codecs="avc1.640033"');
            upscaleSB.mode = 'sequence';
            upscaleSB.addEventListener('updateend', () => {
                upscaleAppending = false;
                upscaleFlushQueue();
            });
            upscaleSB.addEventListener('error', (e) => {
                console.error('[upscale] SourceBuffer error', e);
                upscaleAppending = false;
            });
        } catch(e) {
            console.error('[upscale] addSourceBuffer failed:', e.message);
            upscaleSetStatus('⬆ AI  ·  codec error', '#721c24');
        }
    });

    vp.src = msUrl;
    vp.play().catch(() => {});

    const vsrQuality = (window.appSettings && window.appSettings.vsrQuality) || 'HIGH';
    const vsrScale = (window.appSettings && window.appSettings.vsrScale) || '2';
    const vsrBitrate = (window.appSettings && window.appSettings.vsrBitrate) || '12M';
    const vsrChroma = (window.appSettings && window.appSettings.vsrChroma) || 'yuv420p';

    const result = await window.electronAPI.startUpscaleStream({
        videoPath: rawPath,
        startTime: upscaleOrigTime,
        quality: vsrQuality,
        scale: vsrScale,
        bitrate: vsrBitrate,
        chroma: vsrChroma,
    });
    if (!result.success) {
        window.showToast('Upscale failed: ' + result.error, 'error');
        stopUpscaleMode();
    }
}

function stopUpscaleMode() {
    const vp = el('video-player');
    window.electronAPI.stopUpscaleStream();
    window.electronAPI.offUpscaleChunk();
    window.electronAPI.offUpscaleStatus();
    if (vp && upscaleVpErrorHandler) {
        vp.removeEventListener('error', upscaleVpErrorHandler);
        upscaleVpErrorHandler = null;
    }
    // Only close the stream if the demuxer actually initialised — calling
    // endOfStream() before HAVE_METADATA is itself a source of the DEMUXER error.
    if (upscaleMS && upscaleMS.readyState === 'open' && upscaleChunkCount > 0) {
        try { upscaleMS.endOfStream(); } catch(_) {}
    }
    upscaleMS   = null;
    upscaleSB   = null;
    upscaleQueue = [];

    if (upscaleOrigSrc && vp) {
        vp.src = upscaleOrigSrc;
        vp.currentTime = upscaleOrigTime;
        vp.play().catch(() => {});
    }
    const badge = el('upscale-badge');
    if (badge) badge.remove();
}

function initUpscaleListeners() {
    el('btn-upscale').addEventListener('click', async () => {
        upscaleActive = !upscaleActive;
        el('btn-upscale').classList.toggle('active', upscaleActive);
        if (upscaleActive) {
            window.showToast('Starting real-time upscaling…', 'success');
            await startUpscaleMode();
        } else {
            window.showToast('Upscaling stopped', 'success');
            stopUpscaleMode();
        }
    });
}

// Bind to globals
window.startUpscaleMode = startUpscaleMode;
window.stopUpscaleMode = stopUpscaleMode;
window.isUpscaleActive = isUpscaleActive;
window.setUpscaleActive = setUpscaleActive;
window.initUpscaleListeners = initUpscaleListeners;
