// js/streaming/rd-flow.js — Real-Debrid streaming flow: search, rank, cache-check, unrestrict, play
// Part of the streaming feature, split out of the former monolithic js/streaming.js.

// ─── Quality/Language-Aware triggerRDStream ───────────────────────────────────

let _torrentRequestCounter = 0;

/** Search for the active title's sources even though a last source exists (another release than the one saved). */
window.findOtherSources = function () {
    const m = window.activeStreamingMedia;
    if (!m) return;
    window.triggerRDStream(m.title, m.tmdbId, m.mediaType || 'movie', m.season, m.episode,
        { poster: m.poster, year: m.year, skipLastSource: true });
};

/**
 * Play the source that worked last time for the active title (saved as `lastSource` with its watch progress).
 * Resolves true when it is playing; false (after a short notice) when there is none or it no longer resolves.
 */
async function playLastSource(requestNum, movieTitle, epLabel, statusText) {
    const m = window.activeStreamingMedia;
    if (!m || !window.electronAPI.getWatchProgress) return false;
    let prog = null;
    try {
        prog = await window.electronAPI.getWatchProgress({ mediaType: m.mediaType, tmdbId: m.tmdbId, title: m.title,
                                                           season: m.season, episode: m.episode });
    } catch (_) { return false; }
    // (a TV lookup without an episode returns the latest episode: only reuse the episode asked for)
    const src = prog && prog.lastSource;
    if (!src || !src.url || (m.mediaType === 'tv' && (prog.season !== m.season || prog.episode !== m.episode))) return false;
    if (requestNum !== _torrentRequestCounter) return true;   // superseded: nothing to do here
    // while it opens, "Choose Manually" runs the normal search instead (another release)
    const chooseBtn = el('btn-rd-choose-manually');
    if (chooseBtn) {
        chooseBtn.style.display = 'block';
        chooseBtn.onclick = () => window.findOtherSources();
    }
    statusText.innerHTML = `${window.icons ? window.icons.lightning('tab-icon spinner-inline', 'width:13px; height:13px; display:inline-block; vertical-align:middle; color:var(--vault-accent); margin-right:4px;') : ''} ${window.currentLang === 'fr' ? 'Ouverture de la dernière source' : 'Opening the last source'}:<br><strong>${window.escapeHtml(`${movieTitle}${epLabel}`)}</strong><br><span style="font-size:10px; color:var(--vault-slate);">${window.escapeHtml(`${src.quality || ''} ${src.desc || ''}`)}</span>`;
    let r = null;
    try {
        r = await window.electronAPI.streamRDTorrent({ url: src.url, hash: src.hash, name: src.name, cached: false });
    } catch (_) { r = null; }
    if (requestNum !== _torrentRequestCounter) return true;
    if (!r || !r.success || !r.streamUrl) {
        console.warn('[streaming] last source no longer plays:', r && r.error);
        window.showToast(tr('toastCachedExpired', 'Cached stream expired — finding a fresh source…'), 'info');
        return false;
    }
    const t = { ...src, isRDCached: true, cached: true, fit: 'exact', type: `⚡ ${src.name || ''}`, seeds: '—', peers: '—' };
    window.currentTorrentList = [t];      // the quality menu lists this one (a manual search finds the others)
    window.currentMovieTitle = movieTitle;
    if (typeof window.qualityLabelOf === 'function') window._activeStreamLabel = window.qualityLabelOf(t);
    m.quality = src.quality || '';
    m.release = String(src.desc || '').replace(/^📄\s*/, '');
    m.lastSource = { ...src, savedAt: new Date().toISOString() };
    console.log('[streaming] playing the last source:', (src.desc || src.name || '').slice(0, 80));
    window.playStream(r.streamUrl, movieTitle);
    window.showToast(window.currentLang === 'fr' ? 'Dernière source rouverte.' : 'Opened the last source.', 'success');
    return true;
}

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
window.triggerRDStream = async function(movieTitle, tmdbId = null, mediaType = 'movie', season = null, episode = null, meta = null) {
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
    // Re-show the spinner — prior runs hide it (display:none) on completion/error,
    // and it was never reset, so subsequent searches showed a spinner-less dialog.
    const _spin = loadingStatus.querySelector('.spinner');
    if (_spin) _spin.style.display = 'block';
    torrentsList.style.display = 'none';
    torrentsList.innerHTML = '';
    const chooseManuallyBtn = el('btn-rd-choose-manually');
    if (chooseManuallyBtn) chooseManuallyBtn.style.display = 'none';

    // Usenet is disabled (VaultWares single-IP / Comet-only policy). Force
    // torrent-only so the usenet-only / hybrid branches (which call the removed
    // searchUsenet handler) can never run. Do not restore the settings read.
    const streamingMode = 'torrent-only';

    if (titleTextEl) {
        // Real-Debrid through Comet, with Deepbrid as the fallback, so naming a
        // single provider here would be inaccurate.
        if (streamingMode === 'usenet-only') {
            titleTextEl.textContent = 'Usenet Streaming';
        } else if (streamingMode === 'hybrid') {
            titleTextEl.textContent = 'Hybrid Streaming';
        } else {
            titleTextEl.textContent = 'VaultWares Streaming';
        }
    }

    const isTV = mediaType === 'tv';
    const epLabel = isTV && season != null ? ` S${String(season).padStart(2,'0')}E${String(episode || 1).padStart(2,'0')}` : '';

    if (streamingMode === 'usenet-only') {
        statusText.innerHTML = `${window.icons ? window.icons.search('tab-icon spinner-inline', 'width:13px; height:13px; display:inline-block; vertical-align:middle; color:var(--vault-accent); margin-right:4px;') : ''} Scraping Usenet index for:<br><strong>${window.escapeHtml(movieTitle)}${epLabel}</strong>...`;
    } else if (streamingMode === 'hybrid') {
        statusText.innerHTML = `${window.icons ? window.icons.search('tab-icon spinner-inline', 'width:13px; height:13px; display:inline-block; vertical-align:middle; color:var(--vault-accent); margin-right:4px;') : ''} Scraping Torrents & Usenet for:<br><strong>${window.escapeHtml(movieTitle)}${epLabel}</strong>...`;
    } else {
        statusText.innerHTML = `${window.icons ? window.icons.search('tab-icon spinner-inline', 'width:13px; height:13px; display:inline-block; vertical-align:middle; color:var(--vault-accent); margin-right:4px;') : ''} Querying Comet for cached streams:<br><strong>${window.escapeHtml(movieTitle)}${epLabel}</strong>...`;
    }

    const preferredQuality = getPreferredQuality();
    const preferredLang = getPreferredLang();

    // Cache streaming media metadata for the watch history system.
    // Prefer explicit `meta` (passed by direct-play callers like the Library grid,
    // where the details-modal DOM holds stale poster/year); fall back to the DOM.
    const posterEl = el('streaming-details-poster');
    const yearEl = el('streaming-details-year');
    // A position kept for a quality / source switch belongs to that title (episode) only: another one (Play next, an
    // episode picked while playing) starts at its own saved position, not where the previous episode was.
    const prevMedia = window.activeStreamingMedia;
    const sameItem = prevMedia && String(prevMedia.tmdbId || prevMedia.title) === String(tmdbId || movieTitle)
        && (prevMedia.season || null) === (isTV ? (season || 1) : null) && (prevMedia.episode || null) === (isTV ? (episode || 1) : null);
    if (!sameItem) {
        window._resumePosAfterSwitch = null;
        // leaving a playing title for another: its position is saved now (as itself) and it stops, so its clock is
        // never saved under the new one while the new one's source is searched
        const vpEl = el('video-player');
        if (prevMedia && prevMedia.streamUrl && vpEl && vpEl.duration > 0 && !prevMedia.creditsDone) {
            const at = vpEl.currentTime, dur = vpEl.duration;
            if (window.isWatchedAt && window.isWatchedAt(at, dur)) {
                window.electronAPI.markWatched({ mediaType: prevMedia.mediaType, tmdbId: prevMedia.tmdbId, title: prevMedia.title,
                    season: prevMedia.season, episode: prevMedia.episode, poster: prevMedia.poster, year: prevMedia.year }).catch(() => {});
            } else {
                window.electronAPI.setWatchProgress({ ...prevMedia, positionSec: at, durationSec: dur }).catch(() => {});
            }
        }
        if (prevMedia && vpEl && !vpEl.paused) vpEl.pause();
    }
    window.activeStreamingMedia = {
        mediaType: mediaType || 'movie',
        tmdbId: tmdbId || null,
        title: movieTitle,
        season: isTV ? (season || 1) : null,
        episode: isTV ? (episode || 1) : null,
        // (the details page's poster element may hold an inline placeholder image: never keep that)
        poster: (meta && meta.poster) || (posterEl && /^https?:/i.test(posterEl.src) ? posterEl.src : null),
        year: (meta && meta.year) || (yearEl ? yearEl.textContent : null)
    };

    try {
        // Stagger request to prevent rate limits
        await new Promise(r => setTimeout(r, 500));

        // Cancel output if another search was triggered during the stagger delay
        if (currentRequestNum !== _torrentRequestCounter) {
            console.log(`[streaming] Cancelled outdated torrent search stagger for: ${movieTitle}`);
            return;
        }

        // The source this title (episode) played from last time: open it directly — no search, no picking. Only if
        // it no longer resolves (dropped from the debrid account, …) does the normal search run.
        if (!(meta && meta.skipLastSource) && await playLastSource(currentRequestNum, movieTitle, epLabel, statusText)) return;
        if (currentRequestNum !== _torrentRequestCounter) return;

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

        // Comet tells us which streams are cached (it returns a resolved `url`
        // for those; search.js sets `cached:true`). We trust that flag instead
        // of hitting Real-Debrid directly — a direct call would use the account
        // IP and, since RD killed instantAvailability, would trigger a grab.
        let torrentsWithCacheStatus = [];
        if (torrentItems.length > 0) {
            torrentsWithCacheStatus = torrentItems.map(t => ({
                ...t,
                isRDCached: !!t.cached
            }));
        }

        const mergedList = [...torrentsWithCacheStatus, ...usenetItems];

        // ── Rank torrents/nzbs by user's quality + language prefs ────────────────
        // Listed in the order they will be tried (so "Best Match" is what plays
        // first), then the entries auto-play skips (no link, CAM/3D, other episode).
        const scored = rankTorrents(mergedList);
        const autoQueue = window.buildPlayQueue(scored, { max: Infinity });
        const ranked = [...autoQueue, ...scored.filter(t => !autoQueue.includes(t))];
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

        // ── Auto-start the best result (filtering out CAM/3D/promo releases) ──
        statusText.innerHTML = `${window.icons ? window.icons.lightning('tab-icon spinner-inline', 'width:13px; height:13px; display:inline-block; vertical-align:middle; color:var(--vault-accent); margin-right:4px;') : ''} Auto-selecting best ${preferredQuality} ${preferredLang !== 'en' ? preferredLang.toUpperCase() + ' ' : ''}stream...`;
        await new Promise(r => setTimeout(r, 400));
        if (currentRequestNum !== _torrentRequestCounter) return;
        
        const isRejected = window.isRejectedForAutoPlay || (() => false);
        const acceptableStreams = ranked.filter(t => !isRejected(t) && t.fit !== 'other');

        if (acceptableStreams.length === 0) {
            // All streams are CAM / 3D / promo recordings! Never auto-play.
            // Reveal the manual stream picker with a clear warning.
            loadingStatus.style.display = 'none';
            torrentsList.style.display = 'flex';
            if (chooseManuallyBtn) chooseManuallyBtn.style.display = 'none';
            
            const warningBanner = document.createElement('div');
            warningBanner.style.cssText = 'background: rgba(255, 107, 122, 0.15); border: 1px solid var(--vault-signal-alert, #FF6B7A); border-radius: 6px; padding: 10px 12px; margin-bottom: 10px; color: #fff; font-size: 11px; display: flex; align-items: center; gap: 8px; font-family: var(--font-sans);';
            warningBanner.innerHTML = `${window.icons ? window.icons.alert('', 'width:16px; height:16px; stroke:var(--vault-signal-alert, #FF6B7A); flex-shrink:0;') : ''} <span><strong>Notice:</strong> Only CAM / low-quality or 3D releases were found. Auto-play disabled — select a stream manually below if you wish to proceed.</span>`;
            torrentsList.insertBefore(warningBanner, torrentsList.firstChild);
            return;
        }

        // The queue head, or — when no entry has a Real-Debrid link — no pick at
        // all: the flow then goes straight to its Deepbrid fallback.
        window.startRDDebridFlow(autoQueue[0] || null, title, 0);

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

        // SUCCESS! The dialog is dismissed by beginPlayerHandoff() once the
        // player shell is up, so the two never both disappear at once.
        if (window.activeStreamingMedia) {
            window.activeStreamingMedia.quality = usenetItem.quality || '';
            window.activeStreamingMedia.isUsenet = true;
            window.activeStreamingMedia.nzoId = successfulStream.nzoId;
            window.activeStreamingMedia.folderName = successfulStream.folderName;
        }
        window.playStream(successfulStream.streamUrl, movieTitle);
        window.showToast(tr('toastUsenetLoaded', 'Usenet stream loaded successfully via WebDAV bridge!'), 'success');

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
    // `index` is kept for older callers (the quality picker); the source is found by identity, not position.
    const loadingStatus = el('rd-loading-status');
    const statusText = el('rd-status-text');
    const torrentsList = el('rd-torrents-list');
    const fr = window.currentLang === 'fr';
    const boltIcon = window.icons ? window.icons.lightning('tab-icon', 'width:13px; height:13px; display:inline-block; vertical-align:middle; color:var(--vault-accent); margin-right:4px;') : '';

    // Record the committed quality so the quality picker can mark "now playing".
    if (torrent && typeof window.qualityLabelOf === 'function') {
        window._activeStreamLabel = window.qualityLabelOf(torrent);
    }

    torrentsList.style.display = 'none';
    loadingStatus.style.display = 'block';
    loadingStatus.querySelector('.spinner').style.display = 'block';
    statusText.innerHTML = `${boltIcon} ${fr ? 'Préparation du flux Real-Debrid…' : 'Preparing the Real-Debrid stream…'}<br><span style="font-size:10px; color:var(--vault-slate);">${fr ? 'Vérification de la disponibilité' : 'Checking availability'}</span>`;

    const chooseManuallyBtn = el('btn-rd-choose-manually');
    if (chooseManuallyBtn) {
        chooseManuallyBtn.style.display = 'block';
        chooseManuallyBtn.onclick = () => {
            window.activeRDFlowId = null;
            loadingStatus.style.display = 'none';
            torrentsList.style.display = 'flex';
            chooseManuallyBtn.style.display = 'none';
            window.showToast(fr ? 'Sélection manuelle activée' : 'Manual selection active', 'info');
        };
    }

    const currentFlowId = Math.random();
    window.activeRDFlowId = currentFlowId;
    const cancelled = () => window.activeRDFlowId !== currentFlowId;

    // The ranked, de-duplicated list from triggerRDStream. The picked source goes first; the rest follow in
    // queue order (cached, then single episode / film, then packs), never a link-less entry or a duplicate hash.
    const allTorrents = window.currentTorrentList || [];
    const queue = window.buildPlayQueue(allTorrents, { pick: torrent && torrent.url ? torrent : null });
    const budgetMs = window.PLAY_QUEUE_BUDGET_MS || 120000;
    const started = Date.now();

    const media = window.activeStreamingMedia || {};
    const proxy = (window.appSettings && window.appSettings.debridProxyEnable)
        ? (window.appSettings.debridProxyAddress || '') : '';
    let deepbridTried = false;
    let deepbridDownloading = null;   // { src, progress, torrentId } while Deepbrid downloads the torrent it was given
    const askDeepbrid = async (src, torrentId = null) => {
        const db = await window.electronAPI.streamDeepbrid({ magnet: src.magnet, hash: src.hash, name: src.name, proxy,
            torrentId,   // a retry polls the torrent Deepbrid is downloading instead of adding the magnet again
            // a season pack must yield the requested episode, never another one
            season: media.mediaType === 'tv' ? media.season : null,
            episode: media.mediaType === 'tv' ? media.episode : null });
        if (db && db.success) { deepbridDownloading = null; return { ...db, magnet: src.magnet, hash: src.hash, source: src }; }
        deepbridDownloading = db && db.downloading
            ? { src, progress: Number(db.progress) || 0, torrentId: db.torrentId || torrentId || null } : null;
        if (db && !db.notConfigured) {
            console.warn('[Deepbrid] failed:', db.error);
            if (!deepbridDownloading) lastError = `${lastError ? lastError + ' — ' : ''}Deepbrid: ${db.error}`;
        }
        return null;
    };
    const tryDeepbrid = async (src) => {
        if (!src || deepbridTried || !window.electronAPI.streamDeepbrid) return null;
        deepbridTried = true;
        statusText.innerHTML = `${boltIcon} ${fr ? 'Essai avec Deepbrid…' : 'Trying Deepbrid…'}<br><span style="font-size:10px; color:var(--vault-slate);">${window.escapeHtml(`${src.quality || ''} ${src.desc || ''}`)}</span>`;
        return askDeepbrid(src);
    };

    let lastError = null;
    let response = null;
    let tried = 0;
    let placeholders = 0;
    let refused = 0;       // sources Real-Debrid refused (most often a copyright block on that release)
    const notReady = [];   // sources Real-Debrid accepted and is downloading (Comet's MEDIA_NOT_CACHED_YET)

    try {
        // A manual pick Comet has no link for can only play through Deepbrid: try it there first.
        if (torrent && !torrent.url && torrent.magnet) {
            response = await tryDeepbrid(torrent);
            if (cancelled()) return;
        }

        for (let i = 0; !response && i < queue.length; i++) {
            if (Date.now() - started > budgetMs) {
                console.warn(`[RD] Time budget spent after ${tried} sources`);
                break;
            }
            const current = queue[i];
            tried++;
            statusText.innerHTML = `${boltIcon} ${fr ? 'Ouverture du flux Real-Debrid…' : 'Opening the Real-Debrid stream…'}<br><span style="font-size:10px; color:var(--vault-slate);">${fr ? 'Source' : 'Source'} ${i + 1}/${queue.length}${current.isRDCached ? ' ⚡' : ''}: ${window.escapeHtml(`${current.quality || ''} ${current.desc || ''}`)}</span>`;

            const r = await window.electronAPI.streamRDTorrent({
                magnet: current.magnet,
                hash: current.hash,
                url: current.url,
                name: current.name,
                cached: !!current.isRDCached,
            });
            if (cancelled()) {
                console.log('[Real-Debrid] Flow cancelled during source', i + 1);
                return;
            }
            if (r && r.success) {
                response = { ...r, magnet: current.magnet, hash: current.hash, source: current };
                break;
            }
            if (r && r.placeholder) placeholders++;
            if (r && r.refused) refused++;
            if (r && r.notCachedYet) notReady.push(current);
            lastError = (r && r.error) || 'Unknown error';
            console.warn(`[RD] Source ${i + 1}/${queue.length} failed (${lastError}), trying next`);
        }

        // Nothing played through Real-Debrid / Comet: one Deepbrid try with the likeliest magnet (it starts Deepbrid's
        // download when it does not have it). Skipped quietly when no Deepbrid key is configured.
        if (!response) {
            response = await tryDeepbrid(window.pickDeepbridSource(allTorrents, { pick: torrent }));
            if (cancelled()) return;
        }

        // Still nothing, but something is downloading: Real-Debrid sources it accepted (MEDIA_NOT_CACHED_YET) and/or
        // the torrent Deepbrid took. Ask them again every few seconds for a bounded time (ranking.js: pickWaitSources,
        // RD_WAIT). Sources Real-Debrid refused (copyright block) are never asked again.
        const waitFor = !response && typeof window.pickWaitSources === 'function' ? window.pickWaitSources(notReady) : [];
        const wait = window.RD_WAIT || { rounds: 6, intervalMs: 15000 };
        for (let round = 1; !response && (waitFor.length || deepbridDownloading) && round <= wait.rounds; round++) {
            const who = [waitFor.length ? 'Real-Debrid' : '', deepbridDownloading ? 'Deepbrid' : ''].filter(Boolean).join(' + ');
            const pct = deepbridDownloading && deepbridDownloading.progress ? ` · Deepbrid ${Math.round(deepbridDownloading.progress)} %` : '';
            for (let left = Math.round(wait.intervalMs / 1000); left > 0; left--) {
                statusText.innerHTML = `${boltIcon} ${window.escapeHtml(fr ? `${who} télécharge cet épisode…` : `${who} is downloading this…`)}<br><span style="font-size:10px; color:var(--vault-slate);">${window.escapeHtml(fr
                    ? `Nouvel essai dans ${left} s (${round}/${wait.rounds})${pct} — ou choisissez un flux manuellement`
                    : `Checking again in ${left} s (${round}/${wait.rounds})${pct} — or pick a stream manually`)}</span>`;
                await new Promise(r => setTimeout(r, 1000));
                if (cancelled()) return;
            }
            for (const current of waitFor) {
                const r = await window.electronAPI.streamRDTorrent({
                    magnet: current.magnet, hash: current.hash, url: current.url, name: current.name, cached: false,
                });
                if (cancelled()) return;
                if (r && r.success) {
                    console.log(`[RD] Ready on Real-Debrid after ${round} wait round(s)`);
                    response = { ...r, magnet: current.magnet, hash: current.hash, source: current };
                    break;
                }
                lastError = (r && r.error) || lastError;
            }
            if (!response && deepbridDownloading) {
                response = await askDeepbrid(deepbridDownloading.src, deepbridDownloading.torrentId);
                if (cancelled()) return;
                if (response) console.log(`[Deepbrid] Ready after ${round} wait round(s)`);
            }
            if (!response) console.warn(`[RD] Still downloading after wait round ${round}/${wait.rounds}`);
        }

        if (!response || !response.success) {
            loadingStatus.querySelector('.spinner').style.display = 'none';
            let errMsg = lastError || (fr ? 'Échec du chargement du flux.' : 'Failed to load the stream.');

            if (tried === 0 && !deepbridTried) {
                errMsg = fr
                    ? "Aucune source n'a de lien Real-Debrid. Choisissez un flux manuellement."
                    : 'No source has a Real-Debrid link. Select a stream manually.';
            } else if (lastError === 'infringing_file') {
                errMsg = fr
                    ? "Tous les flux ont été bloqués pour atteinte aux droits d'auteur (DMCA)."
                    : 'All streams were blocked due to copyright complaints (DMCA).';
            } else if (lastError && lastError.includes('bad_token')) {
                errMsg = fr
                    ? 'Clé API Real-Debrid non configurée, invalide ou expirée.'
                    : 'Real-Debrid API key is unconfigured, invalid, or expired.';
            } else if (lastError && lastError.includes('link_not_allowed')) {
                errMsg = fr
                    ? "Aucun des liens testés n'est autorisé par Real-Debrid."
                    : 'None of the tested links are allowed by Real-Debrid.';
            } else if (deepbridDownloading) {
                errMsg = fr
                    ? `Deepbrid télécharge encore cet épisode (${Math.round(deepbridDownloading.progress)} %). Réessayez dans quelques minutes.`
                    : `Deepbrid is still downloading this episode (${Math.round(deepbridDownloading.progress)} %). Try again in a few minutes.`;
            } else if (refused > 0 && refused === placeholders) {
                errMsg = fr
                    ? `Real-Debrid a refusé ${refused} version(s) de cet épisode (le plus souvent un blocage pour droits d'auteur). Choisissez une autre version manuellement.`
                    : `Real-Debrid refused ${refused} release(s) of this episode (most often a copyright block). Pick another release manually.`;
            } else if (placeholders > 0) {
                errMsg = fr
                    ? `${tried} source(s) essayée(s), ${placeholders} pas encore disponible(s) sur Real-Debrid. Choisissez un flux manuellement ou réessayez plus tard.`
                    : `Tried ${tried} source(s); ${placeholders} not available on Real-Debrid yet. Select a stream manually or try again later.`;
            }

            statusText.innerHTML = `${window.icons ? window.icons.close('', 'width:13px; height:13px; display:inline-block; vertical-align:middle; margin-right:4px; stroke:var(--vault-signal-alert);') : ''} ${fr ? 'Erreur de flux' : 'Stream error'}:<br><strong style="color:var(--vault-signal-alert, #FF6B7A); font-size:11px; display: block; margin-top: 6px; line-height: 1.4;">${window.escapeHtml(errMsg)}</strong>`;

            const retryBtn = document.createElement('button');
            retryBtn.innerText = fr ? 'Retour aux Flux' : 'Back to Streams';
            retryBtn.style.cssText = 'margin-top: 15px; background: var(--vault-accent); color: var(--vt-primary); border: none; padding: 6px 16px; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 11px;';
            retryBtn.addEventListener('click', () => {
                loadingStatus.style.display = 'none';
                torrentsList.style.display = 'flex';
            });
            statusText.appendChild(retryBtn);
            return;
        }

        // SUCCESS! The dialog is dismissed by beginPlayerHandoff() once the
        // player shell is up, so the two never both disappear at once.
        const successfulTorrent = response.source || null;
        if (successfulTorrent && typeof window.qualityLabelOf === 'function') {
            window._activeStreamLabel = window.qualityLabelOf(successfulTorrent);
        }
        if (window.activeStreamingMedia) {
            window.activeStreamingMedia.quality = (successfulTorrent || {}).quality || '';
            // the release name: subtitles made for the same release (group, source) have the right timing
            window.activeStreamingMedia.release = String((successfulTorrent || {}).desc || '').replace(/^📄\s*/, '');
            // the source that played, so the next play of this title can open it directly (no search, no picking);
            // saved with the watch progress, its link without the Comet config (src/watch-history.js)
            window.activeStreamingMedia.lastSource = (response.provider !== 'deepbrid' && successfulTorrent && successfulTorrent.url)
                ? { url: successfulTorrent.url, hash: successfulTorrent.hash || null, name: successfulTorrent.name || '',
                    desc: successfulTorrent.desc || '', quality: successfulTorrent.quality || '', size: successfulTorrent.size || '',
                    savedAt: new Date().toISOString() }
                : null;
        }
        window.playStream(response.streamUrl, movieTitle);
        if (response.provider === 'deepbrid') {
            window.showToast(fr ? 'Flux Deepbrid chargé.' : 'Deepbrid stream loaded.', 'success');
        } else {
            window.showToast(tr('toastRdStreamLoaded', 'Direct high-speed RD stream loaded successfully!'), 'success');
        }
        const prefLang = typeof getPreferredLang === 'function' ? getPreferredLang() : (window.appSettings?.streamLang || 'en');
        if (prefLang === 'fr') {
            const sText = `${(successfulTorrent && successfulTorrent.desc) || ''} ${(successfulTorrent && successfulTorrent.name) || ''}`.toLowerCase();
            const hasFrench = /\b(vf|vff|vfq|vfi|french|truefrench|multi|dual|vostfr)\b/.test(sText);
            if (!hasFrench) {
                setTimeout(() => {
                    window.showToast(fr
                        ? 'Aucun flux français en cache. Lecture du meilleur flux en cache (sous-titres français disponibles).'
                        : 'No cached French stream found. Playing best cached stream (French subtitles available).',
                        'info', 6000);
                }, 1200);
            }
        }
    } catch (e) {
        console.error('Real-Debrid streaming workflow failed:', e);
        loadingStatus.querySelector('.spinner').style.display = 'none';
        statusText.innerHTML = `${window.icons ? window.icons.close('', 'width:13px; height:13px; display:inline-block; vertical-align:middle; margin-right:4px; stroke:var(--vault-signal-alert);') : ''} ${fr ? 'Erreur de flux' : 'Stream error'}:<br><strong style="color:var(--vault-signal-alert, #FF6B7A); font-size:11px; display: block; margin-top: 6px; line-height: 1.4;">${window.escapeHtml(e.message || e)}</strong>`;

        const retryBtn = document.createElement('button');
        retryBtn.innerText = fr ? 'Retour aux Flux' : 'Back to Streams';
        retryBtn.style.cssText = 'margin-top: 15px; background: var(--vault-accent); color: var(--vt-primary); border: none; padding: 6px 16px; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 11px;';
        retryBtn.addEventListener('click', () => {
            loadingStatus.style.display = 'none';
            torrentsList.style.display = 'flex';
        });
        statusText.appendChild(retryBtn);
    }
};
