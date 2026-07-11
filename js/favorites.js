/* ==========================================================================
   Vault Favorites & Streaming Library Rendering Module
   ========================================================================== */

/**
 * Render Favorite Local Files. The favorites tab shares its cell renderer
 * (createCardElement) with the main Vault grid, so cards behave identically:
 * star toggles, context menus, double-click to play. The tab maintains its
 * own grid and its own item cache (window.favoriteLocalItems).
 *
 * Robustness:
 *   - Sanitizes appSettings.favorites in-memory; persists only if it actually
 *     changed (no save-on-every-render).
 *   - Drops any path the scanner can't resolve (auto-prune) so a single bad
 *     entry can't break the whole tab.
 *   - Reports how many paths were dropped via a small notice atop the grid.
 */
window.renderFavorites = async function(useCache = false) {
    const grid = el('favorites-grid');
    if (!grid) return;

    const t = window.translations[window.currentLang === 'fr' ? 'fr' : 'en'] || {};

    // Sanitize the in-memory favorites list. Persist only if we actually changed it.
    const raw = Array.isArray(window.appSettings.favorites) ? window.appSettings.favorites : [];
    const cleaned = raw.filter(p =>
        typeof p === 'string' && p.trim() !== '' && !p.startsWith('virtual://')
    );
    if (cleaned.length !== raw.length) {
        window.appSettings.favorites = cleaned;
        window.electronAPI.saveSettings(window.appSettings);
    } else {
        window.appSettings.favorites = cleaned;
    }

    if (cleaned.length === 0) {
        const starIcon = window.icons ? window.icons.star('', 'width: 48px; height: 48px; margin-bottom: 12px; display: inline-block;', 'none', 'var(--vault-gold)') : '';
        grid.innerHTML = `
            <div class="empty-state">
               ${starIcon}
               <h3 style="color:#fff; font-family:var(--font-mono); font-size:15px; margin-bottom:8px; font-weight:700;">
                   ${t.noFavoritesYet || 'No Favorites Yet'}
               </h3>
               <p style="color:var(--vault-slate); font-family:var(--font-body); font-size:12px; max-width:320px; margin:0 auto;">
                   ${t.noFavoritesYetDesc || 'Click the star icon on any video or image in your Vault to save it here.'}
               </p>
            </div>`;
        window.displayedItems = [];
        if (typeof window.updateStatusBar === 'function') window.updateStatusBar();
        return;
    }

    if (!useCache || !window.favoriteLocalItems) {
        grid.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:var(--vault-slate); padding:40px 0;"><div class="spinner" style="margin:0 auto 12px;"></div>${t.loadingFavorites || 'Loading favorites...'}</div>`;
        let scanned = [];
        try {
            scanned = (await window.electronAPI.scanSpecificFiles(cleaned)) || [];
        } catch (e) {
            console.error('[favorites] scanSpecificFiles failed:', e);
            scanned = [];
        }

        // Auto-prune entries that the scanner couldn't resolve (moved/deleted files).
        // Drop them from appSettings.favorites so the next render is clean.
        const foundSet = new Set(scanned.map(i => (i.path || '').toLowerCase()));
        const missing = cleaned.filter(p => !foundSet.has(p.toLowerCase()));
        if (missing.length) {
            window.appSettings.favorites = cleaned.filter(p => foundSet.has(p.toLowerCase()));
            window.electronAPI.saveSettings(window.appSettings);
        }

        scanned.forEach(item => { item.isFavorited = true; });
        window.favoriteLocalItems = scanned;
        // Stash for the notice below; cleared after first display.
        window._favoritesMissingCount = missing.length;
    }

    const term = (el('search-box') && el('search-box').value || '').toLowerCase();
    const filterAttr = el('filter-type') ? el('filter-type').value : 'all';
    const sortBy = el('sort-by') ? el('sort-by').value : 'name';
    const sortOrder = (el('btn-sort-order') && el('btn-sort-order').dataset.order) || 'desc';

    let filtered = (window.favoriteLocalItems || []).filter(v => {
        if (!v) return false;
        if (term && !(v.name || '').toLowerCase().includes(term)) return false;
        if (filterAttr === 'video') return v.type === 'video' || v.type === 'encrypted';
        if (filterAttr === 'image') return v.type === 'image';
        if (filterAttr === 'audio') return v.type === 'audio';
        return true;
    });

    filtered.sort((a, b) => {
        let valA = a[sortBy], valB = b[sortBy];
        if (sortBy === 'name') { valA = (valA || '').toLowerCase(); valB = (valB || '').toLowerCase(); }
        else if (['size', 'duration', 'mtime'].includes(sortBy)) { valA = valA || 0; valB = valB || 0; }
        const cmp = valA < valB ? -1 : valA > valB ? 1 : 0;
        return sortOrder === 'desc' ? -cmp : cmp;
    });

    window.displayedItems = filtered;

    // Optional notice about pruned-missing entries (shown once after the scan).
    let noticeHtml = '';
    if (window._favoritesMissingCount > 0) {
        const n = window._favoritesMissingCount;
        noticeHtml = `<div style="grid-column:1/-1; padding:8px 12px; margin-bottom:8px; background:rgba(245,185,41,0.08); border:1px solid var(--vault-gold); border-radius:4px; font-size:11px; color:var(--vault-gold); font-family:var(--font-mono);">${n} missing favorite${n === 1 ? '' : 's'} pruned (file${n === 1 ? '' : 's'} moved or deleted).</div>`;
        window._favoritesMissingCount = 0;
    }

    if (filtered.length === 0) {
        const searchIcon = window.icons ? window.icons.search('', 'width:48px; height:48px; margin-bottom:12px; display:inline-block;') : '';
        grid.innerHTML = `${noticeHtml}
            <div class="empty-state">
               ${searchIcon}
               <h3 style="color:#fff; font-family:var(--font-mono); font-size:15px; margin-bottom:8px; font-weight:700;">
                   ${t.noItemsFound || 'No items found'}
               </h3>
               <p style="color:var(--vault-slate); font-family:var(--font-body); font-size:12px; max-width:320px; margin:0 auto;">
                   ${t.adjustFiltersFavorites || 'Adjust your search filters.'}
               </p>
            </div>`;
        if (typeof window.updateStatusBar === 'function') window.updateStatusBar();
        return;
    }

    grid.innerHTML = noticeHtml;
    const frag = document.createDocumentFragment();
    filtered.forEach((item, i) => frag.appendChild(window.createCardElement(item, i)));
    grid.appendChild(frag);
    if (typeof window.updateStatusBar === 'function') window.updateStatusBar();
};

