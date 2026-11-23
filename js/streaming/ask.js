// js/streaming/ask.js — the Ask bar's parser (Panopticam's ask.ts, by way of vault-raggae's catalog app).
// A sentence becomes the filters it names (films or series, a year or decade, genres); whatever is left is searched
// by meaning in vault-raggae's catalog. Words in "quotes" go to the meaning search as written. English and French.
//
// Loaded in the renderer (window.vsAsk) and by node for tests (module.exports).

(function (root) {
    'use strict';

    // A whole word or phrase, accented letters included (a plain word boundary only knows ASCII letters).
    const w = src => new RegExp(String.raw`(?<![\p{L}\d])(?:` + src + String.raw`)(?![\p{L}\d])`, 'iu');

    // [pattern, media type, chip label key]; the first that matches wins
    const KINDS = [
        [w('films?|movies?'), 'movie', 'tabMovies'],
        [w('series|séries?|shows?|tv|télé'), 'tv', 'tabSeries'],
    ];

    // The catalog's genre names (IMDb's); the words people use for them, in English and French.
    // Musical comes before Comedy: "comédie musicale" is one genre.
    const GENRES = [
        [w('musicals?|comédies? musicales?'), 'Musical'],
        [w('sci-?fi|science[- ]fiction'), 'Sci-Fi'],
        [w('animated|animation|cartoons?|dessins? animés?'), 'Animation'],
        [w('documentar(?:y|ies)|docs?|documentaires?'), 'Documentary'],
        [w('romantic|romance|love stor(?:y|ies)|romantiques?'), 'Romance'],
        [w('comed(?:y|ies)|funny|comédies?|drôles?'), 'Comedy'],
        [w('horror|scary|horreur|épouvante'), 'Horror'],
        [w('thrillers?'), 'Thriller'],
        [w('crime|polici(?:er|ère)s?|polars?'), 'Crime'],
        [w('dramas?|drames?|dramatiques?'), 'Drama'],
        [w('action'), 'Action'],
        [w('adventures?|aventures?'), 'Adventure'],
        [w('fantasy|fantastiques?'), 'Fantasy'],
        [w('myster(?:y|ies)|mystères?'), 'Mystery'],
        [w('westerns?'), 'Western'],
        // "war" only before films / movies: "war on drugs" stays words
        [w(String.raw`war(?=\s+(?:films?|movies?)(?![\p{L}]))|guerre`), 'War'],
        [w('biograph(?:y|ies)|biopics?|biographies?'), 'Biography'],
        [w('family|familial|familiaux'), 'Family'],
        [w('sports?'), 'Sport'],
    ];

    function decade(two) {
        const d = Number(two);
        return d <= 20 ? 2000 + d : 1900 + d;
    }

    /**
     * "90s heist in Paris, french" -> { filters: { mediaType?, yearMin?, yearMax?, genres[] }, look, parts[] }.
     * `parts` are the "Read as" chips, one per thing understood: { key, label, labelKey?, kind: 'filter'|'look' }.
     */
    function parseAsk(sentence) {
        const filters = { genres: [] };
        const parts = [];
        const quoted = [];
        // Quoted words are kept aside, untouched by the parser.
        let text = String(sentence || '').replace(/["“«]\s*([^"”»]+?)\s*["”»]/g, (_, q) => { quoted.push(q); return ' '; });
        const take = (re, fn) => {
            const m = text.match(re);
            if (m) { fn(m); text = text.replace(m[0], ' '); }
            return !!m;
        };

        // Genres before kinds: "war films" is the War genre and the Films kind.
        for (const [re, genre] of GENRES) {
            let found = false;
            while (take(re, () => {})) found = true;   // every word for it: "comédies drôles" is one genre
            if (found) {
                filters.genres.push(genre);
                parts.push({ key: `genre:${genre}`, label: genre, kind: 'filter' });
            }
        }
        for (const [re, type, labelKey] of KINDS) {
            if (take(re, () => { filters.mediaType = type; })) {
                parts.push({ key: 'kind', label: type === 'tv' ? 'Series' : 'Movies', labelKey, kind: 'filter' });
                break;
            }
        }
        // Years: "before 1980" / "avant 1980", "after 2010" / "since 2010" / "depuis 2010", "1990s" / "90s" /
        // "'90s" / "années 90", a plain year.
        take(/\b(before|until|pre|avant)[ -]?((?:18|19|20)\d{2})\b/i, (m) => {
            filters.yearMax = Number(m[2]) - 1; parts.push({ key: 'year', label: `< ${m[2]}`, kind: 'filter' });
        }) || take(/(^|\s)(after|since|from|après|depuis)\s+((?:18|19|20)\d{2})\b/i, (m) => {
            filters.yearMin = Number(m[3]); parts.push({ key: 'year', label: `${m[3]}+`, kind: 'filter' });
        }) || take(/\b((?:18|19|20)\d)0'?s\b/i, (m) => {
            filters.yearMin = Number(m[1]) * 10; filters.yearMax = filters.yearMin + 9;
            parts.push({ key: 'year', label: `${filters.yearMin}s`, kind: 'filter' });
        }) || take(/\b(?:les\s+)?années\s+((?:18|19|20)?\d0)\b/i, (m) => {
            filters.yearMin = m[1].length === 4 ? Number(m[1]) : decade(m[1]); filters.yearMax = filters.yearMin + 9;
            parts.push({ key: 'year', label: `${filters.yearMin}s`, kind: 'filter' });
        }) || take(/(?:^|\s)'?(\d)0'?s\b/i, (m) => {
            filters.yearMin = decade(`${m[1]}0`); filters.yearMax = filters.yearMin + 9;
            parts.push({ key: 'year', label: `${filters.yearMin}s`, kind: 'filter' });
        }) || take(/\b((?:18|19|20)\d{2})\b/, (m) => {
            filters.yearMin = filters.yearMax = Number(m[1]); parts.push({ key: 'year', label: m[1], kind: 'filter' });
        });
        const leftover = text.replace(/[,;]+/g, ' ').replace(/(^|\s)[dlj]['’ ]\s*/gi, '$1')
            .replace(/(^|\s)(from the|from|in the|of the|and|with|des|de la|du|de|et|avec|en)\s*$/i, '')
            .replace(/^\s*(a|an|the|some|un|une|des|les|le|la)(?=\s|$)/i, '')
            .replace(/\s+/g, ' ').trim();
        const look = [leftover, ...quoted].filter(Boolean).join(' ');
        if (look) parts.push({ key: 'look', label: look, kind: 'look' });
        return { filters, look, parts };
    }

    /** The question without one part (a "Read as" chip clicked). */
    function dropPart(asked, key) {
        const filters = { ...asked.filters, genres: [...asked.filters.genres] };
        if (key === 'kind') delete filters.mediaType;
        else if (key === 'year') { delete filters.yearMin; delete filters.yearMax; }
        else if (key.startsWith('genre:')) filters.genres = filters.genres.filter(g => `genre:${g}` !== key);
        const look = key === 'look' ? '' : asked.look;
        return { filters, look, parts: asked.parts.filter(p => p.key !== key) };
    }

    function isEmpty(a) {
        return !a || (!a.look && !a.filters.mediaType && a.filters.yearMin === undefined
            && a.filters.yearMax === undefined && !a.filters.genres.length);
    }

    const api = { parseAsk, dropPart, isEmpty };
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.vsAsk = api;
})(typeof window !== 'undefined' ? window : null);
