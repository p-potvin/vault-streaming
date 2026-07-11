// card-events.js — handles card context menu triggers, file copy/cut/paste/delete pipelines, subtitles, VSR upscaling, and crypto prompts.

// Helper to update a single video card after AI processing
async function updateSingleVideoCard(videoPath) {
    const normPath = (p) => (p || '').replace(/\\/g, '/').toLowerCase();
    const normalizedPath = normPath(videoPath);
    
    // Find the card by path
    const card = Array.from(document.querySelectorAll('.file-card'))
        .find(c => normPath(c.dataset.path) === normalizedPath);
    
    if (card) {
        const index = parseInt(card.dataset.index);
        // Re-scan this specific file to get updated metadata
        try {
            const newItems = await window.electronAPI.scanSpecificFiles([videoPath]);
            if (newItems && newItems.length > 0) {
                const newItem = newItems[0];
                
                // Update window.allItems
                const existingIndex = window.allItems.findIndex(i => normPath(i.path) === normalizedPath);
                if (existingIndex !== -1) {
                    window.allItems[existingIndex] = newItem;
                } else {
                    window.allItems.push(newItem);
                }
                
                // Update window.displayedItems
                const displayedIndex = window.displayedItems.findIndex(i => normPath(i.path) === normalizedPath);
                if (displayedIndex !== -1) {
                    window.displayedItems[displayedIndex] = newItem;
                    // Re-render just this card
                    card.replaceWith(window.createCardElement(newItem, displayedIndex));
                } else {
                    // If not in displayed items, trigger a filter refresh
                    window.applyFilters();
                }
            }
        } catch (e) {
            console.error('[AI] Failed to update card:', e);
            // Fallback to full refresh
            refreshDirectoryWithScrollPreservation();
        }
    } else {
        // Card not found, fallback to full refresh
        refreshDirectoryWithScrollPreservation();
    }
}

// Helper to save and restore scroll position during directory refresh
function refreshDirectoryWithScrollPreservation() {
    const mainArea = el('main-area');
    const scrollTop = mainArea ? mainArea.scrollTop : 0;
    window.loadDirectory(window.currentNavPath, window.currentRealPath, false);
    // Restore scroll position after the directory loads
    setTimeout(() => {
        if (mainArea) mainArea.scrollTop = scrollTop;
    }, 100);
}