/**
 * Render Streaming Media Library items only.
 */
window.renderLibrary = async function(useCache = false) {
    const grid = el('library-grid');
    if (!grid) return;
    
    window.appSettings.library = window.appSettings.library || [];
    const hasLibrary = window.appSettings.library.length > 0;
    const t = window.translations[window.currentLang === 'fr' ? 'fr' : 'en'] || {};
    
    if (!hasLibrary) {
        const libIcon = window.icons ? window.icons.library('', 'width: 48px; height: 48px; margin-bottom: 12px; display: inline-block; stroke: var(--vault-gold);') : '';
        grid.innerHTML = `
            <div class="empty-state">
               ${libIcon}
               <h3 style="color: #fff; font-family: var(--font-mono); font-size: 15px; margin-bottom: 8px; font-weight: 700;">
                   ${t.libraryEmpty || 'Your Library is Empty'}
               </h3>
               <p style="color: var(--vault-slate); font-family: var(--font-body); font-size: 12px; max-width: 320px; margin: 0 auto;">
                   ${t.libraryEmptyDesc || 'Add films or series to your library from the Movies/Series tab.'}
               </p>
            </div>
        `;
        return;
    }

    grid.innerHTML = '';

    const term = el('search-box').value.toLowerCase();
    const filterAttr = el('filter-type').value;
    const sortBy = el('sort-by').value;
    const sortOrder = el('btn-sort-order').dataset.order || 'desc';

    // 1. Filter and sort Streaming items
    let filteredLibrary = [...window.appSettings.library];
    if (term) {
        filteredLibrary = filteredLibrary.filter(m => 
            (m.title || m.name || '').toLowerCase().includes(term) || 
            (m.genres || '').toLowerCase().includes(term) || 
            (m.overview || '').toLowerCase().includes(term)
        );
    }
    if (filterAttr === 'image') {
        filteredLibrary = []; // No images in streaming library
    }

    // Sort streaming library
    filteredLibrary.sort((a, b) => {
        let valA = a[sortBy] || a.title || a.name || '';
        let valB = b[sortBy] || b.title || b.name || '';
        if (sortBy === 'name' || typeof valA === 'string') {
            valA = String(valA).toLowerCase();
            valB = String(valB).toLowerCase();
        } else {
            valA = valA || 0;
            valB = valB || 0;
        }
        let compare = 0;
        if (valA < valB) compare = -1; else if (valA > valB) compare = 1;
        return sortOrder === 'desc' ? compare * -1 : compare;
    });

    if (filteredLibrary.length === 0) {
        const searchIcon = window.icons ? window.icons.search('', 'width: 48px; height: 48px; margin-bottom: 12px; display: inline-block;') : '';
        grid.innerHTML = `
            <div class="empty-state">
               ${searchIcon}
               <h3 style="color: #fff; font-family: var(--font-mono); font-size: 15px; margin-bottom: 8px; font-weight: 700;">
                   ${t.noItemsFound || 'No items found'}
               </h3>
               <p style="color: var(--vault-slate); font-family: var(--font-body); font-size: 12px; max-width: 320px; margin: 0 auto;">
                   ${t.adjustFiltersFavorites || 'Adjust your search filters.'}
               </p>
            </div>
        `;
        return;
    }

    filteredLibrary.forEach(movie => {
        const card = document.createElement('div');
        card.className = 'file-card tmdb-movie-card in-library';
        card.style.cssText = 'cursor: pointer; background: var(--vault-warm-card); border: 1.5px solid var(--vault-console-gold); border-radius: 6px; box-shadow: 0 0 12px rgba(214, 164, 65, 0.35); position: relative;';
        
        card.addEventListener('click', async () => {
            try {
                const prog = await window.electronAPI.getWatchProgress({
                    mediaType: movie.media_type,
                    tmdbId: movie.id,
                    title: movie.title || movie.name
                });
                if (prog && prog.streamUrl && !prog.completed && prog.positionSec > 0) {
                    window.activeStreamingMedia = {
                        mediaType: movie.media_type,
                        tmdbId: movie.id,
                        title: movie.title || movie.name,
                        season: prog.season || null,
                        episode: prog.episode || null,
                        poster: movie.poster,
                        year: movie.year,
                        streamUrl: prog.streamUrl,
                        streamTitle: prog.streamTitle || movie.title || movie.name,
                        quality: prog.quality,
                        selectedSubtitleTrackIdx: prog.selectedSubtitleTrackIdx,
                        selectedSubtitleLabel: prog.selectedSubtitleLabel,
                        selectedSubtitleLang: prog.selectedSubtitleLang
                    };
                    window.playStream(prog.streamUrl, prog.streamTitle || movie.title || movie.name);
                    const t = window.translations[window.currentLang === 'fr' ? 'fr' : 'en'] || {};
                    window.showToast(t.resumingStream || 'Resuming stream...', 'success');
                } else {
                    window.showMediaDetails(movie);
                }
            } catch (e) {
                console.error("Error resuming library item:", e);
                window.showMediaDetails(movie);
            }
        });
        
        const isTV = movie.media_type === 'tv';
        const tvSvg = window.icons ? window.icons.tv('', 'width:11px; height:11px; display:inline-block;') : '';
        const movieSvg = window.icons ? window.icons.movie('', 'width:11px; height:11px; display:inline-block;') : '';
        const plusSvg = window.icons ? window.icons.plus('', 'width: 10px; height: 10px; display: inline-block;') : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 10px; height: 10px;"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;
        const closeSvg = window.icons ? window.icons.close('', 'width: 10px; height: 10px; display: inline-block;') : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 10px; height: 10px;"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
        
        card.innerHTML = `
            <div class="thumbnail-container" style="position:relative; background:#111; height: 180px; width: 100%; border-top-left-radius: 5px; border-top-right-radius: 5px; overflow: hidden;">
               <button onclick="event.stopPropagation(); window.showMediaDetails(${JSON.stringify(movie).replace(/"/g, '&quot;')})" style="position: absolute; top: 8px; left: 8px; border: none; background: rgba(0,0,0,0.8); color: var(--vault-gold); font-family: var(--font-mono); font-size: 10px; font-weight: 800; padding: 4px 6.5px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 10; border: 1px solid var(--vault-gold); transition: all 0.2s;" title="${isTV ? t.browseSeasons : t.streamMovie}">
                  ${isTV ? tvSvg : movieSvg}
               </button>
               <button onclick="event.stopPropagation(); window.showAddToFolderDialogForStreaming(${JSON.stringify(movie).replace(/"/g, '&quot;')})" style="position: absolute; top: 8px; right: 38px; border: none; background: rgba(0,0,0,0.8); color: var(--vault-accent); font-family: var(--font-mono); font-size: 10px; font-weight: 800; padding: 4px 6.5px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 10; border: 1px solid var(--vault-accent); transition: all 0.2s; width: 24px; height: 24px;" title="${t.addToCollection}">
                  ${plusSvg}
               </button>
               <button onclick="event.stopPropagation(); window.removeFromLibrary(${movie.id}, '${window.escapeHtml(movie.title || movie.name).replace(/'/g, "\\'")}')" style="position: absolute; top: 8px; right: 8px; border: none; background: rgba(0,0,0,0.8); color: var(--vault-signal-alert, #ff7979); font-family: var(--font-mono); font-size: 10px; font-weight: 800; padding: 4px 6.5px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 10; border: 1px solid var(--vault-signal-alert, #ff7979); transition: all 0.2s; width: 24px; height: 24px;" title="${t.removeFromLibrary}">
                  ${closeSvg}
               </button>
               <img class="thumbnail" src="${movie.poster}" alt="${window.escapeHtml(movie.title || movie.name)}" style="object-fit: cover; width:100%; height:100%; transition: opacity 0.25s ease;" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMCIgaGVpZ2h0PSIyMCIgdmlld0JveD0iMCAwIDI0IDI0Ij48cmVjdCB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIGZpbGw9IiMxMTEiIHJ4PSIyIiByeT0iMiIvPjxyZWN0IHg9IjgiIHk9IjgiIHdpZHRoPSI4IiBoZWlnaHQ9IjgiIGZpbGw9IiM5OTkiIHJ4PSIyIiByeT0iMiIvPjwvc3ZnPg==';" />
               <div class="size-badge" style="background:var(--vault-accent); color:var(--vt-primary); font-weight:800; position:absolute; bottom: 8px; left: 8px; width: 28px; height: 28px; border-radius: 4px; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 8.5px; line-height: 1.1; padding: 0; box-shadow: 0 2px 6px rgba(0,0,0,0.4); text-align: center;">
                  <span>${window.icons ? window.icons.star('', 'width:10px;height:10px;', 'currentColor', 'currentColor') : '*'}</span>
                  <span style="margin-top:-1px;">${movie.rating || '0.0'}</span>
               </div>
            </div>
            <div class="filename-container" style="padding:12px; text-align:left;">
               <div style="font-weight:700; font-size:13px; color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--font-mono);">${window.escapeHtml(movie.title || movie.name)}</div>
               <div style="font-size:10px; color:var(--vault-slate); margin-top:2px; font-weight:500;">${movie.year || ''} • ${window.escapeHtml(movie.genres || '')}</div>
               <div style="font-size:11px; color:#bbb; margin-top:6px; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; line-height:1.4; font-family:var(--font-body);">${window.escapeHtml(movie.overview || '')}</div>
            </div>
        `;
        card.setAttribute('data-id', String(movie.id));
        window.attachPremiumHoverCard(card, movie);
        grid.appendChild(card);
    });
};

