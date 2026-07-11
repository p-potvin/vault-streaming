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

function updateSubtabsUI() {
    const subtabMovies = el('subtab-movies');
    const subtabSeries = el('subtab-series');
    if (!subtabMovies || !subtabSeries) return;
    if (window.tmdbCurrentMediaType === 'movie') {
        subtabMovies.classList.add('active');
        subtabMovies.style.background = 'var(--vault-accent)';
        subtabMovies.style.color = 'var(--vt-primary)';
        subtabMovies.style.border = 'none';
        subtabMovies.style.opacity = '1';

        subtabSeries.classList.remove('active');
        subtabSeries.style.background = 'transparent';
        subtabSeries.style.color = 'var(--vault-text)';
        subtabSeries.style.border = '1px solid var(--vault-border)';
        subtabSeries.style.opacity = '0.8';
    } else {
        subtabSeries.classList.add('active');
        subtabSeries.style.background = 'var(--vault-accent)';
        subtabSeries.style.color = 'var(--vt-primary)';
        subtabSeries.style.border = 'none';
        subtabSeries.style.opacity = '1';

        subtabMovies.classList.remove('active');
        subtabMovies.style.background = 'transparent';
        subtabMovies.style.color = 'var(--vault-text)';
        subtabMovies.style.border = '1px solid var(--vault-border)';
        subtabMovies.style.opacity = '0.8';
    }
}

window.updateProviderButtonsUI = updateProviderButtonsUI;
window.updateSubtabsUI = updateSubtabsUI;

window.renderTMDB = async function(query = '', append = false) {
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

    // Update UI for active/inactive state of providers and subtabs
    updateProviderButtonsUI();
    updateSubtabsUI();

    try {
        let response;
        const langCode = window.currentLang === 'fr' ? 'fr-FR' : 'en-US';
        if (window.tmdbCurrentQuery) {
            response = await window.electronAPI.searchTMDB(window.tmdbCurrentQuery, window.tmdbCurrentPage, langCode);
        } else {
            response = await window.electronAPI.discoverTMDB(window.tmdbCurrentProvider, window.tmdbCurrentMediaType, window.tmdbCurrentPage, langCode);
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
            if (!append) {
                grid.innerHTML = `
                    <div class="empty-state" style="grid-column: 1 / -1; padding: 40px 0;">
                       ${window.icons ? window.icons.error('', 'width: 48px; height: 48px; margin-bottom: 12px; stroke-width: 1.5; stroke: var(--vault-signal-alert, #FF6B7A);') : ''}
                       <h3>TMDB Request Failed</h3>
                       <p>${window.escapeHtml(errMsg)}</p>
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
                   <img class="thumbnail" src="${movie.poster}" alt="${window.escapeHtml(movie.title)}" style="object-fit: cover; width:100%; height:100%; transition: opacity 0.25s ease;" onerror="this.src='public/poster_placeholder.svg'">
                   <div class="size-badge" style="background:var(--vault-accent); color:var(--vt-primary); font-weight:800; position:absolute; bottom: 8px; left: 8px; width: 28px; height: 28px; border-radius: 4px; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 8.5px; line-height: 1.1; padding: 0; box-shadow: 0 2px 6px rgba(0,0,0,0.4); text-align: center;">
                      <span>★</span>
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

window.initTMDBListeners = function() {
    console.log('[tmdb] Initializing TMDB listeners...');
    
    // Initialize global TMDB streaming state
    window.tmdbIsFetching = false;
    window.tmdbRequestId = 0;
    window.tmdbCurrentProvider = 'all';
    window.tmdbCurrentMediaType = 'movie';
    window.tmdbCurrentPage = 1;
    window.tmdbCurrentQuery = '';

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
                window.renderTMDB(tmdbSearchInput.value.trim());
            }
        });
    }

    // TMDB Subtabs (Movies / Series) click handlers
    const subtabMovies = el('subtab-movies');
    const subtabSeries = el('subtab-series');
    if (subtabMovies) {
        subtabMovies.addEventListener('click', () => {
            if (tmdbSearchInput) tmdbSearchInput.value = '';
            window.tmdbCurrentQuery = '';
            window.tmdbCurrentMediaType = 'movie';
            window.tmdbCurrentPage = 1;
            window.renderTMDB();
        });
    }
    if (subtabSeries) {
        subtabSeries.addEventListener('click', () => {
            if (tmdbSearchInput) tmdbSearchInput.value = '';
            window.tmdbCurrentQuery = '';
            window.tmdbCurrentMediaType = 'tv';
            window.tmdbCurrentPage = 1;
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

    // TMDB Load More pagination click handler (kept as manual fallback)
    const tmdbLoadMoreBtn = el('tmdb-load-more-btn');
    if (tmdbLoadMoreBtn) {
        tmdbLoadMoreBtn.addEventListener('click', () => {
            window.tmdbCurrentPage++;
            window.renderTMDB(window.tmdbCurrentQuery, true);
        });
    }

    // Auto-paginate: when the user scrolls close to the bottom of the
    // streaming container, automatically fetch the next page. Throttled so
    // mid-fetch scroll events don't fire it again, and only fires when the
    // load-more button is actually visible (i.e. more pages exist).
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
