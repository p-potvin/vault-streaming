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

    function flush() {
        if (!sb || appending || sb.updating || queue.length === 0) return;
        appending = true;
        try { sb.appendBuffer(queue.shift()); }
        catch (e) { appending = false; /* QuotaExceeded etc. — drop and continue */ }
    }

    function teardownListeners() {
        try { window.electronAPI.offTranscodeChunk(); } catch (_) {}
        try { window.electronAPI.offTranscodeStatus(); } catch (_) {}
    }

    window.isTranscodeActive = function () { return active; };

    window.stopTranscode = async function () {
        active = false;
        teardownListeners();
        queue = []; appending = false;
        try { await window.electronAPI.transcodeStreamStop(); } catch (_) {}
        try { if (sb && ms && ms.readyState === 'open') ms.removeSourceBuffer(sb); } catch (_) {}
        sb = null; ms = null;
        hideBadge();
    };

    // Give up on the transcode and play the source URL directly instead.
    function fallbackDirect(url, reason) {
        console.warn('[transcode] falling back to direct playback:', reason);
        window.stopTranscode();
        const vp = el('video-player');
        if (vp) { vp.src = url; vp.play().catch(() => {}); }
        if (window.showToast) window.showToast('Transcoding unavailable — playing original', 'warning');
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

        active = true;
        ms = new MediaSource();
        vp.src = URL.createObjectURL(ms);

        ms.addEventListener('sourceopen', () => {
            if (!active) return;
            try {
                sb = ms.addSourceBuffer(res.codec);
                sb.mode = 'sequence';
                sb.addEventListener('updateend', () => { appending = false; flush(); });
                sb.addEventListener('error', (e) => console.error('[transcode] SourceBuffer error', e));
                flush();
            } catch (e) {
                fallbackDirect(url, 'addSourceBuffer failed: ' + e.message);
            }
        }, { once: true });

        teardownListeners();
        window.electronAPI.onTranscodeChunk(({ buffer }) => {
            if (!active) return;
            const ab = buffer instanceof ArrayBuffer ? buffer
                : (buffer && buffer.buffer) ? buffer.buffer
                : buffer;
            if (ab) { queue.push(ab); flush(); }
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
