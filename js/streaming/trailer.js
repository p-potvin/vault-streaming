// js/streaming/trailer.js — the details modal's trailer, played from the local cache (src/trailers.js)
// Part of the streaming feature, split out of the former monolithic js/streaming.js.

async function _fetchAndInjectTrailer(tmdbId, mediaType) {
    // Generation token: any modal close (destroyTrailer) bumps this, so an
    // in-flight resolution that finishes AFTER the modal closed will abort
    // before attaching an autoplaying <video> off-screen (the "ghost trailer").
    const gen = window._modalTrailerGen = (window._modalTrailerGen || 0) + 1;
    const stillCurrent = () => gen === window._modalTrailerGen;

    const iframeWrapper = el('movie-trailer-wrapper');
    const loadingEl = el('movie-trailer-loading');

    if (iframeWrapper) iframeWrapper.style.display = 'block';
    if (loadingEl) loadingEl.style.display = 'flex';

    try {
        // One call: the trailer's YouTube id and its local copy (src/trailers.js). KinoCheck / TMDB are asked and
        // YouTube is downloaded only the first time a title is opened; after that this is a disk lookup.
        const titleEl0 = el('streaming-details-title');
        const res = (window.electronAPI && window.electronAPI.getTrailer)
            ? await window.electronAPI.getTrailer({ id: tmdbId, mediaType, language: window.tmdbLanguage(),
                                                    title: titleEl0 ? titleEl0.textContent : '' })
            : null;
        const trailerKey = res && res.key;
        const directUrl = res && res.success ? window.trailerSrc(res) : null;
        if (res && !res.success) console.warn('[streaming] Trailer not cached:', res.error);

        if (!trailerKey) {
            if (!stillCurrent()) return;
            if (iframeWrapper) iframeWrapper.style.display = 'none';
            if (loadingEl) loadingEl.style.display = 'none';
            return;
        }

        window._currentTrailerKey = trailerKey;

        const btnTrailer = el('btn-watch-trailer-browser');

        if (btnTrailer) {
            btnTrailer.style.display = 'flex';
            btnTrailer.onclick = () => {
                if (window.electronAPI && window.electronAPI.openExternalURL) {
                    window.electronAPI.openExternalURL(`https://www.youtube.com/watch?v=${trailerKey}`);
                }
            };
        }

        if (!iframeWrapper) return;

        // The modal was closed while we were resolving — do NOT attach anything
        // (this is what prevents the off-screen ghost trailer).
        if (!stillCurrent()) {
            if (loadingEl) loadingEl.style.display = 'none';
            return;
        }

        if (directUrl) {
            console.log('[streaming] Playing the cached trailer', trailerKey);
            // Remove old iframe listener if any
            if (window._ytTrailerListener) {
                window.removeEventListener('message', window._ytTrailerListener);
                window._ytTrailerListener = null;
            }

            // Remove any existing video or iframe, keeping the loading element
            iframeWrapper.querySelectorAll('video, iframe').forEach(e => e.remove());

            const vid = document.createElement('video');
            vid.id = 'movie-trailer-iframe';
            vid.style.cssText = 'width:100%; height:100%; border:none; background:#000; display:block;';
            vid.src = directUrl;
            vid.controls = true;
            vid.playsInline = true;
            vid.preload = 'auto';
            vid.autoplay = true;
            // Trailers at 80% (−20%) by default; muted if the user opted in.
            vid.muted = !!(window.appSettings && window.appSettings.muteTrailers);
            vid.volume = 0.8;

            // Hide loading indicator when video metadata is loaded
            vid.addEventListener('loadedmetadata', () => {
                if (loadingEl) loadingEl.style.display = 'none';
            });

            // Autoplay safety
            vid.addEventListener('canplay', () => {
                vid.play().catch(err => console.warn('[Trailer] Autoplay failed:', err));
            }, { once: true });

            // Restore persisted current time if available
            if (window._persistedTrailerTime) {
                const targetTime = window._persistedTrailerTime;
                window._persistedTrailerTime = 0; // reset
                const restoreTime = () => {
                    vid.currentTime = targetTime;
                    vid.play().catch(err => console.warn('[Trailer] Autoplay failed:', err));
                };
                if (vid.readyState >= 1) {
                    restoreTime();
                } else {
                    vid.addEventListener('loadedmetadata', restoreTime, { once: true });
                }
            }

            iframeWrapper.appendChild(vid);
            iframeWrapper.style.display = 'block';

            // ── Trailer mute/unmute button ───────────────────────────────
            const muteBtn = el('btn-trailer-mute');
            if (muteBtn) {
                const updateMuteIcon = () => {
                    const isMuted = vid.muted || vid.volume === 0;
                    muteBtn.innerHTML = isMuted
                        ? (window.icons ? window.icons.eyeOff('', 'width:16px; height:16px;') : '🔇')
                        : (window.icons ? window.icons.eye('', 'width:16px; height:16px;') : '🔊');
                    muteBtn.title = isMuted ? 'Unmute Trailer' : 'Mute Trailer';
                };
                updateMuteIcon();
                muteBtn.style.display = 'flex';
                muteBtn.onclick = (e) => {
                    e.stopPropagation();
                    vid.muted = !vid.muted;
                    if (!vid.muted && vid.volume === 0) vid.volume = 0.8;
                    updateMuteIcon();
                };
                vid.addEventListener('volumechange', updateMuteIcon);
            }

            return;
        }

        // -----------------------------------------------------------------
        // FALLBACK: iframe embed, only when the download failed (it is
        // retried after a day). Still subject to embedding restrictions.
        // -----------------------------------------------------------------
        // Recreate the iframe if it was removed or isn't a native iframe
        let iframe = el('movie-trailer-iframe');
        if (!iframe || iframe.tagName !== 'IFRAME') {
            if (iframe) iframe.remove();
            iframe = document.createElement('iframe');
            iframe.id = 'movie-trailer-iframe';
            iframe.style.cssText = 'width: 100%; height: 100%; border: none;';
            iframe.setAttribute('allowfullscreen', 'true');
            iframeWrapper.appendChild(iframe);
        }

        if (iframe) {
            iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
            iframe.removeAttribute('sandbox');
            const spoofedOrigin = 'https://www.youtube.com';
            const params = new URLSearchParams({
                autoplay: '1', rel: '0', modestbranding: '1',
                playsinline: '1', enablejsapi: '1',
                origin: spoofedOrigin,
                widget_referrer: spoofedOrigin,
            });

            if (window._persistedTrailerTime) {
                const secs = Math.floor(window._persistedTrailerTime);
                if (secs > 0) {
                    params.set('start', secs);
                }
                window._persistedTrailerTime = 0; // reset
            }

            // Hide loading element when the iframe finishes loading
            iframe.onload = () => {
                if (loadingEl) loadingEl.style.display = 'none';
                try {
                    iframe.contentWindow.postMessage(
                        JSON.stringify({ event: 'listening', id: trailerKey, channel: 'widget' }),
                        '*'
                    );
                    iframe.contentWindow.postMessage(
                        JSON.stringify({ event: 'command', func: 'addEventListener', args: ['onError'] }),
                        '*'
                    );
                } catch (_) { /* cross-origin write — non-fatal */ }
            };

            iframe.src = `https://www.youtube.com/embed/${trailerKey}?${params.toString()}`;
            iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
            iframe.setAttribute('allowfullscreen', 'true');

            if (window._ytTrailerListener) {
                window.removeEventListener('message', window._ytTrailerListener);
            }
            const showFallback = (reason) => {
                console.error('[streaming] YouTube embed unplayable:', reason);
                if (loadingEl) loadingEl.style.display = 'none';
                // Show the trailer's own YouTube thumbnail with an explicit cue
                // rather than collapsing to an empty box — a blank panel reads as
                // a broken app, when in fact the video simply refuses embedding.
                const t = (window.translations && window.translations[window.currentLang]) || {};
                iframeWrapper.style.display = 'block';
                iframeWrapper.innerHTML = `
                    <div class="trailer-unavailable" style="position:relative; width:100%; height:100%; background:#000; border-radius:6px; overflow:hidden;">
                      <img src="https://img.youtube.com/vi/${trailerKey}/hqdefault.jpg" alt=""
                           style="width:100%; height:100%; object-fit:cover; opacity:0.35; filter:grayscale(0.4);">
                      <div style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; text-align:center; padding:16px;">
                        <div style="font-family:var(--font-mono); font-size:11px; letter-spacing:0.06em; text-transform:uppercase; color:var(--vault-accent);">
                          ${window.escapeHtml(t.trailerUnavailable || 'Trailer cannot play here')}
                        </div>
                        <div style="font-size:11.5px; color:#bbb; max-width:320px; line-height:1.45;">
                          ${window.escapeHtml(t.trailerUnavailableHint || 'The channel blocks embedded playback. Use "Watch Trailer on YouTube" to open it in your browser.')}
                        </div>
                      </div>
                    </div>`;
            };
            window._ytTrailerListener = (ev) => {
                if (!ev.origin || !/youtube(-nocookie)?\.com$/i.test(new URL(ev.origin).hostname)) return;
                let data = ev.data;
                if (typeof data === 'string') { try { data = JSON.parse(data); } catch (_) { return; } }
                if (data && data.event === 'onError' && [2, 5, 100, 101, 150].includes(data.info)) {
                    showFallback(`onError ${data.info}`);
                }
            };
            window.addEventListener('message', window._ytTrailerListener);

            iframeWrapper.style.display = 'block';
        }

        // Re-draw badges with the newly active trailer key
        const titleEl = el('streaming-details-title');
        const title = titleEl ? titleEl.textContent : '';
        _populateExternalBadges(title, tmdbId, mediaType, trailerKey);
    } catch (e) {
        // Trailers are optional — fail silently
        console.warn('[streaming] Failed to fetch trailer:', e.message);
        if (iframeWrapper) iframeWrapper.style.display = 'none';
        if (loadingEl) loadingEl.style.display = 'none';
    }
}