/**
 * Remove an item from the streaming library.
 */
window.removeFromLibrary = async function(movieId, movieTitle) {
    const t = window.translations[window.currentLang === 'fr' ? 'fr' : 'en'] || {};
    const confirmTitle = t.removeFromLibrary || 'Remove from Library';
    const confirmMsg = t.confirmRemoveFromLibrary 
        ? t.confirmRemoveFromLibrary.replace('{0}', movieTitle) 
        : `Are you sure you want to remove "${movieTitle}" from your library?`;
        
    if (await window.showConfirmDialog(confirmMsg, confirmTitle)) {
        window.appSettings.library = window.appSettings.library || [];
        window.appSettings.library = window.appSettings.library.filter(m => m.id !== movieId);
        window.electronAPI.saveSettings(window.appSettings);
        
        const successMsg = t.removedFromLibrary || 'Removed from Library';
        window.showToast(successMsg, 'success');
        
        // Reload Library
        window.renderLibrary();
    }
};

/**
 * Open Collection Selection Dialog for TMDB streaming media.
 */
window.showAddToFolderDialogForStreaming = function(movie) {
    const virtualItem = {
        name: movie.title || movie.name,
        path: 'tmdb://metadata:' + JSON.stringify(movie),
        type: 'video', // Matches 'collection'
        isStreaming: true,
        meta: movie
    };
    if (typeof window.showAddToFolderDialog === 'function') {
        window.showAddToFolderDialog(virtualItem);
    }
};

