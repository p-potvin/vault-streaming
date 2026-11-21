// player.js — Custom HTML5 video player core initialization, PiP/countdown widgets, seek/trickplay canvas scrubbers, and history persistence.

window.currentPlayingIndex = -1;
window.currentPlayingItem = null;
window.autoplayTimer = null;
window.autoplayCountdown = 5;
// Autoplay is a plain on/off toggle. "On" uses the 5s countdown; older stored
// values (instant/3s) collapse to on.
window.autoplayMode = (localStorage.getItem('autoplayMode') === 'off') ? 'off' : '5s';
window.autoplayEnabled = (window.autoplayMode !== 'off');

const PLAY_ICON_SVG = window.icons ? window.icons.play('', 'width:16px; height:16px; display:block;') : '';
const PAUSE_ICON_SVG = window.icons ? window.icons.pause('', 'width:16px; height:16px; display:block;') : '';

async function handlePlayerContextMenu(action, menuItem) {
    if (!action || action === 'closed' || action === 'show' || action === 'copied') return;

    const vp = el('video-player');
    const item = window.currentPlayingItem || window.activeStreamingMedia || {};
    const itemPath = item.path || menuItem.path;

    if (action === 'play-pause') {
        if (!vp) return;
        if (vp.paused) vp.play().catch(() => { });
        else vp.pause();
    } else if (action === 'mute') {
        if (!vp) return;
        vp.muted = !vp.muted;
    } else if (action.startsWith('speed:')) {
        const speed = parseFloat(action.split(':')[1]);
        if (vp && !isNaN(speed)) vp.playbackRate = speed;
    } else if (action === 'reload-stream') {
        window.reloadStream();
    } else if (action === 'pip') {
        el('video-modal').classList.toggle('minimized');
    } else if (action === 'fullscreen') {
        if (!vp) return;
        if (!document.fullscreenElement) vp.parentElement.requestFullscreen();
        else document.exitFullscreen();
    } else if (action === 'generate-webm') {
        if (!itemPath) { window.showToast(tr('toastNoVideoPath', 'No video path available'), 'error'); return; }
        window.electronAPI.generateWebm(itemPath, window.currentRealPath).then(async res => {
            if (!res.success) {
                window.showToast(tr('toastPreviewFailed', 'Preview failed: ') + res.error, 'error');
            } else {
                if (typeof window.updateSingleVideoCard === 'function') {
                    await window.updateSingleVideoCard(itemPath);
                } else if (window.electronAPI && typeof window.electronAPI.scanSpecificFiles === 'function') {
                    const newItems = await window.electronAPI.scanSpecificFiles([itemPath]);
                    const normPath = (p) => (p || '').replace(/\\/g, '/').toLowerCase();
                    if (newItems && newItems.length > 0) {
                        const idx = window.displayedItems.findIndex(i => normPath(i.path) === normPath(itemPath));
                        if (idx !== -1) window.displayedItems[idx] = newItems[0];
                    }
                }
                window.showToast(tr('toastPreviewGenerated', 'Preview generated'), 'success');
            }
        });
    } else if (action === 'normalize-audio') {
        if (!itemPath) { window.showToast(tr('toastNoVideoPath', 'No video path available'), 'error'); return; }
        window.showToast(tr('toastEnhancingAudio', 'Enhancing audio in background...'), 'success');
        const runner = window.electronAPI.enhanceAudio || window.electronAPI.normalizeAudio;
        runner({ videoPath: itemPath, vaultRoot: window.currentRealPath, volumeBoost: 1.5 }).then(res => {
            if (res.success || res.status === 'SUCCESS' || res.status === 'EXISTS') {
                window.showToast(`${menuItem.name || 'Video'}: Audio enhanced`, 'success');
                if (typeof refreshDirectoryWithScrollPreservation === 'function') refreshDirectoryWithScrollPreservation();
            } else {
                window.showToast(`${menuItem.name || 'Video'}: Audio enhancement failed: ` + (res.error || 'Unknown'), 'error');
            }
        });
    } else if (action === 'generate-subtitles-prompt') {
        if (!itemPath) { window.showToast(tr('toastNoVideoPath', 'No video path available'), 'error'); return; }
        const defaultLangs = (window.appSettings && window.appSettings.preferredASRLangs) || ['en'];
        const langs = await window.showLanguageModal('Generate Subtitles', true, defaultLangs);
        if (langs && langs.length > 0) {
            if (!window.appSettings) window.appSettings = {};
            window.appSettings.preferredASRLangs = langs;
            window.electronAPI.saveSettings(window.appSettings);
            window.showToast(`Generating subtitles for ${menuItem.name || 'video'}: ${langs.join(', ').toUpperCase()}`, 'success');
            const runner = window.electronAPI.generateSubtitles || window.electronAPI.normalizeAudio;
            runner({ videoPath: itemPath, vaultRoot: window.currentRealPath, language: langs[0] }).then(async res => {
                if (res.success || res.status === 'SUCCESS' || res.status === 'EXISTS') {
                    window.showToast(`${menuItem.name || 'Video'}: Subtitles generated`, 'success');
                    if (typeof loadActiveSubtitles === 'function') {
                        await loadActiveSubtitles(itemPath);
                    }
                    if (typeof refreshDirectoryWithScrollPreservation === 'function') refreshDirectoryWithScrollPreservation();
                } else {
                    window.showToast(`${menuItem.name || 'Video'}: Subtitles failed: ` + (res.error || 'Unknown'), 'error');
                }
            });
        }
    } else if (action === 'translate-video-prompt') {
        if (!itemPath) { window.showToast(tr('toastNoVideoPath', 'No video path available'), 'error'); return; }
        const defaultTransLangs = (window.appSettings && window.appSettings.preferredTransLang) ? [window.appSettings.preferredTransLang] : [];
        const lang = await window.showLanguageModal('Translate Video Track', false, defaultTransLangs);
        if (lang && lang.length > 0) {
            if (!window.appSettings) window.appSettings = {};
            window.appSettings.preferredTransLang = lang[0];
            window.electronAPI.saveSettings(window.appSettings);
            window.showToast(`Synthesizing translation to ${lang[0].toUpperCase()} for ${menuItem.name || 'video'}...`, 'success');
            const runner = window.electronAPI.translateVideo || window.electronAPI.normalizeAudio;
            runner({ videoPath: itemPath, vaultRoot: window.currentRealPath, translateTo: lang[0] }).then(async res => {
                if (res.success || res.status === 'SUCCESS' || res.status === 'EXISTS') {
                    window.showToast(`${menuItem.name || 'Video'}: Translation complete`, 'success');
                    if (typeof loadActiveSubtitles === 'function') {
                        await loadActiveSubtitles(itemPath);
                    }
                    if (typeof refreshDirectoryWithScrollPreservation === 'function') refreshDirectoryWithScrollPreservation();
                } else {
                    window.showToast(`${menuItem.name || 'Video'}: Translation failed: ` + (res.error || 'Unknown'), 'error');
                }
            });
        }
    } else if (action === 'enhance-video-prompt') {
        if (!itemPath) { window.showToast(tr('toastNoVideoPath', 'No video path available'), 'error'); return; }
        const dialogItem = window.currentPlayingItem || { path: itemPath, name: menuItem.name, type: 'video' };
        const config = await window.showVideoEnhancementDialog(dialogItem);
        if (config && config.execute) {
            window.showToast(`AI Video Optimization started for ${menuItem.name || 'video'}...`, 'success');
            const vsrQuality = config.quality || (window.appSettings && window.appSettings.vsrQuality) || 'HIGH';
            const vsrScale = config.scale || (window.appSettings && window.appSettings.vsrScale) || '2';
            const vsrChroma = (window.appSettings && window.appSettings.vsrChroma) || 'yuv420p';
            const runner = window.electronAPI.enhanceVideo || window.electronAPI.upscaleVideo;
            runner({ videoPath: itemPath, path: itemPath, quality: vsrQuality, scale: vsrScale, chroma: vsrChroma }).then(res => {
                if (res.success) {
                    window.showToast(`${menuItem.name || 'Video'}: Enhancement finished`, 'success');
                    if (typeof refreshDirectoryWithScrollPreservation === 'function') refreshDirectoryWithScrollPreservation();
                } else {
                    window.showToast(`${menuItem.name || 'Video'}: Enhancement failed: ` + (res.error || 'Unknown'), 'error');
                }
            });
        }
    } else if (action === 'revert-enhancements' || (typeof action === 'string' && action.startsWith('revert-enhancement:'))) {
        if (!itemPath) { window.showToast(tr('toastNoVideoPath', 'No video path available'), 'error'); return; }
        const target = action.startsWith('revert-enhancement:') ? action.split(':')[1] : null;
        const label = target ? `${target.charAt(0).toUpperCase() + target.slice(1)} Enhancement` : 'All Enhancements';
        const confirmed = typeof window.showGenericConfirmModal === 'function'
            ? await window.showGenericConfirmModal(
                `Revert ${label}`,
                `Are you sure you want to revert ${label.toLowerCase()} for "${menuItem.name || 'this video'}"?`,
                'Revert',
                'btn-danger'
            )
            : confirm(`Are you sure you want to revert ${label.toLowerCase()} for "${menuItem.name || 'this video'}"?`);
        if (!confirmed) return;
        window.showToast(`Reverting ${label.toLowerCase()}...`, 'info');
        const res = target
            ? await (window.electronAPI.revertEnhancementTarget ? window.electronAPI.revertEnhancementTarget({ videoPath: itemPath, target }) : window.electronAPI.revertEnhancements(itemPath))
            : await window.electronAPI.revertEnhancements(itemPath);
        if (res && res.success) {
            window.showToast(`${label} reverted successfully`, 'success');
            if (typeof loadActiveSubtitles === 'function') {
                await loadActiveSubtitles(itemPath);
            }
            if (typeof refreshDirectoryWithScrollPreservation === 'function') refreshDirectoryWithScrollPreservation();
        } else {
            window.showToast(`Failed to revert: ${res && res.error ? res.error : 'Unknown error'}`, 'error');
        }
    } else if (action === 'properties') {
        if (!itemPath) { window.showToast(tr('toastNoVideoPath', 'No video path available'), 'error'); return; }
        window.showPropertiesDialog({ path: itemPath, name: menuItem.name, type: 'video' });
    }
}

// ── Stream reload ───────────────────────────────────────────────────────────
// A stream that played for a while can stop mid-episode: the player follows Comet's link to a debrid download link
// and keeps reading that one, which can expire or drop (a MediaError, often "decoding failed"). Reloading asks Comet
// again (a fresh download link) and continues at the same spot. Context menu → Reload Stream, F5, and automatically
// on such an error (AUTO_RELOADS times, the count reset once playback has run a minute past the reload).
const AUTO_RELOADS = 3;
window._streamLastGood = 0;        // the last position that actually played (the error resets currentTime)
window._streamAutoReloads = { count: 0, at: 0 };

