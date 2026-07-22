/* ==========================================================================
   Vault Premium Netflix-Style Interactive Hover Preview Cards
   ========================================================================== */

// Shared global state to manage all interactive card state, preventing closure isolation
window.premiumHoverState = {
    activeCard: null,
    hoverTimeout: null,
    closeTimeout: null,
    trailerTimeout: null,
    paused: false
};

// ── Trailer preview lifecycle ────────────────────────────────────────────────
// Every hover preview media element is registered here so we can guarantee it
// stops — the old code appended videos/iframes to a container captured before a
// multi-second async resolution, which could detach mid-flight and leave the
// media PLAYING off-screen with no handle to stop it (the "10 previews at once"
// bug). A monotonically increasing generation token invalidates stale async
// resolutions so they never attach.
window._trailerGen = window._trailerGen || 0;
window._activeTrailerEls = window._activeTrailerEls || [];

window.stopAllTrailerPreviews = function () {
    // Nuke anything we registered…
    (window._activeTrailerEls || []).forEach((elm) => {
        try {
            if (elm.tagName === 'VIDEO') { elm.pause(); elm.removeAttribute('src'); elm.load(); }
            else { elm.src = 'about:blank'; }
            elm.remove();
        } catch (_) { /* already gone */ }
    });
    window._activeTrailerEls = [];
    // …and, defensively, any hover-preview media still in the DOM.
    document.querySelectorAll('#premium-hover-card .trailer-iframe-container video, #premium-hover-card .trailer-iframe-container iframe').forEach((elm) => {
        try {
            if (elm.tagName === 'VIDEO') { elm.pause(); elm.removeAttribute('src'); elm.load(); }
            else { elm.src = 'about:blank'; }
            elm.remove();
        } catch (_) { /* already gone */ }
    });
};

// Longer than the old 300ms so a quick transit (e.g. moving the cursor off the
// popup back into the grid) doesn't fire a preview.
const HOVER_OPEN_DELAY = 450;
// Only the upper part of a card arms the preview. The lower strip (the title /
// description area) is a dead zone, so sliding the cursor down off the popup
// into empty space doesn't re-trigger the hover on the card it passes over.
const HOVER_TRIGGER_ZONE = 1.0; // whole card — hovering anywhere on it arms the preview

window.attachPremiumHoverCard = function(card, movie) {
    const inTriggerZone = (e) => {
        const r = card.getBoundingClientRect();
        return (e.clientY - r.top) <= r.height * HOVER_TRIGGER_ZONE;
    };

    // mouseenter + mousemove both run this: arm the timer while the cursor is in
    // the top zone, cancel it the moment it drifts into the bottom safe zone.
    const arm = (e) => {
        if (window.premiumHoverState.cooldown) return;
        if (window.premiumHoverState.activeCard === card) return; // already open for this card

        if (!inTriggerZone(e)) {
            if (window.premiumHoverState.hoverTimeout) {
                clearTimeout(window.premiumHoverState.hoverTimeout);
                window.premiumHoverState.hoverTimeout = null;
            }
            return;
        }

        if (window.premiumHoverState.closeTimeout) {
            clearTimeout(window.premiumHoverState.closeTimeout);
            window.premiumHoverState.closeTimeout = null;
        }
        if (window.premiumHoverState.hoverTimeout) return; // already armed

        window.premiumHoverState.hoverTimeout = setTimeout(() => {
            window.premiumHoverState.hoverTimeout = null;
            window.showPremiumHoverCard(card, movie);
        }, HOVER_OPEN_DELAY);
    };

    card.addEventListener('mouseenter', arm);
    card.addEventListener('mousemove', arm);

    card.addEventListener('mouseleave', () => {
        if (window.premiumHoverState.hoverTimeout) {
            clearTimeout(window.premiumHoverState.hoverTimeout);
            window.premiumHoverState.hoverTimeout = null;
        }
        if (window.premiumHoverState.closeTimeout) {
            clearTimeout(window.premiumHoverState.closeTimeout);
        }
        window.premiumHoverState.closeTimeout = setTimeout(() => {
            window.hidePremiumHoverCard();
        }, 250);
    });
};

