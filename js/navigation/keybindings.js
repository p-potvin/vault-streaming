/* ==========================================================================
   Vault Explorer — Keyboard Hotkeys & Virtual Folder Dialog
   ========================================================================== */

window.initKeybindingsAndFolderListeners = function () {
    console.log('[navigation] Initializing hotkeys and folder dialog setup listeners...');

    // Language switcher trigger click listener
    const langTrigger = el('lang-trigger');
    if (langTrigger) {
        langTrigger.addEventListener('click', () => {
            const nextLang = window.currentLang === 'en' ? 'fr' : 'en';
            window.setLanguage(nextLang);
            if (window.appSettings) {
                window.appSettings.lang = nextLang;
                window.electronAPI.saveSettings(window.appSettings);
            }
        });
    }

    // Refresh directory hotkey (F5)
    document.addEventListener('keydown', async (e) => {
        if (e.key === 'F5') {
            e.preventDefault();
            if (window.currentRealPath) {
                console.log('[F5] Refreshing directory:', window.currentRealPath);
                window.loadDirectory(window.currentNavPath, window.currentRealPath, false);
                window.showToast('Views refreshed successfully', 'success');
            }
        }
    });

    // Global shortcut keys (F2 rename, select all, copy, paste, delete, new folder)
    document.addEventListener('keydown', async (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        // Escape Key Back Navigation
        if (e.key === 'Escape') {
            const playerOpen = el('video-modal') && el('video-modal').style.display === 'flex';
            const dialogsOpen = Array.from(document.querySelectorAll('[role="dialog"], .modal')).some(d => d.style.display === 'flex' || d.style.display === 'block');
            if (!playerOpen && !dialogsOpen) {
                e.preventDefault();
                const backBtn = el('btn-back');
                if (backBtn && !backBtn.disabled) {
                    backBtn.click();
                }
            }
        }

        // Arrow Keys Grid Navigation
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
            const activeGrid = document.querySelector('.file-grid:not([style*="display: none"])') || document.querySelector('#file-grid');
            if (activeGrid) {
                const cards = Array.from(activeGrid.querySelectorAll('.file-card'));
                if (cards.length > 0) {
                    let nextIdx = -1;
                    const currentIdx = cards.indexOf(document.activeElement);

                    if (currentIdx === -1) {
                        nextIdx = 0;
                    } else {
                        let cols = 0;
                        const firstCardTop = cards[0].getBoundingClientRect().top;
                        for (let i = 0; i < cards.length; i++) {
                            if (Math.abs(cards[i].getBoundingClientRect().top - firstCardTop) > 5) {
                                cols = i;
                                break;
                            }
                        }
                        if (cols === 0) cols = cards.length;

                        if (e.key === 'ArrowLeft') {
                            nextIdx = currentIdx - 1;
                        } else if (e.key === 'ArrowRight') {
                            nextIdx = currentIdx + 1;
                        } else if (e.key === 'ArrowUp') {
                            nextIdx = currentIdx - cols;
                        } else if (e.key === 'ArrowDown') {
                            nextIdx = currentIdx + cols;
                        }
                    }

                    if (nextIdx >= 0 && nextIdx < cards.length) {
                        e.preventDefault();
                        cards[nextIdx].focus();

                        if (window.selectedIndices) {
                            window.selectedIndices.clear();
                            window.selectedIndices.add(nextIdx);
                            window.lastSelectedIndex = nextIdx;
                            document.querySelectorAll('.file-card').forEach(c => {
                                const isSel = window.selectedIndices.has(parseInt(c.dataset.index));
                                c.classList.toggle('selected', isSel);
                                const cb = c.querySelector('.file-checkbox');
                                if (cb) cb.checked = isSel;
                            });
                            window.updateStatusBar();
                        }
                    }
                }
            }
        }
    });
};
