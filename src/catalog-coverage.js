// src/catalog-coverage.js — what the TMDB backfill covers, shared by scripts/backfill-catalog.js (who gets TMDB data
// and a poster) and the lists the app and the web UI show (src/tmdb.js), so a list never reaches below what was
// filled (operator, Fri 20 Nov 2026: "the streaming app and web UI is where it shouldn't show empty posters").
//
// The catalog panel shows everything in the inventory; these limits are for the viewer-facing lists only.

/** The fewest IMDb votes a title needs to be backfilled (and so to have a poster): films, series. */
const MIN_VOTES = Object.freeze({ movie: 600, tv: 1000 });

/** The vote floor for a list of this category. */
function minVotesFor(category) {
    return category === 'tv' ? MIN_VOTES.tv : MIN_VOTES.movie;
}

module.exports = { MIN_VOTES, minVotesFor };
