// app.js - Master frontend orchestrator coordinates settings, i18n language setups, mock API integrations, progress channels, and window blur hooks

window.appSettings = { folders: [] };
window.currentLang = 'en';

// Declarative translation. Wiring every string by id (the block further down)
// stopped scaling once the streaming UI arrived: it carries well over a hundred
// strings and most of its markup has no id at all, so anything not listed here
// silently stayed English. Elements now carry data-i18n / data-i18n-placeholder
// / data-i18n-title and are resolved generically — adding a string is a markup
// attribute plus a dictionary entry, with no code change here.
function applyI18n(dict, root) {
    root = root || document;
    if (!dict) return;

    root.querySelectorAll('[data-i18n]').forEach((node) => {
        const value = dict[node.dataset.i18n];
        if (value == null) return;   // no entry: keep whatever the markup authored
        // Replace only text, so embedded markup survives — the nav tabs render an
        // inline SVG icon as a sibling of their label.
        const textNode = Array.prototype.find.call(
            node.childNodes, (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim()
        );
        if (textNode) textNode.textContent = value;
        else node.textContent = value;
    });

    root.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
        const value = dict[node.dataset.i18nPlaceholder];
        if (value != null) node.placeholder = value;
    });

    root.querySelectorAll('[data-i18n-title]').forEach((node) => {
        const value = dict[node.dataset.i18nTitle];
        if (value != null) node.title = value;
    });
}
window.applyI18n = applyI18n;

function setLanguage(lang) {
    window.currentLang = lang;

    // An unknown language must not throw: every lookup below would dereference
    // undefined and take the whole boot sequence with it.
    const dict = (window.translations && window.translations[lang]) || (window.translations && window.translations.en) || {};
    applyI18n(dict);

    if (el('search-box')) el('search-box').placeholder = dict.searchPlaceholder;

    if (el('loading-text')) el('loading-text').innerText = dict.scanning;

    if (el('settings-btn-text')) el('settings-btn-text').innerText = dict.settings;
    const sHeader = document.querySelector('.settings-panel-header');
    if (sHeader) sHeader.innerText = dict.settings;
    if (el('glob-exclusions-label')) el('glob-exclusions-label').innerText = dict.globExclusionsLabel;
    if (el('settings-btn-save')) el('settings-btn-save').innerText = dict.save;
    if (el('label-mute-previews')) el('label-mute-previews').innerText = dict.mutePreviews;

    // Translate top-level application navigation tabs
    const iconStyle = "width:13px; height:13px; flex-shrink:0;";
    if (el('tab-library')) el('tab-library').innerHTML = `${window.icons ? window.icons.library('tab-icon', iconStyle) : ''}${dict.tabLibrary}`;
    if (el('tab-tmdb')) el('tab-tmdb').innerHTML = `${window.icons ? window.icons.filmRoll('tab-icon', iconStyle) : ''}${dict.tabMoviesSeries}`;

    // Translate TMDB subtabs
    if (el('subtab-movies')) el('subtab-movies').innerText = dict.tabMovies;
    if (el('subtab-series')) el('subtab-series').innerText = dict.tabSeries;

    if (!window.currentRealPath && el('path-display')) {
        el('path-display').innerText = dict.noFolderSelected;
    }

    const emptyStateH3 = document.querySelector('#file-grid .empty-state h3');
    const emptyStateP = document.querySelector('#file-grid .empty-state p');
    const emptyStateBtn = document.querySelector('#file-grid .empty-state button');
    if (emptyStateH3) emptyStateH3.innerText = dict.vaultEmpty;
    if (emptyStateP) emptyStateP.innerText = dict.clickBrowse;
    if (emptyStateBtn) emptyStateBtn.innerText = dict.browseVault;

    if (typeof window.updateStatusBar === 'function') window.updateStatusBar();
}