/** Reload the playing stream at its current position. `auto` = after a playback error. False when nothing to reload. */
window.reloadStream = function ({ auto = false } = {}) {
    const media = window.activeStreamingMedia;
    const url = media && media.streamUrl;
    if (!vp || !url || !/^https?:\/\//i.test(String(url)) || window.currentPlayingItem) return false;
    const now = Number.isFinite(vp.currentTime) ? vp.currentTime : 0;
    const at = now > 1 ? now : (window._streamLastGood || 0);
    const resume = auto || !vp.paused;
    console.log(`[streaming] reloading the stream at ${Math.round(at)} s${auto ? ' (after a playback error)' : ''}`);
    window.showToast(window.currentLang === 'fr' ? 'Rechargement du flux…' : 'Reloading the stream…', 'info');

    if (window.isTranscodeActive && window.isTranscodeActive() && window.transcodeRestart
        && window.transcodeRestart(at, { paused: !resume })) return true;

    // a new address so the browser does not reuse the old (expired) redirect target; media.streamUrl stays the same
    const fresh = new URL(`${url}${url.includes('?') ? '&' : '?'}reload=${Date.now()}`).href;   // as vp.src reports it
    // one pending reload at a time, and only for its own load: a reload that failed before its metadata must not
    // seek whatever plays next
    if (_reloadOnMeta) vp.removeEventListener('loadedmetadata', _reloadOnMeta);
    _reloadOnMeta = () => {
        if (vp.src !== fresh || window.activeStreamingMedia !== media) return;
        vp.removeEventListener('loadedmetadata', _reloadOnMeta);
        _reloadOnMeta = null;
        // Comet can answer the new request with a provider status clip: search another source, as on first play
        if (isFinite(vp.duration) && vp.duration < 60) { statusVideoFound(media); return; }
        try { if (at > 1 && (!isFinite(vp.duration) || at < vp.duration - 1)) vp.currentTime = at; } catch (_) { /* not seekable */ }
        if (resume) vp.play().catch(() => {});
    };
    vp.addEventListener('loadedmetadata', _reloadOnMeta);
    vp.src = fresh;
    return true;
};
let _reloadOnMeta = null;

/** A Comet / debrid status video ("Requested stream was not found", a copyright block…) played instead of the title:
 *  forget it as the title's last source (in memory and on disk, position kept) and search another one. */
function statusVideoFound(media) {
    console.warn(`[streaming] the source played a ${vp.duration.toFixed(1)} s clip (a provider status video) — searching again`);
    media.lastSource = null;
    // forget it on disk too (position kept), or the next play would reopen the same error video
    if (window.electronAPI && window.electronAPI.getWatchProgress && window.electronAPI.setWatchProgress) {
        const key = { mediaType: media.mediaType, tmdbId: media.tmdbId, title: media.title, season: media.season, episode: media.episode };
        window.electronAPI.getWatchProgress(key).then((prog) => {
            if (!prog || !prog.lastSource || (media.mediaType === 'tv' && (prog.season !== media.season || prog.episode !== media.episode))) return;
            return window.electronAPI.setWatchProgress({ ...prog, lastSource: null });
        }).catch(() => {});
    }
    vp.pause();
    window.showToast(window.currentLang === 'fr'
        ? 'Cette source a renvoyé une vidéo d\'erreur du fournisseur. Recherche d\'une autre source…'
        : 'That source returned a provider error video. Finding another source…', 'info');
    if (typeof window.findOtherSources === 'function') window.findOtherSources();
}

let vp = null;
let seekArea = null;
let seekFill = null;
let seekPreview = null;
let btnPlay = null;
let btnPrev = null;
let btnNext = null;
let volSlider = null;
let trickFrames = [];
let navHoverPreview = null;

// Hidden scrubber video + canvas for seek preview
let scrubVideo = null;
let seekCanvas = null;
let seekCtx = null;
let seekDebounceTimer = null;
let lastScrubSrc = '';

function updateAutoplayUI() {
    const btn = el('btn-autoplay');
    const knob = el('autoplay-knob-circle');
    if (!btn || !knob) return;

    // Only episodic content has a "next" worth rolling into — hide the toggle
    // entirely for movies.
    const isSeries = !!(window.activeStreamingMedia && window.activeStreamingMedia.mediaType === 'tv');
    btn.style.display = isSeries ? '' : 'none';

    if (window.autoplayMode === 'off') {
        btn.classList.remove('active');
        knob.setAttribute('cx', '8');            // knob left = off
        btn.setAttribute('title', 'Autoplay: Off');
        btn.style.color = '';
    } else {
        btn.classList.add('active');
        knob.setAttribute('cx', '20');           // knob right = on
        btn.setAttribute('title', 'Autoplay: On');
        btn.style.color = 'var(--vault-accent)';
    }
}

function updateVolumeIconUI(vol) {
    const btnVol = el('btn-volume-icon');
    if (!btnVol || !window.icons) return;
    const style = 'width:16px; height:16px; display:block;';
    btnVol.innerHTML = vol === 0 ? window.icons.volumeMute('', style)
        : vol < 0.5 ? window.icons.volumeLow('', style) : window.icons.volume('', style);
}

async function playItem(idx) {
    if (window.autoplayTimer) {
        clearInterval(window.autoplayTimer);
        window.autoplayTimer = null;
    }
    const endedOverlay = el('video-ended-overlay');
    if (endedOverlay) endedOverlay.style.display = 'none';

    const prevBtn = el('btn-prev');
    const nextBtn = el('btn-next');
    if (prevBtn) prevBtn.style.display = 'block';
    if (nextBtn) nextBtn.style.display = 'block';
    const pipPrevBtn = el('pip-btn-prev');
    const pipNextBtn = el('pip-btn-next');
    if (pipPrevBtn) pipPrevBtn.style.display = 'flex';
    if (pipNextBtn) pipNextBtn.style.display = 'flex';

    if (idx < 0 || idx >= window.displayedItems.length) return;
    const itm = window.displayedItems[idx];
    if (itm.type !== 'video') return;

    // Local file playback — hide the (RD-stream-only) quality picker.
    const qCont = el('quality-dropdown-container');
    if (qCont) qCont.style.display = 'none';

    // The previous file's subtitles must not carry over to the new video.
    if (typeof window.resetSubtitles === 'function') window.resetSubtitles();

    window.currentPlayingIndex = idx;
    window.currentPlayingItem = itm;
    trickFrames = [];
    vp.dataset.trickplay = itm.trickplayFolder || '';
    const activePath = itm.enhancedPath || itm.path;
    const newSrc = window.sanitizePath(activePath);
    vp.src = newSrc;
    vp.muted = false;
    if (lastScrubSrc !== newSrc) {
        scrubVideo.src = newSrc;
        lastScrubSrc = newSrc;
    }

    const baseTitle = itm.name.replace(/\.[^.]+$/, '');
    const titleEl = el('player-title');
    if (titleEl) {
        if (itm.enhancedPath) {
            const magicIcon = window.icons ? window.icons.magic('magic-inline-icon', 'width:12px; height:12px; display:inline-block; vertical-align:middle; margin-left:6px; color:var(--vault-gold);') : '';
            titleEl.innerHTML = `${baseTitle} ${magicIcon}`;
        } else {
            titleEl.textContent = baseTitle;
        }
    }
    const tbTitle = el('titlebar-video-title');
    if (tbTitle) {
        if (itm.enhancedPath) {
            const magicIcon = window.icons ? window.icons.magic('magic-inline-icon', 'width:10px; height:10px; display:inline-block; vertical-align:middle; margin-left:4px; color:var(--vault-gold);') : '';
            tbTitle.innerHTML = `Playing: ${itm.name} ${magicIcon} <span style="font-size:9.5px; opacity:0.8;">[Enhanced]</span>`;
        } else {
            tbTitle.textContent = `Playing: ${itm.name}`;
        }
        tbTitle.style.display = 'inline-block';
    }

    try {
        await window.loadActiveSubtitles(itm.path);
    } catch (err) {
        console.error("Auto subtitle loading error:", err);
    }

    const savedPos = (window.appSettings && window.appSettings.rememberPosition !== false &&
        window.appSettings.playbackPositions && window.appSettings.playbackPositions[itm.path]) || 0;
    if (savedPos > 0) {
        const restoreOnce = () => {
            if (savedPos < vp.duration - 3) {
                vp.currentTime = savedPos;
                window.showToast(`Resumed from ${window.formatDuration(savedPos)}`, 'success');
            }
            vp.removeEventListener('loadedmetadata', restoreOnce);
        };
        vp.addEventListener('loadedmetadata', restoreOnce);
    }

    el('video-modal').classList.remove('minimized');
    btnPlay.innerHTML = PAUSE_ICON_SVG;
    el('video-modal').style.display = 'flex';
    el('video-modal').focus();

    // Enable AI upscale for local vault files
    // TODO: VERIFY - Need to verify AI upscaling functionality and quality
    const btnUpscale = el('btn-upscale');
    if (btnUpscale) {
        btnUpscale.disabled = false;
        btnUpscale.style.opacity = '1';
        btnUpscale.style.cursor = 'pointer';
    }

    vp.play().catch(e => console.log("Playback start prevented or failed:", e));
}

function updateNavHover(idx, btnEl) {
    if (idx < 0 || idx >= window.displayedItems.length) {
        navHoverPreview.style.display = 'none';
        return;
    }
    let itm = window.displayedItems[idx];
    const rect = btnEl.getBoundingClientRect();

    let thumbUrl = window.sanitizePath(itm.thumbnail || '');
    if (thumbUrl) {
        navHoverPreview.style.backgroundImage = `url('${thumbUrl}')`;
        navHoverPreview.innerText = itm.name;
        navHoverPreview.style.left = (rect.left + (rect.width / 2)) + 'px';
        navHoverPreview.style.bottom = (window.innerHeight - rect.top + 10) + 'px';
        navHoverPreview.style.display = 'flex';
    } else {
        navHoverPreview.style.display = 'none';
    }
}

function saveAndSetVolume(vol) {
    const safeVol = Math.max(0, Math.min(1, vol));
    if (vp) vp.volume = safeVol;
    if (volSlider) volSlider.value = safeVol;
    updateVolumeIconUI(safeVol);
    localStorage.setItem('player-volume', safeVol);
}

function initPlayer() {
    vp = el('video-player');

    // Cues are nudged clear of the control bar instead of shrinking the video
    // (see .video-wrapper.subtitles-active in player.css).
    if (typeof window.attachCueLifting === 'function') window.attachCueLifting(vp);

    // Close / stop video, trailers, and livestream when app is minimized to tray
    if (window.electronAPI && typeof window.electronAPI.onAppHidden === 'function') {
        window.electronAPI.onAppHidden(() => {
            console.log('[Player] App minimized to tray. Stopping active media players...');
            const closeModalBtn = el('close-modal');
            if (closeModalBtn && el('video-modal').style.display === 'flex') {
                closeModalBtn.click();
            }
            const trailerIframe = el('movie-trailer-iframe');
            if (trailerIframe) {
                if (trailerIframe.tagName === 'VIDEO') { trailerIframe.pause(); trailerIframe.src = ''; trailerIframe.load(); }
                else { trailerIframe.src = ''; }
            }
            if (window.electronAPI.stopLivestream) {
                window.electronAPI.stopLivestream().catch(() => { });
            }
            if (typeof window.resetSubtitles === 'function') window.resetSubtitles();
        });
    }

    seekArea = el('seek-area');
    seekFill = el('seek-fill');
    seekPreview = el('seek-hover-preview');
    btnPlay = el('btn-playpause');
    btnPrev = el('btn-prev');
    btnNext = el('btn-next');
    btnClip = el('btn-clip');
    volSlider = el('volume-slider');

    // Scrubber elements setup
    scrubVideo = document.createElement('video');
    scrubVideo.muted = true;
    scrubVideo.preload = 'metadata';
    scrubVideo.style.display = 'none';
    document.body.appendChild(scrubVideo);

    seekCanvas = seekPreview;
    seekCtx = seekCanvas.getContext('2d');
    seekCanvas.width = 320;
    seekCanvas.height = 180;

    navHoverPreview = document.createElement('div');
    navHoverPreview.className = 'nav-hover-preview';
    document.body.appendChild(navHoverPreview);

    scrubVideo.addEventListener('seeked', () => {
        seekCtx.drawImage(scrubVideo, 0, 0, seekCanvas.width, seekCanvas.height);
    });

    // Close on PiP or Modal Close
    el('minimize-modal').addEventListener('click', (e) => {
        e.stopPropagation();
        el('video-modal').classList.toggle('minimized');
    });

    // PiP overlay control buttons
    const pipPrev = el('pip-btn-prev');
    const pipPlay = el('pip-btn-play');
    const pipNext = el('pip-btn-next');
    if (pipPrev) {
        pipPrev.addEventListener('click', (e) => {
            e.stopPropagation();
            const prevBtn = el('btn-prev');
            if (prevBtn) prevBtn.click();
        });
    }
    if (pipPlay) {
        pipPlay.addEventListener('click', (e) => {
            e.stopPropagation();
            if (vp.paused) {
                vp.play().catch(() => { });
            } else {
                vp.pause();
            }
        });
    }
    if (pipNext) {
        pipNext.addEventListener('click', (e) => {
            e.stopPropagation();
            const nextBtn = el('btn-next');
            if (nextBtn) nextBtn.click();
        });
    }

    // Restore from PiP when clicking inside the video-wrapper (but not on control buttons)
    const wrapper = document.querySelector('.video-wrapper');
    if (wrapper) {
        wrapper.addEventListener('click', (e) => {
            if (el('video-modal').classList.contains('minimized')) {
                if (e.target.closest('.pip-ctrl-btn') || e.target.closest('#pip-close-btn')) {
                    return;
                }
                e.stopPropagation();
                el('video-modal').classList.remove('minimized');
            }
        });
    }

    // Context menu inside the video player
    if (vp) {
        vp.addEventListener('contextmenu', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const item = window.currentPlayingItem || window.activeStreamingMedia || {};
            const isStreaming = !!window.activeStreamingMedia && !window.currentPlayingItem;
            const targetPath = item.path || item.src || (vp.src ? decodeURIComponent(vp.src.replace('file:///', '').replace(/\//g, '\\')) : '');

            let enhancementsState = { audio: false, video: false, subtitles: [], translation: [] };
            let enhancedPath = null;
            if (targetPath && window.electronAPI && typeof window.electronAPI.getEnhancementState === 'function') {
                try {
                    const enhRes = await window.electronAPI.getEnhancementState(targetPath);
                    if (enhRes && enhRes.success && enhRes.state) {
                        enhancementsState = enhRes.state;
                        enhancedPath = enhRes.state.enhancedPath;
                    }
                } catch (_) {}
            }

            const menuItem = {
                type: 'videoPlayer',
                path: targetPath,
                name: item.name || item.title || 'Video',
                isStreaming,
                isPlaying: !vp.paused,
                isMuted: vp.muted,
                speed: vp.playbackRate,
                enhancements: enhancementsState,
                enhancedPath: enhancedPath,
                clientX: e.clientX,
                clientY: e.clientY
            };
            const action = await window.electronAPI.showContextMenu(menuItem);
            await handlePlayerContextMenu(action, menuItem);
        });
    }

    el('pip-close-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        el('close-modal').click();
    });

    el('close-modal').addEventListener('click', (e) => {
        e.stopPropagation();
        el('video-modal').style.display = 'none';
        el('video-modal').classList.remove('minimized');
        el('video-ended-overlay').style.display = 'none';
        if (el('titlebar-video-title')) el('titlebar-video-title').style.display = 'none';
        if (window.autoplayTimer) { clearInterval(window.autoplayTimer); window.autoplayTimer = null; }

        // Forget this playback's subtitles.
        if (typeof window.resetSubtitles === 'function') window.resetSubtitles();

        // Remove all track elements from video element and clear subtitle list
        vp.querySelectorAll('track').forEach(t => t.remove());
        const trackList = el('subtitle-tracks-list');
        if (trackList) trackList.innerHTML = '';
        const btnSubs = el('btn-subtitles');
        if (btnSubs) {
            btnSubs.classList.remove('active');
            btnSubs.innerHTML = `${window.icons ? window.icons.subtitles('', 'width:14px; height:14px; display:block; flex-shrink:0;') : ''}<span>CC</span> ▾`;
        }
        // Re-disable AI button
        const btnUpscale = el('btn-upscale');
        if (btnUpscale) {
            btnUpscale.disabled = true;
            btnUpscale.style.opacity = '0.5';
            btnUpscale.style.cursor = 'not-allowed';
        }

        // Discover's Continue Watching row shows what was just watched once the save below has landed
        if (window.currentStreamingSubtab === 'discover' && typeof window.renderContinueWatching === 'function') {
            setTimeout(() => window.renderContinueWatching(), 600);
        }

        // Final position save to persistent Watch History
        if (vp.duration > 0) {
            if (window.activeStreamingMedia && !window.activeStreamingMedia.streamUrl) {
                // a new episode was still being searched: the loaded video is the previous one (saved when it was left)
            } else if (window.activeStreamingMedia) {
                const completed = window.isWatchedAt(vp.currentTime, vp.duration)   // Settings → Mark as Watched at (95 %)
                    || !!window.activeStreamingMedia.creditsDone;                     // reached its credits (series skip)
                if (completed) {
                    window.electronAPI.markWatched({
                        mediaType: window.activeStreamingMedia.mediaType,
                        tmdbId: window.activeStreamingMedia.tmdbId,
                        title: window.activeStreamingMedia.title,
                        season: window.activeStreamingMedia.season,
                        episode: window.activeStreamingMedia.episode,
                        poster: window.activeStreamingMedia.poster,
                        year: window.activeStreamingMedia.year
                    }).catch(() => { });
                } else {
                    window.electronAPI.setWatchProgress({
                        ...window.activeStreamingMedia,
                        positionSec: vp.currentTime,
                        durationSec: vp.duration
                    }).catch(() => { });
                }
            } else if (window.currentPlayingItem) {
                const closingItm = window.currentPlayingItem;
                if (closingItm && closingItm.path) {
                    window.appSettings.playbackPositions = window.appSettings.playbackPositions || {};
                    const completed = window.isWatchedAt(vp.currentTime, vp.duration);
                    if (completed) {
                        delete window.appSettings.playbackPositions[closingItm.path];
                        window.electronAPI.markWatched({
                            mediaType: 'local',
                            title: closingItm.name
                        }).catch(() => { });
                    } else {
                        window.appSettings.playbackPositions[closingItm.path] = vp.currentTime;
                        window.electronAPI.setWatchProgress({
                            mediaType: 'local',
                            title: closingItm.name,
                            positionSec: vp.currentTime,
                            durationSec: vp.duration
                        }).catch(() => { });
                    }
                    window.electronAPI.saveSettings(window.appSettings).catch(() => { });
                }
            } else if (window.currentPlayingIndex !== -1) {
                const closingItm = window.displayedItems[window.currentPlayingIndex];
                if (closingItm && closingItm.path) {
                    window.appSettings.playbackPositions = window.appSettings.playbackPositions || {};
                    const completed = window.isWatchedAt(vp.currentTime, vp.duration);
                    if (completed) {
                        delete window.appSettings.playbackPositions[closingItm.path];
                        window.electronAPI.markWatched({
                            mediaType: 'local',
                            title: closingItm.name
                        }).catch(() => { });
                    } else {
                        window.appSettings.playbackPositions[closingItm.path] = vp.currentTime;
                        window.electronAPI.setWatchProgress({
                            mediaType: 'local',
                            title: closingItm.name,
                            positionSec: vp.currentTime,
                            durationSec: vp.duration
                        }).catch(() => { });
                    }
                    window.electronAPI.saveSettings(window.appSettings).catch(() => { });
                }
            }
        }


        // Trigger post-playback Usenet cleanup before clearing active media state
        if (window.activeStreamingMedia && window.activeStreamingMedia.isUsenet) {
            const { folderName, nzoId } = window.activeStreamingMedia;
            if (folderName && nzoId) {
                console.log(`[Player] Closing Usenet playback, launching remote drive transfer for ${folderName}...`);
                window.electronAPI.moveUsenetToDrive({ folderName, nzoId }).catch(err => {
                    console.error('[Player] Failed to trigger Usenet cleanup IPC:', err);
                });
            }
        }

        // Reset active streaming media cache + any in-flight RD/quality-switch
        // state. If we leave these set, the NEXT stream attempt can race against
        // a stale flow id or seek to the previous movie's pause position.
        window.activeStreamingMedia = null;
        window.activeRDFlowId = null;
        window._resumePosAfterSwitch = null;
        if (typeof window.seriesControlsOnPlay === 'function') window.seriesControlsOnPlay();   // hides the series UI

        vp.pause();
        // Hard-reset the <video> element. The prior `vp.src = ''` assignment
        // resolved to the document base URL, attempted to load it, and parked
        // the element in MEDIA_ERR_SRC_NOT_SUPPORTED. Subsequent `vp.src =
        // newUrl` then silently no-op'd because the error state persisted —
        // which is why no other movie would play until the app was restarted.
        // removeAttribute + load() returns the element to NETWORK_EMPTY.
        try {
            vp.removeAttribute('src');
            vp.load();
        } catch (e) { console.log('[Player] reset error (non-fatal):', e); }

        window.currentPlayingItem = null;
        if (window.currentPlayingIndex !== -1) {
            const card = document.querySelector(`.file-card[data-index="${window.currentPlayingIndex}"]`);
            if (card) card.focus();
        }
    });

    btnPrev.addEventListener('mouseenter', () => {
        let prevIdx = window.currentPlayingIndex - 1;
        while (prevIdx >= 0 && window.displayedItems[prevIdx].type !== 'video') prevIdx--;
        updateNavHover(prevIdx, btnPrev);
    });
    btnPrev.addEventListener('mouseleave', () => navHoverPreview.style.display = 'none');

    btnNext.addEventListener('mouseenter', () => {
        let nextIdx = window.currentPlayingIndex + 1;
        while (nextIdx < window.displayedItems.length && window.displayedItems[nextIdx].type !== 'video') nextIdx++;
        updateNavHover(nextIdx, btnNext);
    });
    btnNext.addEventListener('mouseleave', () => navHoverPreview.style.display = 'none');

    btnPrev.addEventListener('click', () => {
        let prevIdx = window.currentPlayingIndex - 1;
        while (prevIdx >= 0 && window.displayedItems[prevIdx].type !== 'video') prevIdx--;
        if (prevIdx >= 0) playItem(prevIdx);
    });

    btnNext.addEventListener('click', () => {
        let nextIdx = window.currentPlayingIndex + 1;
        while (nextIdx < window.displayedItems.length && window.displayedItems[nextIdx].type !== 'video') nextIdx++;
        if (nextIdx < window.displayedItems.length) playItem(nextIdx);
    });

    const savedVol = localStorage.getItem('player-volume');
    if (savedVol !== null) {
        const volFloat = parseFloat(savedVol);
        vp.volume = volFloat;
        volSlider.value = volFloat;
    } else {
        vp.volume = parseFloat(volSlider.value || '1');
    }
    updateVolumeIconUI(vp.volume);

    volSlider.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        // Any non-zero slider change implies the user wants sound — unmute.
        if (v > 0 && vp.muted) vp.muted = false;
        saveAndSetVolume(v);
    });

    // Slider hides on mouseleave from the volume container. Drop focus after
    // pointer-up so the :focus-within style doesn't keep it pinned open.
    volSlider.addEventListener('pointerup', () => { try { volSlider.blur(); } catch (_) { } });
    volSlider.addEventListener('touchend', () => { try { volSlider.blur(); } catch (_) { } });
    const volContainer = document.querySelector('.volume-container');
    if (volContainer) {
        volContainer.addEventListener('mouseleave', () => { try { volSlider.blur(); } catch (_) { } });
    }

    // Click the volume icon -> toggle mute. Persists the pre-mute volume so
    // unmuting restores the user's chosen level instead of jumping to 100%.
    const btnVolIcon = el('btn-volume-icon');
    if (btnVolIcon) {
        btnVolIcon.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!vp) return;
            if (vp.muted || vp.volume === 0) {
                vp.muted = false;
                const restore = parseFloat(localStorage.getItem('player-volume-prev-mute') || '');
                const target = isFinite(restore) && restore > 0
                    ? restore
                    : (vp.volume > 0 ? vp.volume : 0.5);
                saveAndSetVolume(target);
            } else {
                localStorage.setItem('player-volume-prev-mute', String(vp.volume));
                vp.muted = true;
                updateVolumeIconUI(0);
                if (volSlider) volSlider.value = 0;
            }
        });
    }

    let lastHistoryUpdate = 0;
    vp.addEventListener('timeupdate', () => {
        if (!vp.duration || !isFinite(vp.duration) || vp.duration <= 0) {
            el('time-display').innerText = '0:00 / 0:00';
            const elEl = el('time-elapsed'); if (elEl) elEl.innerText = '0:00';
            const totEl = el('time-total'); if (totEl) totEl.innerText = '0:00';
            return;
        }
        const pct = vp.currentTime / vp.duration;
        seekFill.style.width = (pct * 100) + '%';
        const cur = window.formatDuration(vp.currentTime);
        const tot = window.formatDuration(vp.duration);
        el('time-display').innerText = cur + ' / ' + tot;
        const elEl = el('time-elapsed'); if (elEl) elEl.innerText = cur;
        const totEl = el('time-total'); if (totEl) totEl.innerText = tot;

        // Periodic Watch History Progress Saving (Every 5 seconds)
        const now = Date.now();
        if (now - lastHistoryUpdate > 5000) {
            lastHistoryUpdate = now;
            trackMomentsPlayback(vp);
            const m = window.activeStreamingMedia;
            if (m) {
                // only the episode whose stream is loaded (a new one being searched has no streamUrl yet: the
                // still-playing video's clock is not its progress); one that reached its credits stays watched
                // (and not the 0 s of a stream being reloaded, before it has seeked back)
                if (m.streamUrl && !m.creditsDone && vp.currentTime > 1 && vp.duration > 0) {
                    window.electronAPI.setWatchProgress({
                        ...m,
                        positionSec: vp.currentTime,
                        durationSec: vp.duration
                    });
                }
            } else if (window.currentPlayingItem) {
                const itm = window.currentPlayingItem;
                if (itm && itm.path) {
                    window.electronAPI.setWatchProgress({
                        mediaType: 'local',
                        title: itm.name,
                        positionSec: vp.currentTime,
                        durationSec: vp.duration
                    });
                }
            } else if (window.currentPlayingIndex !== -1) {
                const itm = window.displayedItems[window.currentPlayingIndex];
                if (itm && itm.path) {
                    window.electronAPI.setWatchProgress({
                        mediaType: 'local',
                        title: itm.name,
                        positionSec: vp.currentTime,
                        durationSec: vp.duration
                    });
                }
            }
        }
    });

    vp.addEventListener('error', (e) => {
        const err = vp.error;
        // Suppress errors that fire as a consequence of closing the player:
        // (a) the modal is already hidden, or
        // (b) src was cleared (empty / unset) — code 4 fires every time we
        //     reset vp.src to '' on close. These aren't user-actionable.
        const modalHidden = el('video-modal').style.display !== 'flex';
        const srcEmpty = !vp.src || vp.src === window.location.href;
        if (modalHidden || srcEmpty) {
            console.log('[Video Player] Ignoring error during close/reset:', err && err.code);
            return;
        }
        // A copied video the browser can't decode: the transcoder restarts it as H.264 at the same spot.
        if (window.isTranscodeActive && window.isTranscodeActive() && window.transcodeRecover
            && window.transcodeRecover('MediaError ' + (err && err.code))) return;
        // A stream that had been playing and then failed: its download link most likely expired or dropped.
        // Reload it at the same spot (a few times) before giving up.
        if (err && err.code !== 1 && window._streamLastGood > 5 && window.activeStreamingMedia
            && window.activeStreamingMedia.streamUrl && !window.currentPlayingItem) {
            const r = window._streamAutoReloads;
            if (r.count < AUTO_RELOADS) {
                r.count++;
                r.at = window._streamLastGood;
                console.warn(`[streaming] playback error ${err.code} at ${Math.round(r.at)} s — auto reload ${r.count}/${AUTO_RELOADS}`);
                if (window.reloadStream({ auto: true })) return;
            }
        }
        let errMsg = 'Unknown playback error.';
        if (err) {
            switch (err.code) {
                case 1:
                    // User aborted - don't show error toast
                    console.log('[Video Player] Playback aborted by user - ignoring error');
                    return;
                case 2: errMsg = 'Network error occurred while loading video.'; break;
                case 3: errMsg = 'Video decoding failed or format is not supported.'; break;
                case 4: errMsg = 'This video could not be played (format not supported, or the link stopped working).'; break;
            }
        }
        console.error('[Video Player Error]', err || e);
        window.showToast(`${window.tr('toastPlaybackError', 'Playback Error')}: ${errMsg}`, 'error');

        // Tear the element down. Without this the <video> keeps painting the last
        // decoded frame of the PREVIOUS title, so a failed source looked like the
        // old movie had reloaded at 00:00 — and with duration still NaN, the seek
        // bar threw on every click.
        try {
            vp.pause();
            vp.removeAttribute('src');
            vp.load();
        } catch (_) { /* element already torn down */ }
        const totalEl = el('time-total');
        const curEl = el('time-current');
        if (totalEl) totalEl.innerText = '0:00';
        if (curEl) curEl.innerText = '0:00';
    });

    // the last position that played (the reload's fallback once an error has reset currentTime); a minute of playback
    // past the last auto reload gives the stream its auto reloads back
    vp.addEventListener('timeupdate', () => {
        if (vp.seeking || !(vp.currentTime > 1) || vp.paused) return;
        window._streamLastGood = vp.currentTime;
        const r = window._streamAutoReloads;
        if (r.count && vp.currentTime > r.at + 60) { r.count = 0; r.at = 0; }
    });

    vp.addEventListener('loadedmetadata', () => {
        const totEl = el('time-total');
        if (totEl && vp.duration && isFinite(vp.duration)) totEl.innerText = window.formatDuration(vp.duration);
    });

    vp.addEventListener('click', (e) => {
        if (el('video-modal').classList.contains('minimized')) { el('video-modal').classList.remove('minimized'); e.stopPropagation(); return; }
        if (vp.paused) { vp.play().catch(() => { }); btnPlay.innerHTML = PAUSE_ICON_SVG; }
        else { vp.pause(); btnPlay.innerHTML = PLAY_ICON_SVG; }
    });

    // Double-click toggles fullscreen (the two single-clicks net to the same
    // play/pause state, so no extra handling needed).
    vp.addEventListener('dblclick', () => {
        if (!document.fullscreenElement) vp.parentElement.requestFullscreen().catch(() => { });
        else document.exitFullscreen().catch(() => { });
    });

    vp.addEventListener('ended', () => {
        // A clip under a minute that "ended" is a provider error video, not the title: nothing was watched
        if (!(vp.duration >= 60)) return;
        // the old episode ending while the next one is being searched is not the new one's end
        if (window.activeStreamingMedia && !window.activeStreamingMedia.streamUrl) return;
        // Series: the Up next card plays the next episode (js/player/up-next.js); the playlist logic below is for
        // library files.
        if (window.activeStreamingMedia && window.activeStreamingMedia.mediaType === 'tv' && typeof window.upNextOnEnded === 'function') {
            window.electronAPI.markWatched({
                mediaType: 'tv', tmdbId: window.activeStreamingMedia.tmdbId, title: window.activeStreamingMedia.title,
                season: window.activeStreamingMedia.season, episode: window.activeStreamingMedia.episode,
                poster: window.activeStreamingMedia.poster, year: window.activeStreamingMedia.year
            });
            window.upNextOnEnded();
            return;
        }
        // Mark as completed on ended
        if (window.activeStreamingMedia) {
            window.electronAPI.markWatched({
                mediaType: window.activeStreamingMedia.mediaType,
                tmdbId: window.activeStreamingMedia.tmdbId,
                title: window.activeStreamingMedia.title,
                season: window.activeStreamingMedia.season,
                episode: window.activeStreamingMedia.episode,
                poster: window.activeStreamingMedia.poster,
                year: window.activeStreamingMedia.year
            });
        } else if (window.currentPlayingItem) {
            const itm = window.currentPlayingItem;
            if (itm && itm.path) {
                window.electronAPI.markWatched({
                    mediaType: 'local',
                    title: itm.name
                });
            }
        } else if (window.currentPlayingIndex !== -1) {
            const itm = window.displayedItems[window.currentPlayingIndex];
            if (itm && itm.path) {
                window.electronAPI.markWatched({
                    mediaType: 'local',
                    title: itm.name
                });
            }
        }

        let currentIdx = parseInt(window.currentPlayingIndex, 10);
        let nextIdx = currentIdx + 1;
        while (nextIdx < window.displayedItems.length && window.displayedItems[nextIdx].type !== 'video') nextIdx++;

        const overlay = el('video-ended-overlay');
        if (!overlay) return;

        const countdownEl = el('ended-countdown');
        // Autoplay is for episodic content only — a movie just ends rather than
        // rolling into an unrelated title.
        const isSeries = !!(window.activeStreamingMedia && window.activeStreamingMedia.mediaType === 'tv');
        if (!isSeries) {
            overlay.style.display = 'flex';
            countdownEl.innerText = 'Finished.';
            countdownEl.style.cursor = 'default';
            return;
        }
        if (nextIdx < window.displayedItems.length) {
            if (window.autoplayMode !== 'off') {
                if (window.autoplayMode === 'instant') {
                    playItem(nextIdx);
                    return;
                }

                window.autoplayCountdown = (window.autoplayMode === '3s') ? 3 : 5;
                countdownEl.innerText = tr('endedNextIn', 'Next video in {n} seconds... (Click to play now)').replace('{n}', window.autoplayCountdown);
                countdownEl.style.cursor = 'pointer';
                overlay.style.display = 'flex';

                if (window.autoplayTimer) clearInterval(window.autoplayTimer);
                window.autoplayTimer = setInterval(() => {
                    window.autoplayCountdown--;
                    if (window.autoplayCountdown <= 0) {
                        clearInterval(window.autoplayTimer);
                        overlay.style.display = 'none';
                        playItem(nextIdx);
                    } else {
                        countdownEl.innerText = tr('endedNextIn', 'Next video in {n} seconds... (Click to play now)').replace('{n}', window.autoplayCountdown);
                    }
                }, 1000);
            } else {
                overlay.style.display = 'flex';
                countdownEl.innerText = "Autoplay is off. Click here to play the next video.";
                countdownEl.style.cursor = 'pointer';
            }
        } else {
            overlay.style.display = 'flex';
            countdownEl.innerText = "End of playlist. Click Replay to start over.";
            countdownEl.style.cursor = 'default';
        }
    });

    el('ended-play-btn').addEventListener('click', () => {
        if (window.autoplayTimer) clearInterval(window.autoplayTimer);
        let currentIdx = parseInt(window.currentPlayingIndex, 10);
        let nextIdx = currentIdx + 1;
        while (nextIdx < window.displayedItems.length && window.displayedItems[nextIdx].type !== 'video') nextIdx++;
        if (nextIdx < window.displayedItems.length) {
            el('video-ended-overlay').style.display = 'none';
            playItem(nextIdx);
        } else {
            // Replay the current video if we are at the end of the playlist
            el('video-ended-overlay').style.display = 'none';
            vp.currentTime = 0;
            vp.play().catch(() => { });
            btnPlay.innerHTML = PAUSE_ICON_SVG;
        }
    });

    el('ended-replay-btn').addEventListener('click', () => {
        if (window.autoplayTimer) clearInterval(window.autoplayTimer);
        el('video-ended-overlay').style.display = 'none';
        vp.currentTime = 0;
        vp.play().catch(() => { });
        btnPlay.innerHTML = PAUSE_ICON_SVG;
    });

    el('ended-countdown').addEventListener('click', () => {
        let currentIdx = parseInt(window.currentPlayingIndex, 10);
        let nextIdx = currentIdx + 1;
        while (nextIdx < window.displayedItems.length && window.displayedItems[nextIdx].type !== 'video') nextIdx++;
        if (nextIdx < window.displayedItems.length) {
            if (window.autoplayTimer) { clearInterval(window.autoplayTimer); window.autoplayTimer = null; }
            el('video-ended-overlay').style.display = 'none';
            playItem(nextIdx);
        } else {
            // Replay if clicked at the end of playlist
            if (window.autoplayTimer) { clearInterval(window.autoplayTimer); window.autoplayTimer = null; }
            el('video-ended-overlay').style.display = 'none';
            vp.currentTime = 0;
            vp.play().catch(() => { });
            btnPlay.innerHTML = PAUSE_ICON_SVG;
        }
    });

    vp.addEventListener('play', () => {
        btnPlay.innerHTML = PAUSE_ICON_SVG;
        const pipPlayBtn = el('pip-btn-play');
        if (pipPlayBtn) pipPlayBtn.innerHTML = window.icons.pause('', 'width:14px;height:14px;vertical-align:middle;');
    });
    // Paused on a stream: one tiny range request a minute keeps Comet's link warm, so playback restarts in ~0.6 s
    // instead of ~3.3 s after a long pause (measured Fri 20 Nov 2026). Stops on play, a new source or close.
    const KEEP_WARM_MS = 60 * 1000;
    const keepWarmUrl = () => {
        const m = window.activeStreamingMedia;
        const u = (m && m.streamUrl) || vp.currentSrc || '';
        return /^https?:\/\//i.test(u) && !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(u) ? u : null;
    };
    const stopKeepWarm = () => { clearInterval(window._keepWarmTimer); window._keepWarmTimer = null; };
    vp.addEventListener('pause', () => {
        stopKeepWarm();
        if (!keepWarmUrl() || vp.ended) return;
        window._keepWarmTimer = setInterval(() => {
            const u = keepWarmUrl();
            if (!u || !vp.paused || el('video-modal').style.display === 'none') { stopKeepWarm(); return; }
            // through the main process (a renderer no-cors fetch would drop the Range header: a whole-video download)
            if (window.electronAPI && window.electronAPI.keepStreamWarm) window.electronAPI.keepStreamWarm({ url: u }).catch(() => {});
        }, KEEP_WARM_MS);
    });
    vp.addEventListener('play', stopKeepWarm);
    vp.addEventListener('emptied', stopKeepWarm);
    vp.addEventListener('pause', () => {
        btnPlay.innerHTML = PLAY_ICON_SVG;
        const pipPlayBtn = el('pip-btn-play');
        if (pipPlayBtn) pipPlayBtn.innerHTML = window.icons.play('', 'width:14px;height:14px;vertical-align:middle;');
    });

    btnPlay.addEventListener('click', () => {
        if (vp.paused) {
            vp.play().catch(() => { });
        } else {
            vp.pause();
        }
    });

    // ── Clip button handler ────────────────────────────────────
    if (btnClip) {
        btnClip.addEventListener('click', () => {
            if (window.clipState && window.clipState.active) {
                // If already in clip mode, end it
                window.endClipMode();
            } else if (typeof window.startClipMode === 'function') {
                // Start clip mode
                window.startClipMode();
            }
        });
    }

    el('btn-fullscreen').addEventListener('click', () => {
        if (!document.fullscreenElement) {
            vp.parentElement.requestFullscreen();
        } else {
            document.exitFullscreen();
        }
    });

    // Mirror document fullscreen onto the Electron window. Without this the
    // OS frame stays in "windowed" mode and paints resize cursors at the
    // screen edges over the video.
    document.addEventListener('fullscreenchange', () => {
        const isFs = !!document.fullscreenElement;
        if (window.electronAPI && typeof window.electronAPI.setWindowFullScreen === 'function') {
            window.electronAPI.setWindowFullScreen(isFs).catch(() => { });
        }
        // Reset idle state on transition so controls aren't stuck hidden (and the app title bar, which fullscreen
        // covers, cannot leave its "hovered" state on).
        document.body.classList.remove('player-idle', 'titlebar-hovered');
        if (isFs) document.body.classList.add('player-awake');
    });

    // Idle-hide: hide custom controls + cursor after 2s of mouse inactivity
    // while the player modal is open. Any mousemove cancels the hide.
    let _idleTimer = null;
    const markActive = () => {
        const wasIdle = document.body.classList.contains('player-idle');
        document.body.classList.remove('player-idle');
        document.body.classList.add('player-awake');
        // Force a cursor repaint in fullscreen — Chromium sometimes fails to
        // repaint the cursor after removing `cursor: none` in fullscreen mode.
        if (wasIdle && document.fullscreenElement) {
            const modal = el('video-modal');
            if (modal) {
                modal.classList.add('cursor-refresh');
                void modal.offsetWidth; // force reflow
                modal.classList.remove('cursor-refresh');
            }
        }
        if (_idleTimer) clearTimeout(_idleTimer);
        const modal = el('video-modal');
        if (!modal || modal.style.display !== 'flex') return;
        _idleTimer = setTimeout(() => {
            // Never hide while a player menu is open — otherwise the menu vanishes
            // (opacity 0) or becomes unclickable (pointer-events:none) mid-use.
            const menuOpen = ['quality-menu', 'subtitles-menu', 'audio-menu', 'speed-menu'].some(id => {
                const m = el(id);
                return m && m.style.display && m.style.display !== 'none';
            });
            // Only hide if the cursor isn't over an interactive control (hover-keep).
            if (!menuOpen && !document.querySelector('#custom-controls:hover, #player-topbar:hover')) {
                document.body.classList.add('player-idle');
            }
        }, 2000);
    };
    document.addEventListener('mousemove', markActive);
    document.addEventListener('mousedown', markActive);
    document.addEventListener('mouseup', markActive);
    document.addEventListener('keydown', markActive);
    // playback starting under a still mouse: the 2 s count starts there too (it only ran from a mouse move)
    vp.addEventListener('playing', markActive);

    // ── Autoplay toggle Switch ──────────────────────────────
    if (el('btn-autoplay')) {
        el('btn-autoplay').addEventListener('click', (e) => {
            // Plain on/off toggle. "On" uses the 5s countdown.
            window.autoplayMode = (window.autoplayMode === 'off') ? '5s' : 'off';
            window.autoplayEnabled = (window.autoplayMode !== 'off');
            localStorage.setItem('autoplayMode', window.autoplayMode);
            updateAutoplayUI();

            window.showToast(`Autoplay: ${window.autoplayMode === 'off' ? 'Off' : 'On'}`, 'success');
        });
        updateAutoplayUI();
    }

    // ── Stream Quality Picker (RD streams only) ──────────────
    // The picker reads from window.currentTorrentList (set by triggerRDStream
    // after ranking). Selecting an option re-starts the RD flow for the
    // chosen torrent and seeks the new stream back to where we paused.
    const qBtn = el('btn-quality');
    const qMenu = el('quality-menu');
    if (qBtn && qMenu) {
        qBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const sm = el('speed-menu'); if (sm) sm.style.display = 'none';
            const subm = el('subtitles-menu'); if (subm) subm.style.display = 'none';
            const am = el('audio-menu'); if (am) am.style.display = 'none';
            window.refreshQualityMenu();
            qMenu.style.display = (qMenu.style.display === 'none' || !qMenu.style.display) ? 'block' : 'none';
        });
    }

    // Shared quality-label classifier (used by the picker and by the RD flow to
    // record what's currently playing).
    window.qualityLabelOf = function (t) {
        const text = `${t.quality || ''} ${t.type || ''} ${t.desc || ''}`.toLowerCase();
        if (/\b(2160p?|4k|uhd)\b/.test(text)) return '2160p';
        if (/\b1080p?\b/.test(text)) return '1080p';
        if (/\b720p?\b/.test(text)) return '720p';
        if (/\b480p?\b/.test(text)) return '480p';
        return (t.quality || 'HD').toUpperCase();
    };

    window.refreshQualityMenu = function () {
        const menu = el('quality-menu');
        const container = el('quality-dropdown-container');
        if (!menu || !container) return;
        const list = Array.isArray(window.currentTorrentList) ? window.currentTorrentList : [];
        if (!list.length) { container.style.display = 'none'; return; }
        container.style.display = 'inline-block';

        // Group by quality label (4K/2160p/1080p/720p/...), keep the BEST-ranked
        // representative per group (currentTorrentList is already ranked).
        const buckets = new Map();
        const rankOrder = { '2160p': 4, '4k': 4, 'uhd': 4, '1080p': 3, '720p': 2, '480p': 1 };
        const labelOf = window.qualityLabelOf;
        list.forEach((t, idx) => {
            const lbl = labelOf(t);
            if (!buckets.has(lbl)) buckets.set(lbl, { label: lbl, torrent: t, idx });
        });
        const ordered = [...buckets.values()].sort((a, b) => (rankOrder[b.label] || 0) - (rankOrder[a.label] || 0));

        // The currently-playing quality is recorded by the RD flow when a torrent
        // is committed (window._activeStreamLabel) — activeStreamingMedia has no
        // quality field, so the old lookup never matched and nothing was marked active.
        const currentLabel = window._activeStreamLabel || null;

        const txt = el('quality-btn-text');
        if (txt) txt.innerText = currentLabel ? currentLabel.toUpperCase() : 'AUTO';

        menu.innerHTML = '';
        // a replayed last source lists only itself: offer the search for the other releases
        if (list.length <= 1 && window.activeStreamingMedia && typeof window.findOtherSources === 'function') {
            const other = document.createElement('div');
            other.style.cssText = 'padding:6px 12px; cursor:pointer; text-align:left; font-family:var(--font-mono); font-size:11px; color:var(--vault-slate); border-bottom:1px solid var(--vault-border);';
            other.textContent = window.currentLang === 'fr' ? 'Autres sources…' : 'Other sources…';
            other.addEventListener('click', (e) => {
                e.stopPropagation();
                menu.style.display = 'none';
                const vpEl = el('video-player');
                window._resumePosAfterSwitch = vpEl ? vpEl.currentTime : 0;
                window.findOtherSources();
            });
            menu.appendChild(other);
        }
        ordered.forEach(entry => {
            const opt = document.createElement('div');
            const isActive = currentLabel === entry.label;
            const activeBg = 'rgba(245,185,41,0.18)';
            opt.style.cssText = `padding:6px 12px; cursor:pointer; text-align:left; font-family:var(--font-mono); font-size:11px; transition:background 0.2s; color:${isActive ? 'var(--vault-accent)' : 'var(--vault-text)'}; font-weight:${isActive ? '700' : '500'}; background:${isActive ? activeBg : 'transparent'}; border-left:3px solid ${isActive ? 'var(--vault-accent)' : 'transparent'};`;
            const nowPlaying = isActive ? ` <span style="color:var(--vault-accent); font-weight:700; font-size:9px; text-transform:uppercase; letter-spacing:0.04em;">● ${window.currentLang === 'fr' ? 'en cours' : 'now playing'}</span>` : '';
            const sizeStr = entry.torrent.size ? ` <span style="color:var(--vault-slate); font-weight:400; font-size:10px;">${entry.torrent.size}</span>` : '';
            opt.innerHTML = `${entry.label.toUpperCase()}${sizeStr}${nowPlaying}`;
            opt.addEventListener('mouseenter', () => { opt.style.background = 'rgba(245,185,41,0.08)'; });
            opt.addEventListener('mouseleave', () => { opt.style.background = isActive ? activeBg : 'transparent'; });
            opt.addEventListener('click', async (e) => {
                e.stopPropagation();
                menu.style.display = 'none';
                if (isActive) return;
                // Save position; the new RD flow will re-open playStream which
                // will pick up window._resumePosAfterSwitch on loadedmetadata.
                const vpEl = el('video-player');
                const at = vpEl ? vpEl.currentTime : 0;
                window._resumePosAfterSwitch = at;
                // Explicit menu pick = play this native quality directly (don't
                // re-apply the settings ceiling and transcode it back down).
                window._qualityOverride = (window.qualityToHeight ? window.qualityToHeight(entry.label) : null) || 'original';
                window.showToast(`Switching to ${entry.label.toUpperCase()}…`, 'info');
                try { if (vpEl) vpEl.pause(); } catch (_) { }
                const title = window.currentMovieTitle || (window.activeStreamingMedia && window.activeStreamingMedia.title) || '';
                if (typeof window.startRDDebridFlow === 'function') {
                    window.startRDDebridFlow(entry.torrent, title, entry.idx);
                }
            });
            menu.appendChild(opt);
        });
    };

    // ── Audio track picker ───────────────────────────────────────────────
    // Populated from the ffprobe result (window._audioTracks). A release name
    // can't tell us which track is a foreign dub, so this is the only reliable
    // way to land on the right audio.
    const AUDIO_LANG_NAMES = {
        en: 'English', fr: 'French', es: 'Spanish', de: 'German', it: 'Italian',
        pt: 'Portuguese', nl: 'Dutch', ru: 'Russian', pl: 'Polish', cs: 'Czech',
        ja: 'Japanese', ko: 'Korean', zh: 'Chinese', hi: 'Hindi', ar: 'Arabic',
        tr: 'Turkish', uk: 'Ukrainian', sv: 'Swedish', hu: 'Hungarian', und: 'Unknown',
    };
    const audioLabel = (t) => {
        const name = AUDIO_LANG_NAMES[t.lang] || (t.lang || 'und').toUpperCase();
        const bits = [];
        if (t.channels) bits.push(t.channels + 'ch');
        if (t.codec) bits.push(String(t.codec).toUpperCase());
        return { name, detail: bits.join(' · '), title: t.title || '' };
    };

    window.refreshAudioMenu = function () {
        const container = el('audio-dropdown-container');
        const menu = el('audio-menu');
        if (!container || !menu) return;

        const info = window._audioTracks;
        const tracks = (info && info.tracks) || [];
        // Only worth showing when there's an actual choice to make.
        if (tracks.length < 2) { container.style.display = 'none'; return; }
        container.style.display = 'inline-block';

        const currentIdx = (window._activeAudioIndex != null)
            ? window._activeAudioIndex : info.defaultAudioIndex;

        const btnTxt = el('audio-btn-text');
        const cur = tracks.find((t) => t.audioIndex === currentIdx) || tracks[0];
        if (btnTxt) btnTxt.innerText = (cur.lang || 'und').toUpperCase();

        menu.innerHTML = '';
        tracks.forEach((t) => {
            const isActive = t.audioIndex === currentIdx;
            const { name, detail, title } = audioLabel(t);
            const opt = document.createElement('div');
            const activeBg = 'rgba(245,185,41,0.18)';
            opt.style.cssText = `padding:6px 12px; cursor:pointer; text-align:left; font-family:var(--font-mono); font-size:11px; transition:background 0.2s; color:${isActive ? 'var(--vault-accent)' : 'var(--vault-text)'}; font-weight:${isActive ? '700' : '500'}; background:${isActive ? activeBg : 'transparent'}; border-left:3px solid ${isActive ? 'var(--vault-accent)' : 'transparent'};`;
            opt.innerHTML = `${window.escapeHtml(name)}` +
                (detail ? ` <span style="color:var(--vault-slate); font-weight:400; font-size:10px;">${window.escapeHtml(detail)}</span>` : '') +
                (title ? `<div style="color:var(--vault-slate); font-size:9.5px; font-weight:400;">${window.escapeHtml(title)}</div>` : '') +
                (isActive ? ` <span style="color:var(--vault-accent); font-weight:700; font-size:9px;">●</span>` : '');
            opt.addEventListener('mouseenter', () => { opt.style.background = 'rgba(245,185,41,0.08)'; });
            opt.addEventListener('mouseleave', () => { opt.style.background = isActive ? activeBg : 'transparent'; });
            opt.addEventListener('click', (e) => {
                e.stopPropagation();
                menu.style.display = 'none';
                if (isActive) return;
                window.switchAudioTrack(t.audioIndex);
            });
            menu.appendChild(opt);
        });
    };

    // Re-open the current stream with a different audio track. The video is
    // copied (not re-encoded) when its codec can be expressed for MediaSource.
    window.switchAudioTrack = async function (audioIndex) {
        const info = window._audioTracks;
        const url = window.activeStreamingMedia && window.activeStreamingMedia.streamUrl;
        if (!info || !url) return;

        const vpEl = el('video-player');
        const at = vpEl ? vpEl.currentTime : 0;
        const track = (info.tracks || []).find((t) => t.audioIndex === audioIndex);
        const langName = track ? (AUDIO_LANG_NAMES[track.lang] || (track.lang || '').toUpperCase()) : '';
        window.showToast(`Switching audio to ${langName}…`, 'info');

        window._activeAudioIndex = audioIndex;
        try { if (vpEl) vpEl.pause(); } catch (_) { }

        const ok = await window.startTranscodePlayback(
            url,
            window.qualityToHeight ? (window.qualityToHeight(window._activeStreamLabel) || 1080) : 1080,
            at,
            { audioIndex, videoInfo: info.videoInfo, durationSec: info.durationSeconds || null },
        );
        if (ok && vpEl) {
            vpEl.play().catch(() => { });
        }
        window.refreshAudioMenu();
    };

    const aBtn = el('btn-audio');
    const aMenu = el('audio-menu');
    if (aBtn && aMenu) {
        aBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const qm = el('quality-menu'); if (qm) qm.style.display = 'none';
            const sm2 = el('subtitles-menu'); if (sm2) sm2.style.display = 'none';
            window.refreshAudioMenu();
            aMenu.style.display = (aMenu.style.display === 'none' || !aMenu.style.display) ? 'block' : 'none';
        });
    }

    // Subtitle setup and upscale setup
    if (typeof window.initSubtitleListeners === 'function') {
        window.initSubtitleListeners();
    }
    if (typeof window.initUpscaleListeners === 'function') {
        if (typeof window.initUpscaleListeners === 'function') window.initUpscaleListeners(); // upscale module removed in Vault Streaming
    }

    // Initialize clip system
    if (typeof window.initClipSystem === 'function') {
        window.initClipSystem();
    }

    // Video Shortcut Keys
    document.addEventListener('keydown', (e) => {
        if (el('video-modal').style.display === 'flex') {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            switch (e.key.toLowerCase()) {
                case ' ':
                    e.preventDefault();
                    if (vp.paused) { vp.play().catch(() => { }); btnPlay.innerHTML = PAUSE_ICON_SVG; }
                    else { vp.pause(); btnPlay.innerHTML = PLAY_ICON_SVG; }
                    break;
                case 'arrowleft':
                    e.preventDefault();
                    vp.currentTime = Math.max(0, vp.currentTime - 5);
                    break;
                case 'arrowright':
                    e.preventDefault();
                    vp.currentTime = Math.min(vp.duration, vp.currentTime + 5);
                    break;
                case 'arrowup':
                    e.preventDefault();
                    saveAndSetVolume(vp.volume + 0.05);
                    break;
                case 'arrowdown':
                    e.preventDefault();
                    saveAndSetVolume(vp.volume - 0.05);
                    break;
                case 'f':
                    e.preventDefault();
                    if (!document.fullscreenElement) vp.parentElement.requestFullscreen();
                    else document.exitFullscreen();
                    break;
                case 'c':
                    if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
                        e.preventDefault();
                        if (window.clipState && window.clipState.active) {
                            window.endClipMode();
                        } else if (typeof window.startClipMode === 'function') {
                            window.startClipMode();
                        }
                    }
                    break;
            }
        }
    });

    seekArea.addEventListener('click', (e) => {
        const rect = seekArea.getBoundingClientRect();
        // duration is NaN until metadata loads, and stays NaN when the source
        // failed — clicking the bar then threw "The provided double value is
        // non-finite" and left the player wedged on the previous title's frame.
        if (!rect.width || !Number.isFinite(vp.duration) || vp.duration <= 0) return;
        const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        const target = ratio * vp.duration;
        if (Number.isFinite(target)) vp.currentTime = target;
    });

    seekArea.addEventListener('mousemove', async (e) => {
        const rect = seekArea.getBoundingClientRect();
        let percent = (e.clientX - rect.left) / rect.width;
        if (percent < 0) percent = 0; if (percent > 1) percent = 1;

        seekPreview.style.display = 'block';
        seekPreview.style.left = (percent * 100) + '%';

        const tooltip = el('seek-time-tooltip');
        if (tooltip) {
            tooltip.style.display = 'block';
            tooltip.style.left = (percent * 100) + '%';
            if (vp.duration && isFinite(vp.duration)) {
                tooltip.innerText = window.formatDuration(percent * vp.duration);
            }
        }

        const tpFolder = vp.dataset.trickplay;
        let usedTrickplay = false;
        if (tpFolder) {
            if (trickFrames.length === 0) trickFrames = await window.electronAPI.getTrickplaySprites(tpFolder);
            if (trickFrames.length > 0) {
                usedTrickplay = true;
                const idx = Math.min(Math.floor(percent * trickFrames.length), trickFrames.length - 1);
                const img = new Image();
                img.onload = () => seekCtx.drawImage(img, 0, 0, seekCanvas.width, seekCanvas.height);
                img.src = window.sanitizePath(trickFrames[idx]);
            }
        }
        if (!usedTrickplay && vp.duration && isFinite(vp.duration) && scrubVideo.src) {
            const targetTime = percent * vp.duration;
            clearTimeout(seekDebounceTimer);
            seekDebounceTimer = setTimeout(() => {
                scrubVideo.currentTime = targetTime;
            }, 60);
        }
    });

    seekArea.addEventListener('mouseleave', () => {
        seekPreview.style.display = 'none';
        const tooltip = el('seek-time-tooltip');
        if (tooltip) tooltip.style.display = 'none';
    });

    // Dismiss speed and subtitles menus
    document.addEventListener('click', (e) => {
        const sm = el('speed-menu');
        if (sm && !e.target.closest('.speed-dropdown-container')) sm.style.display = 'none';
        const sbm = el('subtitles-menu');
        if (sbm && !e.target.closest('.subtitle-dropdown-container')) sbm.style.display = 'none';
    });

    // Esc toggles PiP/minimized mode. Shift+Q closes the player.
    document.addEventListener('keydown', (e) => {
        const modal = el('video-modal');
        if (!modal || modal.style.display !== 'flex') return;
        // Don't intercept while the user is typing in an input/textarea.
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (e.key === 'Escape' && !e.shiftKey && !e.ctrlKey) {
            e.preventDefault();
            e.stopPropagation();
            modal.classList.toggle('minimized');
        } else if (e.shiftKey && (e.key === 'Q' || e.key === 'q')) {
            e.preventDefault();
            e.stopPropagation();
            el('close-modal').click();
        }
    }, true);

    // Auto-hide controls when cursor hovers the app titlebar (above the player)
    const titlebarEl = document.querySelector('.titlebar');
    if (titlebarEl) {
        titlebarEl.addEventListener('mouseenter', () => document.body.classList.add('titlebar-hovered'));
        titlebarEl.addEventListener('mouseleave', () => document.body.classList.remove('titlebar-hovered'));
    }

    // Enable double-click to rename the active local video while playing
    const titleEl = el('player-title');
    if (titleEl) {
        titleEl.style.cursor = 'pointer';
        titleEl.addEventListener('dblclick', () => {
            let itm = null;
            if (window.currentPlayingItem) {
                itm = window.currentPlayingItem;
            } else if (window.currentPlayingIndex !== -1) {
                itm = window.displayedItems[window.currentPlayingIndex];
            }
            if (!itm || !itm.path) return;

            // Prevent multiple input boxes
            if (titleEl.querySelector('input')) return;

            const oldName = itm.name;
            const input = document.createElement('input');
            input.type = 'text';
            input.value = oldName;
            input.style.background = 'var(--vault-bg)';
            input.style.color = 'var(--vault-text)';
            input.style.border = '1px solid var(--vault-accent)';
            input.style.borderRadius = '4px';
            input.style.padding = '2px 8px';
            input.style.fontSize = '14px';
            input.style.fontFamily = 'var(--font-mono)';
            input.style.outline = 'none';
            input.style.width = '350px';
            input.style.textAlign = 'center';

            titleEl.textContent = '';
            titleEl.appendChild(input);
            input.focus();
            input.select();

            const saveRename = async () => {
                const newName = input.value.trim();
                if (!newName || newName === oldName) {
                    const baseTitle = oldName.replace(/\.[^.]+$/, '');
                    if (itm.enhancedPath) {
                        const magicIcon = window.icons ? window.icons.magic('magic-inline-icon', 'width:12px; height:12px; display:inline-block; vertical-align:middle; margin-left:6px; color:var(--vault-gold);') : '';
                        titleEl.innerHTML = `${baseTitle} ${magicIcon}`;
                    } else {
                        titleEl.textContent = baseTitle;
                    }
                    return;
                }

                const res = await window.electronAPI.renameFile(itm.path, newName);
                if (res.success) {
                    const t = window.translations[window.currentLang === 'fr' ? 'fr' : 'en'] || {};
                    window.showToast((t.renamedTo || 'Renamed to ') + `"${newName}"`, 'success');

                    const oldPath = itm.path;
                    const newPath = res.newPath || (itm.path.substring(0, itm.path.lastIndexOf('\\') + 1) + newName);

                    itm.name = newName;
                    itm.path = newPath;

                    const baseTitle = newName.replace(/\.[^.]+$/, '');
                    if (itm.enhancedPath) {
                        const magicIcon = window.icons ? window.icons.magic('magic-inline-icon', 'width:12px; height:12px; display:inline-block; vertical-align:middle; margin-left:6px; color:var(--vault-gold);') : '';
                        titleEl.innerHTML = `${baseTitle} ${magicIcon}`;
                    } else {
                        titleEl.textContent = baseTitle;
                    }

                    const tbTitle = el('titlebar-video-title');
                    if (tbTitle) {
                        if (itm.enhancedPath) {
                            const magicIcon = window.icons ? window.icons.magic('magic-inline-icon', 'width:10px; height:10px; display:inline-block; vertical-align:middle; margin-left:4px; color:var(--vault-gold);') : '';
                            tbTitle.innerHTML = `Playing: ${newName} ${magicIcon} <span style="font-size:9.5px; opacity:0.8;">[Enhanced]</span>`;
                        } else {
                            tbTitle.textContent = `Playing: ${newName}`;
                        }
                    }

                    // Update corresponding card element in layout if open
                    const card = document.querySelector(`.file-card[data-index="${window.currentPlayingIndex}"]`);
                    if (card) {
                        card.dataset.path = newPath;
                        const fn = card.querySelector('.filename');
                        if (fn) fn.innerText = newName;
                        const rInp = card.querySelector('.rename-input');
                        if (rInp) rInp.value = newName;
                    }

                    // Update items list silently to preserve file-grid integrity
                    window.loadDirectory(window.currentNavPath, window.currentRealPath, true);
                } else {
                    window.showToast((window.translations[window.currentLang === 'fr' ? 'fr' : 'en'].renameFailed || 'Rename failed: ') + res.error, 'error');
                    const baseTitle = oldName.replace(/\.[^.]+$/, '');
                    if (itm.enhancedPath) {
                        const magicIcon = window.icons ? window.icons.magic('magic-inline-icon', 'width:12px; height:12px; display:inline-block; vertical-align:middle; margin-left:6px; color:var(--vault-gold);') : '';
                        titleEl.innerHTML = `${baseTitle} ${magicIcon}`;
                    } else {
                        titleEl.textContent = baseTitle;
                    }
                }
            };

            input.addEventListener('blur', saveRename);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    input.blur();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    input.value = oldName;
                    input.blur();
                }
            });
        });
    }
}

