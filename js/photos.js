/* ==========================================================================
   Vault Explorer — Photos Tab Masonry + Photo Editor wiring
   ========================================================================== */

(function () {
    const PHOTO_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif', 'tiff', 'tif']);

    function isPhotoItem(item) {
        if (!item) return false;
        if (item.type === 'image') return true;
        const ext = (item.ext || '').replace(/^\./, '').toLowerCase();
        return PHOTO_EXTS.has(ext);
    }

    function getPhotoItems() {
        const source = window.displayedItems || window.allItems || [];
        return source.filter(isPhotoItem);
    }

    function renderEmpty(container) {
        container.innerHTML = `
            <div class="empty-state" style="padding: 60px 24px; text-align: center; color: var(--vault-slate);">
                <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom: 16px; opacity: 0.6;">
                    <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>
                </svg>
                <h3 style="font-size: 14px; font-weight: 700; margin-bottom: 8px; color: var(--vault-text); font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.05em;">No Photos Found</h3>
                <p style="font-size: 12px; opacity: 0.7; font-family: var(--font-mono);">Load a folder that contains images to browse them here.</p>
            </div>
        `;
    }

    window.renderPhotos = function () {
        const container = el('photos-container');
        if (!container) return;

        const photos = getPhotoItems();
        container.innerHTML = '';

        if (photos.length === 0) {
            renderEmpty(container);
            return;
        }

        const river = document.createElement('div');
        river.className = 'photos-river';

        photos.forEach((item, idx) => {
            const thumbSrc = item.thumbnail ? window.sanitizePath(item.thumbnail) : window.sanitizePath(item.path);
            const div = document.createElement('div');
            div.className = 'photo-item';
            div.dataset.index = idx;
            div.dataset.path = item.path;

            const img = document.createElement('img');
            img.src = thumbSrc;
            img.alt = item.name;
            img.loading = 'lazy';
            img.onerror = () => { img.style.display = 'none'; div.style.background = 'var(--vt-surface-alt)'; };

            div.appendChild(img);

            div.addEventListener('dblclick', () => {
                if (typeof window.openPhotoEditor === 'function') {
                    window.openPhotoEditor(item, photos);
                }
            });

            river.appendChild(div);
        });

        container.appendChild(river);
    };
})();