async function handleCardContextMenu(card, item, index) {
    if (!window.selectedIndices.has(index)) {
        window.selectedIndices.clear();
        window.selectedIndices.add(index);
        document.querySelectorAll('.file-card').forEach(c => {
            const isSel = window.selectedIndices.has(parseInt(c.dataset.index));
            c.classList.toggle('selected', isSel);
            c.querySelector('.file-checkbox').checked = isSel;
        });
        window.updateStatusBar();
    }
    
    const selectedItems = [];
    window.selectedIndices.forEach(idx => {
        const si = window.displayedItems[idx];
        if (si) selectedItems.push(si);
    });
    const isMulti = selectedItems.length > 1;

    const hasClip = !!(window._clipboard && window._clipboard.paths.length > 0);
    const isStarred = !!(window.appSettings && window.appSettings.favorites && window.appSettings.favorites.includes(item.path));
    // Project vf folders into the {name, parent, type} shape the native menu
    // expects, but tag each with an id so the action handler resolves by id (not name).
    const folderMenuList = (window.vf ? window.vf.list({}) : []).map(f => ({
        id: f.id,
        name: f.name,
        type: f.type,
        parent: f.parentId ? window.buildNavPath(f.parentId) : 'root',
        label: f.parentId
            ? `${window.buildNavPath(f.parentId).replace(/^root\/?/, '')}/${f.name} (${f.type})`
            : `${f.name} (${f.type})`,
    }));
    const action = await window.electronAPI.showContextMenu({
        ...item,
        _hasClipboard: hasClip,
        isFavorite: isStarred,
        isMultiSelect: isMulti,
        selectedItems: selectedItems,
        folders: folderMenuList
    });
    console.log('[ctx-menu] action:', action, 'item:', item.name);

    if (action && action.startsWith('add-to-folder:')) {
        const folderId = action.substring('add-to-folder:'.length);
        const folder = window.vf.get(folderId);
        if (!folder) { window.showToast('Folder not found', 'error'); return; }
        const res = window.vf.addItems(folderId, selectedItems);
        if (res.added > 0) {
            window.showToast(`Added ${res.added} item(s) to "${folder.name}"`, 'success');
            window.applyFilters();
        } else if (res.rejected > 0) {
            const want = folder.type === 'album' ? 'images' : folder.type === 'playlist' ? 'audio files' : 'videos';
            window.showToast(`"${folder.name}" only accepts ${want}`, 'error');
        } else {
            window.showToast('Selected item(s) already in this folder', 'info');
        }
        return;
    }

    if (action === 'toggle-favorite') {
        if (isMulti) {
            selectedItems.forEach(si => {
                if (si && si.path) window.toggleFavorite(si.path, null, true);
            });
            window.showToast('Favorites updated for selection', 'success');
        } else {
            window.toggleFavorite(item.path);
        }
    } else if (action === 'generate-webm') {
        const targetVideos = isMulti ? selectedItems.filter(s => s.type === 'video') : [item];
        if (targetVideos.length === 0) {
            window.showToast('No videos selected', 'error');
            return;
        }

        targetVideos.forEach(v => {
            const normPath = (p) => (p || '').replace(/\\/g, '/').toLowerCase();
            const cardElement = Array.from(document.querySelectorAll('.file-card'))
                .find(c => normPath(c.dataset.path) === normPath(v.path));
            if (cardElement) {
                let overlay = cardElement.querySelector('.webm-loading-overlay');
                if (!overlay) {
                    overlay = document.createElement('div');
                    overlay.className = 'webm-loading-overlay';
                    overlay.innerHTML = `<div class="spinner-small"></div><div class="webm-percent" style="margin-top:4px; font-size:10px;">Queue...</div>`;
                    const thumbCont = cardElement.querySelector('.thumbnail-container');
                    if (thumbCont) thumbCont.appendChild(overlay);
                }
            }
        });

        if (isMulti) {
            window.showToast(`Queued ${targetVideos.length} previews for background generation`, 'success');
            window.electronAPI.scheduleIdlePreviews(targetVideos);
        } else {
            console.log('[ctx-menu:generate-webm] Generating preview for:', item.path);
            window.electronAPI.generateWebm(item.path, window.currentRealPath).then(async res => {
                const normPath = (p) => (p || '').replace(/\\/g, '/').toLowerCase();
                const cardElement = Array.from(document.querySelectorAll('.file-card'))
                    .find(c => normPath(c.dataset.path) === normPath(item.path));
                if (cardElement) {
                    const overlay = cardElement.querySelector('.webm-loading-overlay');
                    if (overlay) overlay.remove();
                }
                if (!res.success) {
                    window.showToast('Preview failed: ' + res.error, 'error');
                } else {
                    await updateSingleVideoCard(item.path);
                }
            });
        }
    } else if (action === 'normalize-audio' || action === 'normalize-audio-transcribe') {
        const transcribe = (action === 'normalize-audio-transcribe');
        const targetItems = isMulti ? selectedItems.filter(s => s.type === 'video') : [item];
        if (targetItems.length === 0) { window.showToast('No videos selected', 'error'); return; }
        
        window.showToast(transcribe 
            ? `Vocal isolation, normalization & AI transcription started for ${targetItems.length} video(s)...`
            : `Vocal isolation & normalization started in background for ${targetItems.length} video(s)...`, 'success');
            
        targetItems.forEach(targetItem => {
            const normPath = (p) => (p || '').replace(/\\/g, '/').toLowerCase();
            const cardElement = Array.from(document.querySelectorAll('.file-card'))
                .find(c => normPath(c.dataset.path) === normPath(targetItem.path));
            let overlay = null;
            if (cardElement) {
                overlay = cardElement.querySelector('.webm-loading-overlay');
                if (!overlay) {
                    overlay = document.createElement('div');
                    overlay.className = 'webm-loading-overlay';
                    overlay.innerHTML = `<div class="spinner-small" style="border-top-color:#e056fd;"></div><div class="webm-percent" style="margin-top:4px; font-size:10px; color:#e056fd;">0%</div><div class="normalize-lbl" style="font-size:8px; opacity:0.8; text-align:center; padding:0 4px; margin-top:2px;">Initializing...</div>`;
                    const thumbCont = cardElement.querySelector('.thumbnail-container');
                    if (thumbCont) thumbCont.appendChild(overlay);
                }
            }

            const progressHandler = (eventData) => {
                if (normPath(eventData.videoPath) === normPath(targetItem.path)) {
                    if (overlay) {
                        const pctEl = overlay.querySelector('.webm-percent');
                        if (pctEl) pctEl.innerText = `${eventData.percent}%`;
                        const lblEl = overlay.querySelector('.normalize-lbl');
                        if (lblEl) lblEl.innerText = eventData.label || 'Processing...';
                    }
                }
            };

            window.electronAPI.onNormalizeProgress(progressHandler);

            window.electronAPI.normalizeAudio(targetItem.path, window.currentRealPath, transcribe).then(res => {
                if (overlay) overlay.remove();
                if (res.status === 'SUCCESS' || res.status === 'EXISTS') {
                    window.showToast(`${targetItem.name}: Isolated successfully!`, 'success');
                } else {
                    window.showToast(`${targetItem.name}: Isolation failed: ` + (res.error || 'Unknown error'), 'error');
                }
            });
        });
    } else if (action === 'upscale-video') {
        const targetItems = isMulti ? selectedItems.filter(s => s.type === 'video') : [item];
        if (targetItems.length === 0) { window.showToast('No videos selected', 'error'); return; }
        const missingPath = targetItems.find(t => !t || !t.path);
        if (missingPath) {
            console.error('[ctx-menu:upscale] Missing target item path:', missingPath);
            window.showToast('Cannot upscale: missing file path', 'error');
            return;
        }
        console.log('[ctx-menu:upscale] Upscaling paths:', targetItems.map(t => t.path));

        window.showToast(`AI Video Upscaling started in background for ${targetItems.length} video(s)...`, 'success');
        
        targetItems.forEach(targetItem => {
            const normPath = (p) => (p || '').replace(/\\/g, '/').toLowerCase();
            const cardElement = Array.from(document.querySelectorAll('.file-card'))
                .find(c => normPath(c.dataset.path) === normPath(targetItem.path));
            let overlay = null;
            if (cardElement) {
                overlay = cardElement.querySelector('.webm-loading-overlay');
                if (!overlay) {
                    overlay = document.createElement('div');
                    overlay.className = 'webm-loading-overlay';
                    overlay.innerHTML = `<div class="spinner-small" style="border-top-color:#e056fd;"></div><div class="webm-percent" style="margin-top:4px; font-size:10px; color:#e056fd;">0%</div><div class="normalize-lbl" style="font-size:8px; opacity:0.8; text-align:center; padding:0 4px; margin-top:2px;">Upscaling...</div>`;
                    const thumbCont = cardElement.querySelector('.thumbnail-container');
                    if (thumbCont) thumbCont.appendChild(overlay);
                }
            }

            const upscaleProgressHandler = (eventData) => {
                if (normPath(eventData.videoPath) === normPath(targetItem.path)) {
                    if (overlay) {
                        const pctEl = overlay.querySelector('.webm-percent');
                        if (pctEl) pctEl.innerText = `${eventData.percent}%`;
                        const lblEl = overlay.querySelector('.normalize-lbl');
                        if (lblEl) lblEl.innerText = eventData.label || 'Upscaling...';
                    }
                }
            };

            window.electronAPI.onUpscaleProgress(upscaleProgressHandler);

            const vsrQuality = (window.appSettings && window.appSettings.vsrQuality) || 'HIGH';
            const vsrScale = (window.appSettings && window.appSettings.vsrScale) || '2';
            const vsrChroma = (window.appSettings && window.appSettings.vsrChroma) || 'yuv420p';
            window.electronAPI.upscaleVideo({ path: targetItem.path, quality: vsrQuality, scale: vsrScale, chroma: vsrChroma }).then(res => {
                if (overlay) overlay.remove();
                if (res.success) {
                    window.showToast(`${targetItem.name}: Upscaling complete!`, 'success');
                    refreshDirectoryWithScrollPreservation();
                } else {
                    window.showToast(`${targetItem.name}: Upscale failed: ` + (res.error || 'Unknown'), 'error');
                }
            });
        });
    } else if (action === 'revert-enhancements') {
        const targetItems = isMulti ? selectedItems.filter(s => s.type === 'video') : [item];
        if (targetItems.length === 0) { window.showToast('No videos selected', 'error'); return; }
        
        const confirmMsg = targetItems.length > 1
            ? `Are you sure you want to revert all enhancements for the ${targetItems.length} selected video(s)? This will delete their enhanced copies.`
            : `Are you sure you want to revert all enhancements for "${item.name}"? This will delete the enhanced copy.`;
        if (await window.showConfirmDialog(confirmMsg, 'Revert Video Enhancements')) {
            let count = 0;
            for (const targetItem of targetItems) {
                const res = await window.electronAPI.revertEnhancements(targetItem.path);
                if (res.success) count++;
            }
            window.showToast(`Reverted enhancements for ${count}/${targetItems.length} video(s)`, 'success');
            refreshDirectoryWithScrollPreservation();
        }
    } else if (action === 'generate-subtitles-prompt') {
        const targetItems = isMulti ? selectedItems.filter(s => s.type === 'video') : [item];
        if (targetItems.length === 0) { window.showToast('No videos selected', 'error'); return; }
        
        const defaultLangs = (window.appSettings && window.appSettings.preferredASRLangs) || ['en'];
        const langs = await window.showLanguageModal('Generate Subtitles', true, defaultLangs);
        if (langs && langs.length > 0) {
            if (!window.appSettings) window.appSettings = {};
            window.appSettings.preferredASRLangs = langs;
            window.electronAPI.saveSettings(window.appSettings);

            window.showToast(`Generating subtitles for ${targetItems.length} video(s): ${langs.join(', ').toUpperCase()}`, 'success');
            targetItems.forEach(targetItem => {
                const normPath = (p) => (p || '').replace(/\\/g, '/').toLowerCase();
                const cardElement = Array.from(document.querySelectorAll('.file-card'))
                    .find(c => normPath(c.dataset.path) === normPath(targetItem.path));
                let overlay = null;
                if (cardElement) {
                    overlay = cardElement.querySelector('.webm-loading-overlay');
                    if (!overlay) {
                        overlay = document.createElement('div');
                        overlay.className = 'webm-loading-overlay';
                        overlay.innerHTML = `<div class="spinner-small" style="border-top-color:#e056fd;"></div><div class="webm-percent" style="margin-top:4px; font-size:10px; color:#e056fd;">0%</div><div class="normalize-lbl" style="font-size:8px; opacity:0.8; text-align:center; padding:0 4px; margin-top:2px;">Subs: Init...</div>`;
                        const thumbCont = cardElement.querySelector('.thumbnail-container');
                        if (thumbCont) thumbCont.appendChild(overlay);
                    }
                }
                const progressHandler = (eventData) => {
                    if (normPath(eventData.videoPath) === normPath(targetItem.path)) {
                        if (overlay) {
                            const pctEl = overlay.querySelector('.webm-percent');
                            if (pctEl) pctEl.innerText = `${eventData.percent}%`;
                            const lblEl = overlay.querySelector('.normalize-lbl');
                            if (lblEl) lblEl.innerText = `Subs: ${eventData.label || 'Processing...'}`;
                        }
                    }
                };
                window.electronAPI.onNormalizeProgress(progressHandler);
                window.electronAPI.normalizeAudio(targetItem.path, window.currentRealPath, true).then(res => {
                    if (overlay) overlay.remove();
                    if (res.success || res.status === 'SUCCESS' || res.status === 'EXISTS') {
                        window.showToast(`${targetItem.name}: Subtitles generated successfully!`, 'success');
                        refreshDirectoryWithScrollPreservation();
                    } else {
                        window.showToast(`${targetItem.name}: Subtitles failed: ` + (res.error || 'Unknown'), 'error');
                    }
                });
            });
        }
    } else if (action === 'translate-video-prompt') {
        const targetItems = isMulti ? selectedItems.filter(s => s.type === 'video') : [item];
        if (targetItems.length === 0) { window.showToast('No videos selected', 'error'); return; }
        
        const defaultTransLangs = (window.appSettings && window.appSettings.preferredTransLang) ? [window.appSettings.preferredTransLang] : [];
        const lang = await window.showLanguageModal('Translate Video Track', false, defaultTransLangs);
        if (lang && lang.length > 0) {
            if (!window.appSettings) window.appSettings = {};
            window.appSettings.preferredTransLang = lang[0];
            window.electronAPI.saveSettings(window.appSettings);

            window.showToast(`Synthesizing translation to ${lang[0].toUpperCase()} for ${targetItems.length} video(s)...`, 'success');
            targetItems.forEach(targetItem => {
                const normPath = (p) => (p || '').replace(/\\/g, '/').toLowerCase();
                const cardElement = Array.from(document.querySelectorAll('.file-card'))
                    .find(c => normPath(c.dataset.path) === normPath(targetItem.path));
                let overlay = null;
                if (cardElement) {
                    overlay = cardElement.querySelector('.webm-loading-overlay');
                    if (!overlay) {
                        overlay = document.createElement('div');
                        overlay.className = 'webm-loading-overlay';
                        overlay.innerHTML = `<div class="spinner-small" style="border-top-color:#e056fd;"></div><div class="webm-percent" style="margin-top:4px; font-size:10px; color:#e056fd;">0%</div><div class="normalize-lbl" style="font-size:8px; opacity:0.8; text-align:center; padding:0 4px; margin-top:2px;">Trans: Init...</div>`;
                        const thumbCont = cardElement.querySelector('.thumbnail-container');
                        if (thumbCont) thumbCont.appendChild(overlay);
                    }
                }
                const progressHandler = (eventData) => {
                    if (normPath(eventData.videoPath) === normPath(targetItem.path)) {
                        if (overlay) {
                            const pctEl = overlay.querySelector('.webm-percent');
                            if (pctEl) pctEl.innerText = `${eventData.percent}%`;
                            const lblEl = overlay.querySelector('.normalize-lbl');
                            if (lblEl) lblEl.innerText = `Trans: ${eventData.label || 'Processing...'}`;
                        }
                    }
                };
                window.electronAPI.onNormalizeProgress(progressHandler);
                window.electronAPI.normalizeAudio(targetItem.path, window.currentRealPath, false, lang[0]).then(res => {
                    if (overlay) overlay.remove();
                    if (res.success || res.status === 'SUCCESS' || res.status === 'EXISTS') {
                        window.showToast(`${targetItem.name}: Translation complete!`, 'success');
                        refreshDirectoryWithScrollPreservation();
                    } else {
                        window.showToast(`${targetItem.name}: Translation failed: ` + (res.error || 'Unknown'), 'error');
                    }
                });
            });
        }
    } else if (action === 'enhance-video-prompt') {
        const targetItems = isMulti ? selectedItems.filter(s => s.type === 'video') : [item];
        if (targetItems.length === 0) { window.showToast('No videos selected', 'error'); return; }
        const targetItem = targetItems[0];
        if (!targetItem || !targetItem.path) {
            console.error('[ctx-menu:enhance] Missing target item path:', targetItem);
            window.showToast('Cannot enhance: missing file path', 'error');
            return;
        }
        console.log('[ctx-menu:enhance] Enhancing path:', targetItem.path);

        const config = await window.showVideoEnhancementDialog(targetItem);
        if (config && config.execute) {
            window.showToast(`AI Video Optimization pipeline started for ${targetItems.length} video(s)...`, 'success');
            targetItems.forEach(targetItem => {
                const normPath = (p) => (p || '').replace(/\\/g, '/').toLowerCase();
                const cardElement = Array.from(document.querySelectorAll('.file-card'))
                    .find(c => normPath(c.dataset.path) === normPath(targetItem.path));
                let overlay = null;
                if (cardElement) {
                    overlay = cardElement.querySelector('.webm-loading-overlay');
                    if (!overlay) {
                        overlay = document.createElement('div');
                        overlay.className = 'webm-loading-overlay';
                        overlay.innerHTML = `<div class="spinner-small" style="border-top-color:#e056fd;"></div><div class="webm-percent" style="margin-top:4px; font-size:10px; color:#e056fd;">0%</div><div class="normalize-lbl" style="font-size:8px; opacity:0.8; text-align:center; padding:0 4px; margin-top:2px;">VSR: Init...</div>`;
                        const thumbCont = cardElement.querySelector('.thumbnail-container');
                        if (thumbCont) thumbCont.appendChild(overlay);
                    }
                }
                const progressHandler = (eventData) => {
                    if (normPath(eventData.videoPath) === normPath(targetItem.path)) {
                        if (overlay) {
                            const pctEl = overlay.querySelector('.webm-percent');
                            if (pctEl) pctEl.innerText = `${eventData.percent}%`;
                            const lblEl = overlay.querySelector('.normalize-lbl');
                            if (lblEl) lblEl.innerText = `VSR: ${eventData.label || 'Processing...'}`;
                        }
                    }
                };
                window.electronAPI.onUpscaleProgress(progressHandler);
                const vsrQuality2 = (window.appSettings && window.appSettings.vsrQuality) || 'HIGH';
                const vsrScale2 = (window.appSettings && window.appSettings.vsrScale) || '2';
                const vsrChroma2 = (window.appSettings && window.appSettings.vsrChroma) || 'yuv420p';
                window.electronAPI.upscaleVideo({ path: targetItem.path, quality: vsrQuality2, scale: vsrScale2, chroma: vsrChroma2 }).then(res => {
                    if (overlay) overlay.remove();
                    if (res.success) {
                        window.showToast(`${targetItem.name}: Super-Resolution complete!`, 'success');
                        refreshDirectoryWithScrollPreservation();
                    } else {
                        window.showToast(`${targetItem.name}: Super-Resolution failed: ` + (res.error || 'Unknown'), 'error');
                    }
                });
            });
        }
    } else if (action === 'encrypt-prompt' || action === 'decrypt-prompt') {
        window.triggerCryptoPrompt(action);
    } else if (action === 'open-folder') {
        window.navigateTo(item.id, window.currentRealPath);
    } else if (action === 'paste-into-folder') {
        if (!window._clipboard || window._clipboard.paths.length === 0) { window.showToast('Nothing to paste', 'error'); return; }
        if (!item.id) { window.showToast('Virtual folder not found', 'error'); return; }
        const res = window.vf.addItems(item.id, window._clipboard.paths);
        if (res.added) window.showToast(`Pasted ${res.added} file(s) into "${item.name}"`, 'success');
        else if (res.rejected) {
            const want = item.folderType === 'album' ? 'images' : item.folderType === 'playlist' ? 'audio files' : 'videos';
            window.showToast(`"${item.name}" only accepts ${want}`, 'error');
        } else window.showToast('Already in this folder', 'info');
        if (window._clipboard.mode === 'cut') window._clipboard = { paths: [], mode: 'copy' };
        window.applyFilters();
    } else if (action === 'remove-folder') {
        if (await window.showConfirmDialog(`Remove folder "${item.name}"?`, 'Confirm Folder Removal')) {
            const n = window.vf.remove(item.id);
            window.showToast(n > 1 ? `Removed folder and ${n - 1} sub-folder(s)` : 'Folder removed', 'success');
            window.applyFilters();
        }
    } else if (action === 'delete-item') {
        const targetItems = isMulti ? selectedItems : [item];
        if (targetItems.length === 0) { window.showToast('No items selected', 'error'); return; }
        
        const isVirtual = window.currentNavPath !== 'root';
        const confirmTitle = isVirtual 
            ? (window.currentLang === 'fr' ? 'Confirmer le retrait' : 'Confirm Removal')
            : (window.currentLang === 'fr' ? 'Confirmer la suppression' : 'Confirm Deletion');
        const confirmMsg = isVirtual
            ? (targetItems.length > 1
                ? (window.currentLang === 'fr' ? `Retirer les ${targetItems.length} éléments sélectionnés de ce dossier ?` : `Remove the ${targetItems.length} selected item(s) from this folder?`)
                : (window.currentLang === 'fr' ? `Retirer "${item.name}" de ce dossier ?` : `Remove "${item.name}" from this folder?`))
            : (targetItems.length > 1
                ? `Are you sure you want to delete the ${targetItems.length} selected item(s)?`
                : `Delete "${item.name}"?`);
                
        if (await window.showConfirmDialog(confirmMsg, confirmTitle)) {
            if (isVirtual) {
                const fid = window.currentFolderId;
                if (fid) {
                    const removed = window.vf.removeItems(fid, targetItems.map(i => i.path).filter(Boolean));
                    window.showToast(removed > 1
                        ? (window.currentLang === 'fr' ? `${removed} éléments retirés` : `${removed} items removed`)
                        : (window.currentLang === 'fr' ? `Retiré: ${item.name}` : `Removed: ${item.name}`), 'success');
                    window.applyFilters();
                }
            } else {
                let deletedCount = 0;
                for (const targetItem of targetItems) {
                    console.log('[delete] deleting:', targetItem.path);
                    const res = await window.electronAPI.deleteItem(targetItem.path);
                    if (res.success) {
                        deletedCount++;
                        window.allItems = window.allItems.filter(i => i.path !== targetItem.path);
                    }
                }
                if (deletedCount > 0) {
                    window.showToast(targetItems.length > 1 ? `Deleted ${deletedCount} item(s)` : `Deleted: ${item.name}`, 'success');
                    if (typeof window.invalidateRootCache === 'function') {
                        window.invalidateRootCache();
                    }
                    window.applyFilters();
                } else {
                    window.showToast('Delete failed', 'error');
                }
            }
        }
    } else if (action === 'rename') {
        const inp = card.querySelector('.rename-input');
        const fn = card.querySelector('.filename');
        if (inp && fn) {
            inp.style.display = 'block'; fn.style.display = 'none';
            inp.focus(); inp.select();
        }
    } else if (action === 'copy') {
        window._clipboard = { paths: [], mode: 'copy' };
        window.selectedIndices.forEach(idx => {
            const si = window.displayedItems[idx];
            if (si && si.path) window._clipboard.paths.push(si.path);
        });
        window.showToast(`Copied ${window._clipboard.paths.length} item(s)`, 'success');
    } else if (action === 'cut') {
        window._clipboard = { paths: [], mode: 'cut' };
        window.selectedIndices.forEach(idx => {
            const si = window.displayedItems[idx];
            if (si && si.path) window._clipboard.paths.push(si.path);
        });
        window.showToast(`Cut ${window._clipboard.paths.length} item(s)`, 'success');
    } else if (action === 'paste') {
        if (!window._clipboard || window._clipboard.paths.length === 0) {
            window.showToast('Nothing to paste', 'error');
        } else {
            const res = await window.electronAPI.pasteFiles({ paths: window._clipboard.paths, mode: window._clipboard.mode, destination: window.currentRealPath });
            if (res.success) {
                window.showToast(`Pasted ${res.count} file(s)`, 'success');
                if (window.currentFolderId && Array.isArray(res.pastedPaths)) {
                    window.vf.addItems(window.currentFolderId, res.pastedPaths);
                }
                if (window._clipboard.mode === 'cut') window._clipboard = { paths: [], mode: 'copy' };
                if (window.currentFolderId) window.navigateTo(window.currentFolderId, window.currentRealPath);
                else window.loadDirectory(window.currentNavPath, window.currentRealPath, false);
            } else {
                window.showToast('Paste failed: ' + res.error, 'error');
            }
        }
    } else if (action === 'zip-selection') {
        const zipPaths = [];
        window.selectedIndices.forEach(idx => {
            const si = window.displayedItems[idx];
            if (si && si.path) zipPaths.push(si.path);
        });
        if (zipPaths.length === 0) { window.showToast('No files selected for zip', 'error'); return; }
        window.showToast('Preparing zip of ' + zipPaths.length + ' file(s)...', 'success');
        const res = await window.electronAPI.zipSelection({ paths: zipPaths });
        if (res.success) {
            window.showToast('Zip created successfully: ' + res.path.split(/[\\/]/).pop(), 'success');
            window.loadDirectory(window.currentNavPath, window.currentRealPath, true);
        } else if (!res.canceled) {
            window.showToast('Zip failed: ' + res.error, 'error');
        }
    } else if (action === 'properties') {
        window.showPropertiesDialog(item);
    } else if (action === 'opened') {
        window.showToast('Opening in default app...', 'success');
    } else if (action === 'open-error') {
        window.showToast('Failed to open — check default app config', 'error');
    } else if (action === 'show') {
        window.showToast('Opened in Windows Explorer', 'success');
    } else if (action === 'copied') {
        window.showToast('Path copied to clipboard', 'success');
    }
}