// Bring the player up in a "preparing" state and dissolve the source-search
// dialog into it. Previously the dialog was hidden the moment a source resolved
// while playStream still had async work to do, so the user watched the dialog
// vanish, the grid reappear, and then the player drop in on top.
function beginPlayerHandoff() {
    const modal = el('video-modal');
    if (!modal) return;
    modal.classList.remove('minimized');
    modal.classList.add('preparing');
    modal.style.display = 'flex';

    for (const id of ['rd-stream-dialog', 'rd-stream-backdrop']) {
        const node = el(id);
        if (!node || node.style.display === 'none') continue;
        node.classList.add('handing-off');
        setTimeout(() => {
            node.style.display = 'none';
            node.classList.remove('handing-off');
            node.style.opacity = '';
        }, 240);
    }
}

function endPlayerHandoff() {
    const modal = el('video-modal');
    if (modal) modal.classList.remove('preparing');
}

/**
 * Speech detection for the tracks a probe could not name (src/ipc/audio-tracks.ipc.js 'detect-audio-language'):
 * at most 3 tracks, in parallel, 15 s in all. A track detected in the preferred language becomes the one to play.
 * Mutates the probe result the way the probe itself reports a language switch.
 */
async function applyDetectedLanguages(probe, url, proxy) {
    const ids = (probe.undetermined || []).slice(0, 3);
    if (!ids.length) return;
    const started = Date.now();
    // Each answer is kept as it arrives: at the deadline the ones already in count, a slow track does not void the
    // others. A track in the preferred language ends the wait at once.
    const results = [];
    await new Promise(resolve => {
        let pending = ids.length;
        const timer = setTimeout(resolve, 15000);
        const done = () => { clearTimeout(timer); resolve(); };
        ids.forEach(audioIndex => {
            window.electronAPI.detectAudioLanguage({ url, proxy, audioIndex, durationSeconds: probe.durationSeconds })
                .catch(() => null)
                .then(r => {
                    if (r) results.push(r);
                    if ((r && r.success && r.lang === probe.preferredLang) || --pending === 0) done();
                });
        });
    });
    for (const r of results) {
        if (!r || !r.success) continue;
        const t = probe.tracks.find(x => x.audioIndex === r.audioIndex);
        if (t && t.lang === 'und') { t.lang = r.lang; t.langSource = 'detected'; }
    }
    const want = probe.preferredLang;
    const hit = probe.tracks.find(t => t.langSource === 'detected' && t.lang === want);
    console.log(`[audio-tracks] detection in ${Date.now() - started}ms:`,
        probe.tracks.map(t => `a:${t.audioIndex}=${t.lang}(${t.langSource})`).join(' '));
    if (!hit) return;
    probe.chosenAudioIndex = hit.audioIndex;
    probe.chosenLang = hit.lang;
    probe.chosenCodec = hit.codec;
    probe.mismatch = hit.audioIndex !== probe.defaultAudioIndex;
    probe.suggestedAudioIndex = probe.mismatch ? hit.audioIndex : null;
    probe.needsRemux = probe.mismatch || !hit.browserSafe;
    probe.remuxReason = probe.mismatch ? 'language' : (!hit.browserSafe ? `codec:${hit.codec}` : null);
    probe.languageDetected = true;
}

