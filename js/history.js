/* ==========================================================================
   Vault Watch History Rendering Module
   ========================================================================== */

window.renderWatchHistoryTab = async function() {
    const grid = el('history-grid');
    if (!grid) return;

    const t = window.translations[window.currentLang === 'fr' ? 'fr' : 'en'] || {};

    grid.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:var(--vault-slate); padding:40px 0;"><div class="spinner" style="margin:0 auto 12px;"></div>${t.loadingHistory || 'Loading watch history...'}</div>`;

    try {
        const res = await window.electronAPI.getWatchHistory();
        if (!res || !res.success || !res.items || res.items.length === 0) {
            const histIcon = window.icons ? window.icons.history('', 'width: 48px; height: 48px; margin-bottom: 12px; display: inline-block; stroke: var(--vault-gold);') : '';
            grid.innerHTML = `
                <div class="empty-state">
                   ${histIcon}
                   <h3 style="color: #fff; font-family: var(--font-mono); font-size: 15px; margin-bottom: 8px; font-weight: 700;">
                       ${t.historyEmpty || 'Your Watch History is Empty'}
                   </h3>
                   <p style="color: var(--vault-slate); font-family: var(--font-body); font-size: 12px; max-width: 320px; margin: 0 auto;">
                       ${t.historyEmptyDesc || 'Start streaming movies or series to see them here.'}
                   </p>
                </div>
            `;
            return;
        }

        grid.innerHTML = '';

        const closeSvg = window.icons ? window.icons.close('', 'width: 10px; height: 10px; display: inline-block;') : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 10px; height: 10px;"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
        const playSvg = window.icons ? window.icons.play('', 'width: 11px; height: 11px; display: inline-block;') : '';

        res.items.forEach(item => {
            const card = document.createElement('div');
            card.className = 'file-card tmdb-movie-card';
            card.style.cssText = 'cursor: pointer; background: var(--vault-warm-card); border: 1px solid var(--vault-border); border-radius: 6px; position: relative;';

            // Click to resume play or show details
            card.addEventListener('click', async () => {
                try {
                    // Check if it has a streaming URL to resume
                    if (item.streamUrl && !item.completed && item.positionSec > 0) {
                        window.activeStreamingMedia = {
                            mediaType: item.mediaType,
                            tmdbId: item.tmdbId,
                            title: item.title,
                            season: item.season,
                            episode: item.episode,
                            poster: item.poster,
                            year: item.year,
                            streamUrl: item.streamUrl,
                            streamTitle: item.streamTitle || item.title,
                            quality: item.quality,
                            selectedSubtitleTrackIdx: item.selectedSubtitleTrackIdx,
                            selectedSubtitleLabel: item.selectedSubtitleLabel,
                            selectedSubtitleLang: item.selectedSubtitleLang
                        };
                        window.playStream(item.streamUrl, item.streamTitle || item.title);
                        window.showToast(t.resumingStream || 'Resuming stream...', 'success');

                        // The cached debrid URL can expire. If it fails to load,
                        // fall back to a fresh Comet search for the same title.
                        const _vp = document.getElementById('video-player');
                        if (_vp) {
                            const _clear = () => {
                                _vp.removeEventListener('error', _onErr);
                                _vp.removeEventListener('loadeddata', _clear);
                            };
                            const _onErr = () => {
                                _clear();
                                window.showToast(tr('toastCachedExpired', 'Cached stream expired — finding a fresh source…'), 'warning');
                                if (typeof window.triggerRDStream === 'function') {
                                    window.triggerRDStream(item.title, item.tmdbId, item.mediaType || 'movie',
                                        item.season || null, item.episode || null,
                                        { poster: item.poster, year: item.year });
                                }
                            };
                            _vp.addEventListener('error', _onErr, { once: true });
                            _vp.addEventListener('loadeddata', _clear, { once: true });
                        }
                    } else {
                        // Fallback to media details
                        const movieMeta = {
                            id: item.id || item.tmdbId,
                            media_type: item.mediaType,
                            title: item.title,
                            poster: item.poster,
                            year: item.year,
                            rating: item.rating || '0.0',
                            genres: item.genres || 'General',
                            overview: item.overview || ''
                        };
                        window.showMediaDetails(movieMeta);
                    }
                } catch (e) {
                    console.error("Error resuming history item:", e);
                }
            });

            // Delete from history handler
            const deleteBtn = document.createElement('button');
            deleteBtn.onclick = async (e) => {
                e.stopPropagation();
                const confirmMsg = t.confirmRemoveFromHistory 
                    ? t.confirmRemoveFromHistory.replace('{0}', item.title) 
                    : `Are you sure you want to remove "${item.title}" from your watch history?`;
                if (await window.showConfirmDialog(confirmMsg, t.removeFromHistory || 'Remove from History')) {
                    await window.electronAPI.removeWatchHistory({
                        mediaType: item.mediaType,
                        tmdbId: item.tmdbId,
                        title: item.title,
                        season: item.season,
                        episode: item.episode
                    });
                    window.showToast(t.removedFromHistory || 'Removed from History', 'success');
                    window.renderWatchHistoryTab();
                }
            };
            deleteBtn.style.cssText = 'position: absolute; top: 8px; right: 8px; border: none; background: rgba(0,0,0,0.8); color: var(--vault-signal-alert, #ff7979); font-family: var(--font-mono); font-size: 10px; font-weight: 800; padding: 4px 6.5px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 10; border: 1px solid var(--vault-signal-alert, #ff7979); transition: all 0.2s; width: 24px; height: 24px;';
            deleteBtn.title = t.removeFromHistory || 'Remove from History';
            deleteBtn.innerHTML = closeSvg;

            const isTV = item.mediaType === 'tv';
            const tvLabel = isTV ? `S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}` : '';

            // Calculate watch progress percentage
            const percent = (item.durationSec > 0) ? Math.min(100, Math.round((item.positionSec / item.durationSec) * 100)) : 0;
            const progressHtml = percent > 0 ? `
                <div class="history-progress-container">
                    <div class="history-progress-bar" style="width: ${percent}%;"></div>
                </div>
            ` : '';

            card.innerHTML = `
                <div class="thumbnail-container" style="position:relative; background:#111; height: 160px; width: 100%; border-top-left-radius: 5px; border-top-right-radius: 5px; overflow: hidden;">
                   <img class="thumbnail" src="${item.poster || 'public/poster_placeholder.svg'}" alt="${window.escapeHtml(item.title)}" style="object-fit: cover; width:100%; height:100%; transition: opacity 0.25s ease;" onerror="this.src='public/poster_placeholder.svg'">
                   ${progressHtml}
                   <div class="size-badge" style="background:var(--vault-accent); color:var(--vt-primary); font-weight:800; position:absolute; bottom: 8px; left: 8px; padding: 3px 6px; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 9px; box-shadow: 0 2px 6px rgba(0,0,0,0.4); text-align: center;">
                      <span>${percent > 0 ? `${percent}%` : 'WATCHED'}</span>
                   </div>
                </div>
                <div class="filename-container" style="padding:12px; text-align:left;">
                   <div style="font-weight:700; font-size:13px; color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--font-mono);">${window.escapeHtml(item.title)} ${tvLabel ? `<span style="color:var(--vault-accent); font-size:11px; margin-left:4px;">${tvLabel}</span>` : ''}</div>
                   <div style="font-size:10px; color:var(--vault-slate); margin-top:2px; font-weight:500;">${item.year || ''} • Last Watched: ${new Date(item.lastWatched).toLocaleDateString()}</div>
                </div>
            `;

            // Append delete button
            card.appendChild(deleteBtn);
            grid.appendChild(card);
        });

    } catch (e) {
        console.error("Watch History render error:", e);
        grid.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; color: var(--vault-slate); padding: 40px 0;">Error loading watch history.</div>';
    }
};
