// js/streaming/loading-card.js — the stream loading card: what the stream flow (js/streaming/rd-flow.js) reports while it
// finds and opens a source, shown like the start-up splash (logo, title, animated bar, one status line) in a small card
// over a light dim, the app still visible around it.
//
// The flow keeps driving its own elements in #rd-stream-dialog (status text, spinner, the ranked list): this module
// only watches them. With the player open, the dialog stays invisible and the player's "Up next" card shows the same
// status with a progress ring (js/player/series-controls.js, upNextLoading). "Choose source" opens the ranked list.

(function () {
    const fr = () => window.currentLang === 'fr';
    const tx = (en, frText) => (fr() ? frText : en);

    let dialog, backdrop, statusEl, loadingStatus, list, chooseBtn, card;
    let media = null;          // the title being opened (window.activeStreamingMedia when the dialog opened)
    let open = false;
    let last = null;           // the last status shown { status, detail, pct, error }

    const playerOpen = () => {
        const m = el('video-modal');
        return !!(m && m.style.display === 'flex' && !m.classList.contains('minimized'));
    };
    const inPlayer = () => dialog.classList.contains('in-player');
    const listShown = () => list.style.display === 'flex';
    const listHasSources = () => !!list.querySelector('button');
    const manualVisible = () => chooseBtn && chooseBtn.style.display === 'block';

    /** The flow's status markup -> { status, detail, pct, error }: the first line without the title (the card shows
     *  it), the smaller lines after it, a percentage when one is given, and whether it is a failure. */
    function readStatus() {
        const html = statusEl.innerHTML;
        const clone = statusEl.cloneNode(true);
        clone.querySelectorAll('svg, style, button').forEach(n => n.remove());   // (the error's "Back to Streams")
        // the title (bold in the flow's messages) is on the card already; other bold text (an error) stays
        const title = String((media && media.title) || '').trim();
        clone.querySelectorAll('strong').forEach((n) => { if (title && n.textContent.includes(title)) n.remove(); });
        const parts = clone.innerHTML.split(/<br\s*\/?>/i).map((h) => {
            const d = document.createElement('div');
            d.innerHTML = h;
            return d.textContent.replace(/\s+/g, ' ').trim();
        }).filter(Boolean);
        const status = (parts[0] || '').replace(/\s*:\s*$/, '').replace(/\.\.\.$/, '…');
        const detail = parts.slice(1).join(' · ').replace(/^[.\s]+$/, '');
        const m = /(\d{1,3})\s?%/.exec(statusEl.textContent || '');
        const spin = loadingStatus.querySelector('.spinner');
        const error = /signal-alert/.test(html) || (spin && spin.style.display === 'none' && !listShown());
        return { status, detail, pct: m ? Math.min(100, Number(m[1])) : null, error };
    }

    function titleLines() {
        const m = media || {};
        const isEp = m.mediaType === 'tv' && m.season != null && m.episode != null;
        return { title: m.title || '', sub: isEp && window.episodeLabel ? window.episodeLabel(m.season, m.episode) : (m.year ? String(m.year) : '') };
    }

    /** The title being opened: the flow may be asked for another one while this one loads (the next button twice). */
    function syncMedia() {
        const m = window.activeStreamingMedia || null;
        if (m === media) return;
        media = m;
        if (media && media.mediaType === 'tv' && media.season != null && window.tvEpisodeInfo) {
            window.tvEpisodeInfo(media.tmdbId, media.season, media.episode).then((info) => {
                if (info && info.name && media === m) { m.episodeName = m.episodeName || info.name; render(); }
            }).catch(() => {});
        }
    }

    function render() {
        if (!open) return;
        syncMedia();
        const s = last = readStatus();
        const { title, sub } = titleLines();
        card.querySelector('.sl-title').textContent = title;
        card.querySelector('.sl-sub').textContent = sub + (media && media.episodeName ? ` · ${media.episodeName}` : '');
        card.querySelector('.sl-status').textContent = s.status;
        card.querySelector('.sl-detail').textContent = s.detail;
        const bar = card.querySelector('.sl-bar');
        bar.classList.toggle('determinate', s.pct != null);
        bar.firstElementChild.style.width = s.pct != null ? `${s.pct}%` : '';
        card.classList.toggle('error', !!s.error);
        const canChoose = listHasSources() || manualVisible();
        const choose = card.querySelector('.sl-choose');
        choose.textContent = listShown() ? tx('Hide sources', 'Masquer les sources') : tx('Choose source', 'Choisir la source');
        choose.style.display = canChoose ? '' : 'none';
        dialog.classList.toggle('list-open', listShown());
        if (inPlayer() && typeof window.upNextLoading === 'function') {
            window.upNextLoading({ media, ...s, canChoose, onCancel: cancel, onChoose: chooseSource });
        }
    }

    /** Close the dialog the way its own close button does (the flow checks display 'none' to stop). */
    function cancel() {
        dialog.style.display = 'none';
        if (backdrop) backdrop.style.display = 'none';
    }

    /** Show the ranked list (out of the player card, over the player when it is open); or, while the last source
     *  opens, run the normal search instead (the flow's own "Choose Manually"). */
    function chooseSource() {
        if (!listHasSources() && manualVisible()) { chooseBtn.click(); return; }
        if (!listHasSources()) return;
        leavePlayerMode();
        list.style.display = listShown() ? 'none' : 'flex';
        render();
    }

    function leavePlayerMode() {
        if (!inPlayer()) return;
        dialog.classList.remove('in-player');
        if (backdrop) backdrop.classList.remove('in-player');
        if (typeof window.upNextLoading === 'function') window.upNextLoading(null);
    }

    function onOpen() {
        open = true;
        media = null;
        const p = playerOpen();
        dialog.classList.toggle('in-player', p);
        dialog.classList.toggle('over-player', p);     // when it does show with the player open (the list), above it
        if (backdrop) { backdrop.classList.toggle('in-player', p); backdrop.classList.toggle('over-player', p); }
        dialog.classList.remove('list-open');
        render();
    }

    function onClose() {
        open = false;
        if (inPlayer() && typeof window.upNextLoading === 'function') window.upNextLoading(null);
        dialog.classList.remove('in-player', 'list-open');
        if (backdrop) backdrop.classList.remove('in-player', 'over-player');
    }

    document.addEventListener('DOMContentLoaded', () => {
        dialog = el('rd-stream-dialog');
        backdrop = el('rd-stream-backdrop');
        statusEl = el('rd-status-text');
        loadingStatus = el('rd-loading-status');
        list = el('rd-torrents-list');
        chooseBtn = el('btn-rd-choose-manually');
        card = dialog && dialog.querySelector('.sl-card');
        if (!dialog || !statusEl || !loadingStatus || !list || !card) return;
        card.querySelector('.sl-close').addEventListener('click', (e) => { e.stopPropagation(); cancel(); });
        card.querySelector('.sl-choose').addEventListener('click', (e) => { e.stopPropagation(); chooseSource(); });

        let wasOpen = false;
        new MutationObserver(() => {
            const isOpen = dialog.style.display !== 'none' && dialog.style.display !== '';
            if (isOpen && !wasOpen) onOpen();
            else if (!isOpen && wasOpen) onClose();
            wasOpen = isOpen;
        }).observe(dialog, { attributes: true, attributeFilter: ['style'] });
        // the flow re-renders its status, spinner, list and "Choose Manually" button as it goes
        const changed = () => {
            if (!open) return;
            // the CAM/3D-only case reveals the list itself: show it (over the player when that is open)
            if (listShown() && inPlayer()) leavePlayerMode();
            render();
        };
        const mo = new MutationObserver(changed);
        mo.observe(statusEl, { childList: true, subtree: true, characterData: true });
        mo.observe(loadingStatus, { attributes: true, subtree: true, attributeFilter: ['style'] });
        mo.observe(list, { attributes: true, attributeFilter: ['style'], childList: true });
    });
})();
