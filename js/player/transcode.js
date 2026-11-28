// js/player/transcode.js — renderer side of the down-transcode pipeline.
//
// Plays a debrid stream through ffmpeg (main process) when the source resolution
// exceeds the user's "Max Stream Quality" ceiling, feeding the fragmented-MP4
// chunks into a MediaSource. This gives smooth playback + AAC audio on machines
// that choke on 4K HEVC/DTS remuxes. On any failure it falls back to direct play.

(function () {
    const Q_HEIGHT = [
        ['2160', 2160], ['4k', 2160], ['uhd', 2160],
        ['1440', 1440], ['1080', 1080], ['720', 720], ['480', 480], ['360', 360]
    ];

    function qualityToHeight(q) {
        if (!q) return 0;
        const k = String(q).toLowerCase();
        if (k.includes('source') || k.includes('remux') || k.includes('max')) return 99999;
        for (const [needle, h] of Q_HEIGHT) if (k.includes(needle)) return h;
        return 0;
    }
    window.qualityToHeight = qualityToHeight;

    // Returns the target height to transcode to, or null for direct playback.
    // `override` (set when the user explicitly picks a quality from the menu)
    // bypasses the settings ceiling for that one playback.
    window.decideTranscodeHeight = function (sourceQuality) {
        if (window._qualityOverride === 'original') return null;       // user forced Original
        if (typeof window._qualityOverride === 'number') {
            const src0 = qualityToHeight(sourceQuality);
            return (src0 && src0 > window._qualityOverride) ? window._qualityOverride : null;
        }
        const ceiling = qualityToHeight((window.appSettings && window.appSettings.streamQuality) || '1080p') || 1080;
        const src = qualityToHeight(sourceQuality);
        return (src && src > ceiling) ? ceiling : null;
    };

    // ── MediaSource plumbing ────────────────────────────────────────────────
    let ms = null, sb = null, queue = [], appending = false, active = false;
    let currentUrl = null;
    let isEvicting = false;
    let isTranscodePaused = false;
    let vpTimeUpdateHandler = null;
    let vpWaitingHandler = null;

    function toCleanArrayBuffer(buf) {
        if (!buf) return null;
        if (buf instanceof ArrayBuffer) return buf;
        if (ArrayBuffer.isView(buf)) {
            // Buffer, Uint8Array, etc.
            // Slice out strictly the valid bytes so no underlying pool memory is included.
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        }
        if (buf && buf.buffer && typeof buf.byteOffset === 'number' && typeof buf.byteLength === 'number') {
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        }
        if (buf && buf.data && Array.isArray(buf.data)) {
            return new Uint8Array(buf.data).buffer;
        }
        return new Uint8Array(buf).buffer;
    }

    async function pauseTranscode() {
        if (!active || isTranscodePaused) return;
        isTranscodePaused = true;
        try {
            if (window.electronAPI && window.electronAPI.transcodeStreamPause) {
                await window.electronAPI.transcodeStreamPause();
            }
        } catch (_) {}
    }

    async function resumeTranscode() {
        if (!active || !isTranscodePaused) return;
        isTranscodePaused = false;
        try {
            if (window.electronAPI && window.electronAPI.transcodeStreamResume) {
                await window.electronAPI.transcodeStreamResume();
            }
        } catch (_) {}
    }

    function getForwardBufferSeconds() {
        const vp = el('video-player');
        if (!sb || !vp || !sb.buffered || sb.buffered.length === 0) return 0;
        const cur = vp.currentTime;
        let maxForward = 0;
        for (let i = 0; i < sb.buffered.length; i++) {
            const start = sb.buffered.start(i);
            const end = sb.buffered.end(i);
            if (start <= cur + 2 && cur <= end) {
                const forward = end - cur;
                if (forward > maxForward) maxForward = forward;
            }
        }
        if (maxForward === 0 && sb.buffered.length > 0 && cur <= sb.buffered.start(0) + 1) {
            maxForward = sb.buffered.end(0) - cur;
        }
        return maxForward;
    }

    function checkWatermarks() {
        if (!active) return;
        const fwd = getForwardBufferSeconds();
        // Pause ffmpeg encoding when forward buffer is large (>35s) or queue has many pending chunks (>30)
        if (fwd > 35 || queue.length > 30) {
            pauseTranscode();
        } else if (fwd < 18 && queue.length < 15) {
            resumeTranscode();
        }
    }

    function pruneOldBuffer() {
        const vp = el('video-player');
        if (!sb || isEvicting || sb.updating || !vp) return;
        try {
            const cur = vp.currentTime;
            if (sb.buffered && sb.buffered.length > 0) {
                const bufStart = sb.buffered.start(0);
                // Keep 20 seconds behind playhead for smooth rewind/scrub
                const removeEnd = cur - 20;
                // Only prune if at least 15 seconds of expired buffer can be freed
                if (removeEnd > bufStart + 15) {
                    isEvicting = true;
                    sb.remove(bufStart, removeEnd);
                }
            }
        } catch (e) {
            isEvicting = false;
            console.warn('[transcode] pruneOldBuffer warning:', e.message);
        }
    }

    function flush() {
        if (!sb || appending || isEvicting || sb.updating || queue.length === 0) return;
        const chunk = queue[0];
        appending = true;
        try {
            sb.appendBuffer(chunk);
            // CRITICAL: only shift chunk from queue once appendBuffer accepts it without throwing!
            queue.shift();
            checkWatermarks();
        } catch (e) {
            appending = false;
            if (e.name === 'QuotaExceededError') {
                console.warn('[transcode] QuotaExceededError in appendBuffer, evicting old buffer...');
                pauseTranscode();
                const vp = el('video-player');
                const cur = vp ? vp.currentTime : 0;
                if (!sb.updating && sb.buffered && sb.buffered.length > 0) {
                    const bStart = sb.buffered.start(0);
                    const rEnd = cur - 5;
                    if (rEnd > bStart + 2) {
                        try {
                            isEvicting = true;
                            sb.remove(bStart, rEnd);
                            return; // updateend will call flush()
                        } catch (evictErr) {
                            isEvicting = false;
                        }
                    }
                }
                setTimeout(() => { if (active) flush(); }, 400);
                return;
            }
            console.error('[transcode] SourceBuffer append fatal error:', e);
            fallbackDirect(currentUrl, 'SourceBuffer append failed: ' + e.message);
        }
    }

    function teardownListeners() {
        try { window.electronAPI.offTranscodeChunk(); } catch (_) {}
        try { window.electronAPI.offTranscodeStatus(); } catch (_) {}
    }

    window.isTranscodeActive = function () { return active; };

    window.stopTranscode = async function () {
        active = false;
        teardownListeners();
        const vp = el('video-player');
        if (vpTimeUpdateHandler && vp) {
            vp.removeEventListener('timeupdate', vpTimeUpdateHandler);
            vpTimeUpdateHandler = null;
        }
        if (vpWaitingHandler && vp) {
            vp.removeEventListener('waiting', vpWaitingHandler);
            vpWaitingHandler = null;
        }
        queue = [];
        appending = false;
        isEvicting = false;
        isTranscodePaused = false;
        currentUrl = null;
        try { await window.electronAPI.transcodeStreamStop(); } catch (_) {}
        try {
            if (sb && ms && ms.readyState === 'open') {
                if (sb.updating) {
                    try { sb.abort(); } catch (_) {}
                }
                ms.removeSourceBuffer(sb);
            }
        } catch (_) {}
        sb = null; ms = null;
        hideBadge();
    };

    // Give up on the transcode and play the source URL directly instead.
    function fallbackDirect(url, reason) {
        console.warn('[transcode] falling back to direct playback:', reason);
        window.stopTranscode();
        const vp = el('video-player');
        if (vp && url) { vp.src = url; vp.play().catch(() => {}); }
        if (window.showToast) window.showToast(tr('toastTranscodeUnavailable', 'Transcoding unavailable — playing original'), 'warning');
    }

    // Start transcoded playback. Returns true if the transcode pipeline took over,
    // false if it declined/failed (caller should have set vp.src directly).
    // `opts` may carry { audioIndex, videoInfo } to switch the audio track; in
    // that case the main process copies the video instead of re-encoding it.
    window.startTranscodePlayback = async function (url, targetHeight, startTime, opts = {}) {
        const vp = el('video-player');
        if (!vp) return false;
        await window.stopTranscode(); // clean any previous session

        let res;
        try {
            res = await window.electronAPI.transcodeStreamStart({
                url,
                startTime: startTime || 0,
                targetHeight,
                audioIndex: (opts && opts.audioIndex !== undefined) ? opts.audioIndex : null,
                videoInfo: (opts && opts.videoInfo) || null,
            });
        } catch (e) {
            fallbackDirect(url, 'start threw: ' + e.message);
            return false;
        }
        if (!res || !res.success) {
            fallbackDirect(url, res && res.error);
            return false;
        }

        currentUrl = url;
        active = true;
        isEvicting = false;
        isTranscodePaused = false;
        queue = [];
        appending = false;
        ms = new MediaSource();
        vp.src = URL.createObjectURL(ms);

        const onTimeUpdate = () => {
            if (!active) return;
            checkWatermarks();
            pruneOldBuffer();
        };
        const onWaiting = () => {
            if (!active) return;
            resumeTranscode();
        };
        vp.addEventListener('timeupdate', onTimeUpdate);
        vp.addEventListener('waiting', onWaiting);
        vpTimeUpdateHandler = onTimeUpdate;
        vpWaitingHandler = onWaiting;

        ms.addEventListener('sourceopen', () => {
            if (!active) return;
            try {
                sb = ms.addSourceBuffer(res.codec);
                sb.mode = 'sequence';
                sb.addEventListener('updateend', () => {
                    appending = false;
                    isEvicting = false;
                    checkWatermarks();
                    pruneOldBuffer();
                    flush();
                });
                sb.addEventListener('error', (e) => {
                    console.error('[transcode] SourceBuffer error event', e);
                    fallbackDirect(url, 'SourceBuffer error event fired');
                });
                flush();
            } catch (e) {
                fallbackDirect(url, 'addSourceBuffer failed: ' + e.message);
            }
        }, { once: true });

        teardownListeners();
        window.electronAPI.onTranscodeChunk(({ buffer }) => {
            if (!active) return;
            const ab = toCleanArrayBuffer(buffer);
            if (ab && ab.byteLength > 0) {
                queue.push(ab);
                checkWatermarks();
                flush();
            }
        });
        window.electronAPI.onTranscodeStatus(({ type, error }) => {
            if (!active) return;
            if (type === 'error') fallbackDirect(url, 'ffmpeg: ' + (error || 'unknown'));
            else if (type === 'done') { try { if (ms && ms.readyState === 'open') ms.endOfStream(); } catch (_) {} }
        });

        showBadge(targetHeight);
        vp.play().catch(() => {});
        return true;
    };

    // ── Badge (also a toggle back to Original) ──────────────────────────────
    function showBadge(h) {
        let b = el('transcode-badge');
        if (!b) {
            b = document.createElement('div');
            b.id = 'transcode-badge';
            // Sits BELOW the player top bar — at top:12px it overlapped the
            // title and clipped it.
            b.style.cssText = 'position:absolute; top:52px; left:12px; z-index:210; padding:3px 9px; border-radius:4px; font-size:10px; font-weight:800; letter-spacing:0.05em; color:#fff; background:rgba(176,124,255,0.85); cursor:pointer; font-family:var(--font-mono); box-shadow:0 2px 8px rgba(0,0,0,0.4);';
            b.title = 'Transcoded for smooth playback — click for Original';
            b.addEventListener('click', () => {
                // One-shot override to Original, then replay the current source.
                window._qualityOverride = 'original';
                const m = window.activeStreamingMedia;
                if (m && m.streamUrl && window.playStream) {
                    const vp = el('video-player');
                    window._resumePosAfterSwitch = vp ? vp.currentTime : 0;
                    window.playStream(m.streamUrl, m.streamTitle || m.title || '');
                }
            });
            const modal = el('video-modal');
            if (modal) modal.appendChild(b);
        }
        b.textContent = `${h}P`;
        b.style.display = 'block';
    }
    function hideBadge() {
        const b = el('transcode-badge');
        if (b) b.style.display = 'none';
    }
})();
