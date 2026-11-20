// js/player/episodes.js — what the player knows about the series it is playing: season lists and episode details
// (TMDB, cached for the session), the previous / next episode, and the titles shown over the player and in the app bar.
// Used by the player's prev/next buttons, the "Up next" card, the episodes panel and the skip-intro/outro setting.

(function () {
    const _shows = new Map();     // tvId -> Promise<tv details | null>
    const _seasons = new Map();   // "tvId:season" -> Promise<episodes[]>

    /** A TMDB id the TMDB calls accept (an IMDb "tt…" id or a missing one cannot be used). */
    function tmdbIdOf(id) {
        const n = Number(id);
        return Number.isInteger(n) && n > 0 ? n : null;
    }

    function lang() {
        return typeof window.tmdbLanguage === 'function' ? window.tmdbLanguage() : undefined;
    }

    /** The show's details (seasons with episode counts), or null. */
    window.tvShowDetails = function (tvId) {
        const id = tmdbIdOf(tvId);
        if (!id || !window.electronAPI || !window.electronAPI.getTMDBTV) return Promise.resolve(null);
        if (!_shows.has(id)) {
            _shows.set(id, window.electronAPI.getTMDBTV({ id, language: lang() })
                .then(r => (r && r.success && r.data) ? r.data : null)
                .catch(() => null));
        }
        return _shows.get(id);
    };

    /** The episodes of one season ([] when unknown). */
    window.tvSeasonEpisodes = function (tvId, season) {
        const id = tmdbIdOf(tvId);
        if (!id || season == null || !window.electronAPI || !window.electronAPI.getTMDBTVSeason) return Promise.resolve([]);
        const key = `${id}:${season}`;
        if (!_seasons.has(key)) {
            _seasons.set(key, window.electronAPI.getTMDBTVSeason({ id, seasonNumber: Number(season), language: lang() })
                .then(r => (r && r.success && r.data && Array.isArray(r.data.episodes)) ? r.data.episodes : [])
                .catch(() => []));
        }
        return _seasons.get(key);
    };

    /** Seasons worth listing (no specials, at least one episode), in order. */
    window.tvSeasonsOf = async function (tvId) {
        const show = await window.tvShowDetails(tvId);
        return ((show && show.seasons) || [])
            .filter(s => s.season_number > 0 && s.episode_count > 0)
            .sort((a, b) => a.season_number - b.season_number);
    };

    /** TMDB's episode object, or null. */
    window.tvEpisodeInfo = async function (tvId, season, episode) {
        const eps = await window.tvSeasonEpisodes(tvId, season);
        return eps.find(e => e.episode_number === Number(episode)) || null;
    };

    /**
     * The episode before (dir = -1) or after (dir = +1): same season ±1, else the last episode of the previous season /
     * the first of the next. { season, episode, info } or null at either end of the show (or when it is unknown).
     */
    window.tvAdjacentEpisode = async function (tvId, season, episode, dir) {
        const seasons = await window.tvSeasonsOf(tvId);
        if (!seasons.length) return null;
        const s = Number(season), e = Number(episode);
        const idx = seasons.findIndex(x => x.season_number === s);
        if (idx < 0) return null;
        let target = null;
        if (dir > 0) {
            if (e < seasons[idx].episode_count) target = { season: s, episode: e + 1 };
            else if (seasons[idx + 1]) target = { season: seasons[idx + 1].season_number, episode: 1 };
        } else {
            if (e > 1) target = { season: s, episode: e - 1 };
            else if (seasons[idx - 1]) target = { season: seasons[idx - 1].season_number, episode: seasons[idx - 1].episode_count };
        }
        if (!target) return null;
        target.info = await window.tvEpisodeInfo(tvId, target.season, target.episode);
        return target;
    };

    window.episodeLabel = (season, episode) =>
        `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

    /** "American Dad! · S06E14 · Cops and Roger" (the episode name once known), or the film's title. */
    window.playerTitleText = function (media, info) {
        if (!media) return '';
        if (media.mediaType !== 'tv' || media.season == null || media.episode == null) return media.title || '';
        const parts = [media.title || '', window.episodeLabel(media.season, media.episode)];
        if (info && info.name) parts.push(info.name);
        return parts.filter(Boolean).join(' · ');
    };

    /** Write the title into the player's top bar and the app's title bar, then again once the episode name is known. */
    window.updatePlayerTitles = function (fallbackTitle) {
        const media = window.activeStreamingMedia;
        const write = (text) => {
            const t = el('player-title');
            if (t) t.textContent = text;
            const tb = el('titlebar-video-title');
            if (tb) { tb.textContent = text; tb.style.display = 'inline-block'; }
        };
        write(media ? window.playerTitleText(media) : String(fallbackTitle || ''));
        if (media && media.mediaType === 'tv' && media.season != null) {
            window.tvEpisodeInfo(media.tmdbId, media.season, media.episode).then((info) => {
                if (info && window.activeStreamingMedia === media) {
                    media.episodeName = info.name || null;
                    write(window.playerTitleText(media, info));
                }
            });
        }
    };
})();