/**
 * What plays becomes searchable (src/ipc/moments.ipc.js -> vault-raggae app/moments/stream.py): once a stream has
 * actually played for two minutes (paused time and seeks do not count), it is handed over once, with the audio track
 * being played and that track's language as the stream reports it. Off with appSettings.indexPlayback = false.
 */
const MOMENTS_AFTER_SECONDS = 15;   // handed to Moments (transcript + search vectors) after 15 s of real playback
function trackMomentsPlayback(vp) {
    const s = window._momentsSession;
    if (!s || s.sent) return;
    if (vp.paused || vp.seeking) { s.last = null; return; }
    const t = vp.currentTime;
    if (s.last != null) {
        const d = t - s.last;
        if (d > 0 && d < 15) s.watched += d;          // a jump (seek, transcode restart) is not watching
    }
    s.last = t;
    if (s.watched < MOMENTS_AFTER_SECONDS || !window.electronAPI || !window.electronAPI.indexPlayback) return;
    s.sent = true;
    const media = window.activeStreamingMedia || {};
    const probe = window._audioTracks;
    const audioIndex = window._activeAudioIndex != null ? window._activeAudioIndex
        : (probe && probe.chosenAudioIndex != null ? probe.chosenAudioIndex : 0);
    const track = probe && Array.isArray(probe.tracks) ? probe.tracks.find(x => x.audioIndex === audioIndex) : null;
    const durationSec = (probe && probe.durationSeconds) || (isFinite(vp.duration) ? vp.duration : null);
    momentsSource(s.url, media, track ? track.lang : null).then((src) => window.electronAPI.indexPlayback({
        url: src.url, title: media.title || s.title, tmdbId: media.tmdbId, mediaType: media.mediaType,
        season: media.season, episode: media.episode, audioIndex: src.audioIndex != null ? src.audioIndex : audioIndex,
        language: track ? track.lang : 'und', languageSource: track ? track.langSource : 'none',
        durationSec, sourceRelease: src.release || media.release || null,
    })).then(r => console.log('[moments] playback handed over:', r && (r.state || r.skipped || r.error)))
      .catch(e => console.warn('[moments] hand-over failed:', e && e.message));
}

