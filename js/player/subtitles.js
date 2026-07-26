// subtitles.js — manages subtitle track finding, downloading OpenSubtitles srt sidecars, and subtitle menu populating/track selection.

async function selectSubtitleTrack(trackIdx) {
    const vp = el('video-player');
    if (!vp) return;

    if (window.activeStreamingMedia) {
        window.activeStreamingMedia.selectedSubtitleTrackIdx = trackIdx;
        if (trackIdx >= 0 && vp.textTracks[trackIdx]) {
            window.activeStreamingMedia.selectedSubtitleLabel = vp.textTracks[trackIdx].label || '';
            window.activeStreamingMedia.selectedSubtitleLang = vp.textTracks[trackIdx].language || '';
        } else {
            window.activeStreamingMedia.selectedSubtitleLabel = '';
            window.activeStreamingMedia.selectedSubtitleLang = '';
        }
    }

    for (let i = 0; i < vp.textTracks.length; i++) {
        vp.textTracks[i].mode = 'disabled';
    }

    // Toggle subtitle padding class on video wrapper
    const subsOn = trackIdx >= 0 && !!vp.textTracks[trackIdx];
    const videoWrapper = document.querySelector('.video-wrapper');
    if (videoWrapper) {
        if (subsOn) {
            videoWrapper.classList.add('subtitles-active');
        } else {
            videoWrapper.classList.remove('subtitles-active');
        }
    }
    // The sync-delay row only makes sense when a subtitle track is active.
    const syncRow = el('subtitle-sync-row');
    if (syncRow) syncRow.style.display = subsOn ? '' : 'none';

    const t = window.translations[window.currentLang === 'fr' ? 'fr' : 'en'] || {};
    if (trackIdx >= 0 && vp.textTracks[trackIdx]) {
        const trackEl = vp.querySelectorAll('track')[trackIdx];
        if (trackEl && trackEl.dataset.opensubtitles === "true" && trackEl.dataset.downloaded === "false") {
            window.showToast(t.downloadingSubtitles || 'Downloading subtitles...', 'success');
            try {
                const fileId = trackEl.dataset.fileId;
                const lang = trackEl.dataset.lang;
                const videoPath = trackEl.dataset.videoPath;

                const localPath = await window.electronAPI.downloadSubtitleTrack({ fileId, lang, videoPath });
                if (localPath) {
                    trackEl.src = window.sanitizePath(localPath);
                    trackEl.dataset.downloaded = "true";
                    window.showToast(t.subtitlesReady || 'Subtitles ready', 'success');

                    vp.textTracks[trackIdx].mode = 'disabled';
                    setTimeout(() => {
                        const vpReal = el('video-player');
                        if (vpReal && vpReal.textTracks[trackIdx]) {
                            vpReal.textTracks[trackIdx].mode = 'showing';
                        }
                    }, 50);
                } else {
                    throw new Error("Empty path");
                }
            } catch (err) {
                console.error("OpenSubtitles download failed:", err);
                window.showToast(t.downloadFailed || 'Download failed', 'error');
                return;
            }
        }

        vp.textTracks[trackIdx].mode = 'showing';
    }

    const btn = el('btn-subtitles');
    if (btn) {
        btn.classList.toggle('active', trackIdx >= 0);
        // Show only 2-letter language code in button
        const rawLang = (trackIdx >= 0 && vp.textTracks[trackIdx])
            ? (vp.textTracks[trackIdx].language || vp.textTracks[trackIdx].label || 'CC')
            : 'CC';
        const ccText = rawLang.substring(0, 2).toUpperCase();
        const svgIcon = window.icons ? window.icons.subtitles('', 'width:14px; height:14px; display:block; flex-shrink:0;') : '';
        btn.innerHTML = `${svgIcon}<span>${ccText}</span>`;
    }

    const options = el('subtitles-menu').querySelectorAll('.subtitle-option');
    options.forEach(opt => {
        const idx = parseInt(opt.dataset.idx);
        if (idx === trackIdx) {
            opt.classList.add('active');
            opt.style.color = 'var(--vault-accent)';
            opt.style.fontWeight = '600';
        } else {
            opt.classList.remove('active');
            opt.style.color = 'var(--vault-text)';
            opt.style.fontWeight = 'normal';
        }
    });
}

// Select subtitle from the allAvailableSubtitles array by index
function selectSubtitleByIndex(idx) {
    // Picking a loaded subtitle is exclusive with AI subs — stop the live
    // session so its in-memory track doesn't keep rendering on top.
    if (window._liveSubActive && idx >= 0) window.stopLiveSubtitles(true);
    if (!window._allAvailableSubtitles || idx < 0 || idx >= window._allAvailableSubtitles.length) {
        window._selectedSubtitleIdx = -1;
        selectSubtitleTrack(-1);
        return;
    }
    // Track the renderer's selected index explicitly. The previous active-state
    // check tried to reverse-derive it by comparing track.label/srclang/src
    // against the sub catalog — which collapses any duplicate-label or
    // shared-language entries onto the first match (so picking the 2nd
    // English sub still highlighted the 1st).
    window._selectedSubtitleIdx = idx;
    const sub = window._allAvailableSubtitles[idx];
    const vp = el('video-player');
    if (!vp) return;

    // Remove all existing tracks
    vp.querySelectorAll('track').forEach(t => t.remove());

    // Create and load the selected subtitle
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = sub.label || `Track ${idx + 1}`;
    track.srclang = sub.lang || '';
    if (sub.isOpenSubtitles) {
        track.dataset.opensubtitles = "true";
        track.dataset.fileId = sub.fileId || '';
        track.dataset.lang = sub.lang || '';
        track.dataset.videoPath = sub.videoPath || '';
        track.dataset.downloaded = "false";
        track.src = "";
    } else {
        track.src = window.sanitizePath(sub.path);
    }
    vp.appendChild(track);

    // Set it as showing
    const trackIndex = vp.textTracks.length - 1;
    selectSubtitleTrack(trackIndex);
}

