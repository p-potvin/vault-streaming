// js/streaming/details-modal.js — media details modal, season/episode picker, modal lifecycle
// Part of the streaming feature, split out of the former monolithic js/streaming.js.

// ─── Details Modal ───────────────────────────────────────────────────────────

// _currentModalImdbId lives on window because badges.js (a sibling module) reads it.
let _currentModalTvId = null;
window._currentModalImdbId = null;
let _currentModalTitle = null;
let _currentModalMediaType = null;

/**
 * Open the streaming-details-modal for a media item from the TMDB card grid.
 * @param {object} movie - The media object from the card grid (has id, title, media_type, etc.)
 */
window.showMediaDetails = async function(movie, startAtTime = 0) {
    const modal = el('streaming-details-modal');
    if (!modal) return;

    window._detailsModalJustOpened = true;
    setTimeout(() => { window._detailsModalJustOpened = false; }, 100);

    _currentModalTvId = movie.id;
    window._currentModalImdbId = movie.imdb_id || null;
    _currentModalTitle = movie.title;
    _currentModalMediaType = movie.media_type;
    window._currentTrailerKey = null;
    window._persistedTrailerTime = startAtTime;

    // Show modal immediately with available data
    modal.style.display = 'flex';
    
    // Draw initial badges
    _populateExternalBadges(movie.title, movie.id, movie.media_type);

    // Reset modal state
    el('streaming-details-header-title').textContent = movie.title;
    el('streaming-details-title').textContent = movie.title;
    el('streaming-details-year').textContent = movie.year || '—';
    el('streaming-details-genres').textContent = movie.genres || '—';
    el('streaming-details-rating').textContent = `★ ${movie.rating || '—'}`;
    el('streaming-details-overview').textContent = movie.overview || '';
    el('streaming-details-poster').src = movie.poster || 'public/poster_placeholder.svg';

    // Reset action containers
    const movieActions = el('movie-actions-container');
    const tvActions = el('tv-actions-container');
    const trailerWrapper = el('movie-trailer-wrapper');
    const btnFollow = el('btn-modal-follow');

    if (movieActions) movieActions.style.display = 'none';
    if (tvActions) tvActions.style.display = 'none';
    if (trailerWrapper) trailerWrapper.style.display = 'none';
    if (btnFollow) btnFollow.style.display = 'none';

    const isTV = movie.media_type === 'tv';

    if (isTV) {
        await _setupTVModal(movie);
    } else {
        _setupMovieModal(movie);
    }

    // Setup Add to Library visual state and click handler
    const btnLib = el('btn-modal-library');
    if (btnLib) {
        window.appSettings = window.appSettings || {};
        window.appSettings.library = window.appSettings.library || [];
        const isCurrentlySaved = window.appSettings.library.some(item => item.id === movie.id && item.media_type === movie.media_type);
        
        const plusSvg = window.icons ? window.icons.plus('tab-icon', 'width:12px; height:12px; margin-right:4.5px; display:inline-block; vertical-align:middle;') : '';
        const minusSvg = window.icons ? window.icons.minus('tab-icon', 'width:12px; height:12px; margin-right:4.5px; display:inline-block; vertical-align:middle;') : '';
        
        btnLib.innerHTML = isCurrentlySaved 
            ? `${minusSvg}<span>${window.currentLang === 'fr' ? 'Retirer de la bibliothèque' : 'Remove from Library'}</span>` 
            : `${plusSvg}<span>${window.currentLang === 'fr' ? 'Ajouter à la bibliothèque' : 'Add to Library'}</span>`;
        btnLib.style.background = isCurrentlySaved ? 'rgba(245,185,41,0.15)' : 'rgba(255,255,255,0.06)';
        btnLib.style.borderColor = isCurrentlySaved ? 'var(--vault-gold)' : 'var(--vault-border)';
        
        btnLib.onclick = () => {
            window.appSettings.library = window.appSettings.library || [];
            const idx = window.appSettings.library.findIndex(item => item.id === movie.id && item.media_type === movie.media_type);
            let added = false;
            if (idx !== -1) {
                window.appSettings.library.splice(idx, 1);
                window.showToast(window.currentLang === 'fr' ? 'Retiré de la bibliothèque' : 'Removed from Library', 'success');
            } else {
                window.appSettings.library.push(movie);
                window.showToast(window.currentLang === 'fr' ? 'Ajouté à la bibliothèque' : 'Added to Library', 'success');
                added = true;
            }
            
            // Jump animation
            btnLib.style.transition = 'transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275), background 0.2s, border-color 0.2s';
            btnLib.style.transform = 'scale(1.1)';
            btnLib.style.background = 'rgba(245,185,41,0.3)';
            btnLib.style.borderColor = 'var(--vault-gold)';
            setTimeout(() => {
                btnLib.style.transform = 'scale(1)';
                btnLib.style.background = added ? 'rgba(245,185,41,0.15)' : 'rgba(255,255,255,0.06)';
                btnLib.style.borderColor = added ? 'var(--vault-gold)' : 'var(--vault-border)';
                btnLib.innerHTML = added 
                    ? `${minusSvg}<span>${window.currentLang === 'fr' ? 'Retirer de la bibliothèque' : 'Remove from Library'}</span>` 
                    : `${plusSvg}<span>${window.currentLang === 'fr' ? 'Ajouter à la bibliothèque' : 'Add to Library'}</span>`;
            }, 200);
            
            // Save settings persistently
            window.electronAPI.saveSettings(window.appSettings);
            
            // Live refresh of the library view if open
            if (window.currentTab === 'favorites' && typeof window.renderFavorites === 'function') {
                window.renderFavorites();
            } else if (window.currentTab === 'library' && typeof window.renderLibrary === 'function') {
                window.renderLibrary();
            }
            
            // Live refresh of the catalog results to update golden border/glow instantly
            if (window.currentTab === 'tmdb' && typeof window.searchTMDB === 'function') {
                // If they are on tmdb tab, trigger class update or redraw
                const cards = document.querySelectorAll('.tmdb-movie-card');
                cards.forEach(card => {
                    // Quick check if this card corresponds to this movie
                    if (card.innerHTML.includes(movie.poster)) {
                        if (added) {
                            card.classList.add('in-library');
                            card.style.border = '1.5px solid var(--vault-console-gold)';
                            card.style.boxShadow = '0 0 12px rgba(214, 164, 65, 0.35)';
                        } else {
                            card.classList.remove('in-library');
                            card.style.border = '1px solid var(--vault-border)';
                            card.style.boxShadow = 'none';
                        }
                    }
                });
            }
        };
    }

    // Fetch trailer asynchronously
    _fetchAndInjectTrailer(movie.id, movie.media_type);
};