/** The URL to play a cached trailer from: the file itself in the desktop app, the server's /trailers route on the
 *  web client (which cannot read the host's disk). */
window.trailerSrc = function (res) {
    if (!res) return null;
    return window.__VW_WEB__ ? res.httpPath : res.fileUrl;
};

window.destroyTrailer = function () {
    // Invalidate any in-flight _fetchAndInjectTrailer so a late resolution can't
    // re-attach an autoplaying trailer after we tear down.
    window._modalTrailerGen = (window._modalTrailerGen || 0) + 1;

    const iframeWrapper = document.getElementById('movie-trailer-wrapper');
    if (!iframeWrapper) return;

    // Completely destroy native <video> elements to ensure background streams are cleaned up
    const videos = iframeWrapper.querySelectorAll('video');
    videos.forEach(v => {
        v.pause();
        v.removeAttribute('src');
        v.load();
        v.remove();
    });

    // Destroy iframe elements 
    const iframes = iframeWrapper.querySelectorAll('iframe');
    iframes.forEach(i => {
        i.src = '';
        i.remove();
    });

    // Hide wrapper
    iframeWrapper.style.display = 'none';
    const loadingEl = document.getElementById('movie-trailer-loading');
    if (loadingEl) loadingEl.style.display = 'none';
    const muteBtn = document.getElementById('btn-trailer-mute');
    if (muteBtn) muteBtn.style.display = 'none';
};
