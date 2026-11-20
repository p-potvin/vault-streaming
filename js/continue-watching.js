/* ==========================================================================
   Continue Watching — the 4 most recent titles of the watch history, at the top of Discover
   (Settings → "Continue Watching on Discover", on by default). A card resumes the title: its last source opens
   directly (js/streaming/rd-flow.js, playLastSource) and playback continues where it stopped.
   ========================================================================== */

(function () {
    const COUNT = 4;

    function enabled() {
        return !(window.appSettings && window.appSettings.continueWatchingRow === false);
    }

    function labelOf(item) {
        if (item.mediaType === 'tv' && item.season != null && item.episode != null) {
            return `S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}`;
        }
        return item.year ? String(item.year) : '';
    }

    function resume(item) {
        if (typeof window.triggerRDStream !== 'function') return;
        window.triggerRDStream(item.title, item.tmdbId, item.mediaType || 'movie', item.season || null,
            item.episode || null, { poster: item.poster, year: item.year });
    }

    /** Show (or hide) the row; `searching` = a search query is active (the row is for the plain Discover page). */
    window.renderContinueWatching = async function (searching = false) {
        const section = document.getElementById('continue-watching');
        if (!section) return;
        if (!enabled() || searching || !window.electronAPI || !window.electronAPI.getWatchHistory) {
            section.style.display = 'none';
            return;
        }
        let items = [];
        try {
            const res = await window.electronAPI.getWatchHistory({ limit: COUNT });
            items = (res && res.success && Array.isArray(res.items)) ? res.items.slice(0, COUNT) : [];
        } catch (_) { items = []; }
        if (!items.length) { section.style.display = 'none'; return; }

        const fr = window.currentLang === 'fr';
        const list = section.querySelector('.continue-watching-list');
        list.replaceChildren(...items.map((item) => {
            const pct = item.durationSec > 0 ? Math.min(100, Math.round((item.positionSec / item.durationSec) * 100)) : 0;
            const left = item.durationSec > 0 && !item.completed
                ? Math.max(1, Math.round((item.durationSec - item.positionSec) / 60)) : null;
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'continue-watching-card';
            card.title = item.title || '';
            card.innerHTML = `
                <img class="cw-poster" alt="" loading="lazy" src="${window.escapeHtml(item.poster || '')}" onerror="this.style.visibility='hidden'">
                <span class="cw-body">
                  <span class="cw-title">${window.escapeHtml(item.title || '')}</span>
                  <span class="cw-meta">${window.escapeHtml(labelOf(item))}${item.completed
                    ? ` · ${fr ? 'Terminé' : 'Watched'}`
                    : (left ? ` · ${left} min ${fr ? 'restantes' : 'left'}` : '')}</span>
                  <span class="cw-progress" aria-hidden="true"><span style="width:${item.completed ? 100 : pct}%"></span></span>
                </span>`;
            card.addEventListener('click', () => resume(item));
            return card;
        }));
        section.style.display = '';
    };
})();