async function _setupMovieModal(movie) {
    const movieActions = el('movie-actions-container');
    if (!movieActions) return;
    movieActions.style.display = 'flex';

    const btnStream = el('btn-stream-movie');
    if (btnStream) {
        btnStream.onclick = () => {
            el('streaming-details-modal').style.display = 'none';
            const trailerEl = el('movie-trailer-iframe');
            if (trailerEl) {
                if (trailerEl.tagName === 'VIDEO') { trailerEl.pause(); trailerEl.src = ''; trailerEl.load(); }
                else { trailerEl.src = ''; }
            }
            window.triggerRDStream(movie.title, movie.id, 'movie');
        };
    }

    try {
        const movieRes = await window.electronAPI.getTMDBMovie({ id: movie.id, language: window.currentLang === 'fr' ? 'fr-FR' : 'en-US' });
        if (movieRes && movieRes.success && movieRes.data) {
            window._currentModalImdbId = movieRes.data.imdb_id;
            _populateExternalBadges(movie.title, movie.id, 'movie', window._currentTrailerKey);
        }
    } catch (e) {
        console.warn('[streaming] Failed to fetch movie details for badges:', e);
    }
}

async function _setupTVModal(movie) {
    const tvActions = el('tv-actions-container');
    const seasonSelect = el('tv-season-select');
    const episodesList = el('tv-episodes-list');
    const btnFollow = el('btn-modal-follow');

    if (!tvActions || !seasonSelect || !episodesList) return;

    tvActions.style.display = 'flex';
    if (btnFollow) {
        btnFollow.style.display = 'flex';
        
        window.appSettings = window.appSettings || {};
        window.appSettings.followedShows = window.appSettings.followedShows || [];
        const isFollowed = window.appSettings.followedShows.some(id => id === movie.id);
        
        const plusSvg = window.icons ? window.icons.plus('tab-icon', 'width:12px; height:12px; margin-right:4.5px; display:inline-block; vertical-align:middle;') : '';
        const minusSvg = window.icons ? window.icons.minus('tab-icon', 'width:12px; height:12px; margin-right:4.5px; display:inline-block; vertical-align:middle;') : '';
        
        btnFollow.innerHTML = isFollowed
            ? `${minusSvg}<span>${window.currentLang === 'fr' ? 'Ne plus suivre' : 'Unfollow Show'}</span>`
            : `${plusSvg}<span>${window.currentLang === 'fr' ? 'Suivre la série' : 'Follow Show'}</span>`;
        btnFollow.style.background = isFollowed ? 'rgba(245,185,41,0.15)' : 'rgba(255,255,255,0.06)';
        btnFollow.style.borderColor = isFollowed ? 'var(--vault-gold)' : 'var(--vault-border)';
        
        btnFollow.onclick = () => {
            window.appSettings.followedShows = window.appSettings.followedShows || [];
            const idx = window.appSettings.followedShows.indexOf(movie.id);
            let followed = false;
            if (idx !== -1) {
                window.appSettings.followedShows.splice(idx, 1);
                window.showToast(window.currentLang === 'fr' ? 'Série retirée des suivis' : 'Unfollowed Show', 'success');
            } else {
                window.appSettings.followedShows.push(movie.id);
                window.showToast(window.currentLang === 'fr' ? 'Série ajoutée aux suivis' : 'Followed Show', 'success');
                followed = true;
            }
            
            // Jump animation
            btnFollow.style.transition = 'transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275), background 0.2s, border-color 0.2s';
            btnFollow.style.transform = 'scale(1.1)';
            btnFollow.style.background = 'rgba(245,185,41,0.3)';
            btnFollow.style.borderColor = 'var(--vault-gold)';
            setTimeout(() => {
                btnFollow.style.transform = 'scale(1)';
                btnFollow.style.background = followed ? 'rgba(245,185,41,0.15)' : 'rgba(255,255,255,0.06)';
                btnFollow.style.borderColor = followed ? 'var(--vault-gold)' : 'var(--vault-border)';
                btnFollow.innerHTML = followed
                    ? `${minusSvg}<span>${window.currentLang === 'fr' ? 'Ne plus suivre' : 'Unfollow Show'}</span>`
                    : `${plusSvg}<span>${window.currentLang === 'fr' ? 'Suivre la série' : 'Follow Show'}</span>`;
            }, 200);

            window.electronAPI.saveSettings(window.appSettings);
        };
    }

    seasonSelect.innerHTML = '<option value="">Loading seasons...</option>';
    episodesList.innerHTML = '<tr><td colspan="3" style="text-align:center; color:var(--vault-slate); padding:20px;">Loading...</td></tr>';

    try {
        const tvRes = await window.electronAPI.getTMDBTV({ id: movie.id, language: window.currentLang === 'fr' ? 'fr-FR' : 'en-US' });
        if (!tvRes || !tvRes.success || !tvRes.data) {
            seasonSelect.innerHTML = '<option value="">No seasons found</option>';
            return;
        }

        const tvData = tvRes.data;

        // Cache IMDB ID if available
        if (tvData.external_ids && tvData.external_ids.imdb_id) {
            window._currentModalImdbId = tvData.external_ids.imdb_id;
            _populateExternalBadges(movie.title, movie.id, 'tv', window._currentTrailerKey);
        }

        // Update overview with full version if richer
        if (tvData.overview) {
            el('streaming-details-overview').textContent = tvData.overview;
        }

        // Populate season dropdown — exclude specials (season_number 0) unless it's the only one
        const seasons = (tvData.seasons || []).filter(s => s.season_number > 0 && s.episode_count > 0);
        if (seasons.length === 0) {
            seasonSelect.innerHTML = '<option value="">No seasons available</option>';
            episodesList.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--vault-slate);padding:16px;">No episodes found.</td></tr>';
            return;
        }

        seasonSelect.innerHTML = seasons.map(s =>
            `<option value="${s.season_number}">${window.escapeHtml(s.name || `Season ${s.season_number}`)} (${s.episode_count} ep.)</option>`
        ).join('');

        // Load episodes for first season
        await _loadSeasonEpisodes(movie.id, seasons[0].season_number);

        // Season change handler
        seasonSelect.onchange = async () => {
            const selectedSeason = parseInt(seasonSelect.value, 10);
            if (!isNaN(selectedSeason)) {
                episodesList.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--vault-slate);padding:16px;"><div class="spinner" style="margin:0 auto;"></div></td></tr>';
                await _loadSeasonEpisodes(movie.id, selectedSeason);
            }
        };

    } catch (e) {
        console.error('[streaming] Failed to set up TV modal:', e);
        seasonSelect.innerHTML = '<option value="">Error loading seasons</option>';
        episodesList.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--vault-signal-alert,#FF6B7A);padding:16px;">${window.escapeHtml(e.message)}</td></tr>`;
    }
}