window.showPremiumHoverCard = function(card, movie) {
    let popup = document.getElementById('premium-hover-card');
    if (!popup) {
        popup = document.createElement('div');
        popup.id = 'premium-hover-card';
        popup.className = 'premium-hover-popup vw-console-shell';
        popup.style.cssText = 'display:none; position:fixed; z-index:9999; border-radius:8px; overflow:hidden; border:1.5px solid var(--vault-accent); background: var(--vault-console-bg); pointer-events:auto; box-shadow: 0 10px 30px rgba(0,0,0,0.5);';
        document.body.appendChild(popup);
        
        popup.addEventListener('mouseenter', () => {
            if (window.premiumHoverState.closeTimeout) {
                clearTimeout(window.premiumHoverState.closeTimeout);
                window.premiumHoverState.closeTimeout = null;
            }
        });
        
        popup.addEventListener('mouseleave', () => {
            if (window.premiumHoverState.closeTimeout) {
                clearTimeout(window.premiumHoverState.closeTimeout);
            }
            window.premiumHoverState.closeTimeout = setTimeout(() => {
                window.hidePremiumHoverCard();
            }, 250);
        });
    }
    
    // Restore visibility of any previous card before overwriting the active card reference
    if (window.premiumHoverState.activeCard && window.premiumHoverState.activeCard !== card) {
        window.premiumHoverState.activeCard.style.visibility = 'visible';
    }
    window.premiumHoverState.activeCard = card;
    
    popup.style.cursor = 'pointer';
    popup.onclick = (e) => {
        if (e.target.closest('.actions-row')) return;
        e.preventDefault();
        e.stopPropagation();
        
        // Save current trailer playback time if playing
        const vid = popup.querySelector('video');
        let currentTime = 0;
        if (vid) {
            currentTime = vid.currentTime;
        }
        
        window.showMediaDetails(movie, currentTime);
        window.hidePremiumHoverCard();
    };
    
    if (window.premiumHoverState.closeTimeout) {
        clearTimeout(window.premiumHoverState.closeTimeout);
        window.premiumHoverState.closeTimeout = null;
    }
    
    if (window.premiumHoverState.trailerTimeout) {
        clearTimeout(window.premiumHoverState.trailerTimeout);
        window.premiumHoverState.trailerTimeout = null;
    }
    
    const t = window.translations[window.currentLang === 'fr' ? 'fr' : 'en'] || {};
    const isTV = movie.media_type === 'tv';
    const title = movie.title || movie.name || 'Unknown Title';
    const rating = movie.rating || movie.vote_average || '0.0';
    const overview = movie.overview || t.noDesc || 'No description available.';
    const year = movie.year || (movie.release_date ? movie.release_date.substring(0,4) : (movie.first_air_date ? movie.first_air_date.substring(0,4) : ''));
    const genres = movie.genres || '';
    
    const isSaved = (window.appSettings.library || []).some(item => item.id === movie.id && item.media_type === movie.media_type);
    const libraryIcon = isSaved ? 
        (window.icons ? window.icons.checkmark('', 'width:14px; height:14px; stroke:var(--vault-gold);') : '') : 
        (window.icons ? window.icons.plus('', 'width:14px; height:14px;') : '');
        
    popup.innerHTML = `
      <div class="media-container" style="position:relative; width:100%; height:180px; background:#111; overflow:hidden;">
        <img class="poster" src="${movie.poster}" alt="${window.escapeHtml(title)}" style="width:100%; height:100%; object-fit:cover; transition:opacity 0.3s;" />
        <div class="premium-trailer-loading-spinner" style="display:none; position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); z-index:10; pointer-events:none; background:rgba(0,0,0,0.5); border-radius:50%; padding:8px;">
            <svg class="spinner-inline" viewBox="0 0 24 24" fill="none" stroke="var(--vault-accent, #B07CFF)" stroke-width="3" style="width:20px; height:20px; animation: spin 1s linear infinite;"><circle cx="12" cy="12" r="10" stroke-dasharray="35 35"></circle></svg>
        </div>
        <div class="trailer-iframe-container" style="position:absolute; top:0; left:0; width:100%; height:100%; opacity:0; transition:opacity 0.5s; pointer-events:none;"></div>
        <button class="btn-hover-playpause" title="Play / pause preview" style="position:absolute; bottom:8px; right:8px; z-index:12; width:30px; height:30px; border-radius:50%; border:none; background:rgba(0,0,0,0.6); color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; padding:0; backdrop-filter:blur(4px); transition:background 0.15s;">
          <svg class="pp-icon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
        </button>
      </div>
      <div class="details-container" style="padding:14px; background:linear-gradient(180deg, rgba(20,18,30,0.95), rgba(11,8,19,0.99)); color:#fff; text-align:left; border-top:1px solid rgba(255,255,255,0.06); font-family: var(--font-sans);">
        <div class="title-row" style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <span class="title" style="font-weight:700; font-size:14px; color:#fff; font-family:var(--font-mono); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;">${window.escapeHtml(title)}</span>
          <span class="rating-badge" style="background:var(--vault-accent); color:var(--vt-primary); font-weight:800; font-size:9.5px; padding:1.5px 5px; border-radius:4px; font-family:var(--font-mono); white-space:nowrap;">${window.icons.star('', 'width:9px;height:9px;vertical-align:middle;', 'currentColor', 'currentColor')} ${rating}</span>
        </div>
        <div class="meta-row" style="font-size:10px; color:var(--vault-slate); margin-top:2px; font-weight:600; text-transform:uppercase;">${year} • ${window.escapeHtml(genres)}</div>
        <p class="overview" style="font-size:11px; color:#bbb; margin-top:6px; line-height:1.4; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; font-family:var(--font-body); height:46px; margin-bottom:0;">${window.escapeHtml(overview)}</p>
        
        <div class="actions-row" style="display:flex; gap:6px; margin-top:10px; align-items:center;">
          <button class="btn-hover-play" style="flex:1; background:var(--vault-accent); color:var(--vt-primary); border:none; padding:6px 10px; border-radius:4px; font-size:10.5px; font-weight:800; text-transform:uppercase; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:4px; transition:all 0.2s;">
            ${window.icons ? window.icons.play('', 'width:10px; height:10px; fill:currentColor;') : ''}
            <span class="btn-text-play">${t.streamUpper || 'STREAM'}</span>
          </button>
          <button class="btn-hover-library" style="background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.12); color:#fff; width:28px; height:28px; border-radius:4px; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all 0.2s; padding:0;" title="${isSaved ? (t.removeFromLibrary || 'Remove from Library') : (t.addToLibrary || 'Add to Library')}">
            ${libraryIcon}
          </button>
          <button class="btn-hover-details" style="background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.12); color:#fff; width:28px; height:28px; border-radius:4px; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all 0.2s; padding:0;" title="${t.moreDetails || 'More Details'}">
            ${window.icons ? window.icons.info('', 'width:12px; height:12px;') : ''}
          </button>
        </div>
      </div>
    `;
    
    const btnPlay = popup.querySelector('.btn-hover-play');
    btnPlay.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        window.showMediaDetails(movie);
        window.hidePremiumHoverCard();
        setTimeout(() => {
            if (movie.media_type === 'movie') {
                const btnStream = document.getElementById('btn-stream-movie');
                if (btnStream) btnStream.click();
            } else {
                const epConfirmBtn = document.getElementById('btn-confirm-stream') || document.querySelector('.btn-modal-follow');
                if (epConfirmBtn) epConfirmBtn.click();
            }
        }, 300);
    });
    
    const btnLib = popup.querySelector('.btn-hover-library');
    btnLib.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        window.appSettings.library = window.appSettings.library || [];
        const idx = window.appSettings.library.findIndex(item => item.id === movie.id && item.media_type === movie.media_type);
        const t = window.translations[window.currentLang === 'fr' ? 'fr' : 'en'] || {};
        if (idx !== -1) {
            window.appSettings.library.splice(idx, 1);
            window.showToast(t.removedFromLibrary || 'Removed from Library', 'info');
        } else {
            window.appSettings.library.push(movie);
            window.showToast(t.addedToLibrary || 'Added to Library', 'success');
        }
        await window.electronAPI.saveSettings(window.appSettings);
        
        if (window.currentTab === 'favorites' && typeof window.renderFavorites === 'function') {
            window.renderFavorites();
        } else if (window.currentTab === 'library' && typeof window.renderLibrary === 'function') {
            window.renderLibrary();
        }
        
        const matchedCards = document.querySelectorAll('.tmdb-movie-card');
        matchedCards.forEach(c => {
            const isMatch = c.getAttribute('data-id') === String(movie.id);
            if (isMatch) {
                const isSavedNow = window.appSettings.library.some(item => item.id === movie.id && item.media_type === movie.media_type);
                if (isSavedNow) {
                    c.className = 'file-card tmdb-movie-card in-library';
                    c.style.cssText = 'cursor: pointer; background: var(--vault-warm-card); border: 1.5px solid var(--vault-console-gold); border-radius: 6px; box-shadow: 0 0 12px rgba(214, 164, 65, 0.35); position: relative;';
                } else {
                    c.className = 'file-card tmdb-movie-card';
                    c.style.cssText = 'cursor: pointer; background: var(--vault-warm-card); border: 1px solid var(--vault-border); border-radius: 6px; position: relative;';
                }
            }
        });
        
        const isSavedNow = window.appSettings.library.some(item => item.id === movie.id && item.media_type === movie.media_type);
        btnLib.innerHTML = isSavedNow ? 
            (window.icons ? window.icons.checkmark('', 'width:14px; height:14px; stroke:var(--vault-gold);') : '') : 
            (window.icons ? window.icons.plus('', 'width:14px; height:14px;') : '');
        btnLib.title = isSavedNow ? (t.removeFromLibrary || 'Remove from Library') : (t.addToLibrary || 'Add to Library');
    });
    
    const btnDet = popup.querySelector('.btn-hover-details');
    btnDet.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        
        // Save current trailer playback time if playing
        const vid = popup.querySelector('video');
        let currentTime = 0;
        if (vid) {
            currentTime = vid.currentTime;
        }
        
        window.hidePremiumHoverCard();
        window.showMediaDetails(movie, currentTime);
    });
    
    const rect = card.getBoundingClientRect();
    popup.style.display = 'block';
    
    popup.style.top = rect.top + 'px';
    popup.style.left = rect.left + 'px';
    popup.style.width = rect.width + 'px';
    popup.style.height = rect.height + 'px';
    
    const expWidth = 320;
    const expHeight = 350;

    // Anchor the popup's BOTTOM to the card's bottom (grows upward). The old
    // anchor (rect.top - 60) let the popup extend past the card's bottom edge,
    // which created a dead-zone where the cursor sat over the *next* card's
    // area while the popup was still rendered — causing rapid hover toggling.
    const targetLeft = Math.max(10, Math.min(window.innerWidth - expWidth - 10, rect.left - (expWidth - rect.width) / 2));
    const targetTop  = Math.max(10, Math.min(window.innerHeight - expHeight - 10, rect.bottom - expHeight));
    
    requestAnimationFrame(() => {
        popup.style.left = targetLeft + 'px';
        popup.style.top = targetTop + 'px';
        popup.style.width = expWidth + 'px';
        popup.style.height = expHeight + 'px';
        popup.classList.add('active');
        card.style.visibility = 'hidden';
    });
    
    window._trailerKeyCache = window._trailerKeyCache || new Map();

    // Wire the play/pause toggle. It stops/starts the preview for THIS card and,
    // because stopAllTrailerPreviews() is authoritative, guarantees the user can
    // silence a runaway preview.
    const btnPP = popup.querySelector('.btn-hover-playpause');
    const setPPIcon = (playing) => {
        const ic = btnPP && btnPP.querySelector('.pp-icon');
        if (!ic) return;
        ic.innerHTML = playing
            ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'   // pause
            : '<path d="M8 5v14l11-7z"/>';                                                              // play
    };
    setPPIcon(!window.premiumHoverState.paused);
    if (btnPP) {
        btnPP.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            window.premiumHoverState.paused = !window.premiumHoverState.paused;
            if (window.premiumHoverState.paused) {
                window.stopAllTrailerPreviews();
                const c = popup.querySelector('.trailer-iframe-container');
                if (c) c.style.opacity = '0';
                setPPIcon(false);
            } else {
                setPPIcon(true);
                loadHoverTrailer(popup, movie, title, year);
            }
        });
    }

    // Kick off the (generation-guarded) preview after a short dwell.
    window.premiumHoverState.trailerTimeout = setTimeout(() => {
        if (!window.premiumHoverState.paused) loadHoverTrailer(popup, movie, title, year);
    }, 350);
};

