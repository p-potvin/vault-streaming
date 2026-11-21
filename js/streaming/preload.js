// js/streaming/preload.js — the next episode, ready before it is needed. 30 s before the end of an episode (its credits
// point when the series has one, js/player/series-controls.js), the next episode's source is found and resolved the way
// a play would (its last source, else the search and the ranked queue: Real-Debrid / Comet only, no Deepbrid and no
// waiting), its link kept warm, and its Moments read (embeddings + AI transcript, vault-raggae) queued right away.
// Play next (the card, autoplay, the next button, the episodes panel) then opens it at once (rd-flow.js,
// takePreloadedEpisode). Nothing is shown while it works; a failure only means Play next searches as usual.

(function () {
    const PRELOAD_BEFORE_END_S = 30;
    const KEEP_MS = 30 * 60 * 1000;       // a resolved link older than this is not used (the search runs again)
    const WARM_EVERY_MS = 60 * 1000;
    const MAX_TRIES = 5;                  // sources asked from the ranked queue

    let current = null;   // { key, streamUrl, source, list, at, warm, media }
    let pending = null;   // key being resolved
    let pendingDone = null;   // its promise (Play next waits for it rather than resolving the same link twice)

    window.PRELOAD_BEFORE_END_S = PRELOAD_BEFORE_END_S;

    const keyOf = (idOrTitle, season, episode) => `${String(idOrTitle)}:${Number(season)}:${Number(episode)}`;

    function drop() {
        if (current && current.warm) clearInterval(current.warm);
        current = null;
    }

    async function resolveLastSource(show, season, episode) {
        if (!window.electronAPI.getWatchProgress) return null;
        const prog = await window.electronAPI.getWatchProgress({ mediaType: 'tv', tmdbId: show.tmdbId, title: show.title, season, episode })
            .catch(() => null);
        const src = prog && prog.lastSource;
        if (!src || !src.url || prog.season !== season || prog.episode !== episode) return null;
        const r = await window.electronAPI.streamRDTorrent({ url: src.url, hash: src.hash, name: src.name, cached: false }).catch(() => null);
        if (!r || !r.success || !r.streamUrl || r.placeholder) return null;
        const t = { ...src, isRDCached: true, cached: true, fit: 'exact', type: `⚡ ${src.name || ''}`, seeds: '—', peers: '—' };
        return { streamUrl: r.streamUrl, source: t, list: [t] };
    }

    async function resolveBySearch(show, season, episode) {
        const res = await window.electronAPI.searchTorrents({ movieTitle: show.title, tmdbId: show.tmdbId, mediaType: 'tv', season, episode })
            .catch(() => null);
        const torrents = res && res.success && Array.isArray(res.torrents) ? res.torrents : [];
        if (!torrents.length || !window.rankTorrents || !window.buildPlayQueue) {
            console.log(`[preload] search: ${res && res.success ? 'no sources' : `failed (${(res && res.error) || 'no answer'})`}`);
            return null;
        }
        const scored = window.rankTorrents(torrents.map(t => ({ ...t, isUsenet: false, isRDCached: !!t.cached })));
        const queue = window.buildPlayQueue(scored, { max: Infinity });
        const list = [...queue, ...scored.filter(t => !queue.includes(t))];
        const rejected = window.isRejectedForAutoPlay || (() => false);
        const tries = queue.filter(t => t.url && !rejected(t) && t.fit !== 'other').slice(0, MAX_TRIES);
        for (const t of tries) {
            const r = await window.electronAPI.streamRDTorrent({ magnet: t.magnet, hash: t.hash, url: t.url, name: t.name, cached: !!t.isRDCached })
                .catch(() => null);
            if (r && r.success && r.streamUrl) return { streamUrl: r.streamUrl, source: t, list };
            console.log(`[preload] source not resolved (${(r && r.error) || 'no answer'}): ${String(t.desc || t.name || '').slice(0, 60)}`);
        }
        if (!tries.length) console.log(`[preload] ${torrents.length} source(s), none to try ahead (no link, rejected or another episode)`);
        return null;
    }

    /** The next episode's Moments read, queued now (the play itself hands it over again: already queued, skipped). */
    async function queueMoments(show, season, episode, got) {
        if (!window.electronAPI.indexPlayback || (window.appSettings && window.appSettings.indexPlayback === false)) return;
        const lang = (typeof getPreferredLang === 'function' ? getPreferredLang() : null) || 'en';
        const probe = window.electronAPI.probeAudioTracks
            ? await window.electronAPI.probeAudioTracks({ url: got.streamUrl, preferredLang: lang }).catch(() => null) : null;
        const tracks = probe && probe.success && Array.isArray(probe.tracks) ? probe.tracks : [];
        const audioIndex = probe && probe.chosenAudioIndex != null ? probe.chosenAudioIndex : 0;
        const track = tracks.find(x => x.audioIndex === audioIndex) || null;
        // a track without a language tag can be swapped by the play's speech detection (player.js): the read would be
        // of another track under the same key. Left to the play's own hand-over then.
        if (!track || !track.lang || track.lang === 'und') {
            console.log(`[preload] Moments for ${window.episodeLabel(season, episode)}: left to playback (audio language not tagged)`);
            return;
        }
        const release = String(got.source.desc || '').replace(/^📄\s*/, '');
        const label = window.qualityLabelOf ? window.qualityLabelOf(got.source) : null;
        const src = window.momentsSourceFor
            ? await window.momentsSourceFor(got.streamUrl, { release }, track ? track.lang : null, got.list, label)
            : { url: got.streamUrl };
        const r = await window.electronAPI.indexPlayback({
            url: src.url, title: show.title, tmdbId: show.tmdbId, mediaType: 'tv', season, episode,
            audioIndex: src.audioIndex != null ? src.audioIndex : audioIndex,
            language: track ? track.lang : 'und', languageSource: track ? track.langSource : 'none',
            durationSec: probe && probe.durationSeconds ? probe.durationSeconds : null,
            sourceRelease: src.release || release || null,
        }).catch(e => ({ error: e && e.message }));
        console.log(`[preload] Moments for ${window.episodeLabel(season, episode)}:`, r && (r.state || r.skipped || r.error));
    }

    /** Resolve `next` ({ season, episode }) of the series `show` (the playing media) ahead of time. */
    window.preloadNextEpisode = async function (show, next) {
        if (!show || !next || !window.electronAPI || !window.electronAPI.streamRDTorrent) return;
        const key = keyOf(show.tmdbId || show.title, next.season, next.episode);
        if (pending === key || (current && current.key === key)) return;
        pending = key;
        let settle;
        pendingDone = new Promise(r => { settle = r; });
        const label = window.episodeLabel(next.season, next.episode);
        console.log(`[preload] ${show.title} ${label}: resolving the next episode`);
        try {
            const got = await resolveLastSource(show, next.season, next.episode)
                || await resolveBySearch(show, next.season, next.episode);
            if (pending !== key) return;
            if (!got) { console.log(`[preload] ${label}: no source resolved ahead (Play next will search)`); return; }
            drop();
            current = { key, ...got, at: Date.now(), media: show };
            current.warm = setInterval(() => {
                if (!current || Date.now() - current.at > KEEP_MS) { drop(); return; }
                if (window.electronAPI.keepStreamWarm) window.electronAPI.keepStreamWarm({ url: current.streamUrl }).catch(() => {});
            }, WARM_EVERY_MS);
            console.log(`[preload] ${label} ready: ${(got.source.quality || '')} ${String(got.source.desc || got.source.name || '').slice(0, 70)}`);
            queueMoments(show, next.season, next.episode, got).catch(e => console.warn('[preload] Moments:', e && e.message));
        } catch (e) {
            console.warn('[preload] failed:', e && e.message);
        } finally {
            if (pending === key) { pending = null; pendingDone = null; }
            settle();
        }
    };

    /** The pre-loaded stream for this episode (taken: used once), or null; waits for one still resolving. */
    window.takePreloadedEpisode = async function (idOrTitle, season, episode) {
        const key = keyOf(idOrTitle, season, episode);
        if (pending === key && pendingDone) await pendingDone;   // still resolving this one: its result, not a 2nd try
        if (!current || current.key !== key) return null;
        const p = current;
        current = null;
        if (p.warm) clearInterval(p.warm);
        return Date.now() - p.at <= KEEP_MS ? p : null;
    };
})();
