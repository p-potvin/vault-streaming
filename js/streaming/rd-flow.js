// js/streaming/rd-flow.js — Real-Debrid streaming flow: search, rank, cache-check, unrestrict, play
// Part of the streaming feature, split out of the former monolithic js/streaming.js.

// ─── Quality/Language-Aware triggerRDStream ───────────────────────────────────

let _torrentRequestCounter = 0;

/**
 * Overrides the base triggerRDStream to inject season/episode for TV and
 * apply quality+language ranking before displaying the torrent list.
 *
 * @param {string} movieTitle
 * @param {number|null} tmdbId
 * @param {string} mediaType  'movie' | 'tv'
 * @param {number} [season]   Season number (TV only)
 * @param {number} [episode]  Episode number (TV only)
 */
window.triggerRDStream = async function(movieTitle, tmdbId = null, mediaType = 'movie', season = null, episode = null) {
    _torrentRequestCounter++;
    const currentRequestNum = _torrentRequestCounter;

    window._rdDialogJustOpened = true;
    setTimeout(() => { window._rdDialogJustOpened = false; }, 100);

    const dialog = el('rd-stream-dialog');
    const loadingStatus = el('rd-loading-status');
    const statusText = el('rd-status-text');
    const torrentsList = el('rd-torrents-list');
    const titleTextEl = el('rd-stream-title-text');

    if (!dialog || !loadingStatus || !statusText || !torrentsList) return;

    // Reset view state
    dialog.style.display = 'flex';
    const backdrop = el('rd-stream-backdrop');
    if (backdrop) backdrop.style.display = 'block';
    loadingStatus.style.display = 'block';
    torrentsList.style.display = 'none';
    torrentsList.innerHTML = '';
    const chooseManuallyBtn = el('btn-rd-choose-manually');
    if (chooseManuallyBtn) chooseManuallyBtn.style.display = 'none';

    // Fetch streaming mode from backend first to update title/status
    let streamingMode = 'torrent-only';
    try {
        streamingMode = window.appSettings.streamingMode || await window.electronAPI.getStreamingMode();
    } catch(err) {
        console.warn('[streaming] Could not retrieve streaming mode, using default torrent-only', err);
    }

    if (titleTextEl) {
        if (streamingMode === 'usenet-only') {
            titleTextEl.textContent = 'Usenet Streaming Client';
        } else if (streamingMode === 'hybrid') {
            titleTextEl.textContent = 'Hybrid Streaming Client';
        } else {
            titleTextEl.textContent = 'Real-Debrid Streaming Client';
        }
    }

    const isTV = mediaType === 'tv';
    const epLabel = isTV && season != null ? ` S${String(season).padStart(2,'0')}E${String(episode || 1).padStart(2,'0')}` : '';

    if (streamingMode === 'usenet-only') {
        statusText.innerHTML = `${window.icons ? window.icons.search('tab-icon spinner-inline', 'width:13px; height:13px; display:inline-block; vertical-align:middle; color:var(--vault-accent); margin-right:4px;') : ''} Scraping Usenet index for:<br><strong>${window.escapeHtml(movieTitle)}${epLabel}</strong>...`;
    } else if (streamingMode === 'hybrid') {
        statusText.innerHTML = `${window.icons ? window.icons.search('tab-icon spinner-inline', 'width:13px; height:13px; display:inline-block; vertical-align:middle; color:var(--vault-accent); margin-right:4px;') : ''} Scraping Torrents & Usenet for:<br><strong>${window.escapeHtml(movieTitle)}${epLabel}</strong>...`;
    } else {
        statusText.innerHTML = `${window.icons ? window.icons.search('tab-icon spinner-inline', 'width:13px; height:13px; display:inline-block; vertical-align:middle; color:var(--vault-accent); margin-right:4px;') : ''} Scraping Torrentio index for:<br><strong>${window.escapeHtml(movieTitle)}${epLabel}</strong>...`;
    }

    const preferredQuality = getPreferredQuality();
    const preferredLang = getPreferredLang();

    // Cache streaming media metadata for the watch history system
    const posterEl = el('streaming-details-poster');
    const yearEl = el('streaming-details-year');
    window.activeStreamingMedia = {
        mediaType: mediaType || 'movie',
        tmdbId: tmdbId || null,
        title: movieTitle,
        season: isTV ? (season || 1) : null,
        episode: isTV ? (episode || 1) : null,
        poster: posterEl ? posterEl.src : null,
        year: yearEl ? yearEl.textContent : null
    };

    try {
        // Stagger request to prevent rate limits
        await new Promise(r => setTimeout(r, 500));

        // Cancel output if another search was triggered during the stagger delay
        if (currentRequestNum !== _torrentRequestCounter) {
            console.log(`[streaming] Cancelled outdated torrent search stagger for: ${movieTitle}`);
            return;
        }

        let torrents = [];
        let title = movieTitle;

        if (streamingMode === 'usenet-only') {
            const usenetResponse = await window.electronAPI.searchUsenet({
                movieTitle,
                tmdbId,
                mediaType,
                season: season || 1,
                episode: episode || 1
            });
            if (usenetResponse && usenetResponse.success) {
                torrents = (usenetResponse.streams || []).map(s => ({ ...s, isUsenet: true }));
                title = usenetResponse.title || movieTitle;
            }
        } else if (streamingMode === 'hybrid') {
            const [torrentResponse, usenetResponse] = await Promise.all([
                window.electronAPI.searchTorrents({
                    movieTitle,
                    tmdbId,
                    mediaType,
                    season: season || 1,
                    episode: episode || 1
                }).catch(e => ({ success: false, torrents: [] })),
                window.electronAPI.searchUsenet({
                    movieTitle,
                    tmdbId,
                    mediaType,
                    season: season || 1,
                    episode: episode || 1
                }).catch(e => ({ success: false, streams: [] }))
            ]);

            let tList = [];
            if (torrentResponse && torrentResponse.success && torrentResponse.torrents) {
                tList = torrentResponse.torrents.map(t => ({ ...t, isUsenet: false }));
                title = torrentResponse.title || movieTitle;
            }
            let uList = [];
            if (usenetResponse && usenetResponse.success && usenetResponse.streams) {
                uList = usenetResponse.streams.map(s => ({ ...s, isUsenet: true }));
                if (!title) title = usenetResponse.title || movieTitle;
            }
            torrents = [...tList, ...uList];
        } else {
            // torrent-only
            const torrentResponse = await window.electronAPI.searchTorrents({
                movieTitle,
                tmdbId,
                mediaType,
                season: season || 1,
                episode: episode || 1
            });
            if (torrentResponse && torrentResponse.success && torrentResponse.torrents) {
                torrents = torrentResponse.torrents.map(t => ({ ...t, isUsenet: false }));
                title = torrentResponse.title || movieTitle;
            }
        }

        // Cancel output if a different movie was opened in the meantime
        if (currentRequestNum !== _torrentRequestCounter) {
            console.log(`[streaming] Cancelled outdated search results for: ${movieTitle}`);
            return;
        }

        if (torrents.length === 0) {
            loadingStatus.querySelector('.spinner').style.display = 'none';
            statusText.innerHTML = `${window.icons ? window.icons.close('tab-icon', 'width:13px; height:13px; display:inline-block; vertical-align:middle; margin-right:4px; stroke:var(--vault-signal-alert);') : ''} No media sources found for:<br><strong>${window.escapeHtml(movieTitle)}${epLabel}</strong>.`;
            return;
        }

        // ── Check Real-Debrid cache status for all p2p torrents only ──
        const torrentItems = torrents.filter(t => !t.isUsenet);
        const usenetItems = torrents.filter(t => t.isUsenet);

        let torrentsWithCacheStatus = [];
        if (torrentItems.length > 0) {
            const apiKey = window.appSettings?.rdApiKey;
            const cachedSet = await checkRDCachedBatch(
                torrentItems.map(t => t.hash).filter(Boolean),
                apiKey
            );
            torrentsWithCacheStatus = torrentItems.map(t => ({
                ...t,
                isRDCached: t.hash ? cachedSet.has(t.hash.toLowerCase()) : false
            }));
        }

        const mergedList = [...torrentsWithCacheStatus, ...usenetItems];

        // ── Rank torrents/nzbs by user's quality + language prefs ────────────────
        const ranked = rankTorrents(mergedList);
        window.currentTorrentList = ranked;
        window.currentMovieTitle = title;

        // ── Always pre-render the ranked list (hidden) so the "Choose
        //    Manually" escape hatch in the loading screen has something to
        //    reveal if the user wants it. We auto-pick the best result by
        //    default and start the flow immediately. ─────────────────────────
        torrentsList.style.display = 'none';

        // Header
        const header = document.createElement('div');
        header.style.cssText = 'font-weight:700; font-size:12px; color:#fff; margin-bottom:6px; font-family:var(--font-mono); display:flex; justify-content:space-between; align-items:center;';
        header.innerHTML = `
            <span>Available streams for "<em>${window.escapeHtml(title)}${epLabel}</em>"</span>
            <span style="font-size:9.5px; color:var(--vault-slate); font-weight:500;">
                Ranked: ${preferredQuality} · ${preferredLang.toUpperCase()}
            </span>`;
        torrentsList.appendChild(header);

        ranked.forEach((t, idx) => {
            const btn = document.createElement('button');
            btn.className = 'ctrl-btn-sm';
            btn.style.cssText = 'background:var(--vault-warm-card,#252535); border:1px solid var(--vault-border); border-radius:6px; padding:12px; color:var(--vault-text); font-family:var(--font-sans); text-align:left; cursor:pointer; display:flex; flex-direction:column; gap:4px; transition:all 0.2s; width:100%; position:relative;';

            // Best match badge on first result
            const isBest = idx === 0;
            btn.innerHTML = `
                ${isBest ? `<span style="position:absolute; top:6px; right:8px; background:var(--vault-accent); color:var(--vt-primary); font-size:8px; font-weight:800; padding:2px 6px; border-radius:3px; font-family:var(--font-mono); text-transform:uppercase;">Best Match</span>` : ''}
                <div style="display:flex; justify-content:space-between; align-items:center; width:100%; padding-right:${isBest ? '80px' : '0'};">
                    <strong style="color:var(--vault-accent); font-family:var(--font-mono); font-size:11px; display:inline-flex; align-items:center; gap:6px;">
                        ${t.isUsenet 
                            ? `<span title="Usenet NZB" style="display:inline-flex; align-items:center; gap:4px; background:rgba(168,85,247,0.15); color:#c084fc; font-size:8.5px; font-weight:800; padding:2px 5px; border-radius:3px; font-family:var(--font-mono); text-transform:uppercase; border:1px solid rgba(168,85,247,0.3);"><svg viewBox="0 0 24 24" width="10" height="10" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align:middle; margin-top:-1px;"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg> NZB</span>` 
                            : `<span title="Torrent Torrent" style="display:inline-flex; align-items:center; gap:4px; background:rgba(59,130,246,0.15); color:#60a5fa; font-size:8.5px; font-weight:800; padding:2px 5px; border-radius:3px; font-family:var(--font-mono); text-transform:uppercase; border:1px solid rgba(59,130,246,0.3);"><svg viewBox="0 0 24 24" width="10" height="10" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align:middle; margin-top:-1px;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg> P2P</span>`
                        }
                        ${window.escapeHtml(t.quality)} 
                        <span style="color:var(--vault-slate); font-weight:400; font-size:9.5px;">(${window.escapeHtml(t.type.substring(0, 30).toUpperCase())})</span>
                    </strong>
                    <span style="font-size:9.5px; color:var(--vault-slate); font-weight:600; display:inline-flex; align-items:center; gap:3.5px;">${window.icons ? window.icons.folder('', 'width:10px; height:10px; display:inline-block; vertical-align:middle;') : ''} ${window.escapeHtml(t.size)}</span>
                </div>
                <div style="font-size:10px; color:#eee; text-align:left; margin:2px 0; font-weight:500; font-family:var(--font-sans); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%;">${window.escapeHtml(t.desc || '')}</div>
                <div style="display:flex; gap:15px; font-size:9.5px; color:var(--vault-slate); margin-top:2px;">
                    ${t.isUsenet ? `
                    <span style="display:inline-flex; align-items:center; gap:4.5px;">
                        <span style="display:inline-block; width:5.5px; height:5.5px; border-radius:50%; background:${t.health === 'healthy' ? 'var(--vault-signal-online, #6BE675)' : (t.health === 'unhealthy' ? 'var(--vault-signal-alert, #FF6B7A)' : 'var(--vault-slate, #888)')};"></span>
                        Health: ${t.health ? t.health.toUpperCase() : 'UNKNOWN'} ${t.completionPercent ? '(' + t.completionPercent + '%)' : ''}
                    </span>
                    ` : `
                    <span style="display:inline-flex; align-items:center; gap:4.5px;"><span style="display:inline-block; width:5.5px; height:5.5px; border-radius:50%; background:var(--vault-signal-online, #6BE675); box-shadow: 0 0 5px var(--vault-signal-online);"></span> Seeds: ${t.seeds}</span>
                    <span style="display:inline-flex; align-items:center; gap:4.5px;"><span style="display:inline-block; width:5.5px; height:5.5px; border-radius:50%; background:var(--vault-signal-alert, #FF6B7A); box-shadow: 0 0 5px var(--vault-signal-alert);"></span> Peers: ${t.peers}</span>
                    `}
                </div>`;

            btn.addEventListener('mouseenter', () => {
                btn.style.borderColor = 'var(--vault-gold)';
                btn.style.background = 'rgba(245,185,41,0.05)';
            });
            btn.addEventListener('mouseleave', () => {
                btn.style.borderColor = 'var(--vault-border)';
                btn.style.background = 'var(--vault-warm-card,#252535)';
            });
            
            if (t.isUsenet) {
                btn.addEventListener('click', () => window.startUsenetStreamFlow(t, title, idx));
            } else {
                btn.addEventListener('click', () => window.startRDDebridFlow(t, title, idx));
            }

            torrentsList.appendChild(btn);
        });

        // ── Auto-start the best result ─────────────────────────────────────
        statusText.innerHTML = `${window.icons ? window.icons.lightning('tab-icon spinner-inline', 'width:13px; height:13px; display:inline-block; vertical-align:middle; color:var(--vault-accent); margin-right:4px;') : ''} Auto-selecting best ${preferredQuality} ${preferredLang !== 'en' ? preferredLang.toUpperCase() + ' ' : ''}stream...`;
        await new Promise(r => setTimeout(r, 400));
        if (currentRequestNum !== _torrentRequestCounter) return;
        
        const bestItem = ranked[0];
        if (bestItem.isUsenet) {
            window.startUsenetStreamFlow(bestItem, title, 0);
        } else {
            window.startRDDebridFlow(bestItem, title, 0);
        }

    } catch (e) {
        console.error('[streaming] triggerRDStream failed:', e);
        loadingStatus.querySelector('.spinner').style.display = 'none';
        statusText.innerText = streamingMode === 'usenet-only' ? 'Error scraping Usenet indexers.' : (streamingMode === 'hybrid' ? 'Error scraping media indexes.' : 'Error scraping torrent index.');
    }
};

window.startUsenetStreamFlow = async function(usenetItem, movieTitle, index = 0) {
    const loadingStatus = el('rd-loading-status');
    const statusText = el('rd-status-text');
    const torrentsList = el('rd-torrents-list');

    torrentsList.style.display = 'none';
    loadingStatus.style.display = 'block';
    loadingStatus.querySelector('.spinner').style.display = 'block';
    statusText.innerHTML = `${window.icons ? window.icons.lightning('tab-icon', 'width:13px; height:13px; display:inline-block; vertical-align:middle; color:var(--vault-accent); margin-right:4px;') : ''} Verifying Usenet stream completion & health...<br><span style="font-size:10px; color:var(--vault-slate);">Checking message segments on NNTP provider</span>`;

    const chooseManuallyBtn = el('btn-rd-choose-manually');
    if (chooseManuallyBtn) {
        chooseManuallyBtn.style.display = 'block';
        chooseManuallyBtn.onclick = () => {
            window.activeRDFlowId = null;
            loadingStatus.style.display = 'none';
            torrentsList.style.display = 'flex';
            chooseManuallyBtn.style.display = 'none';
        };
    }

    const currentFlowId = Math.random();
    window.activeRDFlowId = currentFlowId;

    const allStreams = window.currentTorrentList || [];
    let startIndex = index;
    if (usenetItem && !index) {
        startIndex = allStreams.findIndex(s => s.guid === usenetItem.guid || s.downloadUrl === usenetItem.downloadUrl);
    }

    const streamsToTry = [...allStreams].slice(startIndex);

    try {
        const maxAttempts = Math.min(streamsToTry.length, 5);
        let lastError = null;
        let successfulStream = null;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const currentItem = streamsToTry[attempt];
            if (!currentItem) break;
            
            // Fallback to torrent if the next ranked item is a torrent
            if (!currentItem.isUsenet) {
                if (window.activeRDFlowId !== currentFlowId) return;
                window.startRDDebridFlow(currentItem, movieTitle, startIndex + attempt);
                return;
            }

            if (attempt > 0) {
                statusText.innerHTML = `${window.icons ? window.icons.lightning('tab-icon', 'width:13px; height:13px; display:inline-block; vertical-align:middle; color:var(--vault-accent); margin-right:4px;') : ''} Verifying Usenet stream completion & health...<br><span style="font-size:10px; color:var(--vault-slate);">Attempt ${attempt + 1}/${maxAttempts}: ${currentItem.quality} ${currentItem.desc || ''}</span>`;
            }

            // 1. Verify health and password
            const healthResult = await window.electronAPI.verifyUsenetHealth({
                downloadUrl: currentItem.downloadUrl,
                guid: currentItem.guid
            });

            if (window.activeRDFlowId !== currentFlowId) {
                console.log('[Usenet] Flow cancelled during health check');
                return;
            }

            if (!healthResult || healthResult.health === 'unhealthy' || healthResult.isPassworded) {
                console.warn(`[Usenet] Stream ${currentItem.desc} is unhealthy or passworded:`, healthResult);
                lastError = healthResult ? (healthResult.isPassworded ? 'Password-protected NZB' : healthResult.reason) : 'Health verification failed';
                currentItem.health = 'unhealthy';
                currentItem.isPassworded = healthResult ? healthResult.isPassworded : false;
                continue;
            }

            currentItem.health = 'healthy';
            currentItem.completionPercent = healthResult.completionPercent;

            // 2. Add to WebDAV bridge and stream
            statusText.innerHTML = `${window.icons ? window.icons.lightning('tab-icon', 'width:13px; height:13px; display:inline-block; vertical-align:middle; color:var(--vault-accent); margin-right:4px;') : ''} Initiating WebDAV stream mount...<br><span style="font-size:10px; color:var(--vault-slate);">Adding NZB to NzbDAV and resolving largest video file</span>`;

            const streamResult = await window.electronAPI.streamUsenetNzb({
                downloadUrl: currentItem.downloadUrl,
                title: currentItem.desc
            });

            if (window.activeRDFlowId !== currentFlowId) {
                console.log('[Usenet] Flow cancelled during stream resolution');
                return;
            }

            if (streamResult && streamResult.success) {
                if (streamResult.downloading) {
                    let progress = streamResult.progress || 0;
                    let status = streamResult.status || 'downloading';
                    let speed = streamResult.speed || 0;
                    const nzoId = streamResult.nzoId;

                    statusText.innerHTML = `
                        <div style="text-align: center; width: 100%;">
                            <span style="font-size: 13px; font-weight: 700; color: var(--vault-accent, #F5B929); display: block; margin-bottom: 8px;">${window.icons ? window.icons.cloud('', 'width:14px; height:14px; display:inline-block; vertical-align:middle; color:var(--vault-accent); margin-right:4px;') : ''} Downloading NZB via SABnzbd...</span>
                            <div style="width: 100%; height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden; margin: 12px 0;">
                                <div style="width: ${progress}%; height: 100%; background: linear-gradient(90deg, var(--vault-accent, #F5B929), #FF6B7A); border-radius: 4px; transition: width 0.4s ease;"></div>
                            </div>
                            <div style="display: flex; justify-content: space-between; font-size: 11px; color: #fff; margin-bottom: 6px; font-family: var(--font-mono);">
                                <span>Progress: <strong>${progress}%</strong></span>
                                <span>Speed: <strong>${formatSpeed(speed)}</strong></span>
                            </div>
                            <div style="font-size: 10.5px; color: var(--vault-slate); text-align: left; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 6px; margin-top: 6px;">
                                Status: <strong style="color: #fff; text-transform: uppercase;">${status.replace('_', ' ')}</strong>
                            </div>
                        </div>
                    `;

                    while (status !== 'downloaded') {
                        if (window.activeRDFlowId !== currentFlowId || el('rd-stream-dialog').style.display === 'none') {
                            console.log('[Usenet] Downloading flow aborted.');
                            return;
                        }

                        await new Promise(r => setTimeout(r, 3500));

                        if (window.activeRDFlowId !== currentFlowId || el('rd-stream-dialog').style.display === 'none') {
                            console.log('[Usenet] Downloading flow aborted post-sleep.');
                            return;
                        }

                        const poll = await window.electronAPI.getUsenetStatus(nzoId);
                        if (window.activeRDFlowId !== currentFlowId) {
                            console.log('[Usenet] Flow cancelled post getUsenetStatus.');
                            return;
                        }

                        if (!poll || (!poll.success && status !== 'downloading')) {
                            throw new Error(poll ? poll.error : 'Polling SABnzbd failed');
                        }

                        if (poll.success) {
                            status = poll.status;
                            progress = poll.progress || 0;
                            speed = poll.speed || 0;

                            if (status === 'downloaded') {
                                statusText.innerHTML = `${window.icons ? window.icons.lightning('tab-icon', 'width:13px; height:13px; display:inline-block; vertical-align:middle; color:var(--vault-accent); margin-right:4px;') : ''} <span style="color:var(--vault-accent);">Download finished!</span> Extracting and mounting WebDAV stream...`;
                                
                                const finalRes = await window.electronAPI.finalizeUsenetStream({
                                    nzoId: nzoId,
                                    folderName: poll.filename,
                                    title: currentItem.desc
                                });
                                
                                if (window.activeRDFlowId !== currentFlowId) return;
                                
                                if (finalRes && finalRes.success) {
                                    successfulStream = finalRes;
                                    break;
                                } else {
                                    lastError = finalRes?.error || 'Failed to mount WebDAV stream after download';
                                    console.warn(`[Usenet] Final mount failed, trying next...`);
                                    break;
                                }
                            } else if (status === 'error') {
                                throw new Error(`SABnzbd download failed: ${poll.error}`);
                            } else {
                                // Update progress UI
                                statusText.querySelector('.spinner') && (statusText.querySelector('.spinner').style.display = 'none');
                                const pb = statusText.querySelector('div > div > div');
                                if (pb) pb.style.width = `${progress}%`;
                                const spans = statusText.querySelectorAll('div > span > strong');
                                if (spans.length >= 2) {
                                    spans[0].innerText = `${progress}%`;
                                    spans[1].innerText = formatSpeed(speed);
                                }
                                const statStr = statusText.querySelector('div > strong');
                                if (statStr) statStr.innerText = status.toUpperCase();
                            }
                        }
                    }
                } else {
                    successfulStream = streamResult;
                }
                
                if (successfulStream && successfulStream.success) {
                    break;
                }
            }

            lastError = (streamResult && streamResult.error) ? streamResult.error : lastError;
            console.warn(`[Usenet] Stream attempt failed for ${currentItem.desc}:`, lastError);
        }

        if (window.activeRDFlowId !== currentFlowId) return;

        if (!successfulStream) {
            loadingStatus.querySelector('.spinner').style.display = 'none';
            statusText.innerHTML = `${window.icons ? window.icons.close('', 'width:13px; height:13px; display:inline-block; vertical-align:middle; margin-right:4px; stroke:var(--vault-signal-alert);') : ''} Usenet Stream Error:<br><strong style="color:var(--vault-signal-alert, #FF6B7A); font-size:11px; display: block; margin-top: 6px; line-height: 1.4;">${window.escapeHtml(lastError || 'No healthy Usenet streams found')}</strong>`;

            const retryBtn = document.createElement('button');
            retryBtn.innerText = window.currentLang === 'fr' ? 'Retour aux Flux' : 'Back to Streams';
            retryBtn.style.cssText = 'margin-top: 15px; background: var(--vault-accent); color: var(--vt-primary); border: none; padding: 6px 16px; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 11px;';
            retryBtn.addEventListener('click', () => {
                loadingStatus.style.display = 'none';
                torrentsList.style.display = 'flex';
            });
            statusText.appendChild(retryBtn);
            return;
        }

        // SUCCESS!
        el('rd-stream-dialog').style.display = 'none';
        const bd = el('rd-stream-backdrop');
        if (bd) bd.style.display = 'none';
        if (window.activeStreamingMedia) {
            window.activeStreamingMedia.quality = usenetItem.quality || '';
            window.activeStreamingMedia.isUsenet = true;
            window.activeStreamingMedia.nzoId = successfulStream.nzoId;
            window.activeStreamingMedia.folderName = successfulStream.folderName;
        }
        window.playStream(successfulStream.streamUrl, movieTitle);
        window.showToast('Usenet stream loaded successfully via WebDAV bridge!', 'success');

    } catch (e) {
        console.error('Usenet streaming workflow failed:', e);
        loadingStatus.querySelector('.spinner').style.display = 'none';
        statusText.innerHTML = `${window.icons ? window.icons.close('', 'width:13px; height:13px; display:inline-block; vertical-align:middle; margin-right:4px; stroke:var(--vault-signal-alert);') : ''} Usenet Workflow Error:<br><strong style="color:var(--vault-signal-alert, #FF6B7A); font-size:11px; display: block; margin-top: 6px; line-height: 1.4;">${window.escapeHtml(e.message || e)}</strong>`;

        const retryBtn = document.createElement('button');
        retryBtn.innerText = window.currentLang === 'fr' ? 'Retour aux Flux' : 'Back to Streams';
        retryBtn.style.cssText = 'margin-top: 15px; background: var(--vault-accent); color: var(--vt-primary); border: none; padding: 6px 16px; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 11px;';
        retryBtn.addEventListener('click', () => {
            loadingStatus.style.display = 'none';
            torrentsList.style.display = 'flex';
        });
        statusText.appendChild(retryBtn);
    }
};

window.startRDDebridFlow = async function(torrent, movieTitle, index = 0) {
    const loadingStatus = el('rd-loading-status');
    const statusText = el('rd-status-text');
    const torrentsList = el('rd-torrents-list');

    torrentsList.style.display = 'none';
    loadingStatus.style.display = 'block';
    loadingStatus.querySelector('.spinner').style.display = 'block';
    statusText.innerHTML = `${window.icons ? window.icons.lightning('tab-icon', 'width:13px; height:13px; display:inline-block; vertical-align:middle; color:var(--vault-accent); margin-right:4px;') : ''} Unrestricting cached torrent on Real-Debrid servers...<br><span style="font-size:10px; color:var(--vault-slate);">Checking availability & generating direct stream link</span>`;

    const chooseManuallyBtn = el('btn-rd-choose-manually');
    if (chooseManuallyBtn) {
        chooseManuallyBtn.style.display = 'block';
        chooseManuallyBtn.onclick = () => {
            window.activeRDFlowId = null;
            loadingStatus.style.display = 'none';
            torrentsList.style.display = 'flex';
            chooseManuallyBtn.style.display = 'none';
            window.showToast(window.currentLang === 'fr' ? 'Sélection manuelle activée' : 'Manual selection active', 'info');
        };
    }

    // Generate unique flow ID
    const currentFlowId = Math.random();
    window.activeRDFlowId = currentFlowId;

    // Get all torrents for automatic fallback
    const allTorrents = window.currentTorrentList || [];

    // Find starting index
    let startIndex = index;
    if (torrent && !index) {
        startIndex = allTorrents.findIndex(t => t.magnet === torrent.magnet || t.hash === torrent.hash);
    }

    // Sort: RD cached first, then by rank
    const torrentsToTry = [...allTorrents].sort((a, b) => {
        if (a.isRDCached && !b.isRDCached) return -1;
        if (!a.isRDCached && b.isRDCached) return 1;
        return allTorrents.indexOf(a) - allTorrents.indexOf(b);
    });

    // Helper function
    const formatSpeed = (bytesPerSec) => {
        if (!bytesPerSec) return '0 KB/s';
        const kb = bytesPerSec / 1024;
        if (kb < 1024) return kb.toFixed(1) + ' KB/s';
        const mb = kb / 1024;
        return mb.toFixed(1) + ' MB/s';
    };

    try {
        const maxAttempts = Math.min(torrentsToTry.length, 5);
        let lastError = null;
        let successfulResponse = null;
        // Hoisted: the post-loop branch references `response`. If the loop ran
        // zero iterations (empty list / past startIndex) or every iteration
        // hit `continue` before this assignment, the old block-scoped `let`
        // turned every recovery path into a fatal ReferenceError.
        let response = null;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const currentTorrent = torrentsToTry[startIndex + attempt] || torrentsToTry[attempt];
            if (!currentTorrent) break;

            if (attempt > 0) {
                statusText.innerHTML = `${window.icons ? window.icons.lightning('tab-icon', 'width:13px; height:13px; display:inline-block; vertical-align:middle; color:var(--vault-accent); margin-right:4px;') : ''} Unrestricting cached torrent on Real-Debrid servers...<br><span style="font-size:10px; color:var(--vault-slate);">Attempt ${attempt + 1}/${maxAttempts}: ${currentTorrent.quality} ${currentTorrent.desc || ''}</span>`;
            }

            response = await window.electronAPI.streamRDTorrent({
                magnet: currentTorrent.magnet,
                hash: currentTorrent.hash,
                url: currentTorrent.url
            });

            if (window.activeRDFlowId !== currentFlowId) {
                console.log('[Real-Debrid] Flow cancelled during attempt', attempt);
                return;
            }

            // Skip on infringing file
            if (response && response.error === 'infringing_file') {
                console.warn(`[RD] Infringing file, trying next: ${currentTorrent.quality}`);
                lastError = response.error;
                continue;
            }

            // Skip on other recoverable errors
            if (response && !response.success && !response.downloading) {
                const skipErrors = ['link_not_allowed', 'bad_token', 'magnet_error', 'error', 'Duplicate in-flight'];
                if (skipErrors.some(err => response.error && response.error.includes(err))) {
                    console.warn(`[RD] Skipping torrent: ${response.error}`);
                    lastError = response.error;
                    continue;
                }
            }

            if (response && response.success && response.downloading) {
                let progress = response.progress || 0;
                let status = response.status || 'downloading';
                let speed = response.speed || 0;
                let seeders = response.seeders || 0;
                const torrentId = response.torrentId;

                statusText.innerHTML = `
                    <div style="text-align: center; width: 100%;">
                        <span style="font-size: 13px; font-weight: 700; color: var(--vault-accent, #F5B929); display: block; margin-bottom: 8px;">${window.icons ? window.icons.cloud('', 'width:14px; height:14px; display:inline-block; vertical-align:middle; color:var(--vault-accent); margin-right:4px;') : ''} Caching Torrent to Cloud...</span>
                        <div style="width: 100%; height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden; margin: 12px 0;">
                            <div style="width: ${progress}%; height: 100%; background: linear-gradient(90deg, var(--vault-accent, #F5B929), #FF6B7A); border-radius: 4px; transition: width 0.4s ease;"></div>
                        </div>
                        <div style="display: flex; justify-content: space-between; font-size: 11px; color: #fff; margin-bottom: 6px; font-family: var(--font-mono);">
                            <span>Progress: <strong>${progress}%</strong></span>
                            <span>Speed: <strong>${formatSpeed(speed)}</strong></span>
                        </div>
                        <div style="font-size: 10.5px; color: var(--vault-slate); text-align: left; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 6px; margin-top: 6px;">
                            Status: <strong style="color: #fff; text-transform: uppercase;">${status.replace('_', ' ')}</strong> | Seeders: <strong style="color: #fff;">${seeders}</strong>
                        </div>
                    </div>
                `;

                while (status !== 'downloaded') {
                    if (window.activeRDFlowId !== currentFlowId || el('rd-stream-dialog').style.display === 'none') {
                        console.log('[Real-Debrid] Caching flow aborted.');
                        return;
                    }

                    await new Promise(r => setTimeout(r, 3500));

                    if (window.activeRDFlowId !== currentFlowId || el('rd-stream-dialog').style.display === 'none') {
                        console.log('[Real-Debrid] Caching flow aborted post-sleep.');
                        return;
                    }

                    const poll = await window.electronAPI.getTorrentStatus(torrentId);
                    if (window.activeRDFlowId !== currentFlowId) {
                        console.log('[Real-Debrid] Flow cancelled post getTorrentStatus.');
                        return;
                    }

                    if (!poll || !poll.success) {
                        throw new Error(poll ? poll.error : 'Polling failed');
                    }

                    status = poll.status;
                    progress = poll.progress || 0;
                    speed = poll.speed || 0;
                    seeders = poll.seeders || 0;

                    if (status === 'downloaded' || (poll.links && poll.links.length > 0)) {
                        statusText.innerHTML = `${window.icons ? window.icons.lightning('tab-icon', 'width:13px; height:13px; display:inline-block; vertical-align:middle; color:var(--vault-accent); margin-right:4px;') : ''} <span style="color:var(--vault-accent);">Caching finished!</span> Unrestricting final stream...`;
                        const finalRes = await window.electronAPI.streamRDTorrent({
                            magnet: currentTorrent.magnet,
                            hash: currentTorrent.hash,
                            url: currentTorrent.url
                        });
                        if (window.activeRDFlowId !== currentFlowId) return;
                        if (finalRes && finalRes.success) {
                            response = finalRes;
                            break;
                        } else {
                            lastError = finalRes?.error || 'Failed to unrestrict finished link';
                            console.warn(`[RD] Final unrestrict failed, trying next...`);
                            break;
                        }
                    } else if (status === 'dead' || status === 'error' || status === 'magnet_error') {
                        throw new Error(`Torrent download failed: ${status}`);
                    }
                }
            }

            // After each attempt, check if we succeeded
            if (response && response.success) {
                successfulResponse = response;
                break;
            }

            lastError = response?.error || 'Unknown error';
            console.warn(`[RD] Attempt ${attempt + 1}/${maxAttempts} failed, trying next...`);
        }

        if (window.activeRDFlowId !== currentFlowId) return;

        if (successfulResponse && successfulResponse.success) {
            response = successfulResponse;
        }

        if (!response || !response.success) {
            loadingStatus.querySelector('.spinner').style.display = 'none';
            let errMsg = 'Failed to load torrent.';

            if (lastError === 'infringing_file') {
                errMsg = window.currentLang === 'fr'
                    ? "Tous les flux ont été bloqués pour atteinte aux droits d'auteur (DMCA)."
                    : "All streams were blocked due to copyright complaints (DMCA).";
            } else if (lastError) {
                if (lastError.includes('bad_token')) {
                    errMsg = window.currentLang === 'fr'
                        ? "Clé API Real-Debrid non configurée, invalide ou expirée."
                        : "Real-Debrid API key is unconfigured, invalid, or expired.";
                } else if (lastError.includes('link_not_allowed')) {
                    errMsg = window.currentLang === 'fr'
                        ? "Aucun des liens testés n'est autorisé par Real-Debrid."
                        : "None of the tested links are allowed by Real-Debrid.";
                } else {
                    errMsg = lastError;
                }
            }

            statusText.innerHTML = `${window.icons ? window.icons.close('', 'width:13px; height:13px; display:inline-block; vertical-align:middle; margin-right:4px; stroke:var(--vault-signal-alert);') : ''} Real-Debrid Error:<br><strong style="color:var(--vault-signal-alert, #FF6B7A); font-size:11px; display: block; margin-top: 6px; line-height: 1.4;">${window.escapeHtml(errMsg)}</strong>`;

            const retryBtn = document.createElement('button');
            retryBtn.innerText = window.currentLang === 'fr' ? 'Retour aux Flux' : 'Back to Streams';
            retryBtn.style.cssText = 'margin-top: 15px; background: var(--vault-accent); color: var(--vt-primary); border: none; padding: 6px 16px; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 11px;';
            retryBtn.addEventListener('click', () => {
                loadingStatus.style.display = 'none';
                torrentsList.style.display = 'flex';
            });
            statusText.appendChild(retryBtn);
            return;
        }

        // SUCCESS!
        el('rd-stream-dialog').style.display = 'none';
        const bd = el('rd-stream-backdrop');
        if (bd) bd.style.display = 'none';
        if (window.activeStreamingMedia) {
            const successfulTorrent = torrentsToTry.find(t => t.magnet === response.magnet || t.hash === response.hash);
            window.activeStreamingMedia.quality = (successfulTorrent || {}).quality || '';
        }
        window.playStream(response.streamUrl, movieTitle);
        window.showToast('Direct high-speed RD stream loaded successfully!', 'success');
    } catch (e) {
        console.error('Real-Debrid streaming workflow failed:', e);
        loadingStatus.querySelector('.spinner').style.display = 'none';
        statusText.innerHTML = `${window.icons ? window.icons.close('', 'width:13px; height:13px; display:inline-block; vertical-align:middle; margin-right:4px; stroke:var(--vault-signal-alert);') : ''} Real-Debrid Workflow Error:<br><strong style="color:var(--vault-signal-alert, #FF6B7A); font-size:11px; display: block; margin-top: 6px; line-height: 1.4;">${window.escapeHtml(e.message || e)}</strong>`;

        const retryBtn = document.createElement('button');
        retryBtn.innerText = window.currentLang === 'fr' ? 'Retour aux Flux' : 'Back to Streams';
        retryBtn.style.cssText = 'margin-top: 15px; background: var(--vault-accent); color: var(--vt-primary); border: none; padding: 6px 16px; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 11px;';
        retryBtn.addEventListener('click', () => {
            loadingStatus.style.display = 'none';
            torrentsList.style.display = 'flex';
        });
        statusText.appendChild(retryBtn);
    }
};