function refreshSubtitlesList() {
    const vp = el('video-player');
    if (!vp) return;
    const listContainer = el('subtitle-tracks-list');
    if (!listContainer) return;
    listContainer.innerHTML = '';

    // If we have all available subtitles stored, use them
    if (window._allAvailableSubtitles && window._allAvailableSubtitles.length > 0) {
        window._allAvailableSubtitles.forEach((sub, idx) => {
            const opt = document.createElement('div');
            opt.className = 'subtitle-option';
            opt.dataset.idx = idx;
            opt.dataset.isOpensubtitles = sub.isOpenSubtitles ? 'true' : 'false';
            opt.dataset.fileId = sub.fileId || '';
            opt.dataset.lang = sub.lang || '';
            opt.dataset.path = sub.path || '';
            opt.dataset.label = sub.label || '';
            opt.style.cssText = 'padding:6px 12px; cursor:pointer; text-align:left; font-family:var(--font-body); font-size:12px; color:var(--vault-text); transition:background 0.2s;';
            opt.textContent = sub.label || `Track ${idx + 1}`;

            // Active iff this idx matches the renderer's explicit selection.
            const isActive = window._selectedSubtitleIdx === idx;
            if (isActive) {
                opt.classList.add('active');
                opt.style.color = 'var(--vault-accent)';
                opt.style.fontWeight = '600';
            }

            opt.addEventListener('click', (e) => {
                e.stopPropagation();
                selectSubtitleByIndex(idx);
                el('subtitles-menu').style.display = 'none';
            });
            listContainer.appendChild(opt);
        });
    } else {
        // Fallback: show only loaded tracks
        for (let i = 0; i < vp.textTracks.length; i++) {
            const track = vp.textTracks[i];
            const opt = document.createElement('div');
            opt.className = 'subtitle-option';
            opt.dataset.idx = i;
            opt.style.cssText = 'padding:6px 12px; cursor:pointer; text-align:left; font-family:var(--font-body); font-size:12px; color:var(--vault-text); transition:background 0.2s;';
            opt.textContent = track.label || `Track ${i + 1}`;

            if (track.mode === 'showing') {
                opt.classList.add('active');
                opt.style.color = 'var(--vault-accent)';
                opt.style.fontWeight = '600';
            }

            opt.addEventListener('click', (e) => {
                e.stopPropagation();
                selectSubtitleTrack(i);
                el('subtitles-menu').style.display = 'none';
            });
            listContainer.appendChild(opt);
        }
    }

    const offOption = el('subtitles-menu').querySelector('.subtitle-option[data-idx="-1"]');
    if (offOption) {
        // Mirror the explicit selection: Off is active when nothing is picked.
        const offActive = window._selectedSubtitleIdx === -1 || window._selectedSubtitleIdx === undefined;
        offOption.classList.toggle('active', offActive);
        offOption.style.color = offActive ? 'var(--vault-accent)' : 'var(--vault-text)';
        offOption.style.fontWeight = offActive ? '600' : 'normal';
        offOption.onclick = (e) => {
            e.stopPropagation();
            window._selectedSubtitleIdx = -1;
            selectSubtitleTrack(-1);
            el('subtitles-menu').style.display = 'none';
        };
    }
}