/**
 * What Moments reads: a 720p / 480p copy when the played source is above 1080p (js/streaming/ranking.js,
 * momentsCopyCandidates), else the played stream. A copy is resolved through Comet like a play (at most 3 tries) and
 * its audio track is the one in the language being heard. { url, audioIndex?, release? }.
 */
async function momentsSource(playedUrl, media, lang, sources = window.currentTorrentList, label = window._activeStreamLabel) {
    const played = { url: playedUrl };
    try {
        const list = window.momentsCopyCandidates
            ? window.momentsCopyCandidates(sources, label, media.release) : [];
        for (const t of list.slice(0, 3)) {
            const r = await window.electronAPI.streamRDTorrent({ magnet: t.magnet, hash: t.hash, url: t.url, name: t.name,
                                                                 cached: !!t.isRDCached });
            if (!r || !r.success || !r.streamUrl) continue;
            // Each release orders (and has) its own audio tracks: the copy is used only when one of its tracks is in
            // the language being heard — or, that language unknown, when it has a single track. Else the transcript
            // would be of another language, filed under the played one.
            const p = window.electronAPI.probeAudioTracks
                ? await window.electronAPI.probeAudioTracks({ url: r.streamUrl, preferredLang: lang || 'en' }).catch(() => null)
                : null;
            const tracks = p && p.success && Array.isArray(p.tracks) ? p.tracks : [];
            let audioIndex = null;
            if (lang && lang !== 'und') {
                const match = tracks.find(x => x.lang === lang);
                if (match) audioIndex = match.audioIndex;
            } else if (tracks.length === 1) {
                audioIndex = tracks[0].audioIndex;
            }
            if (audioIndex == null) {
                console.log(`[moments] skipping a lighter copy without a ${lang || 'known'} audio track`);
                continue;
            }
            const release = String(t.desc || '').replace(/^📄\s*/, '');
            console.log(`[moments] reading a lighter copy: ${t.quality || ''} ${release.slice(0, 80)}`);
            return { url: r.streamUrl, audioIndex, release };
        }
    } catch (e) {
        console.warn('[moments] lighter copy failed, reading the played stream:', e && e.message);
    }
    return played;
}