async function _loadSeasonEpisodes(tvId, seasonNumber) {
    const episodesList = el('tv-episodes-list');
    if (!episodesList) return;

    try {
        const seasonRes = await window.electronAPI.getTMDBTVSeason({ id: tvId, seasonNumber, language: window.currentLang === 'fr' ? 'fr-FR' : 'en-US' });
        if (!seasonRes || !seasonRes.success || !seasonRes.data) {
            episodesList.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--vault-slate);padding:16px;">No episodes found.</td></tr>';
            return;
        }

        const episodes = seasonRes.data.episodes || [];
        if (episodes.length === 0) {
            episodesList.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--vault-slate);padding:16px;">No episodes in this season.</td></tr>';
            return;
        }

        episodesList.innerHTML = episodes.map(ep => {
            const num = ep.episode_number;
            const title = window.escapeHtml(ep.name || `Episode ${num}`);
            const airDate = ep.air_date ? ep.air_date.substring(0, 7) : '';
            const rating = ep.vote_average ? `★ ${ep.vote_average.toFixed(1)}` : '';
            return `
                <tr style="border-bottom:1px solid var(--vault-border); transition:background 0.15s;" 
                    onmouseenter="this.style.background='rgba(255,255,255,0.03)'"
                    onmouseleave="this.style.background='transparent'">
                    <td style="padding:10px 12px; color:var(--vault-accent); font-family:var(--font-mono); font-weight:700; font-size:12px;">
                        E${num}
                    </td>
                    <td style="padding:10px 12px;">
                        <div style="font-weight:600; color:#fff; font-size:12px; margin-bottom:2px;">${title}</div>
                        <div style="font-size:10px; color:var(--vault-slate); display:flex; gap:10px;">
                            ${airDate ? `<span>${airDate}</span>` : ''}
                            ${rating ? `<span style="color:var(--vault-gold);">${rating}</span>` : ''}
                        </div>
                    </td>
                    <td style="padding:10px 12px; text-align:right;">
                        <button 
                            style="background:var(--vault-accent); color:var(--vt-primary); border:none; padding:5px 14px; border-radius:4px; font-weight:700; cursor:pointer; font-size:10px; text-transform:uppercase; letter-spacing:0.05em; font-family:var(--font-mono); transition:opacity 0.2s; white-space:nowrap;"
                            onclick="window._streamEpisode(${tvId}, ${seasonNumber}, ${num})"
                            onmouseenter="this.style.opacity='0.8'"
                            onmouseleave="this.style.opacity='1'"
                        >⚡ Play</button>
                    </td>
                </tr>`;
        }).join('');

    } catch (e) {
        console.error('[streaming] Failed to load season episodes:', e);
        episodesList.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--vault-signal-alert,#FF6B7A);padding:16px;">${window.escapeHtml(e.message)}</td></tr>`;
    }
}