async function triggerCryptoPrompt(action) {
    const pathsToProcess = [];
    window.selectedIndices.forEach(idx => {
        const si = window.displayedItems[idx];
        if (si && si.path && si.type !== 'fakeFolder') pathsToProcess.push(si.path);
    });

    if (pathsToProcess.length === 0) {
        window.showToast('No valid files selected', 'error');
        return;
    }

    const dialogEl = el('crypto-dialog');
    const passwordInput = el('crypto-password');
    const labelEl = el('crypto-dialog-label');

    labelEl.innerText = action === 'encrypt-prompt'
        ? `Encrypt ${pathsToProcess.length} file(s) with AES-256:`
        : `Decrypt ${pathsToProcess.length} file(s) with AES-256:`;
    passwordInput.value = '';
    dialogEl.style.display = 'block';
    passwordInput.focus();

    const onCancel = () => {
        dialogEl.style.display = 'none';
        cleanup();
    };

    const onConfirm = async () => {
        const password = passwordInput.value;
        if (!password) {
            window.showToast('Password cannot be empty', 'error');
            return;
        }
        dialogEl.style.display = 'none';
        cleanup();

        el('loading-text').innerText = action === 'encrypt-prompt' ? 'Encrypting files...' : 'Decrypting files...';
        el('loading').style.display = 'flex';

        if (action === 'encrypt-prompt') {
            const res = await window.electronAPI.encryptFiles({ paths: pathsToProcess, password });
            el('loading').style.display = 'none';
            el('loading-text').innerText = window.translations[window.currentLang].scanning;
            if (res.success) {
                window.showToast('Files encrypted successfully', 'success');
                window.loadDirectory(window.currentNavPath, window.currentRealPath, true);
            } else {
                window.showToast('Encryption failed: ' + res.error, 'error');
            }
        } else {
            const res = await window.electronAPI.decryptFiles({ paths: pathsToProcess, password });
            el('loading').style.display = 'none';
            el('loading-text').innerText = window.translations[window.currentLang].scanning;
            if (res.success) {
                window.showToast('Files decrypted successfully', 'success');
                window.loadDirectory(window.currentNavPath, window.currentRealPath, true);
            } else {
                window.showToast(`Decrypted ${res.count || 0}/${pathsToProcess.length} files successfully. Some passwords may be incorrect.`, 'error');
                window.loadDirectory(window.currentNavPath, window.currentRealPath, true);
            }
        }
    };

    const onKeydown = (e) => {
        if (e.key === 'Enter') onConfirm();
        else if (e.key === 'Escape') onCancel();
    };

    const cleanup = () => {
        el('btn-cancel-crypto').removeEventListener('click', onCancel);
        el('btn-confirm-crypto').removeEventListener('click', onConfirm);
        passwordInput.removeEventListener('keydown', onKeydown);
    };

    el('btn-cancel-crypto').addEventListener('click', onCancel);
    el('btn-confirm-crypto').addEventListener('click', onConfirm);
    passwordInput.addEventListener('keydown', onKeydown);
}

// Bind to globals
window.handleCardContextMenu = handleCardContextMenu;
window.triggerCryptoPrompt = triggerCryptoPrompt;
