// js/streaming/details-modal.js — media details modal, season/episode picker, modal lifecycle
// Part of the streaming feature, split out of the former monolithic js/streaming.js.

// ─── Details Modal ───────────────────────────────────────────────────────────

// _currentModalImdbId lives on window because badges.js (a sibling module) reads it.
let _currentModalTvId = null;
window._currentModalImdbId = null;
let _currentModalTitle = null;
let _currentModalMediaType = null;

// Series progress for the open show: saved episodes by "s<S>e<E>", and the episode to resume or play next.
let _tvModalToken = 0;          // bumps on every series opened; stale async results are dropped
let _seasonLoadToken = 0;       // bumps on every season list load (a quick season switch keeps the last one)
let _showProgress = new Map();
let _resumeTarget = null;       // { kind: 'resume' | 'next', season, episode, positionSec? }

/**
 * Open the streaming-details-modal for a media item from the TMDB card grid.
 * @param {object} movie - The media object from the card grid (has id, title, media_type, etc.)
 */
window.showMediaDetails = async function(movie, startAtTime = 0, { trailerMuted = null } = {}) {
    const modal = el('streaming-details-modal');
    if (!modal) return;

    window._detailsModalJustOpened = true;
    setTimeout(() => { window._detailsModalJustOpened = false; }, 100);

    _currentModalTvId = movie.id;
    window._currentModalImdbId = movie.imdb_id || null;
    const resolvedTitle = movie.title || movie.name || 'Unknown Title';
    _currentModalTitle = resolvedTitle;
    _currentModalMediaType = movie.media_type;
    window._currentTrailerKey = null;
    window._persistedTrailerTime = startAtTime;
    // The hover preview's sound state carries into the modal's trailer (null = the "Mute trailers" setting).
    window._persistedTrailerMuted = typeof trailerMuted === 'boolean' ? trailerMuted : null;

    // Show modal immediately with available data
    modal.style.display = 'flex';
    
    // Draw initial badges
    _populateExternalBadges(resolvedTitle, movie.id, movie.media_type);

    // Reset modal state
    el('streaming-details-header-title').textContent = resolvedTitle;
    el('streaming-details-title').textContent = resolvedTitle;
    el('streaming-details-year').textContent = movie.year || (movie.release_date ? movie.release_date.substring(0,4) : (movie.first_air_date ? movie.first_air_date.substring(0,4) : '—'));
    el('streaming-details-genres').textContent = movie.genres || '—';
    el('streaming-details-rating').innerHTML = `${window.icons.star('', 'width:13px;height:13px;vertical-align:middle;')} ${window.escapeHtml(String(movie.rating || '—'))}`;
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

    _loadSimilar(movie);   // not awaited: the row fills in when the gateway answers

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

// ─── More like this ──────────────────────────────────────────────────────────
// The nearest titles by meaning (vault-raggae's /v1/catalog/similar, known titles only), as one row of small
// posters; a click opens that title in this modal. Hidden when the gateway is down or the title has no vector.
let _similarToken = 0;

async function _loadSimilar(movie) {
    const box = el('streaming-similar');
    const row = el('streaming-similar-row');
    if (!box || !row) return;
    const token = ++_similarToken;
    box.hidden = true;
    row.innerHTML = '';
    if (!window.electronAPI || !window.electronAPI.raggaeSimilar || !movie || !movie.id) return;
    let cards = [];
    try {
        cards = await window.electronAPI.raggaeSimilar({
            mediaType: movie.media_type === 'tv' ? 'tv' : 'movie',
            tmdbId: movie.id,
            imdbId: movie.imdb_id || null,
        });
    } catch (e) {
        console.warn('[streaming] More like this unavailable:', e);
    }
    if (token !== _similarToken || !Array.isArray(cards) || !cards.length) return;   // another title opened meanwhile
    for (const card of cards) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'streaming-similar-card';
        btn.title = card.year ? `${card.title} (${card.year})` : card.title;
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = '';
        img.src = card.poster || 'public/poster_placeholder.svg';
        img.onerror = () => { img.onerror = null; img.src = 'public/poster_placeholder.svg'; };
        const name = document.createElement('span');
        name.className = 'streaming-similar-title';
        name.textContent = card.title;
        btn.append(img, name);
        if (card.year) {
            const year = document.createElement('span');
            year.className = 'streaming-similar-year';
            year.textContent = String(card.year);
            btn.append(year);
        }
        btn.onclick = () => {
            if (typeof window.destroyTrailer === 'function') window.destroyTrailer();
            const modal = el('streaming-details-modal');
            if (modal) modal.scrollTop = 0;
            window.showMediaDetails(card);
        };
        row.append(btn);
    }
    row.scrollLeft = 0;
    box.hidden = false;
}

