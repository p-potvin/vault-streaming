/* ==========================================================================
   Vault Explorer — Keyboard Hotkeys & Virtual Folder Dialog
   ========================================================================== */

window.initKeybindingsAndFolderListeners = function() {
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

    // Create fake virtual folders dialog setup
    const btnNewFolder = el('btn-new-folder');
    const inputFolderName = el('fake-folder-name');
    const folderDialog = el('fake-folder-dialog');
    const btnCancelFolder = el('btn-cancel-folder');
    const btnCreateFolder = el('btn-create-folder');

    if (btnNewFolder && inputFolderName && folderDialog && btnCancelFolder && btnCreateFolder) { 
        btnNewFolder.addEventListener('click', () => {
            folderDialog.style.display = 'block';
            inputFolderName.value = '';
            btnCreateFolder.disabled = true;
            btnCreateFolder.title = "Folder name cannot be empty";
            // Pre-select folder type based on the active subtab
            const typeEl = el('fake-folder-type');
            if (typeEl) {
                const sub = window.currentFilesSubtab || 'all';
                if (sub === 'albums') typeEl.value = 'album';
                else if (sub === 'playlists') typeEl.value = 'playlist';
                else typeEl.value = 'collection';
            }
            inputFolderName.focus();
        });

        inputFolderName.addEventListener('input', (e) => {
            const hasValue = e.target.value.trim().length > 0;
            btnCreateFolder.disabled = !hasValue;
            btnCreateFolder.title = hasValue ? "" : "Folder name cannot be empty";
        });

        btnCancelFolder.addEventListener('click', () => {
            folderDialog.style.display = 'none';
            inputFolderName.value = '';
            btnNewFolder.focus();
        });

        btnCreateFolder.addEventListener('click', () => {
            const name = inputFolderName.value.trim();
            if (!name) return;
            const typeEl = el('fake-folder-type');
            const type = typeEl ? typeEl.value : 'collection';
            const res = window.vf.create({ name, type, parentId: window.currentFolderId || null });
            if (!res.ok) { window.showToast(res.error || 'Failed to create folder', 'error'); return; }
            folderDialog.style.display = 'none';
            inputFolderName.value = '';
            window.applyFilters();
            btnNewFolder.focus();
        });

        inputFolderName.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (!btnCreateFolder.disabled) {
                    btnCreateFolder.click();
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                btnCancelFolder.click();
            }
        }); 
    }

    // Setup add-to-folder dialog cancel/confirm buttons
    const btnCancelAddToFolder = el('btn-cancel-add-to-folder');
    const btnConfirmAddToFolder = el('btn-confirm-add-to-folder');
    const addToFolderDialog = el('add-to-folder-dialog');
    const selectAddToFolder = el('add-to-folder-select');

    if (btnCancelAddToFolder && btnConfirmAddToFolder && addToFolderDialog && selectAddToFolder) {
        btnCancelAddToFolder.addEventListener('click', () => {
            addToFolderDialog.style.display = 'none';
        });
        
        btnConfirmAddToFolder.addEventListener('click', () => {
            const folderId = selectAddToFolder.value;
            if (!folderId || !window.itemToAssign) return;
            const folder = window.vf.get(folderId);
            if (!folder) { window.showToast('Folder not found', 'error'); return; }
            const res = window.vf.addItems(folderId, [window.itemToAssign]);
            if (res.added) {
                window.showToast(window.currentLang === 'fr' ? 'Ajouté avec succès' : 'Successfully added to virtual folder', 'success');
            } else if (res.rejected) {
                const want = folder.type === 'album' ? 'images' : folder.type === 'playlist' ? 'audio files' : 'videos';
                window.showToast(`"${folder.name}" only accepts ${want}`, 'error');
            } else {
                window.showToast(window.currentLang === 'fr' ? 'Ce fichier est déjà dans ce dossier' : 'This file is already in this folder', 'info');
            }
            addToFolderDialog.style.display = 'none';
            window.applyFilters();
        });
    }

    window.showAddToFolderDialog = function(item) {
        const dialog = el('add-to-folder-dialog');
        const filenameEl = el('add-to-folder-dialog-filename');
        const selectEl = el('add-to-folder-select');

        if (!dialog || !selectEl || !filenameEl) return;

        window.itemToAssign = item;
        filenameEl.innerText = item.name;

        // Resolve the expected folder type for this item once and ask vf for matches.
        const expectedType = (item.type === 'image') ? 'album'
                          : (item.type === 'audio') ? 'playlist'
                          : 'collection';
        const matchingFolders = window.vf.list({ type: expectedType });

        selectEl.innerHTML = '';
        if (matchingFolders.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            const defaultLabel = expectedType === 'collection' ? 'Create a Collection first' : expectedType === 'album' ? 'Create an Album first' : 'Create a Playlist first';
            option.innerText = `(${defaultLabel})`;
            selectEl.appendChild(option);
            btnConfirmAddToFolder.disabled = true;
        } else {
            matchingFolders.forEach(f => {
                const option = document.createElement('option');
                option.value = f.id; // stable id, not name
                const parentLabel = f.parentId ? `${window.buildNavPath(f.parentId).replace(/^root\/?/, '')}/` : '';
                option.innerText = `${parentLabel}${f.name} (${f.type})`;
                selectEl.appendChild(option);
            });
            btnConfirmAddToFolder.disabled = false;
        }

        dialog.style.display = 'block';
    };

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
        
        // Find / Search
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            const sb = el('search-box');
            if (sb) {
                sb.focus();
                sb.select();
            }
        } 
        // Select All
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
            e.preventDefault();
            if (window.selectedIndices && window.displayedItems) {
                window.selectedIndices.clear();
                window.displayedItems.forEach((_, i) => window.selectedIndices.add(i));
                document.querySelectorAll('.file-card').forEach(c => {
                    c.classList.add('selected');
                    const cb = c.querySelector('.file-checkbox');
                    if (cb) cb.checked = true;
                });
                window.updateStatusBar();
            }
        } 
        // Rename (F2)
        else if (e.key === 'F2') {
            if (window.selectedIndices && window.selectedIndices.size === 1) {
                e.preventDefault();
                const idx = Array.from(window.selectedIndices)[0];
                const card = document.querySelector(`.file-card[data-index="${idx}"]`);
                if (card) {
                    const inp = card.querySelector('.rename-input');
                    const fn = card.querySelector('.filename');
                    if (inp && fn) {
                        inp.style.display = 'block';
                        fn.style.display = 'none';
                        inp.focus();
                        inp.select();
                    }
                }
            }
        } 
        // Copy (Ctrl+C) — skip when video player is open to avoid file manager side effects
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
            const playerOpen = el('video-modal') && el('video-modal').style.display === 'flex';
            if (playerOpen) return; // Let browser handle native text copy inside player
            if (window.selectedIndices && window.selectedIndices.size > 0) {
                e.preventDefault();
                window._clipboard = { paths: [], mode: 'copy' };
                window.selectedIndices.forEach(idx => {
                    const si = window.displayedItems[idx];
                    if (si && si.path) window._clipboard.paths.push(si.path);
                });
                window.showToast(`Copied ${window._clipboard.paths.length} item(s)`, 'success');
            }
        } 
        // Cut (Ctrl+X)
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
            if (window.selectedIndices && window.selectedIndices.size > 0) {
                e.preventDefault();
                window._clipboard = { paths: [], mode: 'cut' };
                window.selectedIndices.forEach(idx => {
                    const si = window.displayedItems[idx];
                    if (si && si.path) window._clipboard.paths.push(si.path);
                });
                window.showToast(`Cut ${window._clipboard.paths.length} item(s)`, 'success');
            }
        } 
        // Paste (Ctrl+V)
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
            if (window._clipboard && window._clipboard.paths.length > 0) {
                e.preventDefault();
                (async () => {
                    const res = await window.electronAPI.pasteFiles({
                        paths: window._clipboard.paths,
                        mode: window._clipboard.mode,
                        destination: window.currentRealPath
                    });
                    if (res.success) {
                        window.showToast(`Pasted ${res.count} file(s)`, 'success');
                        if (window.currentFolderId && Array.isArray(res.pastedPaths)) {
                            window.vf.addItems(window.currentFolderId, res.pastedPaths);
                        }
                        if (window._clipboard.mode === 'cut') window._clipboard = { paths: [], mode: 'copy' };
                        if (window.currentFolderId) {
                            window.navigateTo(window.currentFolderId, window.currentRealPath);
                        } else {
                            window.loadDirectory(window.currentNavPath, window.currentRealPath, false);
                        }
                    } else {
                        window.showToast('Paste failed: ' + res.error, 'error');
                    }
                })();
            }
        } 
        // Delete (Delete)
        else if (e.key === 'Delete') {
            if (window.selectedIndices && window.selectedIndices.size > 0) {
                e.preventDefault();
                const itemsToDelete = Array.from(window.selectedIndices).map(idx => window.displayedItems[idx]).filter(Boolean);
                if (itemsToDelete.length > 0) {
                    const names = itemsToDelete.map(i => i.name).join(', ');
                    const isVirtual = window.currentNavPath !== 'root';
                    const confirmTitle = isVirtual 
                        ? (window.currentLang === 'fr' ? 'Confirmer le retrait' : 'Confirm Bulk Removal')
                        : (window.currentLang === 'fr' ? 'Confirmer la suppression' : 'Confirm Bulk Deletion');
                    const confirmMsg = isVirtual
                        ? (window.currentLang === 'fr' ? `Retirer les éléments sélectionnés de ce dossier : ${names} ?` : `Remove selected item(s) from this folder: ${names}?`)
                        : `Delete selected item(s): ${names}?`;
                        
                    if (await window.showConfirmDialog(confirmMsg, confirmTitle)) {
                        (async () => {
                            let successCount = 0;
                            const folderItems = itemsToDelete.filter(i => i.type === 'fakeFolder');
                            const fileItems = itemsToDelete.filter(i => i.type !== 'fakeFolder');

                            // Folders: vf.remove cascades to descendants + their items.
                            for (const it of folderItems) {
                                if (window.vf.remove(it.id)) successCount++;
                            }

                            if (isVirtual && window.currentFolderId && fileItems.length) {
                                successCount += window.vf.removeItems(window.currentFolderId, fileItems.map(i => i.path).filter(Boolean));
                            } else if (!isVirtual) {
                                for (const it of fileItems) {
                                    const res = await window.electronAPI.deleteItem(it.path);
                                    if (res.success) {
                                        window.allItems = window.allItems.filter(i => i.path !== it.path);
                                        successCount++;
                                    }
                                }
                            }

                            if (successCount > 0) {
                                window.showToast(isVirtual ? `Removed ${successCount} item(s)` : `Deleted ${successCount} item(s)`, 'success');
                                if (!isVirtual && typeof window.invalidateRootCache === 'function') window.invalidateRootCache();
                                window.applyFilters();
                            }
                        })();
                    }
                }
            }
        } 
        // New Folder (Ctrl+N)
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
            e.preventDefault();
            const btn = document.getElementById('btn-new-folder');
            if (btn && !btn.disabled) btn.click();
        }
    });
};