function showAsrContextMenu(anchorEl, defaultLangs) {
    return new Promise((resolve) => {
        const existing = document.getElementById('asr-generation-context-menu');
        if (existing) existing.remove();
        const t = window.translations[window.currentLang === 'fr' ? 'fr' : 'en'] || {};
        const clampVolumeBoost = (value) => {
            const parsed = Number.parseFloat(value);
            if (!Number.isFinite(parsed)) return 1.5;
            return Math.min(2.5, Math.max(1, parsed));
        };
        let volumeBoost = clampVolumeBoost(window.appSettings && window.appSettings.asrVolumeBoost);

        const menu = document.createElement('div');
        menu.id = 'asr-generation-context-menu';
        menu.style.cssText = `
            position: fixed;
            /* Explicit dark console surface — this menu is appended to <body>,
               outside the shell, so var(--vault-card-bg) resolves to the light
               warm value and clashed with the dark player. */
            background: rgba(19, 16, 28, 0.97);
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 8px;
            padding: 12px;
            z-index: 10006;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
            backdrop-filter: blur(8px);
            font-family: var(--font-body), sans-serif;
            color: var(--vault-text, #fff);
            width: 240px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        `;

        const title = document.createElement('div');
        title.style.cssText = 'font-size:10px; font-weight:700; text-transform:uppercase; color:var(--vault-gold); letter-spacing:0.05em; padding-bottom:6px; border-bottom:1px solid rgba(255,255,255,0.08); user-select:none;';
        title.textContent = t.asrGenerateSubtitles || 'Generate Subtitles';
        menu.appendChild(title);

        // Explicit one-time-download warning — the first generation pulls a large
        // on-device speech model.
        if (!(window.appSettings && window.appSettings.asrModelReady)) {
            const warn = document.createElement('div');
            warn.style.cssText = 'font-size:10px; color:#F0B94B; background:rgba(240,185,75,0.10); border:1px solid rgba(240,185,75,0.28); border-radius:4px; padding:6px 8px; line-height:1.4; user-select:none;';
            warn.innerHTML = '⚠️ First run downloads a <strong>~2.5 GB</strong> speech-recognition model (one-time). It runs entirely on your device and may take a minute to start.';
            menu.appendChild(warn);
        }

        const listContainer = document.createElement('div');
        listContainer.style.cssText = 'display:flex; flex-direction:column; gap:6px; max-height:220px; overflow-y:auto; padding-right:2px;';
        menu.appendChild(listContainer);

        const languages = [
            { code: 'en', name: 'English (EN)' },
            { code: 'qc', name: 'French / Québécois (FR)' },
            { code: 'es', name: 'Spanish (ES)' },
            { code: 'de', name: 'German (DE)' },
            { code: 'it', name: 'Italian (IT)' },
            { code: 'pt', name: 'Portuguese (PT)' },
            { code: 'nl', name: 'Dutch (NL)' },
            { code: 'ru', name: 'Russian (RU)' },
            { code: 'zh', name: 'Chinese (ZH)' },
            { code: 'ja', name: 'Japanese (JA)' },
            { code: 'ko', name: 'Korean (KO)' },
            { code: 'ar', name: 'Arabic (AR)' },
            { code: 'hi', name: 'Hindi (HI)' },
            { code: 'bn', name: 'Bengali (BN)' },
            { code: 'tr', name: 'Turkish (TR)' },
            { code: 'pl', name: 'Polish (PL)' },
            { code: 'sv', name: 'Swedish (SV)' },
            { code: 'no', name: 'Norwegian (NO)' },
            { code: 'da', name: 'Danish (DA)' },
            { code: 'fi', name: 'Finnish (FI)' },
            { code: 'cs', name: 'Czech (CS)' },
            { code: 'el', name: 'Greek (EL)' },
            { code: 'he', name: 'Hebrew (HE)' },
            { code: 'id', name: 'Indonesian (ID)' },
            { code: 'vi', name: 'Vietnamese (VI)' },
            { code: 'uk', name: 'Ukrainian (UK)' }
        ];

        const selectedCodes = new Set(defaultLangs && defaultLangs.length > 0 ? defaultLangs : ['en', 'qc']);

        function createLangItem(lang) {
            const item = document.createElement('label');
            item.style.cssText = 'display:flex; align-items:center; gap:8px; cursor:pointer; font-size:11px; padding:4px 6px; border-radius:4px; transition:background 0.2s; user-select:none;';
            item.addEventListener('mouseenter', () => item.style.background = 'rgba(255,255,255,0.06)');
            item.addEventListener('mouseleave', () => item.style.background = 'transparent');

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = lang.code;
            cb.checked = selectedCodes.has(lang.code);
            cb.style.cssText = 'accent-color:var(--vault-accent); width:12px; height:12px; margin:0; cursor:pointer;';
            cb.addEventListener('change', () => {
                if (cb.checked) {
                    selectedCodes.add(lang.code);
                } else {
                    selectedCodes.delete(lang.code);
                }
            });

            const span = document.createElement('span');
            span.textContent = lang.name;

            item.appendChild(cb);
            item.appendChild(span);
            return item;
        }

        let initialList = languages.filter(l => selectedCodes.has(l.code));
        if (initialList.length === 0) {
            initialList = [languages[0], languages[1]];
            selectedCodes.add('en');
            selectedCodes.add('qc');
        }

        function renderList(list) {
            listContainer.innerHTML = '';
            list.forEach(lang => {
                listContainer.appendChild(createLangItem(lang));
            });
        }

        renderList(initialList);

        const showMore = document.createElement('div');
        showMore.style.cssText = 'font-size:10px; color:var(--vault-accent); cursor:pointer; text-align:center; padding:6px 0; border-top:1px dashed rgba(255,255,255,0.08); margin-top:4px; font-weight:600; user-select:none;';
        showMore.textContent = t.asrShowMore || 'Show more...';
        menu.appendChild(showMore);

        const boostWrap = document.createElement('div');
        boostWrap.style.cssText = 'border-top:1px solid rgba(255,255,255,0.08); padding-top:8px; display:flex; flex-direction:column; gap:6px;';

        const boostLabel = document.createElement('label');
        boostLabel.htmlFor = 'asr-volume-boost';
        boostLabel.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:10px; font-size:10px; color:var(--vault-text); font-weight:700; text-transform:uppercase; user-select:none;';

        const boostText = document.createElement('span');
        boostText.textContent = t.asrVolumeBoost || 'Voice boost';

        const boostValue = document.createElement('span');
        boostValue.id = 'asr-volume-boost-value';
        boostValue.style.cssText = 'color:var(--vault-accent); font-family:var(--font-mono); white-space:nowrap;';

        const formatBoost = (value) => `+${Math.round((value - 1) * 100)}%`;
        boostValue.textContent = formatBoost(volumeBoost);

        boostLabel.appendChild(boostText);
        boostLabel.appendChild(boostValue);

        const boostSlider = document.createElement('input');
        boostSlider.id = 'asr-volume-boost';
        boostSlider.type = 'range';
        boostSlider.min = '1';
        boostSlider.max = '2.5';
        boostSlider.step = '0.1';
        boostSlider.value = String(volumeBoost);
        boostSlider.title = t.asrVolumeBoostHint || 'Boost mixed vocals for clearer subtitles';
        boostSlider.style.cssText = 'width:100%; accent-color:var(--vault-accent); cursor:pointer;';
        boostSlider.addEventListener('input', () => {
            volumeBoost = clampVolumeBoost(boostSlider.value);
            boostValue.textContent = formatBoost(volumeBoost);
        });

        boostWrap.appendChild(boostLabel);
        boostWrap.appendChild(boostSlider);
        menu.appendChild(boostWrap);

        function adjustPosition() {
            // Force layout reflow by checking offsetWidth/offsetHeight
            const menuWidth = menu.offsetWidth || menu.getBoundingClientRect().width || 220;
            const menuHeight = menu.offsetHeight || menu.getBoundingClientRect().height || 280;

            const rect = anchorEl.getBoundingClientRect();
            // Right-align the menu with the anchor button so it hangs from the
            // right edge (matches the subtitles dropdown's `right:0` layout in
            // the video bottom bar).
            let left = rect.right - menuWidth;
            let top = rect.bottom + 8;

            // Horizontal bounds check
            if (left + menuWidth > window.innerWidth) {
                left = window.innerWidth - menuWidth - 12;
            }
            if (left < 12) {
                left = 12;
            }

            // Vertical bounds check: prefer opening upward when the anchor is
            // in the bottom bar (typical case for the player).
            if (top + menuHeight > window.innerHeight) {
                const spaceAbove = rect.top;
                const spaceBelow = window.innerHeight - rect.bottom;

                if (spaceAbove > spaceBelow) {
                    top = rect.top - menuHeight - 8;
                } else {
                    top = rect.bottom + 8;
                }
            } else if (rect.top > window.innerHeight * 0.6) {
                // Anchor sits in the lower 40% of the viewport — open upward
                // even if there's room below, so the menu doesn't cover the
                // playback controls.
                top = rect.top - menuHeight - 8;
            }

            // Final clamp to prevent clipping off the screen entirely
            if (top + menuHeight > window.innerHeight) {
                top = window.innerHeight - menuHeight - 12;
            }
            if (top < 12) {
                top = 12;
            }

            menu.style.left = `${left}px`;
            menu.style.top = `${top}px`;
            menu.style.right = 'auto';
            menu.style.bottom = 'auto';
        }

        showMore.addEventListener('click', (e) => {
            e.stopPropagation();
            renderList(languages);
            showMore.style.display = 'none';
            adjustPosition();
        });

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex; justify-content:flex-end; gap:6px; border-top:1px solid rgba(255,255,255,0.08); padding-top:6px; margin-top:4px;';

        const cancelBtn = document.createElement('button');
        cancelBtn.style.cssText = 'background:transparent; border:1px solid var(--vault-border, rgba(255,255,255,0.15)); color:var(--vault-text, #fff); font-size:10px; font-weight:600; padding:4px 8px; border-radius:4px; cursor:pointer; font-family:var(--font-mono);';
        cancelBtn.textContent = t.cancel || 'Cancel';

        const cleanup = () => {
            menu.remove();
            document.removeEventListener('mousedown', onMouseDown);
        };

        cancelBtn.addEventListener('click', () => {
            cleanup();
            resolve(null);
        });

        const applyBtn = document.createElement('button');
        applyBtn.style.cssText = 'background:var(--vault-accent); color:var(--vault-accent-text, #0b0813); border:none; font-size:10px; font-weight:700; padding:4px 10px; border-radius:4px; cursor:pointer; font-family:var(--font-mono);';
        applyBtn.textContent = t.generate || 'Generate';
        applyBtn.addEventListener('click', () => {
            const chosen = Array.from(selectedCodes);
            cleanup();
            resolve({ langs: chosen, volumeBoost });
        });

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(applyBtn);
        menu.appendChild(btnRow);

        document.body.appendChild(menu);
        adjustPosition();

        const onMouseDown = (e) => {
            if (!menu.contains(e.target) && !anchorEl.contains(e.target)) {
                cleanup();
                resolve(null);
            }
        };
        document.addEventListener('mousedown', onMouseDown);
    });
}