async function _setupMovieModal(movie) {
    _tvModalToken++;   // a series still loading in the background no longer fills the modal
    const movieActions = el('movie-actions-container');
    if (!movieActions) return;
    movieActions.style.display = 'flex';

    const btnStream = el('btn-stream-movie');
    if (btnStream) {
        btnStream.onclick = () => {
            el('streaming-details-modal').style.display = 'none';
            if (typeof window.destroyTrailer === 'function') window.destroyTrailer();
            window.triggerRDStream(
                movie.title || movie.name,
                movie.id,
                'movie',
                null,
                null,
                { poster: movie.poster, year: movie.year }
            );
        };
    }

    try {
        const movieRes = await window.electronAPI.getTMDBMovie({ id: movie.id, language: window.tmdbLanguage() });
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

    const token = ++_tvModalToken;
    // skip intro / credits seconds for every episode of this series (js/player/series-controls.js)
    const skipIntro = el('tv-skip-intro'), skipOutro = el('tv-skip-outro');
    if (skipIntro && skipOutro && window.seriesSkipFor) {
        const cur = window.seriesSkipFor(movie.id);
        skipIntro.value = String(cur.intro);
        skipOutro.value = String(cur.outro);
        const save = () => window.setSeriesSkip(movie.id, skipIntro.value, skipOutro.value);
        skipIntro.onchange = save;
        skipOutro.onchange = save;
    }
    _showProgress = new Map();
    _resumeTarget = null;
    _renderResumeRow(movie.id);

    seasonSelect.innerHTML = '<option value="">Loading seasons...</option>';
    episodesList.innerHTML = '<tr><td colspan="3" style="text-align:center; color:var(--vault-slate); padding:20px;">Loading...</td></tr>';

    try {
        const tvRes = await window.electronAPI.getTMDBTV({ id: movie.id, language: window.tmdbLanguage() });
        if (token !== _tvModalToken) return;   // another title was opened meanwhile
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

        // Where the show stands: every saved episode, then the one to resume (or the next after a finished one).
        let defaultSeason = seasons[0].season_number;
        try {
            const res = window.electronAPI.getShowProgress
                ? await window.electronAPI.getShowProgress({ tmdbId: movie.id, title: movie.title || movie.name })
                : null;
            if (token !== _tvModalToken) return;   // another title was opened meanwhile
            const items = (res && res.success && Array.isArray(res.items)) ? res.items : [];
            for (const it of items) _showProgress.set(_epKey(it.season, it.episode), it);
            _resumeTarget = _pickResumeTarget(items, seasons);
            const wanted = _resumeTarget ? _resumeTarget.season : (items[0] && items[0].season);
            if (wanted != null && seasons.some(s => s.season_number === wanted)) {
                defaultSeason = wanted;
                seasonSelect.value = String(wanted);
            }
        } catch (e) {
            // Non-fatal: fall back to the first season.
            console.warn('[streaming] Could not resolve the show progress:', e);
        }
        _renderResumeRow(movie.id);

        // Load episodes for the remembered (or first) season
        await _loadSeasonEpisodes(movie.id, defaultSeason);

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

function _epKey(season, episode) {
    return `s${Number(season)}e${Number(episode)}`;
}

function _epLabel(season, episode) {
    return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

function _clock(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return `${h ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`;
}

/**
 * The episode to offer from the show's saved episodes (most recent first) and its TMDB seasons:
 * the last one watched when it is not finished, else the next one (same season +1, else episode 1 of the
 * next season). Null when nothing was watched or the last finished episode is the show's last.
 */
function _pickResumeTarget(items, seasons) {
    const last = items && items[0];
    if (!last || last.season == null || last.episode == null) return null;
    const season = Number(last.season), episode = Number(last.episode);
    if (!last.completed) return { kind: 'resume', season, episode, positionSec: last.positionSec || 0 };
    const ordered = [...seasons].sort((a, b) => a.season_number - b.season_number);
    const done = new Set(items.filter(it => it.completed).map(it => _epKey(it.season, it.episode)));
    const after = (sn, en) => {
        const cur = ordered.find(s => s.season_number === sn);
        if (cur && en < cur.episode_count) return { season: sn, episode: en + 1 };
        const nextSeason = ordered.find(s => s.season_number > sn);
        return nextSeason ? { season: nextSeason.season_number, episode: 1 } : null;
    };
    // the first episode after the last one finished that is not finished already (a rewatch of an older one
    // does not send the show back to an episode seen since)
    let next = after(season, episode);
    for (let guard = 0; next && done.has(_epKey(next.season, next.episode)) && guard < 1000; guard++) {
        next = after(next.season, next.episode);
    }
    return next ? { kind: 'next', ...next } : null;
}

/** The "Resume S02E05 (12:40)" / "Next: S02E06" button above the season picker (hidden when there is nothing). */
function _renderResumeRow(tvId) {
    const row = el('tv-resume-row');
    const btn = el('btn-tv-resume');
    const note = el('tv-resume-note');
    if (!row || !btn) return;
    const fr = window.currentLang === 'fr';
    const target = _resumeTarget;
    if (!target) {
        row.style.display = 'none';
        btn.onclick = null;
        return;
    }
    const label = _epLabel(target.season, target.episode);
    const bolt = window.icons ? window.icons.lightning('', 'width:11px;height:11px;vertical-align:middle;margin-right:4px;') : '';
    if (target.kind === 'resume') {
        const at = target.positionSec > 30 ? ` (${_clock(target.positionSec)})` : '';
        btn.innerHTML = `${bolt}${window.escapeHtml(`${fr ? 'Reprendre' : 'Resume'} ${label}${at}`)}`;
        if (note) note.textContent = fr ? 'Dernier épisode regardé' : 'Last episode watched';
    } else {
        btn.innerHTML = `${bolt}${window.escapeHtml(fr ? `Suivant : ${label}` : `Next: ${label}`)}`;
        const prev = [..._showProgress.values()][0];
        if (note) note.textContent = prev
            ? `${_epLabel(prev.season, prev.episode)} ${fr ? 'terminé' : 'finished'}`
            : '';
    }
    btn.onclick = () => window._streamEpisode(tvId, target.season, target.episode);
    row.style.display = 'flex';
}

async function _loadSeasonEpisodes(tvId, seasonNumber) {
    const episodesList = el('tv-episodes-list');
    if (!episodesList) return;
    const loadToken = ++_seasonLoadToken;

    try {
        const seasonRes = await window.electronAPI.getTMDBTVSeason({ id: tvId, seasonNumber, language: window.tmdbLanguage() });
        if (loadToken !== _seasonLoadToken) return;   // another season (or show) was asked for meanwhile
        if (!seasonRes || !seasonRes.success || !seasonRes.data) {
            episodesList.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--vault-slate);padding:16px;">No episodes found.</td></tr>';
            return;
        }

        const episodes = seasonRes.data.episodes || [];
        if (episodes.length === 0) {
            episodesList.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--vault-slate);padding:16px;">No episodes in this season.</td></tr>';
            return;
        }

        const fr = window.currentLang === 'fr';
        const target = _resumeTarget && _resumeTarget.season === Number(seasonNumber) ? _resumeTarget.episode : null;
        episodesList.innerHTML = episodes.map(ep => {
            const num = ep.episode_number;
            const title = window.escapeHtml(ep.name || `Episode ${num}`);
            const airDate = ep.air_date ? ep.air_date.substring(0, 7) : '';
            const rating = ep.vote_average ? `${window.icons.star('', 'width:10px;height:10px;vertical-align:middle;')} ${ep.vote_average.toFixed(1)}` : '';
            const prog = _showProgress.get(_epKey(seasonNumber, num));
            const pct = prog && prog.durationSec > 0 ? Math.min(100, Math.round((prog.positionSec / prog.durationSec) * 100)) : 0;
            let state = '';
            if (prog && prog.completed) {
                state = `<span class="tv-ep-watched-mark">✓ ${fr ? 'Vu' : 'Watched'}</span>`;
            } else if (prog && prog.positionSec > 30) {
                state = `<span>${window.escapeHtml(`${fr ? 'Arrêté à' : 'Stopped at'} ${_clock(prog.positionSec)}`)}</span>`;
            }
            const bar = prog && (prog.completed || pct > 0)
                ? `<span class="tv-ep-progress" aria-hidden="true"><span style="width:${prog.completed ? 100 : pct}%"></span></span>` : '';
            const cls = ['tv-ep-row', prog && prog.completed ? 'tv-ep-watched' : '', num === target ? 'tv-ep-target' : '']
                .filter(Boolean).join(' ');
            return `
                <tr class="${cls}" data-episode="${num}">
                    <td style="padding:10px 12px; color:var(--vault-accent); font-family:var(--font-mono); font-weight:700; font-size:12px;">
                        E${num}
                    </td>
                    <td style="padding:10px 12px;">
                        <div class="tv-ep-title" style="font-weight:600; font-size:12px; margin-bottom:2px;">${title}</div>
                        <div style="font-size:10px; color:var(--vault-slate); display:flex; gap:10px;">
                            ${airDate ? `<span>${airDate}</span>` : ''}
                            ${rating ? `<span style="color:var(--vault-gold);">${rating}</span>` : ''}
                            ${state}
                        </div>
                        ${bar}
                    </td>
                    <td style="padding:10px 12px; text-align:right;">
                        <button 
                            style="background:var(--vault-accent); color:var(--vt-primary); border:none; padding:5px 14px; border-radius:4px; font-weight:700; cursor:pointer; font-size:10px; text-transform:uppercase; letter-spacing:0.05em; font-family:var(--font-mono); transition:opacity 0.2s; white-space:nowrap;"
                            onclick="window._streamEpisode(${tvId}, ${seasonNumber}, ${num})"
                            onmouseenter="this.style.opacity='0.8'"
                            onmouseleave="this.style.opacity='1'"
                        >${window.icons.lightning('', 'width:11px;height:11px;vertical-align:middle;')} Play</button>
                    </td>
                </tr>`;
        }).join('');

        // Bring the episode to resume (or the next one) into view inside the list, not the whole modal.
        const targetRow = target != null ? episodesList.querySelector(`tr[data-episode="${target}"]`) : null;
        const box = episodesList.closest('.tv-episodes-container');
        if (targetRow && box) {
            box.scrollTop = Math.max(0, targetRow.offsetTop - box.clientHeight / 2 + targetRow.offsetHeight / 2);
        }

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
    if (typeof window.destroyTrailer === 'function') window.destroyTrailer();

    window.triggerRDStream(
        _currentModalTitle,
        tvId,
        'tv',
        seasonNumber,
        episodeNumber,
        {
            poster: el('streaming-details-poster')?.src || null,
            year: el('streaming-details-year')?.textContent || null
        }
    );
};

// ─── Modal close handlers (click-outside / Esc) ──────────────────────────────
// Close modals when clicking outside their active boundaries
document.addEventListener('click', (e) => {
    const detailsModal = document.getElementById('streaming-details-modal');
    if (detailsModal && detailsModal.style.display === 'flex' && !window._detailsModalJustOpened) {
        if (!detailsModal.contains(e.target)) {
            detailsModal.style.display = 'none';
            if (typeof window.destroyTrailer === 'function') window.destroyTrailer();
        }
    }

    const rdDialog = document.getElementById('rd-stream-dialog');
    // (with the player open the loading shows on the player's card, which has its own cancel: playing with the video
    // must not stop the next episode's loading)
    if (rdDialog && rdDialog.style.display === 'flex' && !window._rdDialogJustOpened && !rdDialog.classList.contains('in-player')) {
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
        if (rdDialog && rdDialog.style.display === 'flex' && !rdDialog.classList.contains('in-player')) {
            rdDialog.style.display = 'none';
            const backdrop = document.getElementById('rd-stream-backdrop');
            if (backdrop) backdrop.style.display = 'none';
        }
    }
});
