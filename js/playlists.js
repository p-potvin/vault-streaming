/* ==========================================================================
   Vault Explorer — Playlists Tab (Music Playlist Grid)
   ========================================================================== */

(function () {
    const AUDIO_EXTS = new Set(['mp3', 'flac', 'wav', 'aac', 'ogg', 'm4a', 'opus', 'wma', 'aiff', 'ape']);

    function isAudio(item) {
        if (!item) return false;
        if (item.type === 'audio') return true;
        const ext = (item.ext || '').replace(/^\./, '').toLowerCase();
        return AUDIO_EXTS.has(ext);
    }

    function groupByFolder(items) {
        const groups = new Map();
        items.forEach(item => {
            const folder = item.folder || 'Uncategorized';
            if (!groups.has(folder)) {
                groups.set(folder, { name: folder, items: [], cover: null });
            }
            const g = groups.get(folder);
            g.items.push(item);
            if (!g.cover && item.thumbnail) g.cover = item.thumbnail;
        });
        return Array.from(groups.values());
    }

    function createPlaylistCard(pl, index) {
        const card = document.createElement('div');
        card.className = 'file-card';
        card.style.cursor = 'pointer';
        card.dataset.playlistIndex = index;

        const coverSrc = pl.cover
            ? window.sanitizePath(pl.cover)
            : 'data:image/svg+xml;utf8,<svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="%232a2340"/><text x="50%" y="50%" fill="%23777" font-family="sans-serif" font-size="14" text-anchor="middle">NO COVER</text></svg>';

        // Audio-specific waveform-style decorative element
        const waveBars = Array.from({length: 20}, (_, i) => {
            const h = 20 + Math.random() * 60;
            return `<div style="width:2px; height:${h}%; background:rgba(176,124,255,0.4); border-radius:1px;"></div>`;
        }).join('');

        card.innerHTML = `
            <div class="thumbnail-container" style="position:relative; overflow:hidden;">
                <img class="thumbnail" src="${coverSrc}" alt="${window.escapeHtml(pl.name)}" loading="lazy" style="border-radius: 28px;">
                <div style="position:absolute; bottom:8px; left:8px; right:8px; display:flex; align-items:flex-end; gap:2px; height:40px; pointer-events:none; opacity:0.6;">
                    ${waveBars}
                </div>
            </div>
            <div class="filename-container" style="padding-top: 8px;">
                <div class="filename">${window.escapeHtml(pl.name)}</div>
                <div style="font-size:10px; color:var(--vault-slate); margin-top:4px; font-family:var(--font-mono);">${pl.items.length} track${pl.items.length !== 1 ? 's' : ''}</div>
            </div>
        `;

        card.addEventListener('click', () => {
            window.switchTab('audio');
            const source = window.allItems || [];
            window.displayedItems = source.filter(item => (item.folder || 'Uncategorized') === pl.name && isAudio(item));
            if (typeof window.renderAudio === 'function') window.renderAudio();
        });

        return card;
    }

    window.renderPlaylists = function () {
        const container = el('playlists-grid');
        if (!container) return;

        const source = window.allItems || window.displayedItems || [];
        const audio = source.filter(isAudio);
        const playlists = groupByFolder(audio);

        container.innerHTML = '';

        if (playlists.length === 0) {
            const empty = window.createFolderChooserEmptyState(
                { title: 'No Playlists Yet', body: 'Load a folder containing audio files to see them grouped by playlist.' },
                () => window.browseTabFolder('playlists')
            );
            container.appendChild(empty);
            return;
        }

        playlists.forEach((pl, idx) => {
            container.appendChild(createPlaylistCard(pl, idx));
        });
    };
})();