// ── Live streaming ASR subtitles (Parakeet) ─────────────────────────────────
// Starts a background transcription that streams VTTCues onto the <video> in
// real time while the file plays, and writes an .srt sidecar on the Python
// side. Cues carry absolute timestamps so they stay in sync with currentTime.

const _liveNormPath = (p) => (p || '').replace(/\\/g, '/').toLowerCase();

function updateLiveSubButton(active) {
    const btn = el('btn-subtitles');
    if (!btn) return;
    const svgIcon = window.icons ? window.icons.subtitles('', 'width:14px; height:14px; display:block; flex-shrink:0;') : '';
    if (active) {
        btn.classList.add('active');
        btn.innerHTML = `${svgIcon}<span style="color:var(--vault-gold);">● LIVE</span>`;
    }
    // When inactive we leave whatever selectSubtitleTrack last rendered.

    // Reflect the running state in the menu item label so a second click reads
    // as "Stop".
    const optGen = el('opt-generate-subtitle');
    const span = optGen && optGen.querySelector('span');
    if (span) span.textContent = active ? 'Stop Live Subtitles' : 'Live Subtitles (AI)';
}

function startLiveSubtitleSession(videoPath, itemName, langs, volumeBoost) {
    const vp = el('video-player');
    if (!vp) return;

    // Tear down any prior live track before starting a fresh take.
    window.stopLiveSubtitles(true);

    // AI subtitles are exclusive: unload any loaded SRT/VTT tracks so we never
    // render two overlapping subtitle streams. The AI sidecar (.srt) it writes
    // will overwrite the previous one for this file.
    const hadLoaded = vp.querySelectorAll('track').length > 0;
    vp.querySelectorAll('track').forEach(t => t.remove());
    for (let i = 0; i < vp.textTracks.length; i++) vp.textTracks[i].mode = 'disabled';
    if (window.refreshSubtitlesList) window.refreshSubtitlesList();
    if (hadLoaded) window.showToast('Replaced the loaded subtitles with AI subtitles.', 'info');

    ensureLiveSubtitleListeners();

    const primaryLang = (langs && langs[0]) || 'en';
    const startTime = Math.max(0, (vp.currentTime || 0) - 1.0);

    // In-memory text track — no <track> element needed; the browser renders and
    // syncs its cues to currentTime automatically.
    const track = vp.addTextTrack('subtitles', `AI Live (${primaryLang.toUpperCase()})`, primaryLang);
    track.mode = 'showing';

    window._liveSubTrack = track;
    window._liveSubVideoPath = videoPath;
    window._liveSubActive = true;
    window._selectedSubtitleIdx = -1; // our track isn't in the sidecar catalog
    // Remembered so a seek can restart the ASR feed from the new position.
    window._liveSubLangs = langs;
    window._liveSubBoost = volumeBoost;
    window._liveSubItemName = itemName;

    // A live track counts as active subtitles → reveal the sync-delay row.
    const _liveSyncRow = el('subtitle-sync-row');
    if (_liveSyncRow) _liveSyncRow.style.display = '';

    // The picked primary language is the desired output language: transcribe in
    // the spoken language (auto-detected) and translate finals to it. Same-lang
    // is a near-passthrough.
    const translateTo = primaryLang;

    // The Comet playback URL embeds the debrid API keys as a base64 config
    // segment — never print it raw to the console.
    const _redactUrl = (u) => String(u || '').replace(/\/eyJ[^/]+/, '/<config>');
    console.log('[live-subs] session start', {
        videoPath: _redactUrl(videoPath),
        primaryLang, translateTo, langs, volumeBoost, startTime: startTime.toFixed(2),
    });

    updateLiveSubButton(true);
    window.showToast(`Live subtitles started for "${itemName}" (${primaryLang.toUpperCase()})…`, 'success');

    // SRT sidecar is opt-in (default off) — controlled by the menu checkbox.
    const srtChk = el('chk-write-srt');
    const writeSrt = !!(srtChk && srtChk.checked);

    window.electronAPI.startLiveSubtitles({
        videoPath,
        langs,
        volumeBoost,
        startTime,
        translateTo,
        writeSrt,
    }).then((res) => {
        if (!res || !res.success) {
            window.showToast('Live subtitles failed to start: ' + ((res && res.error) || 'unknown'), 'error');
            window.stopLiveSubtitles(true);
        } else if (window.appSettings && !window.appSettings.asrModelReady) {
            // Session started successfully → model is present; suppress the
            // one-time ~2.5 GB download warning on future runs.
            window.appSettings.asrModelReady = true;
            try { window.electronAPI.saveSettings(window.appSettings); } catch (_) { }
        }
    }).catch((err) => {
        window.showToast('Live subtitles failed to start: ' + err.message, 'error');
        window.stopLiveSubtitles(true);
    });
}

