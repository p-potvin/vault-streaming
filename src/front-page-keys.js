// src/front-page-keys.js — catalog list keys shared by the Discover handlers (src/tmdb.js) and the scheduled
// front-page ingest (scripts/ingest-front-page.js). Changing a key orphans the stored list until the next run.

/** The Discover providers the UI offers (index.html .provider-btn), plus 'all'. TMDB watch-provider ids. */
const PROVIDERS = ['all', '8', '337', '350', '119'];

/** The id TMDB knows a provider by in a region: the UI's Prime button sends 119 (Prime Video), which TMDB lists as 9
 *  (Amazon Prime Video) in the US — 119 there returned no titles. */
function tmdbProvider(provider, watchRegion) {
    return provider === '119' && String(watchRegion || '').toUpperCase() === 'US' ? '9' : provider;
}

module.exports = {
    PROVIDERS,
    tmdbProvider,
    trending: () => 'vs:trending:all:day',
    discover: (category, provider, watchRegion) =>
        `vs:discover:${category === 'tv' ? 'tv' : 'movie'}:${provider || 'all'}:${String(watchRegion || 'US').toUpperCase()}`,
};
