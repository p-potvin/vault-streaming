// card.js — createCardElement: builds a single file-card DOM node with thumbnail, star, checkbox, rename, drag, hover preview

function createCardElement(item, index) {
    const card = document.createElement('div');
    card.className = 'file-card';
    if (item.type === 'audio') card.classList.add('audio-card');
    card.tabIndex = 0;
    card.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (item.isStreaming) {
                if (typeof window.showMediaDetails === 'function') window.showMediaDetails(item.meta || item);
            } else if (item.type === 'video') {
                if (typeof window.playItem === 'function') window.playItem(index);
            } else if (item.type === 'fakeFolder') {
                window.navigateTo(item.id, window.currentRealPath);
            } else {
                window.electronAPI.openFile(item.path);
            }
        }
    });
    if (item.type === 'fakeFolder') {
        card.classList.add('fake-folder');
        card.addEventListener('dragover', (e) => { e.preventDefault(); card.style.borderColor = "var(--vault-accent)"; });
        card.addEventListener('dragleave', () => { card.style.borderColor = ""; });
        card.addEventListener('drop', (e) => {
            e.preventDefault();
            card.style.borderColor = "";
            const pathDropped = e.dataTransfer.getData('text/plain');
            if (!pathDropped || !item.id) return;
            const res = window.vf.addItems(item.id, [pathDropped]);
            if (res.added) window.applyFilters();
            else if (res.rejected) window.showToast(`"${item.name}" only accepts ${item.folderType === 'album' ? 'images' : item.folderType === 'playlist' ? 'audio' : 'video'} files`, 'error');
        });
    } else {
        card.draggable = true;
        card.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', item.path);
            e.dataTransfer.effectAllowed = 'move';
        });
    }

    card.dataset.index = index; card.title = item.name;
    card.dataset.path = item.path || '';
    if (item.hoverWebm) card.dataset.hasWebm = "true";
    if (item.thumbnail) card.dataset.hasThumb = "true";

    let thumbHtml = '';
    if (item.type === 'fakeFolder') {
        const isFavorites = item.name === 'Favorites';
        thumbHtml = window.icons
            ? (isFavorites
                ? window.icons.star('', 'width:50px; height:50px; display:block; margin:auto;', '#E5A93B', '#E5A93B')
                : window.icons.folder('', 'width:50px; height:50px; stroke:#fff; stroke-width:2;'))
            : '';
    } else if (item.type === 'encrypted') {
        thumbHtml = window.icons ? window.icons.lock('', 'width:50px; height:50px; stroke:var(--vault-accent); stroke-width:2; margin: auto;') : '';
    } else if (item.type === 'audio') {
        // Multi-color dynamic waveform
        const palette = [
            ['#b07cff','rgba(176,124,255,0.35)'],
            ['#9b6ff0','rgba(155,111,240,0.3)'],
            ['#74b1be','rgba(116,177,190,0.35)'],
            ['#5ad4e6','rgba(90,212,230,0.35)'],
            ['#4ecdc4','rgba(78,205,196,0.35)'],
            ['#74b1be','rgba(116,177,190,0.3)'],
            ['#D6A441','rgba(214,164,65,0.35)'],
            ['#f0b94b','rgba(240,185,75,0.3)'],
            ['#ff9a6c','rgba(255,154,108,0.3)'],
            ['#ff6b7a','rgba(255,107,122,0.3)'],
            ['#cc5fa8','rgba(204,95,168,0.35)'],
            ['#b07cff','rgba(176,124,255,0.3)']
        ];
        const bars = Array.from({length: 12}, (_, i) => {
            const [col, dim] = palette[i % palette.length];
            const lo  = (0.12 + Math.random() * 0.2).toFixed(2);
            const hi  = (0.55 + Math.random() * 0.45).toFixed(2);
            const dur = (0.65 + Math.random() * 0.7).toFixed(2);
            const del = (i * 0.07).toFixed(2);
            return `<div class="wv-bar" style="--wv-color:${col};--wv-color-dim:${dim};--wv-lo:${lo};--wv-hi:${hi};--wv-dur:${dur}s;animation-delay:${del}s;"></div>`;
        }).join('');
        const noteIcon = window.icons ? window.icons.musicNote('audio-note-icon', 'width:52px;height:52px;stroke:rgba(176,124,255,0.6);stroke-width:1.2;') : '';
        thumbHtml = `${noteIcon}<div class="audio-waveform">${bars}</div>`;
    } else {
        const thumbSrc = item.isStreaming ? item.thumbnail : (window.sanitizePath(item.thumbnail) || 'data:image/svg+xml;utf8,<svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="%23333"/><text x="50%" y="50%" fill="%23777" font-family="sans-serif" font-size="14" text-anchor="middle">NO THUMB</text></svg>');
        const durationStr = (item.duration && item.duration > 0) ? window.formatDuration(item.duration) : '';
        thumbHtml = `<img class="thumbnail" loading="lazy" src='${thumbSrc}' alt="${window.escapeHtml(item.name)} thumbnail"><img class="trickplay" alt="">
                  <div class="duration-badge" style="display: ${durationStr ? 'block' : 'none'};">${durationStr}</div>`;
    }

    let sizeBadgeHtml = '';
    if (item.type !== 'fakeFolder' && item.size) {
        sizeBadgeHtml = `<div class="size-badge">${window.formatBytes(item.size)}</div>`;
    }

    let metaLineHtml = '';
    if (item.type !== 'fakeFolder') {
        const extLabel = item.isStreaming ? 'STREAM' : (item.ext ? item.ext.toUpperCase().substring(1) : 'FILE');
        const sizeStr = item.size ? window.formatBytes(item.size) : '';
        metaLineHtml = `<div style="font-size:10px; color:#888; margin-top:2px; display:flex; gap:6px; justify-content:center; align-items:center;">
         <span style="font-weight:600; color:var(--vault-accent);">${extLabel}</span>
         ${sizeStr ? `<span>•</span><span>${sizeStr}</span>` : ''}
      </div>`;
    }

    const isStarred = !!(window.appSettings && window.appSettings.favorites && window.appSettings.favorites.includes(item.path));
    const starFill = isStarred ? '#E5A93B' : 'none';
    const starStroke = isStarred ? '#E5A93B' : '#ffffff';
    const starSvg = window.icons ? window.icons.star('star-svg', 'transition: transform 0.2s; display: block; margin: 0; padding: 0; pointer-events: none; width: 14px; height: 14px;', starFill, starStroke) : '';
    const t = window.translations[window.currentLang === 'fr' ? 'fr' : 'en'] || {};

    let plusBtnHtml = '';
    if (item.type !== 'fakeFolder') {
        let plusBtnTitle = "Add to Virtual Folder";
        if (item.type === 'video' || item.type === 'encrypted') plusBtnTitle = window.currentLang === 'fr' ? "Ajouter à la Collection" : "Add to Collection";
        else if (item.type === 'image') plusBtnTitle = window.currentLang === 'fr' ? "Ajouter à l'Album" : "Add to Album";
        else if (item.type === 'audio') plusBtnTitle = window.currentLang === 'fr' ? "Ajouter à la Playlist" : "Add to Playlist";

        plusBtnHtml = `
           <button class="add-to-folder-btn" style="position: absolute; top: 6px; right: 6px; border: none; background: rgba(0,0,0,0.65); width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 9999 !important; pointer-events: auto !important; padding: 0; margin: 0; outline: none; box-shadow: none; transition: background 0.2s; color: #ffffff;" title="${plusBtnTitle}" aria-label="Add to Virtual Folder">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 13px; height: 13px; pointer-events: none;"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
           </button>
        `;
    }

    card.innerHTML = `
    <input type="checkbox" class="file-checkbox" aria-label="Select ${window.escapeHtml(item.name)}">
    <div class="thumbnail-container" style="position:relative;">
       <button class="favorite-star-btn" style="position: absolute; top: 6px; left: 6px; border: none; background: rgba(0,0,0,0.65); width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 9999 !important; pointer-events: auto !important; padding: 0; margin: 0; outline: none; box-shadow: none; transition: background 0.2s;" title="${t.addToFavorites || 'Add to Favorites'}" aria-label="Favorite">
          ${starSvg}
       </button>
       ${plusBtnHtml}
       ${thumbHtml}
       ${sizeBadgeHtml}
    </div>
    <div class="filename-container" style="padding-top:4px;">
       <div class="filename">${window.escapeHtml(item.name)}</div>
       ${metaLineHtml}
       ${item.mtimeFormatted ? `<div style="font-size:10px; color:#aaa; margin-top:2px;">${item.mtimeFormatted}</div>` : ''}
       <input type="text" class="rename-input" value="${window.escapeHtml(item.name)}" aria-label="Rename ${window.escapeHtml(item.name)}">
    </div>
  `;

    const starBtn = card.querySelector('.favorite-star-btn');
    if (starBtn) {
        starBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.toggleFavorite(item.path, starBtn);
        });
    }

    const plusBtn = card.querySelector('.add-to-folder-btn');
    if (plusBtn) {
        plusBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showAddToFolderMenu(item, plusBtn);
        });
    }

    const chk = card.querySelector('.file-checkbox');
    chk.addEventListener('click', (e) => {
        e.stopPropagation();
        if (chk.checked) window.selectedIndices.add(index);
        else window.selectedIndices.delete(index);
        card.classList.toggle('selected', chk.checked);
        window.lastSelectedIndex = index;
        window.updateStatusBar();
    });

    // WebM Hover Play Logic
    if (item.hoverWebm) {
        window.attachHoverWebmToCard(card, item.hoverWebm);
    } else if (item.trickplayFolder) {
        let hoverTimer; let tpIndex = 0; let frames = [];
        const tpImg = card.querySelector('.trickplay');
        const mainImg = card.querySelector('.thumbnail');

        card.addEventListener('mouseenter', async () => {
            if (frames.length === 0) frames = await window.electronAPI.getTrickplaySprites(item.trickplayFolder);
            if (frames.length === 0) return;
            tpImg.style.display = 'block'; mainImg.style.display = 'none'; tpIndex = 0;
            tpImg.src = window.sanitizePath(frames[tpIndex]);
            hoverTimer = setInterval(() => {
                tpIndex = (tpIndex + 1) % frames.length;
                tpImg.src = window.sanitizePath(frames[tpIndex]);
            }, 400);
        });
        card.addEventListener('mouseleave', () => {
            clearInterval(hoverTimer); tpImg.style.display = 'none'; mainImg.style.display = 'block';
        });
    } else if (item.type === 'audio') {
        let hoverAudioTimer;
        card.addEventListener('mouseenter', () => {
            // Debounce audio hover preview slightly to avoid instant triggers when quickly moving cursor
            hoverAudioTimer = setTimeout(() => {
                if (window.hoverAudioPreview) {
                    try { window.hoverAudioPreview.pause(); } catch(e) {}
                    window.hoverAudioPreview = null;
                }
                const audioPath = window.sanitizePath(item.path);
                window.hoverAudioPreview = new Audio(audioPath);
                window.hoverAudioPreview.volume = 0.4;
                window.hoverAudioPreview.play().catch(e => {
                    console.log('[Audio Hover] Autoplay prevented or aborted:', e);
                });
            }, 300);
        });
        card.addEventListener('mouseleave', () => {
            clearTimeout(hoverAudioTimer);
            if (window.hoverAudioPreview) {
                try { window.hoverAudioPreview.pause(); } catch(e) {}
                window.hoverAudioPreview = null;
            }
        });
    }

    // Rename Feature (F2)
    const input = card.querySelector('.rename-input');
    const filename = card.querySelector('.filename');
    const commitRename = async () => {
        input.style.display = 'none'; filename.style.display = 'block';
        if (input.value && input.value !== item.name) {
            const t = window.translations[window.currentLang === 'fr' ? 'fr' : 'en'] || {};
            if (item.type === 'fakeFolder') {
                const newName = input.value.trim();
                if (!newName) { input.value = item.name; return; }
                const res = window.vf.rename(item.id, newName);
                if (res.ok) {
                    item.name = res.folder.name;
                    filename.innerText = res.folder.name;
                    window.showToast((t.renamedTo || 'Renamed to ') + `"${res.folder.name}"`, 'success');
                    window.applyFilters();
                } else {
                    input.value = item.name;
                    window.showToast(res.error || 'Rename failed', 'error');
                }
            } else {
                const res = await window.electronAPI.renameFile(item.path, input.value);
                if (res.success) {
                    window.showToast((t.renamedTo || 'Renamed to ') + `"${input.value}"`, 'success');
                    const oldPath = item.path;
                    const newPath = res.newPath || (item.path.substring(0, item.path.lastIndexOf('\\') + 1) + input.value);
                    const oldDotIdx = item.name.lastIndexOf('.');
                    const oldBase = oldDotIdx !== -1 ? item.name.substring(0, oldDotIdx) : item.name;
                    const newDotIdx = input.value.lastIndexOf('.');
                    const newBase = newDotIdx !== -1 ? input.value.substring(0, newDotIdx) : input.value;
                    item.name = input.value;
                    item.path = newPath;
                    if (item.thumbnail) item.thumbnail = item.thumbnail.replace(oldBase, newBase);
                    if (item.hoverWebm) item.hoverWebm = item.hoverWebm.replace(oldBase, newBase);
                    filename.innerText = input.value;
                    card.dataset.path = newPath;
                } else {
                    input.value = item.name;
                    window.showToast((t.renameFailed || 'Rename failed: ') + res.error, 'error');
                }
            }
        }
    };
    input.addEventListener('mousedown', e => e.stopPropagation());
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('blur', commitRename);
    input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commitRename();
        else if (e.key === 'Escape') { input.value = item.name; input.blur(); }
    });

    // Async Duration Extract
    if (item.type === 'video') {
        requestAnimationFrame(() => {
            let tmp = document.createElement('video');
            tmp.preload = "metadata";
            tmp.src = window.sanitizePath(item.path);
            tmp.onloadedmetadata = () => {
                const d = card.querySelector('.duration-badge');
                if (d && tmp.duration) {
                    d.innerText = window.formatDuration(tmp.duration);
                    d.style.display = 'block';
                    item.duration = tmp.duration;
                }
                tmp.src = ""; tmp.remove();
            };
        });
    }

    // Click selection
    card.addEventListener('click', (e) => {
        if (e.target.closest('input')) return;
        if (e.ctrlKey) {
            if (window.selectedIndices.has(index)) window.selectedIndices.delete(index); else window.selectedIndices.add(index);
            window.lastSelectedIndex = index;
        } else if (e.shiftKey && window.lastSelectedIndex !== -1) {
            const start = Math.min(window.lastSelectedIndex, index); const end = Math.max(window.lastSelectedIndex, index);
            window.selectedIndices.clear(); for (let i = start; i <= end; i++) window.selectedIndices.add(i);
        } else {
            window.selectedIndices.clear(); window.selectedIndices.add(index); window.lastSelectedIndex = index;
        }
        document.querySelectorAll('.file-card').forEach(c => {
            const isSel = window.selectedIndices.has(parseInt(c.dataset.index));
            c.classList.toggle('selected', isSel);
            const cb = c.querySelector('.file-checkbox');
            if (cb) cb.checked = isSel;
        });
        window.updateStatusBar();
    });

    card.addEventListener('dblclick', () => {
        if (item.isStreaming) {
            if (typeof window.showMediaDetails === 'function') window.showMediaDetails(item.meta || item);
        } else if (item.type === 'video') {
            if (typeof window.playItem === 'function') window.playItem(index);
        } else if (item.type === 'audio') {
            window.electronAPI.openFile(item.path);
        } else if (item.type === 'image') {
            if (typeof window.openImageViewer === 'function') {
                window.openImageViewer(index);
            } else {
                window.electronAPI.openFile(item.path);
            }
        } else if (item.type === 'fakeFolder') window.navigateTo(item.id, window.currentRealPath);
        else if (item.type === 'encrypted') {
            window.selectedIndices.clear();
            window.selectedIndices.add(index);
            document.querySelectorAll('.file-card').forEach(c => {
                const isSel = window.selectedIndices.has(parseInt(c.dataset.index));
                c.classList.toggle('selected', isSel);
                c.querySelector('.file-checkbox').checked = isSel;
            });
            window.updateStatusBar();
            window.triggerCryptoPrompt('decrypt-prompt');
        } else {
            if (item.type === 'image') {
                if (typeof window.openImageViewer === 'function') {
                    window.openImageViewer(index);
                } else {
                    window.electronAPI.openFile(item.path);
                }
            } else {
                window.electronAPI.openFile(item.path);
            }
        }
    });

    // Context menu — delegated to card-events.js
    card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        window.handleCardContextMenu(card, item, index);
    });

    return card;
}

