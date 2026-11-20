// js/player/series-controls.js — the player's series features (episode data from js/player/episodes.js):
//   • previous / next episode buttons, with a hover preview (still, label, title, air date / runtime);
//   • the "Up next" card, bottom-left, N seconds before the end (Settings → "Up next card", default 40 s), which also
//     carries autoplay: at the end it counts down 5 s (autoplay on) or waits for "Play now";
//   • the per-series "skip intro / skip credits" seconds (set in the series' details window): the intro is jumped over
//     when an episode starts from the beginning, the credits point counts as the end;
//   • the episodes panel (a drawer over the video): seasons, episodes with still, title and watched marks, click to play.
// Library files keep the playlist behaviour in player.js; everything here applies only while a series episode plays.

(function () {
    const fr = () => window.currentLang === 'fr';
    const tx = (en, frText) => (fr() ? frText : en);
    const STILL = (p, size = 'w300') => (p ? `https://image.tmdb.org/t/p/${size}${p}` : '');
    const UP_NEXT_DEFAULT = 40;

    let vp = null;
    let state = null;   // per episode: { media, next, prev, card: 'hidden'|'shown'|'dismissed', introDone, ended, countdown }

    const isSeries = () => {
        const m = window.activeStreamingMedia;
        return !!(m && m.mediaType === 'tv' && m.season != null && m.episode != null);
    };

    /** Settings → "Up next card" seconds before the end (0 = off), default 40. */
    window.upNextSeconds = function (value) {
        const raw = value !== undefined ? value : (window.appSettings && window.appSettings.upNextSeconds);
        const n = Math.round(Number(raw));
        return raw === '' || raw == null || !Number.isFinite(n) ? UP_NEXT_DEFAULT : Math.min(600, Math.max(0, n));
    };

    /** The per-series skip seconds { intro, outro } (0 = none), saved in appSettings.seriesSkip[tvId]. */
    window.seriesSkipFor = function (tvId) {
        const all = (window.appSettings && window.appSettings.seriesSkip) || {};
        const v = all[String(tvId)] || {};
        const clamp = (x) => { const n = Math.round(Number(x)); return Number.isFinite(n) && n > 0 ? Math.min(900, n) : 0; };
        return { intro: clamp(v.intro), outro: clamp(v.outro) };
    };

    window.setSeriesSkip = function (tvId, intro, outro) {
        window.appSettings = window.appSettings || {};
        const all = window.appSettings.seriesSkip = window.appSettings.seriesSkip || {};
        const v = { intro: Math.max(0, Math.round(Number(intro) || 0)), outro: Math.max(0, Math.round(Number(outro) || 0)) };
        if (!v.intro && !v.outro) delete all[String(tvId)]; else all[String(tvId)] = v;
        if (window.electronAPI && window.electronAPI.saveSettings) window.electronAPI.saveSettings(window.appSettings);
    };

    /** Play another episode of the series now playing (the normal stream flow: last source, else the search). */
    function playEpisode(season, episode) {
        const m = window.activeStreamingMedia;
        if (!m || typeof window.triggerRDStream !== 'function') return;
        hideCard();
        closePanel();
        window.triggerRDStream(m.title, m.tmdbId, 'tv', season, episode, { poster: m.poster, year: m.year });
    }
    window.playSeriesEpisode = playEpisode;

    function effectiveEnd() {
        if (!vp || !(vp.duration > 0) || !state) return Infinity;
        const { outro } = window.seriesSkipFor(state.media.tmdbId);
        return outro > 0 && outro < vp.duration - 30 ? vp.duration - outro : vp.duration;
    }

    // ── Previous / next buttons ─────────────────────────────────────────────────
    let preview = null;
    function previewEl() {
        if (preview) return preview;
        preview = document.createElement('div');
        preview.className = 'series-nav-preview';
        (el('custom-controls') || document.body).appendChild(preview);
        return preview;
    }

    function showNavPreview(btn, target, label) {
        const p = previewEl();
        if (!target) {
            p.innerHTML = `<div class="snp-body"><div class="snp-label">${window.escapeHtml(label)}</div>
                <div class="snp-title">${window.escapeHtml(tx('No episode', 'Aucun épisode'))}</div></div>`;
        } else {
            const info = target.info || {};
            const meta = [info.air_date ? info.air_date.slice(0, 4) : '', info.runtime ? `${info.runtime} min` : ''].filter(Boolean).join(' · ');
            p.innerHTML = `${info.still_path ? `<img class="snp-still" alt="" src="${STILL(info.still_path)}">` : ''}
                <div class="snp-body">
                  <div class="snp-label">${window.escapeHtml(`${label} · ${window.episodeLabel(target.season, target.episode)}`)}</div>
                  <div class="snp-title">${window.escapeHtml(info.name || '')}</div>
                  ${meta ? `<div class="snp-meta">${window.escapeHtml(meta)}</div>` : ''}
                </div>`;
        }
        const r = btn.getBoundingClientRect();
        const host = p.parentElement.getBoundingClientRect();
        p.style.left = `${Math.max(8, r.left - host.left)}px`;
        p.style.display = 'flex';
    }

    function wireNavButton(id, dir) {
        const btn = el(id);
        if (!btn) return;
        const label = () => (dir > 0 ? tx('Next', 'Suivant') : tx('Previous', 'Précédent'));
        btn.addEventListener('mouseenter', (e) => {
            if (!isSeries() || !state) return;
            e.stopImmediatePropagation();
            const t = dir > 0 ? state.next : state.prev;
            if (t && typeof t.then === 'function') t.then(x => showNavPreview(btn, x, label()));
            else showNavPreview(btn, t, label());
        }, true);
        btn.addEventListener('mouseleave', (e) => {
            if (!isSeries()) return;
            e.stopImmediatePropagation();
            if (preview) preview.style.display = 'none';
        }, true);
        btn.addEventListener('click', async (e) => {
            if (!isSeries() || !state) return;
            e.stopImmediatePropagation();
            e.preventDefault();
            const t = await (dir > 0 ? state.next : state.prev);
            if (t) playEpisode(t.season, t.episode);
        }, true);
    }

    function showNavButtons(show) {
        for (const id of ['btn-prev', 'btn-next']) {
            const b = el(id);
            if (b) b.style.display = show ? 'block' : 'none';
        }
    }

    // ── Up next card ───────────────────────────────────────────────────────────
    let card = null;
    function cardEl() {
        if (card) return card;
        card = document.createElement('div');
        card.id = 'up-next-card';
        card.setAttribute('role', 'dialog');
        const wrapper = vp && vp.parentElement;   // inside .video-wrapper, so it shows in fullscreen too
        (wrapper || document.body).appendChild(card);
        return card;
    }

    function hideCard() {
        if (state && state.countdown) { clearInterval(state.countdown); state.countdown = null; }
        if (card) card.classList.remove('visible');
    }

    function renderCard(next, countdownSec) {
        const c = cardEl();
        const info = next.info || {};
        const meta = [info.air_date ? info.air_date.slice(0, 4) : '', info.runtime ? `${info.runtime} min` : ''].filter(Boolean).join(' · ');
        c.innerHTML = `
            ${info.still_path ? `<img class="unc-still" alt="" src="${STILL(info.still_path)}">` : '<div class="unc-still unc-still-empty"></div>'}
            <div class="unc-body">
              <div class="unc-kicker">${window.escapeHtml(tx('Up next', 'À suivre'))} · ${window.escapeHtml(window.episodeLabel(next.season, next.episode))}</div>
              <div class="unc-title">${window.escapeHtml(info.name || '')}</div>
              ${meta ? `<div class="unc-meta">${window.escapeHtml(meta)}</div>` : ''}
              ${info.overview ? `<div class="unc-overview">${window.escapeHtml(info.overview)}</div>` : ''}
              <div class="unc-actions">
                <button type="button" class="unc-play">${window.icons ? window.icons.play('', 'width:11px;height:11px;') : ''}
                  <span>${window.escapeHtml(countdownSec != null
                      ? tx(`Playing in ${countdownSec} s`, `Lecture dans ${countdownSec} s`) : tx('Play now', 'Lire maintenant'))}</span></button>
                <button type="button" class="unc-dismiss" title="${window.escapeHtml(tx('Hide', 'Masquer'))}"
                  aria-label="${window.escapeHtml(tx('Hide', 'Masquer'))}">${window.icons ? window.icons.close('', 'width:12px;height:12px;') : '×'}</button>
              </div>
            </div>`;
        c.querySelector('.unc-play').onclick = (e) => { e.stopPropagation(); playEpisode(next.season, next.episode); };
        c.querySelector('.unc-dismiss').onclick = (e) => {
            e.stopPropagation();
            if (state) state.card = 'dismissed';
            hideCard();
        };
        c.classList.add('visible');
    }

    async function maybeShowCard() {
        if (!state || state.card !== 'hidden') return;
        const secs = window.upNextSeconds();
        if (!secs) return;
        const left = effectiveEnd() - vp.currentTime;
        if (!(left <= secs && left > 0)) return;
        state.card = 'shown';
        const next = await state.next;
        if (!next || !state || state.card !== 'shown') return;
        renderCard(next, null);
    }

    /** The episode ended (or reached its credits): next one after a 5 s countdown with autoplay on, else the card. */
    window.upNextOnEnded = async function () {
        if (!state || state.ended) return;
        state.ended = true;
        const next = await state.next;
        if (!next) return;
        if (window.autoplayMode === 'off') { state.card = 'shown'; renderCard(next, null); return; }
        let n = 5;
        state.card = 'shown';
        renderCard(next, n);
        state.countdown = setInterval(() => {
            n -= 1;
            if (!state || state.card === 'dismissed') { hideCard(); return; }
            if (n <= 0) { hideCard(); playEpisode(next.season, next.episode); return; }
            renderCard(next, n);
        }, 1000);
    };

    // ── Episodes panel ─────────────────────────────────────────────────────────
    let panel = null;
    function closePanel() { if (panel) panel.classList.remove('open'); }

    async function renderPanelSeason(season) {
        const m = window.activeStreamingMedia;
        const list = panel.querySelector('.ep-panel-list');
        list.innerHTML = `<div class="ep-panel-empty">${window.escapeHtml(tx('Loading…', 'Chargement…'))}</div>`;
        const [eps, prog] = await Promise.all([
            window.tvSeasonEpisodes(m.tmdbId, season),
            window.electronAPI.getShowProgress ? window.electronAPI.getShowProgress({ tmdbId: m.tmdbId, title: m.title }).catch(() => null) : null,
        ]);
        if (window.activeStreamingMedia !== m) return;
        const saved = new Map(((prog && prog.items) || []).map(it => [`${it.season}:${it.episode}`, it]));
        if (!eps.length) { list.innerHTML = `<div class="ep-panel-empty">${window.escapeHtml(tx('No episodes found.', 'Aucun épisode trouvé.'))}</div>`; return; }
        list.innerHTML = '';
        for (const ep of eps) {
            const it = saved.get(`${season}:${ep.episode_number}`);
            const current = Number(season) === Number(m.season) && ep.episode_number === Number(m.episode);
            const pct = it && it.durationSec > 0 ? Math.min(100, Math.round(it.positionSec / it.durationSec * 100)) : 0;
            const row = document.createElement('button');
            row.type = 'button';
            row.className = `ep-panel-row${current ? ' current' : ''}${it && it.completed ? ' watched' : ''}`;
            row.innerHTML = `
                <span class="ep-panel-thumb">${ep.still_path ? `<img alt="" loading="lazy" src="${STILL(ep.still_path)}">` : ''}
                  ${it && (it.completed || pct) ? `<span class="ep-panel-bar"><span style="width:${it.completed ? 100 : pct}%"></span></span>` : ''}</span>
                <span class="ep-panel-text">
                  <span class="ep-panel-num">${window.escapeHtml(`E${ep.episode_number}`)}${it && it.completed ? ' <span class="ep-panel-check">✓</span>' : ''}${current ? ` <span class="ep-panel-now">${window.escapeHtml(tx('Playing', 'En cours'))}</span>` : ''}</span>
                  <span class="ep-panel-name">${window.escapeHtml(ep.name || `Episode ${ep.episode_number}`)}</span>
                  <span class="ep-panel-meta">${window.escapeHtml([ep.air_date ? ep.air_date.slice(0, 4) : '', ep.runtime ? `${ep.runtime} min` : ''].filter(Boolean).join(' · '))}</span>
                </span>`;
            row.addEventListener('click', (e) => { e.stopPropagation(); if (!current) playEpisode(Number(season), ep.episode_number); });
            list.appendChild(row);
            if (current) requestAnimationFrame(() => row.scrollIntoView({ block: 'center' }));
        }
    }

    async function openPanel() {
        if (!isSeries()) return;
        const m = window.activeStreamingMedia;
        if (!panel) {
            panel = document.createElement('aside');
            panel.id = 'episodes-panel';
            panel.innerHTML = `
                <div class="ep-panel-head">
                  <select class="ep-panel-season" aria-label="${window.escapeHtml(tx('Season', 'Saison'))}"></select>
                  <button type="button" class="ep-panel-close" aria-label="${window.escapeHtml(tx('Close', 'Fermer'))}">${window.icons ? window.icons.close('', 'width:13px;height:13px;') : '×'}</button>
                </div>
                <div class="ep-panel-list"></div>`;
            panel.addEventListener('click', (e) => e.stopPropagation());
            panel.addEventListener('dblclick', (e) => e.stopPropagation());
            panel.querySelector('.ep-panel-close').onclick = closePanel;
            panel.querySelector('.ep-panel-season').onchange = (e) => renderPanelSeason(Number(e.target.value));
            (vp.parentElement || document.body).appendChild(panel);
        }
        const seasons = await window.tvSeasonsOf(m.tmdbId);
        const sel = panel.querySelector('.ep-panel-season');
        sel.innerHTML = seasons.map(s => `<option value="${s.season_number}">${window.escapeHtml(s.name || `${tx('Season', 'Saison')} ${s.season_number}`)}</option>`).join('');
        sel.value = String(m.season);
        panel.classList.add('open');
        await renderPanelSeason(Number(m.season));
    }

    // ── Per episode: called by playStream once the stream is set ───────────────
    window.seriesControlsOnPlay = function () {
        hideCard();
        closePanel();
        const media = window.activeStreamingMedia;
        const series = isSeries();
        showNavButtons(series);
        const epBtn = el('btn-episodes');
        if (epBtn) epBtn.style.display = series ? '' : 'none';
        if (!series) { state = null; return; }
        state = {
            media, card: 'hidden', introDone: false, ended: false, countdown: null,
            next: window.tvAdjacentEpisode(media.tmdbId, media.season, media.episode, +1),
            prev: window.tvAdjacentEpisode(media.tmdbId, media.season, media.episode, -1),
        };
        state.next.then(n => { if (state && state.media === media) state.next = n; });
        state.prev.then(p => { if (state && state.media === media) state.prev = p; });
    };

    function onTime() {
        if (!state || !isSeries() || window.activeStreamingMedia !== state.media || !(vp.duration >= 60)) return;
        // skip the intro once, only when the episode starts at the beginning (a resume is left where it was)
        if (!state.introDone) {
            state.introDone = true;
            const { intro } = window.seriesSkipFor(state.media.tmdbId);
            if (intro > 0 && vp.currentTime < 5 && intro < vp.duration - 60) {
                vp.currentTime = intro;
                window.showToast(tx(`Intro skipped (${intro} s)`, `Intro passée (${intro} s)`), 'info');
            }
        }
        maybeShowCard();
        // the credits point counts as the end (the player's own "ended" covers episodes without one)
        const end = effectiveEnd();
        if (end < vp.duration && vp.currentTime >= end && !state.ended) {
            state.media.creditsDone = true;   // later saves (tick, close) keep it watched (player.js)
            window.electronAPI.markWatched({
                mediaType: 'tv', tmdbId: state.media.tmdbId, title: state.media.title, season: state.media.season,
                episode: state.media.episode, poster: state.media.poster, year: state.media.year,
            });
            vp.pause();
            window.upNextOnEnded();
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        vp = el('video-player');
        if (!vp) return;
        vp.addEventListener('timeupdate', onTime);
        // seeking back before the card's point hides it again
        vp.addEventListener('seeked', () => {
            if (!state) return;
            if (effectiveEnd() - vp.currentTime > window.upNextSeconds() && state.card === 'shown' && !state.ended) {
                state.card = 'hidden';
                hideCard();
            }
            if (vp.currentTime < effectiveEnd()) state.ended = false;
        });
        wireNavButton('btn-prev', -1);
        wireNavButton('btn-next', +1);
        const epBtn = el('btn-episodes');
        if (epBtn) epBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (panel && panel.classList.contains('open')) closePanel(); else openPanel();
        });
    });
})();