// Loads the hover trailer preview. Guarded against stale async resolutions:
// each call bumps the generation token; if the token changes (another card was
// hovered) or the popup detaches during a lookup, the resolved media is NOT
// attached — killing the orphaned-background-audio bug. Uses the fast YouTube
// yt-dlp direct stream as the PRIMARY source (bypasses embed error 152/4),
// falling back to the youtube-nocookie iframe only if extraction fails.
async function loadHoverTrailer(popup, movie, title, year) {
    const gen = ++window._trailerGen;
    window.stopAllTrailerPreviews();

    const iframeContainer = popup.querySelector('.trailer-iframe-container');
    if (!iframeContainer) return;
    const spinner = popup.querySelector('.premium-trailer-loading-spinner');
    if (spinner) spinner.style.display = 'block';

    // Resolve a trailer key (cached across hovers).
    window._trailerKeyCache = window._trailerKeyCache || new Map();
    let trailerKey = '';
    const cacheKey = `${movie.media_type}_${movie.id}`;
    if (window._trailerKeyCache.has(cacheKey)) {
        trailerKey = window._trailerKeyCache.get(cacheKey);
    } else if (movie.id) {
        try {
            if (window.electronAPI && window.electronAPI.getKinoCheckTrailer) {
                const kc = await window.electronAPI.getKinoCheckTrailer({ tmdbId: movie.id, mediaType: movie.media_type });
                if (kc && kc.success && kc.key) trailerKey = kc.key;
            }
            if (!trailerKey && window.electronAPI) {
                const res = movie.media_type === 'tv'
                    ? await window.electronAPI.getTMDBTV({ id: movie.id, language: window.currentLang === 'fr' ? 'fr-FR' : 'en-US' })
                    : await window.electronAPI.getTMDBMovie({ id: movie.id, language: window.currentLang === 'fr' ? 'fr-FR' : 'en-US' });
                if (res && res.success && res.data) {
                    const videos = res.data.videos ? res.data.videos.results : [];
                    const trailer = (Array.isArray(videos) ? videos : []).find(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser' || v.type === 'Clip'));
                    if (trailer) trailerKey = trailer.key;
                }
            }
            if (trailerKey) window._trailerKeyCache.set(cacheKey, trailerKey);
        } catch (e) {
            console.error('[HoverCard] Failed to fetch trailer key:', e);
        }
    }

    // A newer hover superseded us, the user paused, or the popup detached —
    // abort WITHOUT attaching so no off-screen media can play.
    if (gen !== window._trailerGen || window.premiumHoverState.paused || !document.contains(iframeContainer)) {
        if (spinner) spinner.style.display = 'none';
        return;
    }

    // A hover is still valid only if nothing superseded it. Re-checked after each
    // await so a stale resolution can never attach off-screen media.
    const stillValid = () => gen === window._trailerGen && !window.premiumHoverState.paused && document.contains(iframeContainer);

    // ── PRIMARY: yt-dlp direct stream ──
    // The youtube-nocookie iframe frequently returns embed error 152/4 (owner
    // disallows off-site playback). yt-dlp resolves the real media URL, which the
    // main-process header rewrite (Referer/Origin -> youtube.com) lets us play in
    // a native <video> with NO embed restrictions. This is what actually makes
    // trailers reliable; the iframe is only a last resort.
    window._directTrailerUrlCache = window._directTrailerUrlCache || {};
    let directUrl = trailerKey ? window._directTrailerUrlCache[trailerKey] : '';
    if (!directUrl && trailerKey && window.electronAPI && window.electronAPI.extractYouTubeURL) {
        try {
            const result = await window.electronAPI.extractYouTubeURL(trailerKey);
            if (result && result.success && result.url) {
                directUrl = result.url;
                window._directTrailerUrlCache[trailerKey] = directUrl;
            }
        } catch (e) {
            console.warn('[HoverCard] yt-dlp extraction failed, will fall back to iframe:', e.message);
        }
    }

    if (!stillValid()) { if (spinner) spinner.style.display = 'none'; return; }

    if (directUrl) {
        window.stopAllTrailerPreviews(); // clear any straggler before attaching
        const vid = document.createElement('video');
        vid.style.cssText = 'width:100%; height:100%; border:none; background:#000; display:block; transform:scale(1.02); pointer-events:none;';
        vid.src = directUrl;
        // Trailers play at 80% (−20%) by default; muted entirely if the user opted in.
        const _muteTrailers = !!(window.appSettings && window.appSettings.muteTrailers);
        vid.muted = _muteTrailers;
        vid.volume = 0.8;
        vid.autoplay = true;
        vid.loop = true;
        vid.playsInline = true;
        vid.preload = 'auto';
        const hideSpinner = () => { if (spinner) spinner.style.display = 'none'; };
        vid.addEventListener('playing', hideSpinner);
        vid.addEventListener('canplay', hideSpinner);
        vid.addEventListener('loadeddata', hideSpinner);
        iframeContainer.appendChild(vid);
        window._activeTrailerEls.push(vid);
        iframeContainer.style.opacity = '1';
        return;
    }

    // ── FALLBACK: iframe embed (only when yt-dlp is unavailable/failed) ──
    const embedUrl = trailerKey
        ? `https://www.youtube-nocookie.com/embed/${trailerKey}?autoplay=1&mute=${(window.appSettings&&window.appSettings.muteTrailers)?1:0}&controls=0&modestbranding=1&rel=0&showinfo=0&iv_load_policy=3&disablekb=1`
        : `https://www.youtube-nocookie.com/embed?listType=search&list=${encodeURIComponent(title + ' ' + (year || '') + ' official trailer')}&autoplay=1&mute=${(window.appSettings&&window.appSettings.muteTrailers)?1:0}&controls=0&modestbranding=1&rel=0`;

    window.stopAllTrailerPreviews(); // clear any straggler before attaching
    const iframe = document.createElement('iframe');
    iframe.src = embedUrl;
    iframe.style.cssText = 'width:100%; height:100%; border:none; transform: scale(1.02); pointer-events:none;';
    iframe.allow = 'autoplay; encrypted-media';
    iframe.onload = () => { if (spinner) spinner.style.display = 'none'; };
    iframeContainer.appendChild(iframe);
    window._activeTrailerEls.push(iframe);
    iframeContainer.style.opacity = '1';
}

window.hidePremiumHoverCard = function() {
    // Invalidate any in-flight trailer resolution and stop ALL preview media —
    // the authoritative teardown, so nothing can keep playing off-screen.
    window._trailerGen++;
    window.stopAllTrailerPreviews();
    const popup = document.getElementById('premium-hover-card');
    if (popup) {
        if (window.premiumHoverState.trailerTimeout) {
            clearTimeout(window.premiumHoverState.trailerTimeout);
            window.premiumHoverState.trailerTimeout = null;
        }
        popup.classList.remove('active');
        const iframeContainer = popup.querySelector('.trailer-iframe-container');
        if (iframeContainer) {
            iframeContainer.innerHTML = '';
            iframeContainer.style.opacity = '0';
        }
        popup.style.display = 'none';
        
        if (window.premiumHoverState.activeCard) {
            window.premiumHoverState.activeCard.style.visibility = 'visible';
            window.premiumHoverState.activeCard = null;
        }

        // Add 200ms cooldown to ignore instant enter events on backdrop cards
        window.premiumHoverState.cooldown = true;
        if (window.premiumHoverState.cooldownTimeout) {
            clearTimeout(window.premiumHoverState.cooldownTimeout);
        }
        window.premiumHoverState.cooldownTimeout = setTimeout(() => {
            window.premiumHoverState.cooldown = false;
        }, 200);
    }
};
