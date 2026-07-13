/* ==========================================================================
   Vault Streaming — Navigation Routing
   ========================================================================== */

window.currentStreamingSubtab = 'discover';

window.switchStreamingSubtab = function(subtab) {
    window.currentStreamingSubtab = subtab;

    // Toggle active classes on subnav pills
    const pills = document.querySelectorAll('#sub-nav-streaming .sub-nav-pill');
    pills.forEach(pill => {
        const id = pill.id;
        const targetId = `subtab-streaming-${subtab}`;
        if (id === targetId) {
            pill.classList.add('active');
            pill.style.background = 'var(--vault-accent)';
            pill.style.color = 'var(--vt-primary)';
            pill.style.border = 'none';
            pill.style.opacity = '1';
        } else {
            pill.classList.remove('active');
            pill.style.background = 'transparent';
            pill.style.color = 'var(--vault-text)';
            pill.style.border = '1px solid var(--vault-border)';
            pill.style.opacity = '0.8';
        }
    });

    // Handle container visibility
    const tmdbContainer = document.getElementById('tmdb-container');
    const libGrid = document.getElementById('library-grid');
    
    if (subtab === 'discover') {
        // Edge-to-edge: #tmdb-container owns its own scroll, so drop .main-area's
        // 32px padding + scroll (which otherwise leaves a dead, non-scrollable
        // gutter around the grid — the "can't scroll unless the cursor is inside
        // the container" bug). The CSS rule keys off this body class.
        document.body.classList.add('tab-streaming-active');
        if (tmdbContainer) tmdbContainer.style.display = 'block';
        if (libGrid) libGrid.style.display = 'none';
        if (typeof window.renderTMDB === 'function') window.renderTMDB();
    } else if (subtab === 'library') {
        // library-grid is a bare grid that relies on .main-area's own scroll, so
        // restore the padded/scrollable main-area for this view.
        document.body.classList.remove('tab-streaming-active');
        if (tmdbContainer) tmdbContainer.style.display = 'none';
        if (libGrid) libGrid.style.display = 'grid';
        if (typeof window.renderLibrary === 'function') window.renderLibrary();
    }
};

window.initTabListeners = function() {
    console.log('[tabs] Initializing navigation click listeners...');

    // Boot default is the Discover grid — apply the edge-to-edge class now so the
    // grid is scrollable to the screen edge from first paint (see switchStreamingSubtab).
    document.body.classList.add('tab-streaming-active');

    // Streaming subtab listeners
    const subtabDisc = document.getElementById('subtab-streaming-discover');
    const subtabLib = document.getElementById('subtab-streaming-library');
    if (subtabDisc) subtabDisc.addEventListener('click', () => window.switchStreamingSubtab('discover'));
    if (subtabLib) subtabLib.addEventListener('click', () => window.switchStreamingSubtab('library'));

    // NOTE: the initial Discover load is triggered at the END of initApp (app.js)
    // — firing it here ran renderTMDB before initTMDBListeners had initialized
    // the TMDB state, which silently produced an empty grid at boot.
};

// Legacy shim for `switchTab` if other parts of the app still call it
window.switchTab = function(tabName) {
    console.log('[tabs] Legacy switchTab called with:', tabName);
    // Ignore all other tabs
};