// Stops the Python process and (optionally) removes the in-memory live track.
window.stopLiveSubtitles = function stopLiveSubtitles(clearTrack) {
    if (window._liveSubActive || window._liveSubTrack) {
        console.log('[live-subs] stop', { clearTrack: !!clearTrack, cues: window._liveSubTrack && window._liveSubTrack.cues ? window._liveSubTrack.cues.length : 0 });
        try { window.electronAPI.stopLiveSubtitles(); } catch (e) { /* noop */ }
    }
    window._liveSubActive = false;

    if (clearTrack && window._liveSubTrack) {
        try {
            window._liveSubTrack.mode = 'disabled';
            // Drop cues so a stale track can't linger over the next video.
            const cues = window._liveSubTrack.cues;
            if (cues) {
                for (let i = cues.length - 1; i >= 0; i--) {
                    window._liveSubTrack.removeCue(cues[i]);
                }
            }
        } catch (e) { /* noop */ }
        window._liveSubTrack = null;
        window._liveSubVideoPath = null;
        window._livePartialCue = null;
        window._lastLiveCue = null;
        // No active subs anymore → hide the sync-delay row.
        const _sr = el('subtitle-sync-row');
        if (_sr) _sr.style.display = 'none';
    }
    updateLiveSubButton(false);
};