function showAddToFolderMenu(item, anchorEl) {
    const t = window.translations[window.currentLang === 'fr' ? 'fr' : 'en'] || {};
    const expectedType = (item.type === 'image') ? 'album'
                       : (item.type === 'audio') ? 'playlist'
                       : 'collection';
    const typeLabel = expectedType === 'album' ? (t.album || 'Album')
                     : expectedType === 'playlist' ? (t.playlist || 'Playlist')
                     : (t.collection || 'Collection');

    const folders = (window.vf ? window.vf.list({ type: expectedType }) : [])
        .slice()
        .sort((a, b) => {
            if (a.name === 'Favorites') return -1;
            if (b.name === 'Favorites') return 1;
            return (b.lastUsed || 0) - (a.lastUsed || 0);
        })
        .map(f => ({ ...f, label: f.parentId
            ? `${window.buildNavPath(f.parentId).replace(/^root\/?/, '')}/${f.name}`
            : f.name }));

    const existing = document.getElementById('add-to-folder-inline-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'add-to-folder-inline-menu';
    menu.style.cssText = `
        position: fixed;
        z-index: 2147483647;
        background: var(--vault-card-bg, rgba(25, 20, 35, 0.98));
        border: 1px solid var(--vault-border);
        border-radius: 6px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.5);
        padding: 6px 0;
        min-width: 180px;
        max-width: 260px;
        max-height: 220px;
        overflow-y: auto;
        font-family: var(--font-sans), system-ui;
        color: var(--vault-text);
    `;

    const header = document.createElement('div');
    header.style.cssText = 'font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--vault-slate); padding: 4px 12px 8px; border-bottom: 1px solid var(--vault-border); margin-bottom: 4px;';
    header.innerText = `${t.addToFolder || 'Add to'} ${typeLabel}`;
    menu.appendChild(header);

    if (folders.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding: 8px 12px; font-size: 11px; color: var(--vault-slate); font-style: italic;';
        empty.innerText = t.noFolders || 'No folders yet';
        menu.appendChild(empty);
    } else {
        folders.forEach(folder => {
            const row = document.createElement('button');
            row.style.cssText = `
                display: flex; align-items: center; gap: 8px;
                width: 100%; text-align: left; background: transparent; border: none;
                color: var(--vault-text); cursor: pointer; padding: 7px 12px;
                font-size: 12px; font-family: inherit; transition: background 0.15s;
            `;
            row.addEventListener('mouseenter', () => row.style.background = 'rgba(255,255,255,0.06)');
            row.addEventListener('mouseleave', () => row.style.background = 'transparent');
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                const res = window.vf.addItems(folder.id, [item]);
                menu.remove();
                if (res.added > 0) {
                    window.showToast(`${t.addedToFolder || 'Added to'} "${folder.name}"`, 'success');
                    window.applyFilters();
                } else if (res.rejected > 0) {
                    const want = folder.type === 'album' ? (t.images || 'images') : folder.type === 'playlist' ? (t.audioFiles || 'audio files') : (t.videos || 'videos');
                    window.showToast(`"${folder.name}" ${t.onlyAccepts || 'only accepts'} ${want}`, 'error');
                } else {
                    window.showToast(t.alreadyInFolder || 'Already in folder', 'info');
                }
            });
            const icon = folder.name === 'Favorites'
                ? window.icons.star('', 'width:12px; height:12px;', '#E5A93B', '#E5A93B')
                : window.icons.folder('', 'width:12px; height:12px; stroke:var(--vault-slate); stroke-width:2;');
            row.innerHTML = `${icon}<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${window.escapeHtml(folder.label)}</span>`;
            menu.appendChild(row);
        });
    }

    const createRow = document.createElement('button');
    createRow.style.cssText = `
        display: flex; align-items: center; gap: 8px;
        width: 100%; text-align: left; background: transparent; border: none;
        border-top: 1px solid var(--vault-border); color: var(--vault-accent); cursor: pointer;
        padding: 7px 12px; font-size: 12px; font-family: inherit; margin-top: 4px;
        transition: background 0.15s;
    `;
    createRow.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:12px; height:12px;"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg><span>${t.createNewFolder || 'Create new...'}</span>`;
    createRow.addEventListener('mouseenter', () => createRow.style.background = 'rgba(255,255,255,0.06)');
    createRow.addEventListener('mouseleave', () => createRow.style.background = 'transparent');
    createRow.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.remove();
        if (typeof window.showAddToFolderDialog === 'function') window.showAddToFolderDialog(item);
    });
    menu.appendChild(createRow);

    document.body.appendChild(menu);

    const rect = anchorEl.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let top = rect.bottom + 6;
    let left = rect.left;
    if (left + menuRect.width > window.innerWidth) {
        left = Math.max(4, rect.right - menuRect.width);
    }
    if (top + menuRect.height > window.innerHeight) {
        top = Math.max(4, rect.top - menuRect.height - 6);
    }
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;

    const closeMenu = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener('click', closeMenu, true);
            document.removeEventListener('keydown', onKey);
        }
    };
    const onKey = (e) => {
        if (e.key === 'Escape') { menu.remove(); document.removeEventListener('click', closeMenu, true); document.removeEventListener('keydown', onKey); }
    };
    setTimeout(() => {
        document.addEventListener('click', closeMenu, true);
        document.addEventListener('keydown', onKey);
    }, 0);
}

window.createCardElement = createCardElement;
