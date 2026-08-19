/* ==========================================================================
   Vault TMDB searching & Results Rendering Module
   ========================================================================== */

const MOCK_TMDB_DATA = [
    {
        title: "Dune: Part Two",
        year: "2024",
        rating: "8.3",
        genres: "Sci-Fi, Adventure",
        poster: "public/poster_placeholder.svg",
        overview: "Follow the mythic journey of Paul Atreides as he unites with Chani and the Fremen while on a path of revenge against the conspirators who destroyed his family."
    },
    {
        title: "Oppenheimer",
        year: "2023",
        rating: "8.1",
        genres: "Drama, History",
        poster: "public/poster_placeholder.svg",
        overview: "The story of J. Robert Oppenheimer's role in the development of the atomic bomb during World War II."
    },
    {
        title: "Interstellar",
        year: "2014",
        rating: "8.4",
        genres: "Sci-Fi, Drama",
        poster: "public/poster_placeholder.svg",
        overview: "The adventures of a group of explorers who make use of a newly discovered wormhole to surpass the limitations on human space travel."
    },
    {
        title: "The Dark Knight",
        year: "2008",
        rating: "8.6",
        genres: "Action, Crime, Drama",
        poster: "public/poster_placeholder.svg",
        overview: "When the menace known as the Joker wreaks havoc and chaos on Gotham, Batman must accept one of the greatest psychological and physical tests."
    }
];

function updateProviderButtonsUI() {
    document.querySelectorAll('.provider-btn').forEach(btn => {
        const prov = btn.dataset.provider;
        if (prov === window.tmdbCurrentProvider) {
            btn.classList.add('active');
            btn.style.background = 'var(--vault-accent)';
            btn.style.color = 'var(--vt-primary)';
            btn.style.border = 'none';
        } else {
            btn.classList.remove('active');
            btn.style.background = 'transparent';
            if (prov === 'all') {
                btn.style.color = 'var(--vault-text)';
                btn.style.border = '1px solid var(--vault-border)';
            } else if (prov === '8') {
                btn.style.color = '#E50914';
                btn.style.border = '1px solid rgba(229,9,20,0.4)';
            } else if (prov === '337') {
                btn.style.color = '#0063e5';
                btn.style.border = '1px solid rgba(0,99,229,0.4)';
            } else if (prov === '350') {
                btn.style.color = '#fff';
                btn.style.border = '1px solid rgba(255,255,255,0.3)';
            } else if (prov === '9') {
                btn.style.color = '#00A8E1';
                btn.style.border = '1px solid rgba(0,168,225,0.4)';
            }
        }
    });
}

function updateFiltersUI() {
    const pill = el('search-type-pill');
    if (pill) {
        pill.innerText = window.tmdbCurrentMediaType === 'movie' ? 'Movies' : 'Series';
    }

    const btnMovies = el('filter-format-movies');
    const btnSeries = el('filter-format-series');
    if (btnMovies && btnSeries) {
        if (window.tmdbCurrentMediaType === 'movie') {
            btnMovies.classList.add('active');
            btnMovies.style.background = 'var(--vault-accent)';
            btnMovies.style.color = 'var(--vt-primary)';
            btnMovies.style.border = 'none';

            btnSeries.classList.remove('active');
            btnSeries.style.background = 'transparent';
            btnSeries.style.color = 'var(--vault-text)';
            btnSeries.style.border = '1px solid var(--vault-border)';
        } else {
            btnSeries.classList.add('active');
            btnSeries.style.background = 'var(--vault-accent)';
            btnSeries.style.color = 'var(--vt-primary)';
            btnSeries.style.border = 'none';

            btnMovies.classList.remove('active');
            btnMovies.style.background = 'transparent';
            btnMovies.style.color = 'var(--vault-text)';
            btnMovies.style.border = '1px solid var(--vault-border)';
        }
    }
}

window.updateProviderButtonsUI = updateProviderButtonsUI;
window.updateFiltersUI = updateFiltersUI;