let _liveListenersBound = false;
function ensureLiveSubtitleListeners() {
    if (_liveListenersBound) return;
    _liveListenersBound = true;

    // When the user seeks, the ASR feed keeps reading linearly from its original
    // start, so cues drift out / disappear ahead of the new position. Restart the
    // session from the new spot (debounced so scrubbing doesn't thrash the daemon).
    const vpSeek = el('video-player');
    if (vpSeek) {
        let _seekRestartTimer = null;
        vpSeek.addEventListener('seeked', () => {
            if (!window._liveSubActive || !window._liveSubVideoPath) return;
            clearTimeout(_seekRestartTimer);
            _seekRestartTimer = setTimeout(() => {
                if (!window._liveSubActive || !window._liveSubVideoPath) return;
                console.log('[live-subs] seek detected → restarting ASR from new position');
                startLiveSubtitleSession(
                    window._liveSubVideoPath,
                    window._liveSubItemName || 'Active Video',
                    window._liveSubLangs || ['en'],
                    window._liveSubBoost || 1.5
                );
            }, 700);
        });
    }

    window.electronAPI.onLiveSubtitleCue((cue) => {
        if (!window._liveSubActive || !window._liveSubTrack) return;
        if (_liveNormPath(cue.videoPath) !== _liveNormPath(window._liveSubVideoPath)) return;
        if (cue.partial) return; // finals only
        try {
            const track = window._liveSubTrack;
            const MIN_DISPLAY = 1.6;                       // keep short lines readable
            const off = window._subtitleOffset || 0;       // user sync nudge (±0.25s)
            const s = Math.max(0, cue.start + off);
            const e = Math.max(s + MIN_DISPLAY, cue.end + off);

            // Trim the previous cue so an extended line doesn't overlap the next.
            if (window._lastLiveCue && window._lastLiveCue.endTime > s) {
                window._lastLiveCue.endTime = Math.max(window._lastLiveCue.startTime + 0.1, s);
            }
            const vtt = new VTTCue(s, e, cue.text);
            track.addCue(vtt);
            window._lastLiveCue = vtt;

            const vp = el('video-player');
            console.log(`[live-subs] +FINAL [${s.toFixed(2)}-${e.toFixed(2)}] "${cue.text}" ` +
                `(playhead=${vp ? vp.currentTime.toFixed(1) : '?'}s, offset=${off.toFixed(2)}s, cues=${track.cues ? track.cues.length : '?'})`);
        } catch (e) {
            console.warn('[live-subs] addCue failed', cue, e);
        }
    });

    window.electronAPI.onLiveSubtitleStatus((s) => {
        // Model-download / daemon-lifecycle events aren't tied to a video.
        if (s.status === 'downloading') {
            const pct = s.percent || 0;
            const btn = el('btn-subtitles');
            if (btn) btn.innerHTML = `<span style="color:var(--vault-gold);">DL ${pct}%</span>`;
            if (pct === 0 || pct % 25 === 0) {
                window.showToast(`Downloading AI subtitle model… ${pct}% (${s.receivedMB || 0}/${s.totalMB || 0} MB)`, 'info');
            }
            return;
        }
        if (s.status === 'downloaded') {
            window.showToast('Model downloaded — starting…', 'success');
            if (window.appSettings) { window.appSettings.asrModelReady = true; try { window.electronAPI.saveSettings(window.appSettings); } catch (_) { } }
            return;
        }
        if (s.status === 'download-failed') {
            window.showToast('Model download failed: ' + (s.error || 'unknown'), 'error');
            window.stopLiveSubtitles(true);
            return;
        }
        if (s.status === 'loading' || s.status === 'ready' || s.status === 'error') {
            console.log('[live-subs] daemon', s.status, s.message || '');
            return;
        }

        // Session events must match the active video.
        if (_liveNormPath(s.videoPath) !== _liveNormPath(window._liveSubVideoPath)) return;
        console.log('[live-subs] status', s);
        if (s.status === 'started') { updateLiveSubButton(true); return; }
        if (s.final) {
            if (s.status === 'SUCCESS') {
                window.showToast(`Live subtitles finished — ${s.cues || 0} cues written to sidecar.`, 'success');
            } else if (s.status === 'FAILED') {
                window.showToast('Live subtitles error: ' + (s.error || 'unknown'), 'error');
            }
            window._liveSubActive = false;
            updateLiveSubButton(false);
        }
    });
}

window.startLiveSubtitleSession = startLiveSubtitleSession;

// ── Subtitle sync offset (±0.25s) ───────────────────────────────────────────
// Shifts every cue on the active subtitle track(s) — live or loaded SRT — by a
// user-tunable delay. VTTCue start/end are mutable, so we retime existing cues
// in place and remember the offset for future live cues. Persisted in settings.
window._subtitleOffset = (window.appSettings && Number(window.appSettings.subtitleOffset)) || 0;

function updateSubtitleOffsetLabel() {
    const lbl = el('subtitle-offset-value');
    if (lbl) {
        const o = window._subtitleOffset || 0;
        lbl.textContent = `${o >= 0 ? '+' : ''}${o.toFixed(2)}s`;
    }
}

function adjustSubtitleOffset(delta) {
    window._subtitleOffset = Math.round(((window._subtitleOffset || 0) + delta) * 100) / 100;
    const vp = el('video-player');
    if (vp && vp.textTracks) {
        for (const track of vp.textTracks) {
            if (!track.cues) continue;
            for (let i = 0; i < track.cues.length; i++) {
                const c = track.cues[i];
                const ns = Math.max(0, c.startTime + delta);
                const ne = Math.max(ns + 0.1, c.endTime + delta);
                c.startTime = ns;
                c.endTime = ne;
            }
        }
    }
    if (window.appSettings) {
        window.appSettings.subtitleOffset = window._subtitleOffset;
        window.electronAPI.saveSettings(window.appSettings);
    }
    updateSubtitleOffsetLabel();
    const o = window._subtitleOffset;
    window.showToast(`Subtitle delay: ${o >= 0 ? '+' : ''}${o.toFixed(2)}s`, 'info');
}
window.adjustSubtitleOffset = adjustSubtitleOffset;