// (js/streaming/preload.js: the next episode's read, with that episode's own source list)
window.momentsSourceFor = momentsSource;

async function playStream(url, title) {
    // a new playback: its own 15-second count before it is handed to Moments (streams only, not library files)
    window._momentsSession = (/^https?:\/\//i.test(String(url || ''))
        && !(window.appSettings && window.appSettings.indexPlayback === false))
        ? { url, title, watched: 0, last: null, sent: false } : null;
    if (window.autoplayTimer) {
        clearInterval(window.autoplayTimer);
        window.autoplayTimer = null;
    }
    beginPlayerHandoff();
    const endedOverlay = el('video-ended-overlay');
    if (endedOverlay) endedOverlay.style.display = 'none';

    const prevBtn = el('btn-prev');
    const nextBtn = el('btn-next');
    if (prevBtn) prevBtn.style.display = 'none';
    if (nextBtn) nextBtn.style.display = 'none';
    const pipPrevBtn = el('pip-btn-prev');
    const pipNextBtn = el('pip-btn-next');
    if (pipPrevBtn) pipPrevBtn.style.display = 'none';
    if (pipNextBtn) pipNextBtn.style.display = 'none';

    window.currentPlayingIndex = -1;
    trickFrames = [];
    vp.dataset.trickplay = '';

    // Route to Swift native player when running inside the iOS app container
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.vaultStreamingBridge) {
        endPlayerHandoff();
        const modal = el('video-modal');
        if (modal) {
            modal.style.display = 'none';
            modal.classList.remove('preparing');
        }
        const media = window.activeStreamingMedia || {};
        const fetchProgress = (window.electronAPI && typeof window.electronAPI.getWatchProgress === 'function')
            ? window.electronAPI.getWatchProgress({
                mediaType: media.mediaType,
                tmdbId: media.tmdbId,
                title: media.title,
                season: media.season,
                episode: media.episode
            }).catch(() => null)
            : Promise.resolve(null);

        fetchProgress.then((prog) => {
            const startPos = (prog && prog.positionSec) || 0;
            window.webkit.messageHandlers.vaultStreamingBridge.postMessage({
                action: 'playNative',
                url: url,
                title: title || media.title || '',
                posterUrl: media.backdropUrl || media.posterUrl || '',
                startPosition: startPos,
                mediaType: media.mediaType || null,
                season: media.season || null,
                episode: media.episode || null
            });
        });
        return;
    }

    // A Comet / debrid status video ("Requested stream was not found", a copyright block…) is a clip of a few seconds.
    // A movie or episode never is: treat it as a failed source, forget it as the title's last source, search again.
    const media = window.activeStreamingMedia;
    if (media && /^https?:\/\//i.test(String(url || ''))) {
        vp.addEventListener('loadedmetadata', function statusVideoGuard() {
            if (window.activeStreamingMedia !== media || !isFinite(vp.duration) || vp.duration >= 60) return;
            statusVideoFound(media);
        }, { once: true });
    }
    window._streamLastGood = 0;
    window._streamAutoReloads = { count: 0, at: 0 };
    vp.src = url;

    // Arm the overlay teardown HERE, immediately after the source is assigned.
    // Attaching it at the end of this function raced against the media element:
    // playStream still has async work to do (subtitle lookup, audio probe), so
    // loadeddata — or an early error — had usually already fired by then and
    // only the 15s timeout cleared the spinner, leaving it over playing video.
    const clearOverlay = () => {
        endPlayerHandoff();
        vp.removeEventListener('loadeddata', clearOverlay);
        vp.removeEventListener('playing', clearOverlay);
        vp.removeEventListener('error', clearOverlay);
        clearTimeout(window._handoffTimeout);
    };
    clearTimeout(window._handoffTimeout);
    window._handoffTimeout = setTimeout(clearOverlay, 15000);
    if (vp.readyState >= 2 || vp.error) {
        clearOverlay();
    } else {
        vp.addEventListener('loadeddata', clearOverlay);
        vp.addEventListener('playing', clearOverlay);
        vp.addEventListener('error', clearOverlay);
    }
    vp.muted = false;
    if (lastScrubSrc !== url) {
        scrubVideo.src = url;
        lastScrubSrc = url;
    }

    // "Series · S06E14 · Episode name" (or the film's title) in the player and the app bar (js/player/episodes.js)
    if (typeof window.updatePlayerTitles === 'function') window.updatePlayerTitles(title);
    // series: prev/next episode buttons, Up next card, skip intro/credits, episodes panel (js/player/series-controls.js)
    if (typeof window.seriesControlsOnPlay === 'function') window.seriesControlsOnPlay();

    if (window.activeStreamingMedia) {
        window.activeStreamingMedia.streamUrl = url;
        window.activeStreamingMedia.streamTitle = title;
    }

    // Fetch watch progress early
    let prog = null;
    if (window.activeStreamingMedia) {
        try {
            prog = await window.electronAPI.getWatchProgress({
                mediaType: window.activeStreamingMedia.mediaType,
                tmdbId: window.activeStreamingMedia.tmdbId,
                title: window.activeStreamingMedia.title,
                season: window.activeStreamingMedia.season,
                episode: window.activeStreamingMedia.episode
            });
        } catch (e) {
            console.error('[Player] Failed to fetch watch progress:', e);
        }
    }

    // ── Down-transcode decision ─────────────────────────────────────────────
    // If the source exceeds the user's Max Stream Quality ceiling (or a one-shot
    // menu/badge override applies), play through the ffmpeg transcoder instead of
    // the raw URL. ffmpeg -ss handles the resume position, so the loadedmetadata
    // seeks further down are skipped for transcoded playback (see _transcodePlay).
    // ── Audio-track probe (runs BEFORE playback) ────────────────────────────
    // Deciding the track up front means the movie opens with the right language
    // and a decodable codec, instead of starting silent/wrong and correcting
    // itself a few seconds in. Capped so a slow probe can't stall playback.
    window._audioTracks = null;
    window._activeAudioIndex = null;
    if (typeof window.refreshAudioMenu === 'function') window.refreshAudioMenu();

    let audioProbe = null;
    if (window.electronAPI && window.electronAPI.probeAudioTracks && url) {
        const _proxy = (window.appSettings && window.appSettings.debridProxyEnable)
            ? (window.appSettings.debridProxyAddress || '') : '';
        try {
            audioProbe = await Promise.race([
                window.electronAPI.probeAudioTracks({
                    url,
                    proxy: _proxy,
                    preferredLang: (window.appSettings && window.appSettings.streamLang) || 'en',
                }),
                new Promise((resolve) => setTimeout(() => resolve(null), 12000)),
            ]);
        } catch (_) { audioProbe = null; }

        if (audioProbe && audioProbe.success) {
            // No reported track is in the preferred language, but some report none: ask speech detection about those
            // (in parallel, capped). What a stream reports is never overridden by a guess.
            if (audioProbe.needsDetection && window.electronAPI.detectAudioLanguage) {
                await applyDetectedLanguages(audioProbe, url, _proxy);
            }
            window._audioTracks = audioProbe;
            if (typeof window.refreshAudioMenu === 'function') window.refreshAudioMenu();

            // The probe knows the real runtime, so a trailer/sample that slipped
            // past the title-and-size heuristics in ranking.js gets caught here —
            // the only place we ever see the actual file rather than its name.
            // Episodes are legitimately short, so only movies are checked.
            const isEpisode = !!(window.activeStreamingMedia
                && (window.activeStreamingMedia.mediaType === 'tv'
                    || window.activeStreamingMedia.season != null));
            if (audioProbe.implausibleRuntime && !isEpisode) {
                const mins = Math.round((audioProbe.durationSeconds || 0) / 60);
                console.warn(`[audio-tracks] source runtime is ${mins} min — likely a trailer or sample, not the feature`);
                window.showToast(
                    `This source is only ${mins} min long — probably a trailer. Use "Choose Manually" to pick another.`,
                    'error');
            }
        } else {
            audioProbe = null;
            console.warn('[audio-tracks] probe unavailable — playing source directly');
        }
    }

    {
        const srcQ = window.activeStreamingMedia && window.activeStreamingMedia.quality;
        const tHeight = window.decideTranscodeHeight ? window.decideTranscodeHeight(srcQ) : null;
        window._qualityOverride = null; // one-shot; consumed after the decision

        // Take over playback when the audio needs fixing: wrong language, or a
        // codec this build can't decode (DTS/TrueHD would play silently).
        const needAudioFix = !!(audioProbe && audioProbe.needsRemux && audioProbe.chosenAudioIndex != null);
        const audioIdx = needAudioFix ? audioProbe.chosenAudioIndex : null;
        if (needAudioFix) {
            window._activeAudioIndex = audioIdx;
            if (typeof window.refreshAudioMenu === 'function') window.refreshAudioMenu();
            if (audioProbe.remuxReason === 'language') {
                window.showToast(
                    `Audio: using ${String(audioProbe.chosenLang).toUpperCase()} track` +
                    (audioProbe.languageDetected ? ' (language detected from speech)' : ` (default was ${String(audioProbe.defaultLang).toUpperCase()})`),
                    'info');
            } else {
                window.showToast(`Preparing ${String(audioProbe.chosenCodec || '').toUpperCase()} audio…`, 'info');
            }
            console.warn('[audio-tracks] taking over playback before start —',
                audioProbe.remuxReason, '-> a:' + audioIdx);
        }

        if (tHeight || needAudioFix) {
            const resumeAt = (typeof window._resumePosAfterSwitch === 'number' && window._resumePosAfterSwitch > 0)
                ? window._resumePosAfterSwitch
                : (prog && !prog.completed && prog.positionSec > 0 ? prog.positionSec : 0);
            window._resumePosAfterSwitch = null;   // handled by ffmpeg -ss, not a vp seek
            window._transcodePlay = true;
            // No quality ceiling but an audio fix? Then the video is copied, so
            // the height is only a fallback for codecs we can't express for MSE.
            const h = tHeight || (window.qualityToHeight ? (window.qualityToHeight(window._activeStreamLabel) || 1080) : 1080);
            const durationSec = audioProbe && audioProbe.durationSeconds ? audioProbe.durationSeconds : null;
            window.startTranscodePlayback(url, h, resumeAt,
                needAudioFix ? { audioIndex: audioIdx, videoInfo: audioProbe.videoInfo, durationSec }
                    : { durationSec, videoInfo: audioProbe ? audioProbe.videoInfo : null });
        } else {
            window._transcodePlay = false;
            if (window.stopTranscode) window.stopTranscode(); // tear down any prior session
        }
    }

    try {
        // the default OpenSubtitles match (by IMDb id) and, once vault-raggae has made it, the AI transcript
        await window.loadStreamSubtitles(url, title, prog);
    } catch (err) {
        console.error("Auto subtitle loading error:", err);
    }

    // If the user just switched stream quality, restore their position from
    // the in-memory marker (takes precedence over saved server progress
    // because they were mid-watch when they switched). Also explicitly call
    // play() after the seek — the upfront vp.play() may have been blocked
    // because the new src wasn't ready yet, leaving the player paused.
    if (!window._transcodePlay && typeof window._resumePosAfterSwitch === 'number' && window._resumePosAfterSwitch > 0) {
        const resumeAt = window._resumePosAfterSwitch;
        window._resumePosAfterSwitch = null;
        const seekOnce = () => {
            if (resumeAt < vp.duration - 5) vp.currentTime = resumeAt;
            // Resume playback after seek (the initial vp.play() may have
            // rejected on the still-loading src).
            vp.play().catch(e => console.log('[Player] resume after quality switch:', e));
            vp.removeEventListener('loadedmetadata', seekOnce);
        };
        vp.addEventListener('loadedmetadata', seekOnce);
    } else if (!window._transcodePlay && prog && prog.positionSec > 0 && prog.durationSec > 0 && !prog.completed) {
        // Restore stream playback progress from saved server-side watch progress.
        const restoreOnce = () => {
            if (prog.positionSec < vp.duration - 15) {
                vp.currentTime = prog.positionSec;
                window.showToast(`Resumed from ${window.formatDuration(prog.positionSec)}`, 'success');
            }
            vp.removeEventListener('loadedmetadata', restoreOnce);
        };
        vp.addEventListener('loadedmetadata', restoreOnce);
    }

    // Refresh the quality picker — visible whenever currentTorrentList exists.
    if (typeof window.refreshQualityMenu === 'function') window.refreshQualityMenu();
    // Re-evaluate the autoplay toggle: it's shown for series, hidden for movies.
    updateAutoplayUI();

    // (The audio-track probe runs BEFORE playback — see the decision block above.)

    el('video-modal').classList.remove('minimized');
    btnPlay.innerHTML = PAUSE_ICON_SVG;
    el('video-modal').style.display = 'flex';
    el('video-modal').focus();

    vp.play().catch(e => console.log("Stream playback start prevented or failed:", e));
}