window.renderTMDB = async function (query = '', append = false) {
    if (!append) {
        const detailsModal = document.getElementById('streaming-details-modal');
        if (detailsModal) detailsModal.style.display = 'none';
        if (typeof window.destroyTrailer === 'function') {
            window.destroyTrailer();
        }
    }

    if (window.tmdbIsFetching && append) {
        console.log('[TMDB] Fetch already in progress, ignoring duplicate load-more call.');
        return;
    }

    const grid = el('tmdb-results-grid');
    if (!grid) return;

    window.tmdbIsFetching = true;
    window.tmdbRequestId = (window.tmdbRequestId || 0) + 1;
    const currentRequestId = window.tmdbRequestId;

    const loadMoreContainer = el('tmdb-load-more-container');
    const loadMoreText = el('tmdb-load-more-text');

    if (!append) {
        grid.innerHTML = '';
        window.tmdbCurrentPage = 1;
        window.tmdbCurrentQuery = query;
        grid.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; color: var(--vault-slate); padding: 40px 0;"><div class="spinner" style="margin: 0 auto 12px;"></div>Searching TMDB...</div>';
        if (loadMoreContainer) loadMoreContainer.style.display = 'none';
    } else {
        if (loadMoreText) loadMoreText.innerText = 'Loading...';
    }

    // Update UI for active/inactive state of providers and filters
    updateProviderButtonsUI();
    updateFiltersUI();

    try {
        let response;
        const langCode = window.tmdbLanguage();
        if (window.tmdbCurrentQuery) {
            response = await window.electronAPI.searchTMDB(window.tmdbCurrentQuery, window.tmdbCurrentPage, langCode);
        } else {
            response = await window.electronAPI.discoverTMDB(
                window.tmdbCurrentProvider,
                window.tmdbCurrentMediaType,
                window.tmdbCurrentPage,
                langCode,
                window.tmdbCurrentGenre,
                window.tmdbCurrentDecade,
                window.tmdbCurrentRegion,
                window.tmdbCurrentSort
            );
        }

        // Check if this request is still the latest one
        if (currentRequestId !== window.tmdbRequestId) {
            console.log(`[TMDB] Discarding stale request ${currentRequestId} in favor of ${window.tmdbRequestId}`);
            return;
        }

        if (!append) {
            grid.innerHTML = '';
        } else {
            if (loadMoreText) loadMoreText.innerText = 'Load More';
        }

        if (!response || !response.success) {
            const errMsg = response ? response.error : 'Unknown error';
            // The raw upstream text (TMDB status_message, HTTP codes) is for the
            // console, not the grid: it was rendered verbatim and untranslated.
            console.error('[TMDB] discover/search failed:', errMsg);
            const t = (window.translations && window.translations[window.currentLang]) || {};
            if (!append) {
                grid.innerHTML = `
                    <div class="empty-state" style="grid-column: 1 / -1; padding: 40px 0;">
                       ${window.icons ? window.icons.error('', 'width: 48px; height: 48px; margin-bottom: 12px; stroke-width: 1.5; stroke: var(--vault-signal-alert, #FF6B7A);') : ''}
                       <h3>${t.tmdbFailedTitle || 'Could not load titles'}</h3>
                       <p>${t.tmdbFailedBody || 'TMDB did not answer. Check your connection and try again.'}</p>
                    </div>
                `;
            } else {
                window.showToast('Failed to load more items: ' + errMsg, 'error');
            }
            if (loadMoreContainer) loadMoreContainer.style.display = 'none';
            return;
        }

        const results = response.results || [];
        if (results.length === 0) {
            if (!append) {
                grid.innerHTML = `
                    <div class="empty-state" style="grid-column: 1 / -1; padding: 40px 0;">
                       ${window.icons ? window.icons.search('', 'width: 48px; height: 48px; margin-bottom: 12px; stroke-width: 1.5; color: var(--vault-accent);') : ''}
                       <h3>No TMDB Results Found</h3>
                       <p>We couldn't find any movies or TV shows matching your criteria.</p>
                    </div>
                `;
            } else {
                window.showToast('No more items found', 'info');
            }
            if (loadMoreContainer) loadMoreContainer.style.display = 'none';
            return;
        }

        // Ensure watch-status map is loaded before rendering cards
        if (typeof window.refreshWatchStatusMap === 'function') {
            await window.refreshWatchStatusMap();
        }

        results.forEach(movie => {
            const card = document.createElement('div');

            // Check if movie is currently saved in the library to apply the premium highlight state
            window.appSettings = window.appSettings || {};
            window.appSettings.library = window.appSettings.library || [];
            const isCurrentlySaved = window.appSettings.library.some(item => item.id === movie.id && item.media_type === movie.media_type);

            if (isCurrentlySaved) {
                card.className = 'file-card tmdb-movie-card in-library';
                card.style.cssText = 'cursor: pointer; background: var(--vault-warm-card); border: 1.5px solid var(--vault-console-gold); border-radius: 6px; box-shadow: 0 0 12px rgba(214, 164, 65, 0.35); position: relative;';
            } else {
                card.className = 'file-card tmdb-movie-card';
                card.style.cssText = 'cursor: pointer; background: var(--vault-warm-card); border: 1px solid var(--vault-border); border-radius: 6px; position: relative;';
            }

            card.addEventListener('click', () => {
                window.showMediaDetails(movie);
            });

            const isTV = movie.media_type === 'tv';

            // Modernized SVGs for standard badging
            const tvSvg = window.icons ? window.icons.tv('', 'width:11px; height:11px; display:inline-block;') : '';
            const movieSvg = window.icons ? window.icons.movie('', 'width:11px; height:11px; display:inline-block;') : '';

            card.innerHTML = `
                <div class="thumbnail-container" style="position:relative; background:#111; height: 180px; width: 100%; border-top-left-radius: 5px; border-top-right-radius: 5px; overflow: hidden;">
                   <button onclick="event.stopPropagation(); window.showMediaDetails(${JSON.stringify(movie).replace(/"/g, '&quot;')})" style="position: absolute; top: 8px; left: 8px; border: none; background: rgba(0,0,0,0.8); color: var(--vault-gold); font-family: var(--font-mono); font-size: 10px; font-weight: 800; padding: 4px 6.5px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 10; border: 1px solid var(--vault-gold); transition: all 0.2s;" title="${isTV ? 'Browse Seasons' : 'Stream Movie'}">
                      ${isTV ? tvSvg : movieSvg}
                   </button>
                   <button class="card-add-lib" onclick="event.stopPropagation(); window.handleCardLibToggle(this, ${JSON.stringify(movie).replace(/"/g, '&quot;')})" style="position:absolute; top:8px; right:8px; border:1px solid var(--vault-gold); background:${isCurrentlySaved ? 'var(--vault-gold)' : 'rgba(0,0,0,0.8)'}; color:${isCurrentlySaved ? 'var(--vt-primary)' : 'var(--vault-gold)'}; width:24px; height:24px; border-radius:4px; cursor:pointer; display:flex; align-items:center; justify-content:center; z-index:10; padding:0; transition:all 0.2s;" title="Add to Library">
                      ${window.icons ? window.icons.plus('', 'width:12px;height:12px;') : '+'}
                   </button>
                   <img class="thumbnail" src="${movie.poster}" alt="${window.escapeHtml(movie.title)}" style="object-fit: cover; width:100%; height:100%; transition: opacity 0.25s ease;" onerror="this.src='public/poster_placeholder.svg'">
                   <div class="size-badge" style="background:var(--vault-accent); color:var(--vt-primary); font-weight:800; position:absolute; bottom: 8px; left: 8px; width: 28px; height: 28px; border-radius: 4px; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 8.5px; line-height: 1.1; padding: 0; box-shadow: 0 2px 6px rgba(0,0,0,0.4); text-align: center;">
                      <span>${window.icons.star('', 'width:10px;height:10px;', 'currentColor', 'currentColor')}</span>
                      <span style="margin-top:-1px;">${movie.rating}</span>
                   </div>
                </div>
                <div class="filename-container" style="padding:12px; text-align:left;">
                   <div style="font-weight:700; font-size:13px; color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--font-mono);">${window.escapeHtml(movie.title)}</div>
                   <div style="font-size:10px; color:var(--vault-slate); margin-top:2px; font-weight:500;">${movie.year} • ${window.escapeHtml(movie.genres)}</div>
                   <div style="font-size:11px; color:#bbb; margin-top:6px; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; line-height:1.4; font-family:var(--font-body);">${window.escapeHtml(movie.overview)}</div>
                </div>
            `;
            card.setAttribute('data-id', String(movie.id));
            if (typeof window.applyWatchStatusCues === 'function') window.applyWatchStatusCues(card, movie);
            window.attachPremiumHoverCard(card, movie);
            grid.appendChild(card);
        });

        // Show pagination container if results are returned
        if (loadMoreContainer) {
            loadMoreContainer.style.display = 'flex';
        }

        window.updateStatusBar();
    } catch (e) {
        console.error("TMDB render error:", e);
        if (currentRequestId !== window.tmdbRequestId) return;
        if (!append) {
            grid.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; color: var(--vault-slate); padding: 40px 0;">Error loading TMDB results.</div>';
        } else {
            window.showToast('Error loading more items', 'error');
        }
        if (loadMoreContainer) loadMoreContainer.style.display = 'none';
    } finally {
        if (currentRequestId === window.tmdbRequestId) {
            window.tmdbIsFetching = false;
        }
    }
};