function updateSortOrderButtonUI() {
    const btn = el('btn-sort-order');
    if (!btn) return; // sort controls removed with the local vault UI
    const order = btn.dataset.order || 'desc';
    const lang = window.currentLang || 'en';
    const dict = (window.translations && window.translations[lang]) || {};
    if (order === 'asc') {
        btn.innerHTML = window.icons ? window.icons.arrowUp('', 'width:14px; height:14px;') : '';
        btn.title = dict.ascending;
    } else {
        btn.innerHTML = window.icons ? window.icons.arrowDown('', 'width:14px; height:14px;') : '';
        btn.title = dict.descending;
    }
}

// ── Master Entrypoint ─────────────────────────────────────────────
async function initApp() {
    // Setup mock API fallback for standard browsers
    if (!window.electronAPI) {
        window.electronAPI = {
            openDirectory: async () => 'C:\\MockVault',
            scanDirectory: async (dirPath) => [
                { path: 'C:\\MockVault\\Sample Video.mp4', name: 'Sample Video.mp4', type: 'video', thumbnail: 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=400&q=80', hoverWebm: '', duration: 120, size: 104857600, mtime: Date.now(), mtimeFormatted: '2026-05-18 12:00' },
                { path: 'C:\\MockVault\\Stunning View.jpg', name: 'Stunning View.jpg', type: 'image', thumbnail: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=400&q=80', hoverWebm: '', size: 2048576, mtime: Date.now() - 3600000, mtimeFormatted: '2026-05-18 11:00' }
            ],
            scanSpecificFiles: async (arr) => [],
            getEverythingSize: async (dirPath) => 1073741824,
            getTrickplaySprites: async (folder) => [],
            getFileSize: async (p) => 1073741824,
            openFile: async (filePath) => console.log('Mock Open File:', filePath),
            showInFolder: async (filePath) => console.log('Mock Show In Folder:', filePath),
            copyToClipboard: async (text) => console.log('Mock Copy:', text),
            showContextMenu: async (item) => 'opened',
            generateWebm: async (p, vaultRoot) => ({ success: true, path: p + '.webm' }),
            upscaleVideo: async (p) => ({ success: true, path: p }),
            renameFile: async (oldPath, newName) => ({ success: true }),
            deleteItem: async (p) => ({ success: true }),
            getFolderSizeBackground: async (dirPath) => 1073741824,
            getSettings: async () => ({ folders: [], theme: 'golden-slate', lang: 'en' }),
            saveSettings: async (s) => console.log('Mock Save Settings:', s),
            findSubtitles: async (p) => [],
            onWebmProgress: (cb) => { },
            onNormalizeProgress: (cb) => { },
            offNormalizeProgress: () => { },
            offUpscaleChunk: () => { },
            offUpscaleStatus: () => { },
            onUpscaleStatus: (cb) => { },
            onUpscaleChunk: (cb) => { },
            startUpscaleStream: async () => ({ success: true }),
            stopUpscaleStream: () => { },
            encryptFiles: async () => ({ success: true }),
            decryptFiles: async () => ({ success: true }),
            pasteFiles: async () => ({ success: true }),
            zipSelection: async () => ({ success: true }),
            getFileProperties: async () => ({ success: true, properties: {} })
        };
    }

    window.appSettings = await window.electronAPI.getSettings();
    // One-shot migration: legacy {folders,folderContents} -> stable-id virtualFolders.
    // Safe no-op if already migrated.
    if (window.vf && typeof window.vf.migrateLegacy === 'function') {
        try { window.vf.migrateLegacy(); } catch (e) { console.error('[app] vf.migrateLegacy failed:', e); }
    }
    // Ensure default virtual folders are always present
    if (window.vf && typeof window.vf.ensureDefaultFavorites === 'function') {
        try { window.vf.ensureDefaultFavorites(); } catch (e) { console.error('[app] vf.ensureDefaultFavorites failed:', e); }
    }
    if (window.vf && typeof window.vf.syncFavorites === 'function') {
        try { window.vf.syncFavorites(); } catch (e) { console.error('[app] vf.syncFavorites failed:', e); }
    }
    if (window.appSettings.mutePreviews === undefined) window.appSettings.mutePreviews = false;
    if (!window.appSettings.lastPath) window.appSettings.lastPath = { navPath: 'root', realPath: '' };
    if (!window.appSettings.scrollPositions) window.appSettings.scrollPositions = {};

    window.scrollPositions = window.appSettings.scrollPositions;

    const subSize = window.appSettings.subFontSize || '20px';
    document.documentElement.style.setProperty('--sub-font-size', subSize);

    // Theme switching was removed — the single console shell is applied
    // statically via <body class="vw-console-shell"> in index.html, so no
    // theme select population or applyTheme()/initThemeGrid() call is needed
    // (all were deleted with theme.js). Calling them here aborted initApp().

    const preferredLang = window.appSettings.lang || window.appSettings.defaultLang || 'en';
    if (preferredLang && (preferredLang === 'en' || preferredLang === 'fr')) {
        setLanguage(preferredLang);
    } else {
        setLanguage('en');
    }

    // Initialize player, settings, tab clicks, keybindings, and TMDB search.
    // Local-vault modules (navigation/directory) were removed — guard each init.
    if (typeof window.initPlayer === 'function') window.initPlayer();
    if (typeof window.initSettingsListeners === 'function') window.initSettingsListeners();
    if (typeof window.initTabListeners === 'function') window.initTabListeners();
    if (typeof window.initNavigationListeners === 'function') window.initNavigationListeners();
    if (typeof window.initKeybindingsAndFolderListeners === 'function') window.initKeybindingsAndFolderListeners();
    if (typeof window.initTMDBListeners === 'function') window.initTMDBListeners();

    // ── WebM Real-time Progress Tracking ─────────────────────────────────────
    window.electronAPI.onWebmProgress((data) => {
        if (!data) return;

        const badge = el('task-badge');
        const pctText = el('task-percent');

        // Handle Batch Preview Generation Progress
        if (data.isBatchStart || data.isBatchProgress || data.isBatchComplete) {
            if (badge) {
                badge.style.display = 'inline-flex';
                const total = data.total || 0;
                const completed = data.completed || 0;
                const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
                if (pctText) {
                    pctText.innerText = `${completed}/${total} (${pct}%)`;
                }
                // Hide badge when batch is complete, has error, or is invalid
                if (data.isBatchComplete || (completed >= total && total > 0)) {
                    setTimeout(() => {
                        if (badge) badge.style.display = 'none';
                    }, 2000);
                }
                // Also hide if there's an error or completion without total
                if (data.error || (data.completed > 0 && total === 0)) {
                    setTimeout(() => {
                        if (badge) badge.style.display = 'none';
                    }, 3000);
                }
            }
            return;
        }

        // Handle Single Video Preview Generation
        if (data.videoPath) {
            const { videoPath, percent } = data;
            const normPath = (p) => (p || '').replace(/\\/g, '/').toLowerCase();
            const card = Array.from(document.querySelectorAll('.file-card'))
                .find(c => normPath(c.dataset.path) === normPath(videoPath));

            if (card) {
                let overlay = card.querySelector('.webm-loading-overlay');
                if (percent < 100) {
                    if (!overlay) {
                        overlay = document.createElement('div');
                        overlay.className = 'webm-loading-overlay';
                        overlay.innerHTML = `<div class="spinner-small"></div><div class="webm-percent" style="margin-top:4px; font-size:10px;">0%</div>`;
                        const thumbCont = card.querySelector('.thumbnail-container');
                        if (thumbCont) thumbCont.appendChild(overlay);
                    }
                    const overlayPctText = overlay.querySelector('.webm-percent');
                    if (overlayPctText) overlayPctText.innerText = `${percent}%`;
                } else {
                    if (overlay) overlay.remove();
                    if (data.hoverWebm) {
                        card.dataset.hasWebm = "true";
                        const idx = parseInt(card.dataset.index);
                        if (window.displayedItems[idx]) {
                            window.displayedItems[idx].hoverWebm = data.hoverWebm;
                        }
                        window.attachHoverWebmToCard(card, data.hoverWebm);
                    }
                    if (data.thumbnail) {
                        card.dataset.hasThumb = "true";
                        const idx = parseInt(card.dataset.index);
                        if (window.displayedItems[idx]) {
                            window.displayedItems[idx].thumbnail = data.thumbnail;
                        }
                        const imgEl = card.querySelector('img.thumbnail');
                        if (imgEl) {
                            imgEl.src = window.sanitizePath(data.thumbnail);
                        }
                    }
                    window.showToast('Preview generated and loaded!', 'success');
                }
            }

            if (badge) {
                if (percent < 100) {
                    badge.style.display = 'inline-flex';
                    if (pctText) pctText.innerText = `${percent}%`;
                } else {
                    badge.style.display = 'none';
                }
            }
        }
    });

    // 🔊 Audio Normalization Real-time Progress Tracking
    if (window.electronAPI && typeof window.electronAPI.onNormalizeProgress === 'function') {
        window.electronAPI.onNormalizeProgress((data) => {
            if (!data) return;
            const badge = el('task-badge');
            const pctText = el('task-percent');
            if (!badge) return;

            badge.style.display = 'inline-flex';

            // Get the label span (second child span)
            const labelSpan = badge.querySelector('span:nth-child(2)');
            if (labelSpan) {
                const label = data.label || (window.currentLang === 'fr' ? 'Normalisation' : 'Normalization');
                labelSpan.innerHTML = `${label}: <span id="task-percent">${data.percent}%</span>`;
            } else if (pctText) {
                pctText.innerText = `${data.percent}%`;
            }

            if (data.percent >= 100 || data.error) {
                setTimeout(() => {
                    badge.style.display = 'none';
                    // Restore original text just in case
                    if (labelSpan) {
                        labelSpan.innerHTML = `Generating Previews: <span id="task-percent">0%</span>`;
                    }
                }, 3000);
            }
        });
    }

    // Focus Lost (Window Blur) -> Pause hover webms cleanly
    window.addEventListener('blur', () => {
        console.log('[window] Blur focus lost: pausing previews.');
        if (window.killAllHoverVideos) {
            window.killAllHoverVideos();
        }
        document.querySelectorAll('.file-card').forEach(card => {
            const mainImg = card.querySelector('.thumbnail');
            if (mainImg) mainImg.style.display = 'block';
        });
    });

    // Failsafe: Clear task badge after 5 minutes to prevent stuck messages
    setInterval(() => {
        const badge = el('task-badge');
        if (badge && badge.style.display === 'inline-flex') {
            // Only clear if no active progress is happening
            const loadingEl = el('loading');
            if (loadingEl && loadingEl.style.display === 'none') {
                console.log('[cleanup] Clearing stuck task badge');
                badge.style.display = 'none';
            }
        }
    }, 5 * 60 * 1000);

    // Warm the live-subtitle daemon behind the splash so the model is loaded
    // by the time the user opens the player. Only preloads if the model is
    // already on disk — no surprise 2.5 GB download on launch.
    if (window.electronAPI && typeof window.electronAPI.warmLiveSubtitles === 'function') {
        window.electronAPI.warmLiveSubtitles().catch(() => { /* daemon warm-up is best-effort */ });
    }

    // Boot straight into Discover — must run AFTER initTMDBListeners so the
    // TMDB state (providers, search) is initialized before the first render.
    if (typeof window.switchStreamingSubtab === 'function') {
        window.switchStreamingSubtab('discover');
    }

}

// Kickstart app when page loads
document.addEventListener('DOMContentLoaded', initApp);

// Bind i18n setter
window.setLanguage = setLanguage;
window.updateSortOrderButtonUI = updateSortOrderButtonUI;
