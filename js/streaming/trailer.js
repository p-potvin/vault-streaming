// js/streaming/trailer.js — trailer resolution (KinoCheck + TMDB fallback) and TMDB token cache
// Part of the streaming feature, split out of the former monolithic js/streaming.js.

async function _fetchAndInjectTrailer(tmdbId, mediaType) {
    const iframeWrapper = el('movie-trailer-wrapper');
    const loadingEl = el('movie-trailer-loading');
    
    if (iframeWrapper) iframeWrapper.style.display = 'block';
    if (loadingEl) loadingEl.style.display = 'flex';
    
    try {
        let trailerKey = null;
        const cacheKey = `${mediaType}_${tmdbId}`;
        window._trailerKeyCache = window._trailerKeyCache || new Map();

        if (window._trailerKeyCache.has(cacheKey)) {
            trailerKey = window._trailerKeyCache.get(cacheKey);
        } else {
            // API Key Priority Tracking
            const statsJson = localStorage.getItem('vault_trailer_api_stats');
            const stats = statsJson ? JSON.parse(statsJson) : { kinocheck: 0, tmdb: 0 };
            
            const providers = [
                {
                    id: 'kinocheck',
                    score: stats.kinocheck,
                    fn: async () => {
                        if (window.electronAPI && window.electronAPI.getKinoCheckTrailer) {
                            console.log(`[streaming] Attempting KinoCheck Premium for TMDB ID: ${tmdbId}`);
                            const kcResult = await window.electronAPI.getKinoCheckTrailer({ tmdbId, mediaType });
                            if (kcResult && kcResult.success && kcResult.key) {
                                console.log(`[streaming] KinoCheck successfully resolved trailer key:`, kcResult.key);
                                return kcResult.key;
                            } else {
                                console.warn(`[streaming] KinoCheck premium lookup skipped or empty:`, kcResult ? kcResult.error : 'No response');
                            }
                        }
                        return null;
                    }
                },
                {
                    id: 'tmdb',
                    score: stats.tmdb,
                    fn: async () => {
                        console.log(`[streaming] Attempting TMDB video lookup for TMDB ID: ${tmdbId}`);
                        const type = mediaType === 'tv' ? 'tv' : 'movie';
                        const url = `https://api.themoviedb.org/3/${type}/${tmdbId}/videos?language=en-US`;
                        const TMDB_BEARER_TOKEN = await _getTMDBToken();
                        if (TMDB_BEARER_TOKEN) {
                            const res = await fetch(url, {
                                headers: { accept: 'application/json', Authorization: `Bearer ${TMDB_BEARER_TOKEN}` }
                            });
                            if (res.ok) {
                                const data = await res.json();
                                const trailer = (data.results || []).find(v => v.type === 'Trailer' && v.site === 'YouTube') || data.results?.[0];
                                if (trailer && trailer.key) {
                                    return trailer.key;
                                }
                            }
                        }
                        return null;
                    }
                }
            ];

            // Sort providers by success score descending
            providers.sort((a, b) => b.score - a.score);

            for (const provider of providers) {
                trailerKey = await provider.fn();
                if (trailerKey) {
                    stats[provider.id]++;
                    localStorage.setItem('vault_trailer_api_stats', JSON.stringify(stats));
                    break;
                }
            }

            if (trailerKey) {
                window._trailerKeyCache.set(cacheKey, trailerKey);
            }
        }

        if (!trailerKey) {
            console.warn('[streaming] No trailer could be resolved from KinoCheck or TMDB fallback.');
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

        // -----------------------------------------------------------------
        // PRIMARY: Extract direct stream URL via yt-dlp (bypasses ALL
        // embedding restrictions, CORS, error 152/150/101).
        // -----------------------------------------------------------------
        window._directTrailerUrlCache = window._directTrailerUrlCache || {};
        let directUrl = window._directTrailerUrlCache[trailerKey];
        
        if (!directUrl && window.electronAPI && window.electronAPI.extractYouTubeURL) {
            try {
                const result = await window.electronAPI.extractYouTubeURL(trailerKey);
                if (result && result.success && result.url) {
                    directUrl = result.url;
                    window._directTrailerUrlCache[trailerKey] = directUrl;
                }
            } catch (e) {
                console.warn('[streaming] yt-dlp extraction failed, falling back to iframe:', e.message);
            }
        }
        
        if (directUrl) {
            console.log('[streaming] yt-dlp resolved direct stream, replacing iframe with native video');
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
            return;
        }

        // -----------------------------------------------------------------
        // FALLBACK: Legacy iframe embed (for when yt-dlp is unavailable or
        // the video has no downloadable formats). Still subject to
        // embedding restrictions.
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
                iframeWrapper.style.display = 'none';
                if (loadingEl) loadingEl.style.display = 'none';
                window.showToast('Trailer blocked from embedding. Use "Watch Trailer on YouTube" to open in your browser.', 'warning');
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

// Cache TMDB token retrieval (read from settings data or env indirectly through search result headers)
let _cachedTMDBToken = null;
async function _getTMDBToken() {
    if (_cachedTMDBToken) return _cachedTMDBToken;
    // We use the TMDB search endpoint to confirm the token is valid; the token itself
    // lives in the backend (.env). For front-end trailer fetches, we must re-use it from window.appSettings.
    const settings = window.appSettings || {};
    if (settings.tmdbBearerToken) {
        _cachedTMDBToken = settings.tmdbBearerToken;
        return _cachedTMDBToken;
    }
    return null; // Trailer fetch will silently skip — movie info still works
}

window.destroyTrailer = function() {
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
};
