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
    } else if (action === 'pip') {
        el('video-modal').classList.toggle('minimized');
    } else if (action === 'fullscreen') {
        if (!vp) return;
        if (!document.fullscreenElement) vp.parentElement.requestFullscreen();
        else document.exitFullscreen();
    } else if (action === 'generate-webm') {
        if (!itemPath) { window.showToast('No video path available', 'error'); return; }
        window.electronAPI.generateWebm(itemPath, window.currentRealPath).then(async res => {
            if (!res.success) {
                window.showToast('Preview failed: ' + res.error, 'error');
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
                window.showToast('Preview generated', 'success');
            }
        });
    } else if (action === 'normalize-audio') {
        if (!itemPath) { window.showToast('No video path available', 'error'); return; }
        window.showToast('Enhancing audio in background...', 'success');
        window.electronAPI.normalizeAudio(itemPath, window.currentRealPath, false).then(res => {
            if (res.success || res.status === 'SUCCESS' || res.status === 'EXISTS') {
                window.showToast(`${menuItem.name || 'Video'}: Audio enhanced`, 'success');
            } else {
                window.showToast(`${menuItem.name || 'Video'}: Audio enhancement failed: ` + (res.error || 'Unknown'), 'error');
            }
        });
    } else if (action === 'generate-subtitles-prompt') {
        if (!itemPath) { window.showToast('No video path available', 'error'); return; }
        const defaultLangs = (window.appSettings && window.appSettings.preferredASRLangs) || ['en'];
        const langs = await window.showLanguageModal('Generate Subtitles', true, defaultLangs);
        if (langs && langs.length > 0) {
            if (!window.appSettings) window.appSettings = {};
            window.appSettings.preferredASRLangs = langs;
            window.electronAPI.saveSettings(window.appSettings);
            window.showToast(`Generating subtitles for ${menuItem.name || 'video'}: ${langs.join(', ').toUpperCase()}`, 'success');
            window.electronAPI.normalizeAudio(itemPath, window.currentRealPath, true).then(res => {
                if (res.success || res.status === 'SUCCESS' || res.status === 'EXISTS') {
                    window.showToast(`${menuItem.name || 'Video'}: Subtitles generated`, 'success');
                    refreshDirectoryWithScrollPreservation();
                } else {
                    window.showToast(`${menuItem.name || 'Video'}: Subtitles failed: ` + (res.error || 'Unknown'), 'error');
                }
            });
        }
    } else if (action === 'translate-video-prompt') {
        if (!itemPath) { window.showToast('No video path available', 'error'); return; }
        const defaultTransLangs = (window.appSettings && window.appSettings.preferredTransLang) ? [window.appSettings.preferredTransLang] : [];
        const lang = await window.showLanguageModal('Translate Video Track', false, defaultTransLangs);
        if (lang && lang.length > 0) {
            if (!window.appSettings) window.appSettings = {};
            window.appSettings.preferredTransLang = lang[0];
            window.electronAPI.saveSettings(window.appSettings);
            window.showToast(`Synthesizing translation to ${lang[0].toUpperCase()} for ${menuItem.name || 'video'}...`, 'success');
            window.electronAPI.normalizeAudio(itemPath, window.currentRealPath, false, lang[0]).then(res => {
                if (res.success || res.status === 'SUCCESS' || res.status === 'EXISTS') {
                    window.showToast(`${menuItem.name || 'Video'}: Translation complete`, 'success');
                    refreshDirectoryWithScrollPreservation();
                } else {
                    window.showToast(`${menuItem.name || 'Video'}: Translation failed: ` + (res.error || 'Unknown'), 'error');
                }
            });
        }
    } else if (action === 'enhance-video-prompt') {
        if (!itemPath) { window.showToast('No video path available', 'error'); return; }
        const dialogItem = window.currentPlayingItem || { path: itemPath, name: menuItem.name, type: 'video' };
        const config = await window.showVideoEnhancementDialog(dialogItem);
        if (config && config.execute) {
            window.showToast(`AI Video Optimization started for ${menuItem.name || 'video'}...`, 'success');
            const vsrQuality = (window.appSettings && window.appSettings.vsrQuality) || 'HIGH';
            const vsrScale = (window.appSettings && window.appSettings.vsrScale) || '2';
            const vsrChroma = (window.appSettings && window.appSettings.vsrChroma) || 'yuv420p';
            window.electronAPI.upscaleVideo({ path: itemPath, quality: vsrQuality, scale: vsrScale, chroma: vsrChroma }).then(res => {
                if (res.success) {
                    window.showToast(`${menuItem.name || 'Video'}: Enhancement started`, 'success');
                } else {
                    window.showToast(`${menuItem.name || 'Video'}: Enhancement failed: ` + (res.error || 'Unknown'), 'error');
                }
            });
        }
    } else if (action === 'properties') {
        if (!itemPath) { window.showToast('No video path available', 'error'); return; }
        window.showPropertiesDialog({ path: itemPath, name: menuItem.name, type: 'video' });
    }
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
    if (!btnVol) return;
    let pathContent = '';
    if (vol === 0) {
        pathContent = `<path d="M 7 11 L 7 9 L 11 9 L 15 5 L 15 19 L 11 15 L 7 15 L 7 13" /><line x1="18" y1="9" x2="22" y2="13" /><line x1="18" y1="13" x2="21" y2="10" />`;
    } else if (vol < 0.5) {
        pathContent = `<path d="M 7 11 L 7 9 L 11 9 L 15 5 L 15 19 L 11 15 L 7 15 L 7 13" /><path d="M 18 9 A 3 3 0 0 1 18 15" />`;
    } else {
        pathContent = `<path d="M 7 11 L 7 9 L 11 9 L 15 5 L 15 19 L 11 15 L 7 15 L 7 13" /><path d="M 18 9 A 3 3 0 0 1 18 15" /><path d="M 21 7 A 6 6 0 0 1 21 17" />`;
    }
    btnVol.innerHTML = window.icons ? window.icons.volume('', 'width:16px; height:16px; display:block;', pathContent) : '';
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

    // A live subtitle session is bound to the previous file — end it before we
    // swap sources so its cues don't bleed onto the new video.
    if (typeof window.stopLiveSubtitles === 'function') window.stopLiveSubtitles(true);

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

    vp.querySelectorAll('track').forEach(t => t.remove());
    try {
        const subs = await window.electronAPI.findSubtitles(itm.path, null, true);
        if (subs && subs.length > 0) {
            // Find the best matching subtitle for user's preferred language
            const prefLang = (window.appSettings && window.appSettings.defaultSubLang) || 'original';
            let bestSub = null;

            // Priority order: 1. Exact match with prefLang, 2. Language starts with prefLang, 3. Original, 4. First available
            for (const sub of subs) {
                const subLang = sub.lang || '';
                const subLabel = sub.label || '';

                if (prefLang === 'original' && subLabel.toLowerCase() === 'original') {
                    bestSub = sub;
                    break;
                } else if (prefLang !== 'und' && subLang.toLowerCase() === prefLang.toLowerCase()) {
                    bestSub = sub;
                    break;
                } else if (prefLang !== 'und' && subLabel.toLowerCase().includes(`(${prefLang.toLowerCase()})`)) {
                    bestSub = sub;
                    break;
                }
            }

            // If no exact match, fall back to first subtitle
            if (!bestSub && subs.length > 0) {
                bestSub = subs[0];
            }

            // Only load the best matching subtitle
            if (bestSub) {
                const track = document.createElement('track');
                track.kind = 'subtitles';
                track.label = bestSub.isOpenSubtitles ? bestSub.label : (bestSub.label === 'Original' ? 'original' : `Subtitles (${bestSub.label})`);
                track.srclang = bestSub.lang;
                if (bestSub.isOpenSubtitles) {
                    track.dataset.opensubtitles = "true";
                    track.dataset.fileId = bestSub.fileId;
                    track.dataset.lang = bestSub.lang;
                    track.dataset.videoPath = itm.path;
                    track.dataset.downloaded = "false";
                    track.src = "";
                } else {
                    track.src = window.sanitizePath(bestSub.path);
                }
                vp.appendChild(track);

                window.refreshSubtitlesList();
                window.selectSubtitleTrack(0);
                window.showToast(`Loaded subtitle: ${track.label}`, 'success');
            }
        } else {
            window.refreshSubtitlesList();
            window.selectSubtitleTrack(-1);
        }
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
            if (typeof window.stopLiveSubtitles === 'function') window.stopLiveSubtitles(true);
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
            const menuItem = {
                type: 'videoPlayer',
                path: item.path || item.src || (vp.src ? decodeURIComponent(vp.src.replace('file:///', '').replace(/\//g, '\\')) : ''),
                name: item.name || item.title || 'Video',
                isStreaming,
                isPlaying: !vp.paused,
                isMuted: vp.muted,
                speed: vp.playbackRate
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

        // Stop any running live ASR subtitle session and drop its track.
        if (typeof window.stopLiveSubtitles === 'function') window.stopLiveSubtitles(true);

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

        // Final position save to persistent Watch History
        if (vp.duration > 0) {
            if (window.activeStreamingMedia) {
                const completed = vp.currentTime >= vp.duration - 15; // 15 seconds from end counts as finished
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
                    const completed = vp.currentTime >= vp.duration - 15;
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
                    const completed = vp.currentTime >= vp.duration - 15;
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
            if (window.activeStreamingMedia) {
                window.electronAPI.setWatchProgress({
                    ...window.activeStreamingMedia,
                    positionSec: vp.currentTime,
                    durationSec: vp.duration
                });
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
        let errMsg = 'Unknown playback error.';
        if (err) {
            switch (err.code) {
                case 1:
                    // User aborted - don't show error toast
                    console.log('[Video Player] Playback aborted by user - ignoring error');
                    return;
                case 2: errMsg = 'Network error occurred while loading video.'; break;
                case 3: errMsg = 'Video decoding failed or format is not supported.'; break;
                case 4: errMsg = 'Video source could not be loaded (invalid or expired link).'; break;
            }
        }
        console.error('[Video Player Error]', err || e);
        window.showToast(`Playback Error: ${errMsg}`, 'error');
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
        if (nextIdx < window.displayedItems.length) {
            if (window.autoplayMode !== 'off') {
                if (window.autoplayMode === 'instant') {
                    playItem(nextIdx);
                    return;
                }

                window.autoplayCountdown = (window.autoplayMode === '3s') ? 3 : 5;
                countdownEl.innerText = `Next video in ${window.autoplayCountdown} seconds... (Click to play now)`;
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
                        countdownEl.innerText = `Next video in ${window.autoplayCountdown} seconds... (Click to play now)`;
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
        // Reset idle state on transition so controls aren't stuck hidden.
        document.body.classList.remove('player-idle');
    });

    // Idle-hide: hide custom controls + cursor after 2s of mouse inactivity
    // while the player modal is open. Any mousemove cancels the hide.
    let _idleTimer = null;
    const markActive = () => {
        const wasIdle = document.body.classList.contains('player-idle');
        document.body.classList.remove('player-idle');
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
            const menuOpen = ['quality-menu', 'subtitles-menu', 'speed-menu'].some(id => {
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
        ordered.forEach(entry => {
            const opt = document.createElement('div');
            const isActive = currentLabel === entry.label;
            const activeBg = 'rgba(245,185,41,0.18)';
            opt.style.cssText = `padding:6px 12px; cursor:pointer; text-align:left; font-family:var(--font-mono); font-size:11px; transition:background 0.2s; color:${isActive ? 'var(--vault-accent)' : 'var(--vault-text)'}; font-weight:${isActive ? '700' : '500'}; background:${isActive ? activeBg : 'transparent'}; border-left:3px solid ${isActive ? 'var(--vault-accent)' : 'transparent'};`;
            const nowPlaying = isActive ? ` <span style="color:var(--vault-accent); font-weight:700; font-size:9px; text-transform:uppercase; letter-spacing:0.04em;">● now playing</span>` : '';
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
        vp.currentTime = ((e.clientX - rect.left) / rect.width) * vp.duration;
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

async function playStream(url, title) {
    if (window.autoplayTimer) {
        clearInterval(window.autoplayTimer);
        window.autoplayTimer = null;
    }
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
    vp.src = url;
    vp.muted = false;
    if (lastScrubSrc !== url) {
        scrubVideo.src = url;
        lastScrubSrc = url;
    }

    const titleEl = el('player-title');
    if (titleEl) titleEl.innerHTML = `${window.icons.lightning('', 'width:13px;height:13px;vertical-align:middle;')} RD Stream: ${window.escapeHtml(String(title || ''))}`;
    const tbTitle = el('titlebar-video-title');
    if (tbTitle) {
        tbTitle.textContent = `RD Streaming: ${title}`;
        tbTitle.style.display = 'inline-block';
    }

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
    {
        const srcQ = window.activeStreamingMedia && window.activeStreamingMedia.quality;
        const tHeight = window.decideTranscodeHeight ? window.decideTranscodeHeight(srcQ) : null;
        window._qualityOverride = null; // one-shot; consumed after the decision
        if (tHeight) {
            const resumeAt = (typeof window._resumePosAfterSwitch === 'number' && window._resumePosAfterSwitch > 0)
                ? window._resumePosAfterSwitch
                : (prog && !prog.completed && prog.positionSec > 0 ? prog.positionSec : 0);
            window._resumePosAfterSwitch = null;   // handled by ffmpeg -ss, not a vp seek
            window._transcodePlay = true;
            window.startTranscodePlayback(url, tHeight, resumeAt); // overrides vp.src with a MediaSource
        } else {
            window._transcodePlay = false;
            if (window.stopTranscode) window.stopTranscode(); // tear down any prior session
        }
    }

    vp.querySelectorAll('track').forEach(t => t.remove());
    try {
        const subs = await window.electronAPI.findSubtitles(url, title);
        // Bug fix: the streaming path never populated _allAvailableSubtitles,
        // so the menu only showed the one auto-loaded sub. Set it so the menu
        // exposes every OpenSubtitles result the search returned.
        window._allAvailableSubtitles = subs || [];
        let preferredSub = null;
        let preferredTrackIdx = -1;

        // Determine preferred language
        const prefLang = (window.appSettings && window.appSettings.defaultSubLang) || 'original';

        // If we have saved progress with subtitle info, use that
        if (prog && prog.selectedSubtitleTrackIdx !== undefined) {
            // Try to find the saved subtitle from the list
            if (prog.selectedSubtitleLabel) {
                preferredSub = subs.find(s => s.label === prog.selectedSubtitleLabel);
            }
            if (!preferredSub && prog.selectedSubtitleLang) {
                preferredSub = subs.find(s => s.lang === prog.selectedSubtitleLang);
            }
            if (!preferredSub && prog.selectedSubtitleTrackIdx >= 0 && prog.selectedSubtitleTrackIdx < subs.length) {
                preferredSub = subs[prog.selectedSubtitleTrackIdx];
            }
        }

        // If no saved preference, find the best match for user's preferred language
        if (!preferredSub && subs && subs.length > 0) {
            if (prefLang === 'original') {
                preferredSub = subs.find(s => s.label.toLowerCase() === 'original');
            } else if (prefLang !== 'und') {
                preferredSub = subs.find(s =>
                    (s.lang && s.lang.toLowerCase().startsWith(prefLang.toLowerCase())) ||
                    (s.label && s.label.toLowerCase().includes(`(${prefLang.toLowerCase()})`))
                );
            }
            // If no match found, use the first available subtitle
            if (!preferredSub) {
                preferredSub = subs[0];
            }
        }

        // Only load the preferred subtitle track (max 1)
        if (preferredSub) {
            const track = document.createElement('track');
            track.kind = 'subtitles';
            track.label = preferredSub.isOpenSubtitles ? preferredSub.label : (preferredSub.label === 'Original' ? 'original' : `Subtitles (${preferredSub.label})`);
            track.srclang = preferredSub.lang;
            if (preferredSub.isOpenSubtitles) {
                track.dataset.opensubtitles = "true";
                track.dataset.fileId = preferredSub.fileId;
                track.dataset.lang = preferredSub.lang;
                track.dataset.videoPath = url;
                track.dataset.downloaded = "false";
                track.src = "";
            } else {
                track.src = window.sanitizePath(preferredSub.path);
            }
            vp.appendChild(track);
            preferredTrackIdx = 0; // Only one track, so index is 0

            window.selectSubtitleTrack(preferredTrackIdx);
            window.refreshSubtitlesList();

            const t = window.translations[window.currentLang === 'fr' ? 'fr' : 'en'] || {};
            window.showToast(preferredSub.isOpenSubtitles
                ? (t.downloadingSubtitles || 'Downloading subtitles...')
                : (t.subtitlesReady || 'Subtitles ready'), 'success');
        } else {
            window.refreshSubtitlesList();
            window.selectSubtitleTrack(-1);
        }
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
