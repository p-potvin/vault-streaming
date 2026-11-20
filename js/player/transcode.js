// js/player/transcode.js — renderer side of the down-transcode pipeline.
//
// Plays a debrid stream through ffmpeg (main process) when the source resolution
// exceeds the user's "Max Stream Quality" ceiling, or when the audio needs fixing
// (another language than the file's default, or a codec Chromium can't play),
// feeding the fragmented-MP4 chunks into a MediaSource.
//
// The <video> sees the real timeline: the MediaSource gets the title's duration
// and each session's chunks are placed at its start time (timestampOffset), so the
// clock, the seek bar and the saved watch progress are right. A seek past what is
// buffered restarts ffmpeg there. A copied video the browser can't decode (the
// SourceBuffer errors) is retried once as an H.264 re-encode at the same spot,
// instead of falling back to the raw file, whose default audio track is the one
// the user didn't want.

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
    let session = null;          // { url, height, opts, start, id, copied, reencoded }
    let restarting = false;
    // a copy-failure recovery is starting: errors of the session it replaces (and <video> errors before the new
    // session exists) are expected; the new session's own errors are not
    let pendingRecovery = false;
    const retired = new WeakSet();

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
        sb = null; ms = null; session = null;
        hideBadge();
    };

    // Give up on the transcode and play the source URL directly instead.
    function fallbackDirect(url, reason) {
        console.warn('[transcode] falling back to direct playback:', reason);
        window.stopTranscode();
        const vp = el('video-player');
        const at = vp && Number.isFinite(vp.currentTime) ? vp.currentTime : 0;
        if (vp) {
            vp.src = url;
            if (at > 1) vp.addEventListener('loadedmetadata', () => { try { vp.currentTime = at; } catch (_) {} }, { once: true });
            vp.play().catch(() => {});
        }
        if (window.showToast) window.showToast(tr('toastTranscodeUnavailable', 'Transcoding unavailable — playing original'), 'warning');
    }

    function isBuffered(vp, t) {
        const b = vp.buffered;
        for (let i = 0; i < b.length; i++) if (t >= b.start(i) - 0.5 && t <= b.end(i) + 0.5) return true;
        return false;
    }

    /**
     * The copied video failed (SourceBuffer / decode error): restart as an H.264 re-encode where playback was. True
     * when a recovery started (callers then skip their own error handling), false when there is nothing to retry.
     */
    window.transcodeRecover = function (reason, from = null) {
        if (from && retired.has(from)) return true;      // the replaced session reporting again: already handled
        if (pendingRecovery && !from) return true;       // the <video> erroring while the replacement starts
        if (!active || !session || !session.copied || session.reencoded) return false;
        retired.add(session);
        pendingRecovery = true;
        const vp = el('video-player');
        const at = vp && Number.isFinite(vp.currentTime) && vp.currentTime > 0 ? vp.currentTime : session.start;
        console.warn(`[transcode] copied video not playable (${reason}) — re-encoding from ${Math.round(at)} s`);
        const { url, height, opts } = session;
        // a compatibility re-encode: 1080p at most (lighter, and what every decoder takes)
        window.startTranscodePlayback(url, Math.min(Number(height) || 1080, 1080), at, { ...opts, forceReencode: true });
        return true;
    };

    /** Restart the current transcode (same source, height and options) at `at` seconds: the stream reload
     *  (js/player/player.js, reloadStream). False when no transcode is running. */
    window.transcodeRestart = function (at, { paused = false } = {}) {
        if (!active || !session) return false;
        const { url, height, opts } = session;
        retired.add(session);
        pendingRecovery = true;
        window.startTranscodePlayback(url, height, Math.max(0, Number(at) || 0), { ...opts, startPaused: paused });
        return true;
    };

    // Start transcoded playback. Returns true if the transcode pipeline took over,
    // false if it declined/failed (caller should have set vp.src directly).
    // `opts`: { audioIndex, videoInfo } to switch the audio track (the main process then copies the video when it
    // can), durationSec (the title's runtime, for the clock and seek bar), forceReencode.
    window.startTranscodePlayback = async function (url, targetHeight, startTime, opts = {}) {
        const vp = el('video-player');
        if (!vp) return false;
        await window.stopTranscode(); // clean any previous session
        const start = Math.max(0, Number(startTime) || 0);
        // startPaused (a reload of a paused stream) applies to this start only, not to the session's later restarts
        const startPaused = !!opts.startPaused;
        if ('startPaused' in opts) { opts = { ...opts }; delete opts.startPaused; }

        let res;
        try {
            res = await window.electronAPI.transcodeStreamStart({
                url,
                startTime: start,
                targetHeight,
                audioIndex: (opts && opts.audioIndex !== undefined) ? opts.audioIndex : null,
                videoInfo: (opts && opts.videoInfo) || null,
                forceReencode: !!(opts && opts.forceReencode),
            });
        } catch (e) {
            fallbackDirect(url, 'start threw: ' + e.message);
            return false;
        }
        if (!res || !res.success) {
            pendingRecovery = false;
            fallbackDirect(url, res && res.error);
            return false;
        }
        // A copied video in a codec this Chromium can't take: ask for the H.264 re-encode right away.
        if (res.copiedVideo && window.MediaSource && !MediaSource.isTypeSupported(res.codec)) {
            console.warn('[transcode] copy codec not supported here:', res.codec, '— re-encoding instead');
            return window.startTranscodePlayback(url, Math.min(Number(targetHeight) || 1080, 1080), start, { ...opts, forceReencode: true });
        }

        active = true;
        session = { url, height: targetHeight, opts, start, id: res.session, copied: !!res.copiedVideo,
                    reencoded: !!(opts && opts.forceReencode) };
        const thisSession = session;
        pendingRecovery = false;      // from here, errors are this session's own
        ms = new MediaSource();
        vp.src = URL.createObjectURL(ms);
        let positioned = false;

        ms.addEventListener('sourceopen', () => {
            if (!active || session !== thisSession) return;
            try {
                const dur = Number(opts && opts.durationSec);
                if (Number.isFinite(dur) && dur > start) ms.duration = dur;   // the clock and seek bar show the title
                sb = ms.addSourceBuffer(res.codec);
                sb.mode = 'sequence';
                sb.timestampOffset = start;                                   // chunks land at their real time
                sb.addEventListener('updateend', () => {
                    appending = false;
                    if (!positioned && start > 0 && vp.buffered.length) {
                        positioned = true;
                        restarting = true;
                        try { vp.currentTime = start; } catch (_) {}
                        setTimeout(() => { restarting = false; }, 500);
                    }
                    flush();
                });
                sb.addEventListener('error', (e) => {
                    console.error('[transcode] SourceBuffer error', e && e.type);
                    if (!window.transcodeRecover('SourceBuffer error', thisSession)) fallbackDirect(url, 'SourceBuffer error');
                });
                flush();
            } catch (e) {
                if (!window.transcodeRecover('addSourceBuffer: ' + e.message, thisSession)) fallbackDirect(url, 'addSourceBuffer failed: ' + e.message);
            }
        }, { once: true });

        teardownListeners();
        window.electronAPI.onTranscodeChunk(({ buffer, session: id }) => {
            if (!active || (id != null && id !== thisSession.id)) return;
            const ab = buffer instanceof ArrayBuffer ? buffer
                : (buffer && buffer.buffer) ? buffer.buffer
                : buffer;
            if (ab) { queue.push(ab); flush(); }
        });
        window.electronAPI.onTranscodeStatus(({ type, error, session: id }) => {
            if (!active || (id != null && id !== thisSession.id)) return;
            if (type === 'error') {
                if (!window.transcodeRecover('ffmpeg: ' + (error || 'unknown'), thisSession)) fallbackDirect(url, 'ffmpeg: ' + (error || 'unknown'));
            } else if (type === 'done') { try { if (ms && ms.readyState === 'open') ms.endOfStream(); } catch (_) {} }
        });

        if (res.copiedVideo) hideBadge(); else showBadge(targetHeight);
        if (!startPaused) vp.play().catch(() => {});
        return true;
    };

    // A seek outside what is buffered: restart ffmpeg at the new position (debounced while scrubbing).
    let seekTimer = null;
    document.addEventListener('DOMContentLoaded', () => {
        const vp = el('video-player');
        if (!vp) return;
        vp.addEventListener('seeking', () => {
            if (!active || !session || restarting) return;
            const t = vp.currentTime;
            if (isBuffered(vp, t)) return;
            clearTimeout(seekTimer);
            seekTimer = setTimeout(() => {
                if (!active || !session || isBuffered(vp, vp.currentTime)) return;
                const { url, height, opts } = session;
                window.startTranscodePlayback(url, height, vp.currentTime, { ...opts, forceReencode: session.reencoded });
            }, 350);
        });
    });

    // ── Badge (also a toggle back to Original) ──────────────────────────────
    function showBadge(h) {
        let b = el('transcode-badge');
        if (!b) {
            b = document.createElement('div');
            b.id = 'transcode-badge';
            // Sits BELOW the player top bar — at top:12px it overlapped the
            // title and clipped it. Hidden in PiP (css/player.css).
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
