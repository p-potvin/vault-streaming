/* ==========================================================================
   Continue Watching — the 4 most recent titles of the watch history, at the top of Discover
   (Settings → "Continue Watching on Discover", on by default). A card resumes the title: its last source opens
   directly (js/streaming/rd-flow.js, playLastSource) and playback continues where it stopped.
   ========================================================================== */

(function () {
    const COUNT = 4;
    let searchingNow = false;   // the last state Discover reported (a search hides the row)

    function enabled() {
        return !(window.appSettings && window.appSettings.continueWatchingRow === false);
    }

    function labelOf(item) {
        if (item.mediaType === 'tv' && item.season != null && item.episode != null) {
            return `S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}`;
        }
        return item.year ? String(item.year) : '';
    }

    /** One entry per title: a series shows only its most recently played episode (finished or not); the history is
     *  already sorted most recent first. Same show = same TMDB id (compared as text), else the same title. */
    function latestPerTitle(history) {
        const seen = new Set();
        const out = [];
        for (const item of history) {
            // a series: its id and its title both name it (an episode may have been saved without the id)
            const keys = item.mediaType === 'tv'
                ? [item.tmdbId != null && item.tmdbId !== '' ? `tv:id:${item.tmdbId}` : null, item.title ? `tv:title:${item.title}` : null].filter(Boolean)
                : [item.key || `${item.mediaType}:${item.tmdbId || item.title}`];
            if (keys.some(k => seen.has(k))) continue;
            keys.forEach(k => seen.add(k));
            out.push(item);
        }
        return out;
    }
    window._continueWatchingLatestPerTitle = latestPerTitle;   // (tests)

    function resume(item) {
        // A finished episode: open the series on its next episode (the details modal offers "Next: S02E06")
        // instead of replaying the one already watched.
        if (item.mediaType === 'tv' && item.completed && item.tmdbId && typeof window.showMediaDetails === 'function') {
            window.showMediaDetails({ id: item.tmdbId, media_type: 'tv', title: item.title, poster: item.poster,
                                      year: item.year });
            return;
        }
        if (typeof window.triggerRDStream !== 'function') return;
        window.triggerRDStream(item.title, item.tmdbId, item.mediaType || 'movie', item.season || null,
            item.episode || null, { poster: item.poster, year: item.year });
    }

    /** Show (or hide) the row; `searching` = a search query is active (the row is for the plain Discover page);
     *  left out, the last state Discover reported is kept (a Settings save, the player closing). */
    window.renderContinueWatching = async function (searching) {
        if (typeof searching === 'boolean') searchingNow = searching;
        searching = searchingNow;
        const section = document.getElementById('continue-watching');
        if (!section) return;
        if (!enabled() || searching || !window.electronAPI || !window.electronAPI.getWatchHistory) {
            section.style.display = 'none';
            return;
        }
        let items = [];
        try {
            // most recent first: enough entries to fill the row once a series' episodes collapse into one card
            const res = await window.electronAPI.getWatchHistory({ limit: 200 });
            items = (res && res.success && Array.isArray(res.items)) ? latestPerTitle(res.items).slice(0, COUNT) : [];
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