const MOVIE_GENRES = [
    { id: 'all', name: 'All Genres' },
    { id: 28, name: 'Action' },
    { id: 12, name: 'Adventure' },
    { id: 16, name: 'Animation' },
    { id: 35, name: 'Comedy' },
    { id: 80, name: 'Crime' },
    { id: 99, name: 'Documentary' },
    { id: 18, name: 'Drama' },
    { id: 10751, name: 'Family' },
    { id: 14, name: 'Fantasy' },
    { id: 36, name: 'History' },
    { id: 27, name: 'Horror' },
    { id: 10402, name: 'Music' },
    { id: 9648, name: 'Mystery' },
    { id: 10749, name: 'Romance' },
    { id: 878, name: 'Sci-Fi' },
    { id: 10770, name: 'TV Movie' },
    { id: 53, name: 'Thriller' },
    { id: 10752, name: 'War' },
    { id: 37, name: 'Western' }
];

const TV_GENRES = [
    { id: 'all', name: 'All Genres' },
    { id: 10759, name: 'Action & Adventure' },
    { id: 16, name: 'Animation' },
    { id: 35, name: 'Comedy' },
    { id: 80, name: 'Crime' },
    { id: 99, name: 'Documentary' },
    { id: 18, name: 'Drama' },
    { id: 10751, name: 'Family' },
    { id: 10762, name: 'Kids' },
    { id: 9648, name: 'Mystery' },
    { id: 10763, name: 'News' },
    { id: 10764, name: 'Reality' },
    { id: 10765, name: 'Sci-Fi & Fantasy' },
    { id: 10766, name: 'Soap' },
    { id: 10767, name: 'Talk' },
    { id: 10768, name: 'War & Politics' },
    { id: 37, name: 'Western' }
];

