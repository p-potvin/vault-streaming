// js/player/jump-to.js — "jump to" inside the playing title (vault-raggae semantic plan section 3.3).
//
// A line ("where they say winter") or a scene ("the car chase") in what is playing, from the Moments vault-raggae
// keeps of every streamed title (src/ipc/moments.ipc.js: lines said first, then scenes seen). Low-key on purpose
// (operator: a cool feature but rarely used): one small button among the right-hand controls, shown only while a
// catalog title streams, and a compact box above it. A title becomes searchable after it has played a little while.

(function () {
    const MAX_ROWS = 6;
    let reqId = 0;

    function media() {
        const m = window.activeStreamingMedia;
        return m && m.tmdbId ? m : null;
    }

    function clock(sec) {
        const s = Math.max(0, Math.floor(sec || 0));
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
        return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
    }

    function els() {
        return {
            box: el('jump-dropdown-container'), btn: el('btn-jump'), menu: el('jump-menu'),
            input: el('jump-input'), list: el('jump-results'), vp: el('video-player'),
        };
    }

    function isOpen() {
        const { menu } = els();
        return !!menu && menu.style.display === 'block';
    }

    function close() {
        const { menu, btn } = els();
        const wasOpen = isOpen();
        if (menu) menu.style.display = 'none';
        if (btn) btn.setAttribute('aria-expanded', 'false');
        // the idle timer kept the controls while the box was open: start it again (js/player/player.js)
        if (wasOpen) document.dispatchEvent(new MouseEvent('mousemove'));
    }

    function open() {
        const { menu, btn, input } = els();
        if (!menu || !media()) return;
        menu.style.display = 'block';
        if (btn) btn.setAttribute('aria-expanded', 'true');
        if (input) { input.focus(); input.select(); }
    }

    function note(text) {
        const { list } = els();
        if (!list) return;
        list.innerHTML = '';
        const p = document.createElement('div');
        p.className = 'jump-note';
        p.textContent = text;
        list.append(p);
    }

    async function search() {
        const { input, list, vp } = els();
        const m = media();
        const q = input ? input.value.trim() : '';
        if (!q || !m || !window.electronAPI || !window.electronAPI.jumpSearch) return;
        const id = ++reqId;
        note(tr('jumpSearching', 'Searching…'));
        let res = null;
        try {
            res = await window.electronAPI.jumpSearch({
                tmdbId: m.tmdbId, mediaType: m.mediaType, season: m.season, episode: m.episode, q,
            });
        } catch (_) { res = null; }
        if (id !== reqId || !list) return;
        if (!res || res.error) {
            note(tr('jumpUnreachable', 'The catalog did not answer. Try again in a moment.'));
            return;
        }
        const hits = Array.isArray(res.hits) ? res.hits.slice(0, MAX_ROWS) : [];
        if (!hits.length) {
            note(res.indexed ? tr('jumpNothing', 'Nothing matches in this title.')
                : tr('jumpNotIndexed', 'This title becomes searchable after it has played for a little while.'));
            return;
        }
        list.innerHTML = '';
        // the times come from the source Moments read; another cut of the title (a longer opening, say) shifts them
        if (Number.isFinite(res.duration) && vp && Number.isFinite(vp.duration) && vp.duration > 0
            && Math.abs(vp.duration - res.duration) > 30) {
            const warn = document.createElement('div');
            warn.className = 'jump-note warn';
            warn.textContent = tr('jumpOtherCut', 'Read from another cut of this title: the times may be off.');
            list.append(warn);
        }
        for (const h of hits) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'jump-row';
            const time = document.createElement('span');
            time.className = 'jump-time';
            time.textContent = clock(h.t0);
            const text = document.createElement('span');
            text.className = 'jump-text';
            if (h.kind === 'said' && h.said) {
                text.textContent = `“${h.said}”`;
            } else {
                text.textContent = tr('jumpScene', 'Scene');
                text.classList.add('scene');
            }
            row.append(time, text);
            row.onclick = () => {
                if (vp && Number.isFinite(h.t0)) {
                    const t = Number.isFinite(vp.duration) ? Math.min(h.t0, Math.max(0, vp.duration - 1)) : h.t0;
                    vp.currentTime = t;
                    if (vp.paused) vp.play().catch(() => { });
                }
                close();
            };
            list.append(row);
        }
    }

    /** Shown only while a catalog title streams (the key is that title's); hidden, and closed, otherwise. */
    function refresh() {
        const { box, input, list } = els();
        if (!box) return;
        const m = media();
        const key = m ? `${m.tmdbId}|${m.season || ''}|${m.episode || ''}` : null;
        box.style.display = m ? '' : 'none';
        if (box.dataset.title !== key) {          // another title: nothing of the last search stays
            box.dataset.title = key || '';
            if (input) input.value = '';
            if (list) list.innerHTML = '';
            close();
        }
        if (!m) close();
    }

    function wire() {
        const { btn, menu, input, vp } = els();
        if (!btn || !menu || !input) return;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isOpen()) close(); else open();
        });
        menu.addEventListener('click', (e) => e.stopPropagation());
        // Escape anywhere in the box (the field, a result) closes it and gives the focus back to its button
        el('jump-dropdown-container').addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && isOpen()) {
                e.preventDefault();
                e.stopPropagation();
                close();
                btn.focus();
            }
        });
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();                  // typing here is not a player shortcut
            if (e.key === 'Enter') { e.preventDefault(); search(); }
            if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); }
            document.dispatchEvent(new MouseEvent('mousemove'));   // typing is activity: the controls stay
        });
        document.addEventListener('click', () => { if (isOpen()) close(); });
        if (vp) ['loadstart', 'loadedmetadata', 'playing', 'emptied'].forEach(ev => vp.addEventListener(ev, refresh));
        refresh();
    }

    window.jumpToRefresh = refresh;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})();