// Bind globals
window.playItem = playItem;
window.initPlayer = initPlayer;
window.playStream = playStream;

// Native iOS Player progress synchronization callback
window.onNativePlaybackProgress = function (data) {
    if (!data) return;
    const { position, duration, completed } = data;
    console.log('[NativeBridge] Progress received from iOS player:', position, '/', duration, 'completed:', completed);
    const modal = el('video-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('preparing');
        modal.classList.remove('minimized');
    }
    if (window.activeStreamingMedia && window.electronAPI && typeof window.electronAPI.saveWatchProgress === 'function') {
        window.electronAPI.saveWatchProgress({
            mediaType: window.activeStreamingMedia.mediaType,
            tmdbId: window.activeStreamingMedia.tmdbId,
            title: window.activeStreamingMedia.title,
            season: window.activeStreamingMedia.season,
            episode: window.activeStreamingMedia.episode,
            positionSec: Math.round(position || 0),
            durationSec: Math.round(duration || 0),
            completed: !!completed
        }).catch(err => console.error('[NativeBridge] Failed to save progress:', err));
    }
};

// Handler when the native iOS media player is closed/dismissed
window.onNativePlayerDismissed = function () {
    console.log('[NativeBridge] Native player dismissed by user');
    const modal = el('video-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('preparing');
        modal.classList.remove('minimized');
    }
    const endedOverlay = el('video-ended-overlay');
    if (endedOverlay) endedOverlay.style.display = 'none';
    if (el('titlebar-video-title')) el('titlebar-video-title').style.display = 'none';
    if (window.autoplayTimer) {
        clearInterval(window.autoplayTimer);
        window.autoplayTimer = null;
    }
    if (typeof vp !== 'undefined' && vp) {
        vp.pause();
        vp.removeAttribute('src');
        vp.load();
    }
};