/**
 * Called when the user clicks ⚡ Play on an episode row.
 */
window._streamEpisode = function(tvId, seasonNumber, episodeNumber) {
    // Close the details modal
    el('streaming-details-modal').style.display = 'none';
    const trailerEl3 = el('movie-trailer-iframe');
    if (trailerEl3) {
        if (trailerEl3.tagName === 'VIDEO') { trailerEl3.pause(); trailerEl3.src = ''; trailerEl3.load(); }
        else { trailerEl3.src = ''; }
    }

    window.triggerRDStream(
        _currentModalTitle,
        tvId,
        'tv',
        seasonNumber,
        episodeNumber
    );
};

// ─── Modal close handlers (click-outside / Esc) ──────────────────────────────
// Close modals when clicking outside their active boundaries
document.addEventListener('click', (e) => {
    const detailsModal = document.getElementById('streaming-details-modal');
    if (detailsModal && detailsModal.style.display === 'flex' && !window._detailsModalJustOpened) {
        if (!detailsModal.contains(e.target)) {
            detailsModal.style.display = 'none';
            const trailer = document.getElementById('movie-trailer-iframe');
            if (trailer) {
                if (trailer.tagName === 'VIDEO') { trailer.pause(); trailer.src = ''; trailer.load(); }
                else { trailer.src = ''; }
            }
        }
    }

    const rdDialog = document.getElementById('rd-stream-dialog');
    if (rdDialog && rdDialog.style.display === 'flex' && !window._rdDialogJustOpened) {
        if (!rdDialog.contains(e.target)) {
            rdDialog.style.display = 'none';
            const backdrop = document.getElementById('rd-stream-backdrop');
            if (backdrop) backdrop.style.display = 'none';
        }
    }
});

// Keyboard controls (Esc key to close modals)
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const detailsModal = document.getElementById('streaming-details-modal');
        if (detailsModal && detailsModal.style.display === 'flex') {
            detailsModal.style.display = 'none';
            if (typeof window.destroyTrailer === 'function') {
                window.destroyTrailer();
            }
        }

        const rdDialog = document.getElementById('rd-stream-dialog');
        if (rdDialog && rdDialog.style.display === 'flex') {
            rdDialog.style.display = 'none';
            const backdrop = document.getElementById('rd-stream-backdrop');
            if (backdrop) backdrop.style.display = 'none';
        }
    }
});