function initSubtitleListeners() {
    const vp = el('video-player');

    // Subtitles Dropdown Triggers
    el('btn-subtitles').addEventListener('click', (e) => {
        e.stopPropagation();
        // The speed menu was removed from the UI; guard so a missing element
        // doesn't throw and abort the toggle (which left the CC menu unopenable).
        const sm = el('speed-menu'); if (sm) sm.style.display = 'none';
        const menu = el('subtitles-menu');
        const isHidden = menu.style.display === 'none';
        menu.style.display = isHidden ? 'block' : 'none';
    });

    el('opt-upload-subtitle').addEventListener('click', (e) => {
        e.stopPropagation();
        el('subtitles-menu').style.display = 'none';
        el('subtitle-file-input').click();
    });

    // Subtitle sync nudge (±0.25s) — retimes active cues and persists the offset.
    updateSubtitleOffsetLabel();
    const offMinus = el('subtitle-offset-minus');
    const offPlus = el('subtitle-offset-plus');
    if (offMinus) offMinus.addEventListener('click', (e) => { e.stopPropagation(); adjustSubtitleOffset(-0.25); });
    if (offPlus) offPlus.addEventListener('click', (e) => { e.stopPropagation(); adjustSubtitleOffset(0.25); });

    // OpenSubtitles language search. Expanded by default so the preferred-language
    // searches are instantly visible rather than buried behind the dropdown.
    const moreBtn = el('opt-more-subs');
    const morePanel = el('subtitles-more-panel');
    const moreCaret = el('more-subs-caret');
    if (moreBtn && morePanel) {
        morePanel.style.display = 'block';
        if (moreCaret) moreCaret.textContent = '▾';
        moreBtn.addEventListener('mouseenter', () => { moreBtn.style.background = 'rgba(245,185,41,0.08)'; });
        moreBtn.addEventListener('mouseleave', () => { moreBtn.style.background = 'transparent'; });
        moreBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = morePanel.style.display !== 'none';
            morePanel.style.display = open ? 'none' : 'block';
            if (moreCaret) moreCaret.textContent = open ? '▸' : '▾';
        });
    }

    // The sync-delay row starts hidden — it's only relevant once a track is active.
    const _initSyncRow = el('subtitle-sync-row');
    if (_initSyncRow) _initSyncRow.style.display = 'none';

    // ── Quick-lang search buttons (English / French CA / French) ─────────
    // Searches OpenSubtitles with a narrow `languages` filter for the
    // currently-playing title, picks the best result (FR-CA preferred over
    // FR-FR when the user asked for 'fr-CA'), loads it as a track.
    document.querySelectorAll('.subtitle-quick-lang').forEach(btn => {
        btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(245,185,41,0.08)'; });
        btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const lang = btn.dataset.lang || 'en';
            el('subtitles-menu').style.display = 'none';
            await searchAndLoadSubtitlesByLang(lang);
        });
    });

    const optGen = el('opt-generate-subtitle');
    if (optGen) {
        optGen.addEventListener('click', async (e) => {
            e.stopPropagation();
            el('subtitles-menu').style.display = 'none';

            // Toggle: a second click while a session is running stops it.
            if (window._liveSubActive) {
                window.stopLiveSubtitles(true);
                window.showToast('Live subtitles stopped.', 'info');
                return;
            }

            let videoPath = null;
            let itemName = 'Active Video';
            if (window.currentPlayingItem) {
                videoPath = window.currentPlayingItem.path;
                itemName = window.currentPlayingItem.name;
            } else if (window.currentPlayingIndex !== -1) {
                const itm = window.displayedItems[window.currentPlayingIndex];
                if (itm) { videoPath = itm.path; itemName = itm.name; }
            }
            // Fallback for remote streams: pull the URL straight from the <video> element.
            if (!videoPath) {
                const vp = el('video-player');
                if (vp && vp.src) videoPath = vp.src;
            }
            if (window.activeStreamingMedia && window.activeStreamingMedia.title) {
                itemName = window.activeStreamingMedia.title;
            }

            if (!videoPath) {
                window.showToast('No playback source for live subtitles.', 'error');
                return;
            }

            const defaultLangs = (window.appSettings && window.appSettings.preferredASRLangs) || ['en'];
            // Anchor to the persistent CC button — optGen lives in the menu we
            // just hid, and a hidden element reports a zero-size rect.
            const asrAnchor = el('btn-subtitles') || optGen;
            const asrConfig = await showAsrContextMenu(asrAnchor, defaultLangs);
            const langs = Array.isArray(asrConfig) ? asrConfig : (asrConfig && asrConfig.langs);
            const volumeBoost = Array.isArray(asrConfig) ? 1.5 : (asrConfig && asrConfig.volumeBoost) || 1.5;
            if (!langs || langs.length === 0) return;

            if (!window.appSettings) window.appSettings = {};
            window.appSettings.preferredASRLangs = langs;
            window.appSettings.asrVolumeBoost = volumeBoost;
            window.electronAPI.saveSettings(window.appSettings);

            startLiveSubtitleSession(videoPath, itemName, langs, volumeBoost);
        });
    }

    el('subtitle-file-input').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // Uploading a subtitle is exclusive with a running AI session.
        if (window._liveSubActive) window.stopLiveSubtitles(true);

        const track = document.createElement('track');
        track.kind = 'subtitles';
        track.label = file.name;
        track.srclang = 'und';
        track.src = URL.createObjectURL(file);

        vp.appendChild(track);
        refreshSubtitlesList();

        const trackIdx = vp.textTracks.length - 1;
        selectSubtitleTrack(trackIdx);

        const t = window.translations[window.currentLang === 'fr' ? 'fr' : 'en'] || {};
        window.showToast((t.subtitlesLoaded || 'Subtitles loaded: ') + file.name, 'success');
        e.target.value = '';
    });
}