/**
 * Toggle local file favorite status.
 */
window.toggleFavorite = function(filePath, btnEl) {
    window.appSettings.favorites = window.appSettings.favorites || [];
    const idx = window.appSettings.favorites.indexOf(filePath);
    let isNowStarred = false;
    const t = window.translations[window.currentLang === 'fr' ? 'fr' : 'en'] || {};
    
    if (idx !== -1) {
        window.appSettings.favorites.splice(idx, 1);
        window.showToast(t.removedFromFavorites || 'Removed from Favorites', 'success');
    } else {
        window.appSettings.favorites.push(filePath);
        // Don't show toast - yellow star provides visual feedback
        isNowStarred = true;
    }
    
    // Save settings persistently
    window.electronAPI.saveSettings(window.appSettings);

    // Keep the Favorites virtual folder in sync
    if (window.vf && typeof window.vf.syncFavorites === 'function') {
        try { window.vf.syncFavorites(); } catch (e) { console.error('[favorites] syncFavorites failed:', e); }
    }

    // Invalidate local favorites cache to ensure freshness on next tab render/filter
    window.favoriteLocalItems = null;
    
    // Update SVG icon in any matching card elements
    const normPath = (p) => (p || '').replace(/\\/g, '/').toLowerCase();
    const targetPath = normPath(filePath);
    document.querySelectorAll('.file-card').forEach(c => {
        const cardPath = normPath(c.dataset.path);
        if (cardPath === targetPath) {
            const svg = c.querySelector('.star-svg');
            if (svg) {
                svg.setAttribute('fill', isNowStarred ? '#E5A93B' : 'none');
                svg.setAttribute('stroke', isNowStarred ? '#E5A93B' : '#ffffff');
                svg.style.transform = 'scale(1.3)';
                setTimeout(() => { svg.style.transform = 'scale(1.0)'; }, 200);
            }
        }
    });

    if (window.currentTab === 'files' && window.currentFilesSubtab === 'favorites') {
        window.renderFavorites();
    }
};
