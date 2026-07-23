/* ==========================================================================
   Vault Streaming — Navigation Routing
   ========================================================================== */

window.currentStreamingSubtab = 'discover';

window.switchStreamingSubtab = function (subtab) {
    window.currentStreamingSubtab = subtab;

    // Toggle active classes on subnav pills
    const pills = document.querySelectorAll('#sub-nav-streaming .sub-nav-pill');
    pills.forEach(pill => {
        const id = pill.id;
        const targetId = `subtab-streaming-${subtab}`;
        if (id === targetId) {
            // Distinct "tab" look (not a floating pill): filled head + gold underline.
            pill.classList.add('active');
            pill.style.background = 'var(--vault-accent)';
            pill.style.color = 'var(--vt-primary)';
            pill.style.border = 'none';
            pill.style.borderBottom = '2px solid var(--vault-gold)';
            pill.style.opacity = '1';
        } else {
            pill.classList.remove('active');
            pill.style.background = 'transparent';
            pill.style.color = 'var(--vault-text)';
            pill.style.border = 'none';
            pill.style.borderBottom = '2px solid transparent';
            pill.style.opacity = '0.7';
        }
    });

    // Handle container visibility
    const tmdbContainer = document.getElementById('tmdb-container');
    const libGrid = document.getElementById('library-grid');
    const histGrid = document.getElementById('history-grid');

    if (subtab === 'discover') {
        // Edge-to-edge: #tmdb-container owns its own scroll
        document.body.classList.add('tab-streaming-active');
        if (tmdbContainer) tmdbContainer.style.display = 'block';
        if (libGrid) libGrid.style.display = 'none';
        if (histGrid) histGrid.style.display = 'none';
        if (typeof window.renderTMDB === 'function') window.renderTMDB();
    } else if (subtab === 'library') {
        document.body.classList.remove('tab-streaming-active');
        if (tmdbContainer) tmdbContainer.style.display = 'none';
        if (libGrid) libGrid.style.display = 'grid';
        if (histGrid) histGrid.style.display = 'none';
        if (typeof window.renderLibrary === 'function') window.renderLibrary();
    } else if (subtab === 'history') {
        document.body.classList.remove('tab-streaming-active');
        if (tmdbContainer) tmdbContainer.style.display = 'none';
        if (libGrid) libGrid.style.display = 'none';
        if (histGrid) histGrid.style.display = 'grid';
        if (typeof window.renderWatchHistoryTab === 'function') window.renderWatchHistoryTab();
    }
};

window.initTabListeners = function () {
    console.log('[tabs] Initializing navigation click listeners...');

    // Boot default is the Discover grid
    document.body.classList.add('tab-streaming-active');

    // Streaming subtab listeners
    const subtabDisc = document.getElementById('subtab-streaming-discover');
    const subtabLib = document.getElementById('subtab-streaming-library');
    const subtabHist = document.getElementById('subtab-streaming-history');
    if (subtabDisc) subtabDisc.addEventListener('click', () => window.switchStreamingSubtab('discover'));
    if (subtabLib) subtabLib.addEventListener('click', () => window.switchStreamingSubtab('library'));
    if (subtabHist) subtabHist.addEventListener('click', () => window.switchStreamingSubtab('history'));

    // NOTE: the initial Discover load is triggered at the END of initApp (app.js)
    // — firing it here ran renderTMDB before initTMDBListeners had initialized
    // the TMDB state, which silently produced an empty grid at boot.
};