// Fetch OpenSubtitles results for a narrow language filter and load the best
// match as a track. Reuses the existing find-subtitles IPC (extended with a
// 4th `langsOverride` param) and the existing addSubtitleTrack logic.
//
// Language presets:
//   'en'    -> just English
//   'fr-CA' -> Quebec/Canadian French preferred; falls back to fr-FR/fr
//   'fr'    -> any French (FR-FR first, then FR-CA)
async function searchAndLoadSubtitlesByLang(lang) {
    const t = window.translations[window.currentLang === 'fr' ? 'fr' : 'en'] || {};

    // Resolve a video path + query title for both local and stream contexts.
    let videoPath = null;
    let queryTitle = null;
    if (window.currentPlayingItem && window.currentPlayingItem.path) {
        videoPath = window.currentPlayingItem.path;
        queryTitle = window.currentPlayingItem.name;
    } else if (window.activeStreamingMedia) {
        videoPath = (el('video-player') && el('video-player').src) || '';
        queryTitle = window.activeStreamingMedia.title;
    }
    if (!queryTitle) {
        window.showToast('No active title to search subtitles for', 'error');
        return;
    }

    // Translate the picker code to OpenSubtitles language codes. fr-CA is
    // a valid OpenSubtitles language code; we ask for fr too as a fallback.
    const langsParam = lang === 'fr-CA' ? 'fr-CA,fr'
        : lang === 'fr' ? 'fr,fr-CA'
            : 'en';

    window.showToast(`Searching OpenSubtitles for ${lang.toUpperCase()}…`, 'info');
    let results = [];
    try {
        results = await window.electronAPI.findSubtitles(videoPath, queryTitle, false, langsParam) || [];
    } catch (err) {
        console.error('[subtitles] quick-lang search failed:', err);
        window.showToast('Subtitle search failed', 'error');
        return;
    }
    // Keep only OpenSubtitles hits (we already cover local sidecars elsewhere).
    const osHits = results.filter(s => s.isOpenSubtitles);
    if (osHits.length === 0) {
        window.showToast(`No ${lang.toUpperCase()} subtitles found for "${queryTitle}"`, 'warning');
        return;
    }
    // Canadian-French priority: when the user asked for fr-CA, surface any
    // result whose language code starts with 'fr-ca' first; FR otherwise.
    const want = lang.toLowerCase();
    osHits.sort((a, b) => {
        const aL = (a.lang || '').toLowerCase();
        const bL = (b.lang || '').toLowerCase();
        const aMatch = aL === want ? 0 : aL.startsWith(want.split('-')[0]) ? 1 : 2;
        const bMatch = bL === want ? 0 : bL.startsWith(want.split('-')[0]) ? 1 : 2;
        return aMatch - bMatch;
    });
    const chosen = osHits[0];

    // Merge into the menu's catalog (stamp videoPath so the download IPC
    // knows where to write the SRT/VTT sidecar — or to use a stream-safe
    // path when videoPath is a stream URL).
    window._allAvailableSubtitles = window._allAvailableSubtitles || [];
    osHits.forEach(h => {
        h.videoPath = videoPath || '';
        if (!window._allAvailableSubtitles.some(x => x.fileId === h.fileId)) {
            window._allAvailableSubtitles.push(h);
        }
    });

    // Find the chosen sub's index in the catalog and let selectSubtitleByIndex
    // own the actual <track> create + lazy-download + select chain.
    const chosenIdx = window._allAvailableSubtitles.findIndex(s => s.fileId === chosen.fileId);
    if (chosenIdx >= 0) {
        selectSubtitleByIndex(chosenIdx);
    }
    refreshSubtitlesList();
    window.showToast(`Loaded ${(chosen.label || lang.toUpperCase())}`, 'success');
}

async function loadActiveSubtitles(videoPath) {
    const vpReal = el('video-player');
    if (!vpReal) return;
    vpReal.querySelectorAll('track').forEach(t => t.remove());
    try {
        const subs = await window.electronAPI.findSubtitles(videoPath, null, true);

        // Store all available subtitles for the menu
        window._allAvailableSubtitles = subs || [];

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
                    track.dataset.videoPath = videoPath;
                    track.dataset.downloaded = "false";
                    track.src = "";
                } else {
                    track.src = window.sanitizePath(bestSub.path);
                }
                vpReal.appendChild(track);
            }

            refreshSubtitlesList();
            selectSubtitleTrack(bestSub ? 0 : -1);
        } else {
            window._allAvailableSubtitles = [];
            refreshSubtitlesList();
            selectSubtitleTrack(-1);
        }
    } catch (err) {
        console.error("Subtitles reload failed:", err);
    }
}

// Bind to globals
window.selectSubtitleTrack = selectSubtitleTrack;
window.selectSubtitleByIndex = selectSubtitleByIndex;
window.refreshSubtitlesList = refreshSubtitlesList;
window.initSubtitleListeners = initSubtitleListeners;
window.loadActiveSubtitles = loadActiveSubtitles;