function updateGenreOptions() {
    const genreSelect = el('filter-genre');
    if (!genreSelect) return;
    const genres = window.tmdbCurrentMediaType === 'movie' ? MOVIE_GENRES : TV_GENRES;

    // Remember currently selected genre if valid in target format
    const oldVal = genreSelect.value;
    // This rebuild replaces the markup's <option>s, which is why the data-i18n
    // attributes authored in index.html never survived. Derive a stable key from
    // the English name and translate here, so the list is localised both on
    // first render and on a later language switch (applyI18n re-resolves it).
    const dict = (window.translations && window.translations[window.currentLang]) || {};
    const genreKey = (name) => 'tmdbGenre' + String(name).replace(/[^A-Za-z]/g, '');
    genreSelect.innerHTML = genres.map(g => {
        const key = genreKey(g.name);
        const label = dict[key] || g.name;
        return `<option value="${g.id}" data-i18n="${key}">${label}</option>`;
    }).join('');
    if (genres.some(g => String(g.id) === oldVal)) {
        genreSelect.value = oldVal;
        window.tmdbCurrentGenre = oldVal;
    } else {
        genreSelect.value = 'all';
        window.tmdbCurrentGenre = 'all';
    }
}

window.initTMDBListeners = function () {
    console.log('[tmdb] Initializing TMDB listeners...');

    // Initialize global TMDB streaming state
    window.tmdbIsFetching = false;
    window.tmdbRequestId = 0;
    window.tmdbCurrentProvider = 'all';
    window.tmdbCurrentMediaType = 'movie';
    window.tmdbCurrentPage = 1;
    window.tmdbCurrentQuery = '';

    // Advanced Filters State
    window.tmdbCurrentGenre = 'all';
    window.tmdbCurrentDecade = 'all';
    window.tmdbCurrentRegion = 'all';
    window.tmdbCurrentSort = 'popularity.desc';
    window.tmdbAdvancedExpanded = false;

    // Initialize genres dropdown
    updateGenreOptions();

    // TMDB Search listeners
    const tmdbSearchBtn = el('tmdb-search-btn');
    const tmdbSearchInput = el('tmdb-search-input');
    if (tmdbSearchBtn) {
        tmdbSearchBtn.addEventListener('click', () => {
            const query = tmdbSearchInput ? tmdbSearchInput.value.trim() : '';
            window.renderTMDB(query);
        });
    }
    if (tmdbSearchInput) {
        tmdbSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                clearTimeout(window._tmdbSearchDebounce);
                window.renderTMDB(tmdbSearchInput.value.trim());
            }
        });
        // Dynamic, debounced live search as the user types (mirrors vault-tv).
        // Clearing the box (empty query) falls back to Discover via renderTMDB.
        tmdbSearchInput.addEventListener('input', () => {
            clearTimeout(window._tmdbSearchDebounce);
            const q = tmdbSearchInput.value.trim();
            window._tmdbSearchDebounce = setTimeout(() => { window.renderTMDB(q); }, 380);
        });
    }

    // Toggle search type pill (Movie/Series) on the search bar
    const searchTypePill = el('search-type-pill');
    if (searchTypePill) {
        searchTypePill.addEventListener('click', () => {
            window.tmdbCurrentMediaType = window.tmdbCurrentMediaType === 'movie' ? 'tv' : 'movie';
            if (tmdbSearchInput) tmdbSearchInput.value = '';
            window.tmdbCurrentQuery = '';
            window.tmdbCurrentPage = 1;
            updateGenreOptions();
            window.renderTMDB();
        });
    }

    // Advanced Drawer Toggle
    const advancedToggle = el('tmdb-advanced-toggle');
    const advancedChevron = el('advanced-chevron');
    const advancedFiltersDrawer = el('streaming-advanced-filters');
    if (advancedToggle && advancedFiltersDrawer) {
        advancedToggle.addEventListener('click', () => {
            window.tmdbAdvancedExpanded = !window.tmdbAdvancedExpanded;
            if (window.tmdbAdvancedExpanded) {
                advancedFiltersDrawer.style.display = 'flex';
                if (advancedChevron) advancedChevron.style.transform = 'rotate(180deg)';
                advancedToggle.style.background = 'rgba(255, 255, 255, 0.08)';
            } else {
                advancedFiltersDrawer.style.display = 'none';
                if (advancedChevron) advancedChevron.style.transform = 'rotate(0deg)';
                advancedToggle.style.background = 'transparent';
            }
        });
    }

    // Filter Format buttons (inside advanced filters)
    const filterFormatMovies = el('filter-format-movies');
    const filterFormatSeries = el('filter-format-series');
    if (filterFormatMovies) {
        filterFormatMovies.addEventListener('click', () => {
            if (window.tmdbCurrentMediaType !== 'movie') {
                window.tmdbCurrentMediaType = 'movie';
                if (tmdbSearchInput) tmdbSearchInput.value = '';
                window.tmdbCurrentQuery = '';
                window.tmdbCurrentPage = 1;
                updateGenreOptions();
                window.renderTMDB();
            }
        });
    }
    if (filterFormatSeries) {
        filterFormatSeries.addEventListener('click', () => {
            if (window.tmdbCurrentMediaType !== 'tv') {
                window.tmdbCurrentMediaType = 'tv';
                if (tmdbSearchInput) tmdbSearchInput.value = '';
                window.tmdbCurrentQuery = '';
                window.tmdbCurrentPage = 1;
                updateGenreOptions();
                window.renderTMDB();
            }
        });
    }

    // Dropdown Select Filters
    const filterGenre = el('filter-genre');
    const filterDecade = el('filter-decade');
    const filterRegion = el('filter-region');
    const filterSort = el('filter-sort');

    if (filterGenre) {
        filterGenre.addEventListener('change', () => {
            window.tmdbCurrentGenre = filterGenre.value;
            window.tmdbCurrentPage = 1;
            window.renderTMDB();
        });
    }
    if (filterDecade) {
        filterDecade.addEventListener('change', () => {
            window.tmdbCurrentDecade = filterDecade.value;
            window.tmdbCurrentPage = 1;
            window.renderTMDB();
        });
    }
    if (filterRegion) {
        filterRegion.addEventListener('change', () => {
            window.tmdbCurrentRegion = filterRegion.value;
            window.tmdbCurrentPage = 1;
            window.renderTMDB();
        });
    }
    if (filterSort) {
        filterSort.addEventListener('change', () => {
            window.tmdbCurrentSort = filterSort.value;
            window.tmdbCurrentPage = 1;
            window.renderTMDB();
        });
    }

    // Reset Advanced Filters
    const btnResetFilters = el('btn-clear-advanced-filters');
    if (btnResetFilters) {
        btnResetFilters.addEventListener('click', () => {
            window.tmdbCurrentProvider = 'all';
            window.tmdbCurrentMediaType = 'movie';
            window.tmdbCurrentGenre = 'all';
            window.tmdbCurrentDecade = 'all';
            window.tmdbCurrentRegion = 'all';
            window.tmdbCurrentSort = 'popularity.desc';
            window.tmdbCurrentPage = 1;
            window.tmdbCurrentQuery = '';

            if (tmdbSearchInput) tmdbSearchInput.value = '';
            if (filterGenre) filterGenre.value = 'all';
            if (filterDecade) filterDecade.value = 'all';
            if (filterRegion) filterRegion.value = 'all';
            if (filterSort) filterSort.value = 'popularity.desc';

            updateGenreOptions();
            window.renderTMDB();
        });
    }

    // TMDB Watch Providers click handlers
    document.querySelectorAll('.provider-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (tmdbSearchInput) tmdbSearchInput.value = '';
            window.tmdbCurrentQuery = '';
            window.tmdbCurrentProvider = btn.dataset.provider;
            window.tmdbCurrentPage = 1;
            window.renderTMDB();
        });
    });

    // TMDB Load More pagination click handler
    const tmdbLoadMoreBtn = el('tmdb-load-more-btn');
    if (tmdbLoadMoreBtn) {
        tmdbLoadMoreBtn.addEventListener('click', () => {
            window.tmdbCurrentPage++;
            window.renderTMDB(window.tmdbCurrentQuery, true);
        });
    }

    // Auto-paginate
    const tmdbContainer = el('tmdb-container');
    if (tmdbContainer) {
        tmdbContainer.addEventListener('scroll', () => {
            if (window.tmdbIsFetching) return;
            const loadMoreContainer = el('tmdb-load-more-container');
            if (!loadMoreContainer || loadMoreContainer.style.display === 'none') return;
            const nearBottom = tmdbContainer.scrollTop + tmdbContainer.clientHeight
                >= tmdbContainer.scrollHeight - 600;
            if (nearBottom) {
                window.tmdbCurrentPage++;
                window.renderTMDB(window.tmdbCurrentQuery, true);
            }
        }, { passive: true });
    }
};
