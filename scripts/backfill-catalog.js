#!/usr/bin/env node
// scripts/backfill-catalog.js — one-time TMDB backfill of the catalog's films and series (operator, Wed 18 Nov 2026),
// so the app reads them from vault-raggae instead of asking TMDB on each first view.
//
// Who: IMDb films with >= --movie-votes votes (default 600) and series with >= --tv-votes (default 600, lowered from
// 1,000 on Sat 21 Nov 2026), most voted first. Every series also gets all its seasons' episodes, specials (season 0)
// included: up to 14 seasons come in the details request itself, the rest 20 a request. By default there is no cap
// (operator, Sat 21 Nov 2026: the long-running soaps / talk / game shows too); --max-episodes N leaves out the episodes
// of series longer than N (counted locally from IMDb's title.episode dump), and --episodes-top N keeps only the N most
// voted series (both 0 by default; until Sat 21 Nov 2026 they were 500 and 3000). A series stored before without all
// its episodes is asked again for them: backfill-episodes-done-v2.txt lists the series whose episodes are stored.
//
// As much as possible per request (TMDB's append_to_response):
//   1. GET /find/{imdb id}                      -> the TMDB id (skipped when the catalog already has it)
//   2. GET /movie|tv/{id}?append_to_response=videos,translations,external_ids,keywords,release_dates|content_ratings
//      [+ season/1..season/N for the episode series: at most 20 appends a request, so a long series takes more]
// Stored like the app's own read-through (src/tmdb.js slimDetails / slimSeason), through POST /v1/catalog/ingest
// (fill-only for plain fields):
//   - raw_enrichment.tmdb["en-US"]: the details, videos (trailer ids), season list, and season_details (episodes)
//   - raw_enrichment.tmdb["fr-FR"] (the key js/utils.js tmdbLanguage() asks for): the same with TMDB's French title /
//     overview / tagline from `translations` (Québec's, else France's), so a French UI needs no request either;
//     episodes stay English (the app falls back to them)
//   - raw_enrichment.tmdb.meta: keywords, certification, origin country, popularity
//   - poster_url at w780 (1170 px tall: the 1080p poster; `python -m app.pictures catalog` in vault-raggae then keeps
//     the file), overview / release date / runtime / external_ids.tmdb when the catalog has none
//
// Bounded (REQUEST_RATE_LIMITING): one request start every --interval-ms (default 100 ms: 10/s, TMDB allows ~40/s),
// a hard --max-requests cap (default 200000) per run. A 429 waits its Retry-After; 3 in a row (no success between)
// start a 5-minute cooldown, after which the run goes on; the 4th cooldown stops the run. No other retries. Resumable: done and missed titles are kept in %LOCALAPPDATA%\VaultWares\vault-streaming\
// (backfill-done.txt, backfill-misses.txt) and skipped by the next run (--retry-misses asks the misses again).
// --dry-run asks only the local gateway and prints the plan.
//
// Category mismatches (Thu, 19 Nov 2026: 1,917 of the first run's 1,918 misses): IMDb files TV specials and some TV
// movies differently from TMDB (a tvSpecial is a TMDB movie). /find's other list is taken when the expected one is
// empty; a stored TMDB id is fetched as its stored tmdb_type, and an untyped one that 404s is checked with /find (taken
// as the other type only when /find gives the same number); the catalog keeps its own category, TMDB's is
// kept in raw_enrichment.tmdb.meta.tmdb_type. Each miss line carries its cause after a tab: find-empty,
// find-season:<show id> / find-episode:<show id> (TMDB merged the title into that series), find-404, details-404:<type>/<id>, details-404-stale:<stored>-><found> (a stored id TMDB
// no longer gives for that IMDb id).
// IMDb `video` titles (bonus features, deleted scenes) are left out (title.basics dump); --keep-video takes them.
//
//   node scripts/backfill-catalog.js --dry-run [--movie-votes 600] [--tv-votes 600] [--episodes-top 0]
//   node scripts/backfill-catalog.js --execute [--limit N] [--category movie|tv] [--max-requests 200000] [--retry-misses]

const fs = require('fs');
const os = require('os');
const path = require('path');

// .env first: src/raggae.js and src/tmdb.js read it at load (the token is never logged)
(function loadEnv() {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
})();
const raggae = require('../src/raggae');
const { _internals: T } = require('../src/tmdb');

// ── options ──────────────────────────────────────────────────────────────────
function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const int = (name, def) => Math.max(0, parseInt(arg(name, String(def)), 10) || 0) || def;
const EXECUTE = process.argv.includes('--execute');
const RETRY_MISSES = process.argv.includes('--retry-misses');
// defaults shared with the app's lists (src/catalog-coverage.js): change them there, not here
const { MIN_VOTES } = require('../src/catalog-coverage');
const MOVIE_VOTES = int('movie-votes', MIN_VOTES.movie);
const TV_VOTES = int('tv-votes', MIN_VOTES.tv);
const EPISODES_TOP = parseInt(arg('episodes-top', '0'), 10) || 0;  // 0: every series under the cap
// 0: no cap (operator, Sat 21 Nov 2026: the 433 long-running series too); N skips the episodes of longer series
const MAX_EPISODES = parseInt(arg('max-episodes', '0'), 10) || 0;
const EPISODE_DUMP = process.env.IMDB_EPISODE_DUMP || 'G:/Catalogs/Sources/films/title.episode.tsv.gz';
const BASICS_DUMP = process.env.IMDB_BASICS_DUMP || 'G:/Catalogs/Sources/films/title.basics.tsv.gz';
const KEEP_VIDEO = process.argv.includes('--keep-video');   // IMDb `video` titles are left out by default (operator, Fri 20 Nov 2026)
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;
const ONLY = arg('category', '');
const MAX_REQUESTS = int('max-requests', 200000);
const INTERVAL_MS = Math.max(25, int('interval-ms', 100));
// seasons asked in the details request itself: 20 appends, less videos, translations, external_ids, keywords, the
// ratings and the credits (a 15th there cost every series a second request: Sat 21 Nov 2026)
const FIRST_SEASONS = 14;
const MAX_429_STREAK = 3;               // consecutive 429s before a cooldown
const COOLDOWN_MS = 5 * 60 * 1000;
const MAX_COOLDOWNS = 4;                // the 4th cooldown ends the run
const TOKEN = process.env.TMDB_BEARER_TOKEN;
const STATE_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'VaultWares', 'vault-streaming');
const DONE_FILE = path.join(STATE_DIR, 'backfill-done.txt');
const MISS_FILE = path.join(STATE_DIR, 'backfill-misses.txt');
// series whose episodes are stored, specials (season 0) included: the -v2 file restarts the list (Sat 21 Nov 2026: the
// first file's series were checkpointed without their specials, so they are asked again)
const EPISODES_DONE_FILE = path.join(STATE_DIR, 'backfill-episodes-done-v2.txt');
const CREDITS_DONE_FILE = path.join(STATE_DIR, 'backfill-credits-done.txt');     // titles whose cast / crew are stored

// ── bounded TMDB requests ────────────────────────────────────────────────────
let requests = 0;
let lastAt = 0;
let streak429 = 0;
let cooldowns = 0;
class Stop extends Error { }

async function tmdb(route) {
    if (requests >= MAX_REQUESTS) throw new Stop(`request cap reached (${MAX_REQUESTS})`);
    const wait = lastAt + INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastAt = Date.now();
    requests++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
        const res = await fetch(`https://api.themoviedb.org/3${route}`, {
            headers: { accept: 'application/json', Authorization: `Bearer ${TOKEN}` }, signal: controller.signal,
        });
        if (res.status === 429) {
            if (++streak429 >= MAX_429_STREAK) {
                if (++cooldowns >= MAX_COOLDOWNS) throw new Stop(`TMDB kept answering 429 after ${MAX_COOLDOWNS - 1} cooldowns: stopping this run`);
                console.warn(`  ${streak429} 429s in a row: cooling down 5 min (${cooldowns}/${MAX_COOLDOWNS - 1})`);
                streak429 = 0;
                await new Promise(r => setTimeout(r, COOLDOWN_MS));
                return null;
            }
            const after = Math.min(60, parseInt(res.headers.get('retry-after') || '10', 10) || 10);
            console.warn(`  429: waiting ${after} s`);
            await new Promise(r => setTimeout(r, after * 1000));
            return null;
        }
        streak429 = 0;
        if (!res.ok) return res.status === 404 ? { notFound: true } : null;
        return await res.json();
    } catch (e) {
        if (e instanceof Stop) throw e;
        console.warn(`  ${route.split('?')[0]} failed: ${e.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// ── who ──────────────────────────────────────────────────────────────────────
async function candidates(category, minVotes) {
    const out = [];
    for (let offset = 0; ; offset += 500) {
        // deep offsets are slow on the gateway (offset 29,500 passed 30 s while it was storing batches): 120 s a
        // page and two more tries, 30 s apart
        let rows = null;
        for (let attempt = 0; attempt < 3 && rows === null; attempt++) {
            if (attempt) await new Promise(r => setTimeout(r, 30000));
            rows = await raggae.browse({ category, sort: 'votes', limit: 500, offset, minVotes, nullOnError: true, timeoutMs: 120000 });
        }
        // a failed page would silently end the list early: stop the run instead
        if (rows === null) throw new Error(`catalog browse failed (${category}, offset ${offset}); nothing was asked of TMDB`);
        if (!rows.length) break;
        for (const r of rows) if (String(r.catalog_id).startsWith('imdb:') && (r.votes || 0) >= minVotes) out.push(r);
        if (rows.length < 500 || (rows[rows.length - 1].votes || 0) < minVotes) break;
    }
    return out;
}

/** Episodes per series (IMDb tconst -> count) from the local title.episode dump, for the given series only. */
async function episodeCounts(ids) {
    const zlib = require('zlib');
    const readline = require('readline');
    const counts = new Map([...ids].map(id => [id, 0]));
    if (!fs.existsSync(EPISODE_DUMP)) throw new Error(`IMDb episode dump not found: ${EPISODE_DUMP}`);
    const rl = readline.createInterface({ input: fs.createReadStream(EPISODE_DUMP).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    for await (const line of rl) {
        const parent = line.split('\t', 2)[1];
        if (counts.has(parent)) counts.set(parent, counts.get(parent) + 1);
    }
    return counts;
}

/** IMDb tconsts of the given ids whose title type is `video` (bonus features, deleted scenes, shorts: TMDB rarely
 *  has them, 329 of the first run's misses), from the local title.basics dump. */
async function videoTitles(ids) {
    const zlib = require('zlib');
    const readline = require('readline');
    const out = new Set();
    if (!fs.existsSync(BASICS_DUMP)) throw new Error(`IMDb title dump not found: ${BASICS_DUMP} (or pass --keep-video)`);
    const rl = readline.createInterface({ input: fs.createReadStream(BASICS_DUMP).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    for await (const line of rl) {
        const [tconst, type] = line.split('\t', 2);
        if (type === 'video' && ids.has(tconst)) out.add(tconst);
    }
    return out;
}

function readSet(file) {
    // a line is a catalog id, optionally followed by a tab and a cause (misses)
    try { return new Set(fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.split('\t')[0]).filter(Boolean)); } catch (_) { return new Set(); }
}

// ── what is stored ───────────────────────────────────────────────────────────
function frenchOf(translations) {
    const list = (translations && translations.translations) || [];
    // the Québec translation first, France's otherwise; stored under fr-FR, the key the renderer asks for
    const fr = list.find(t => t.iso_639_1 === 'fr' && t.iso_3166_1 === 'CA') || list.find(t => t.iso_639_1 === 'fr');
    return fr && fr.data ? fr.data : null;
}

function certificationOf(data, category) {
    const pick = list => (list || []).find(r => r.iso_3166_1 === 'CA') || (list || []).find(r => r.iso_3166_1 === 'US');
    if (category === 'tv') {
        const r = pick(data.content_ratings && data.content_ratings.results);
        return r ? { country: r.iso_3166_1, rating: r.rating } : null;
    }
    const r = pick(data.release_dates && data.release_dates.results);
    const c = r && (r.release_dates || []).find(d => d.certification);
    return c ? { country: r.iso_3166_1, rating: c.certification } : null;
}

/** `category` is TMDB's type for the data (movie | tv); `catalogCategory` the catalog item's, kept as is. */
function buildIngest(item, data, category, seasons, catalogCategory = category) {
    const cross = category !== catalogCategory;
    // a TMDB movie stored on a catalog series (or the reverse) answers to both name and title
    const alias = blob => { if (cross) { blob.name = blob.name || blob.title; blob.title = blob.title || blob.name; } return blob; };
    const en = alias(T.slimDetails(data, category));
    if (seasons && Object.keys(seasons).length) en.season_details = seasons;
    const fr = frenchOf(data.translations);
    const frBlob = { ...en };
    delete frBlob.season_details;
    if (fr) {
        const frTitle = category === 'tv' ? fr.name : fr.title;
        if (frTitle) { frBlob[category === 'tv' ? 'name' : 'title'] = frTitle; if (cross) frBlob[category === 'tv' ? 'title' : 'name'] = frTitle; }
        if (fr.overview) frBlob.overview = fr.overview;
        if (fr.tagline) frBlob.tagline = fr.tagline;
    }
    const keywords = data.keywords && (data.keywords.keywords || data.keywords.results);
    const ingest = T.detailsToIngest(data, en, category, 'en-US', item.catalog_id);
    ingest.category = catalogCategory;
    ingest.poster_url = T.tmdbImage(data.poster_path, 'w780');
    ingest.raw_enrichment = {
        tmdb: {
            'en-US': en,
            'fr-FR': frBlob,
            meta: {
                keywords: Array.isArray(keywords) ? keywords.map(k => k.name).slice(0, 30) : [],
                certification: certificationOf(data, category),
                origin_country: data.origin_country || (data.production_countries || []).map(c => c.iso_3166_1),
                popularity: data.popularity || null, tmdb_type: category, backfilled_at: new Date().toISOString(),
            },
            // the people (language-neutral), with their TMDB person ids: the cast catalog joins on them
            credits: T.slimCredits(category === 'tv' ? data.aggregate_credits : data.credits, category === 'tv'),
        },
    };
    return ingest;
}

async function details(category, tmdbId, seasonNumbers) {
    // the people too: a series' cast / crew across all its episodes (aggregate_credits), a film's credits
    const base = ['videos', 'translations', 'external_ids', 'keywords', category === 'tv' ? 'content_ratings' : 'release_dates',
                  category === 'tv' ? 'aggregate_credits' : 'credits'];
    const first = seasonNumbers.slice(0, 20 - base.length);
    const data = await tmdb(`/${category}/${tmdbId}?language=en-US&include_video_language=en,fr,null` +
        `&append_to_response=${[...base, ...first.map(n => `season/${n}`)].join(',')}`);
    if (!data || data.notFound) return data;
    const seasons = {};
    let incomplete = false;
    const take = (src, n) => { const s = src[`season/${n}`]; if (s && Array.isArray(s.episodes)) seasons[String(n)] = T.slimSeason(s); };
    first.forEach(n => take(data, n));
    // a season TMDB lists (with episodes) but whose append came back empty: not done, asked again next run
    const listed = (Array.isArray(data.seasons) ? data.seasons : [])
        .filter(s => s.season_number >= 1 && s.episode_count > 0).map(s => s.season_number);
    if (first.some(n => listed.includes(n) && !seasons[String(n)])) incomplete = true;
    for (let i = first.length; i < seasonNumbers.length; i += 20) {
        const chunk = seasonNumbers.slice(i, i + 20);
        const more = await tmdb(`/tv/${tmdbId}?language=en-US&append_to_response=${chunk.map(n => `season/${n}`).join(',')}`);
        if (more && !more.notFound) chunk.forEach(n => take(more, n));
        else incomplete = true;
    }
    return { data, seasons, incomplete };
}

// ── run ──────────────────────────────────────────────────────────────────────
async function main() {
    const t0 = Date.now();
    if (!(await raggae.health()).available) throw new Error('vault-raggae is not reachable (127.0.0.1:8750)');
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const done = readSet(DONE_FILE);
    const misses = readSet(MISS_FILE);
    const episodesDone = readSet(EPISODES_DONE_FILE);
    const creditsDone = readSet(CREDITS_DONE_FILE);

    const movies = ONLY === 'tv' ? [] : await candidates('movie', MOVIE_VOTES);
    const shows = ONLY === 'movie' ? [] : await candidates('tv', TV_VOTES);
    const eps = shows.length ? await episodeCounts(new Set(shows.map(s => s.catalog_id.slice(5)))) : new Map();
    const underCap = MAX_EPISODES ? shows.filter(s => (eps.get(s.catalog_id.slice(5)) || 0) <= MAX_EPISODES) : shows;
    const episodeSet = new Set((EPISODES_TOP ? underCap.slice(0, EPISODES_TOP) : underCap).map(s => s.catalog_id));
    const skippedLong = shows.length - underCap.length;
    const episodeTotal = [...episodeSet].reduce((a, cid) => a + (eps.get(cid.slice(5)) || 0), 0);
    // a series stored earlier without its episodes (outside the old top 3000): asked again for them
    const needsEpisodes = cid => episodeSet.has(cid) && !episodesDone.has(cid);
    const againForEpisodes = shows.filter(s => done.has(s.catalog_id) && needsEpisodes(s.catalog_id)).length;
    // titles stored before their cast / crew (and the full episode fields) were kept: asked again (Sat 21 Nov 2026)
    const needsCredits = cid => !creditsDone.has(cid);
    const againForCredits = [...movies, ...shows].filter(s => done.has(s.catalog_id) && needsCredits(s.catalog_id)).length;
    let queue = [...shows.map(i => ({ item: i, category: 'tv' })), ...movies.map(i => ({ item: i, category: 'movie' }))]
        .filter(q => (!done.has(q.item.catalog_id) || needsEpisodes(q.item.catalog_id) || needsCredits(q.item.catalog_id))
                     && (RETRY_MISSES || !misses.has(q.item.catalog_id)));
    const videos = KEEP_VIDEO || !queue.length ? new Set() : await videoTitles(new Set(queue.map(q => q.item.catalog_id.slice(5))));
    if (videos.size) queue = queue.filter(q => !videos.has(q.item.catalog_id.slice(5)));
    if (LIMIT) queue = queue.slice(0, LIMIT);

    const needFind = queue.filter(q => !(q.item.external_ids && q.item.external_ids.tmdb)).length;
    console.log(`[backfill] films >= ${MOVIE_VOTES} votes: ${movies.length}; series >= ${TV_VOTES}: ${shows.length};` +
        ` episodes for ${episodeSet.size} series (${episodeTotal} episodes; ${skippedLong} over ${MAX_EPISODES} episodes` +
        ` skipped); already done ${done.size} (asked again: ${againForEpisodes} series for their episodes, ${againForCredits} titles for their cast / crew), misses ${misses.size}${RETRY_MISSES ? ' (asked again: --retry-misses)' : ''}; ${videos.size} IMDb video titles left out` +
        `${KEEP_VIDEO ? ' (--keep-video: none)' : ''}`);
    // episodes ride in the details request (14 seasons); a series past 14 seasons takes one more request per 20
    console.log(`[backfill] to do: ${queue.length} titles; ~${needFind + queue.length} requests (+1 per 20 seasons past` +
        ` the 14th), one per ${INTERVAL_MS} ms: ~${((needFind + queue.length) * INTERVAL_MS / 3600000).toFixed(1)} h;` +
        ` cap ${MAX_REQUESTS}`);
    if (!EXECUTE) {
        console.log('[backfill] dry run: nothing asked of TMDB (add --execute)');
        return;
    }
    if (!TOKEN) throw new Error('TMDB_BEARER_TOKEN is not set (.env)');

    let stored = 0;
    let missed = 0;
    let stop = null;
    const pending = [];
    let pendingBytes = 0;
    const flush = async () => {
        if (!pending.length) return;
        const batch = pending.splice(0, pending.length);
        // a big batch can take the gateway a while to store: 60 s, a timeout does not mark the gateway down, and
        // one retry 20 s later (the ingest is fill-only and keyed, so a batch stored twice is harmless)
        const opts = { timeoutMs: 60000, tripOnTimeout: false };
        let res = await raggae.ingest(batch.map(b => b.ingest), opts);
        if (!res || !Array.isArray(res.items)) {
            await new Promise(r => setTimeout(r, 20000));
            res = await raggae.ingest(batch.map(b => b.ingest), opts);
        }
        if (!res || !Array.isArray(res.items)) {
            console.warn(`  ingest of ${batch.length} titles failed; they stay to do`);
            return;
        }
        // done only when the gateway saved that title and its data was complete (a series with a failed season
        // request is stored as far as it goes and asked again by the next run)
        const saved = new Set(res.items.map(s => s && s.catalog_id).filter(Boolean));
        const finished = batch.filter(b => saved.has(b.cid) && !b.incomplete).map(b => b.cid);
        if (finished.length) fs.appendFileSync(DONE_FILE, finished.join('\n') + '\n');
        const withEpisodes = batch.filter(b => b.episodes && saved.has(b.cid) && !b.incomplete).map(b => b.cid);
        if (withEpisodes.length) fs.appendFileSync(EPISODES_DONE_FILE, withEpisodes.join('\n') + '\n');
        const withCredits = batch.filter(b => b.credits && saved.has(b.cid) && !b.incomplete).map(b => b.cid);
        if (withCredits.length) fs.appendFileSync(CREDITS_DONE_FILE, withCredits.join('\n') + '\n');
        stored += batch.filter(b => saved.has(b.cid)).length;
        if (saved.size < batch.length) console.warn(`  the gateway skipped ${batch.length - saved.size} of ${batch.length} titles`);
    };
    const missCauses = {};
    const miss = (cid, cause) => {
        fs.appendFileSync(MISS_FILE, `${cid}\t${cause}\n`);
        missed++;
        const kind = cause.split(':')[0];
        missCauses[kind] = (missCauses[kind] || 0) + 1;
    };
    let crossed = 0;
    for (const [i, q] of queue.entries()) {
        try {
            const cid = q.item.catalog_id;
            const imdb = cid.slice(5);
            const other = q.category === 'tv' ? 'movie' : 'tv';
            const storedId = q.item.external_ids && q.item.external_ids.tmdb;
            const storedType = storedId ? q.item.external_ids.tmdb_type : null;
            // TMDB's answer for the IMDb id: { id, type }, { miss: cause }, or null when TMDB did not answer
            const findRef = async () => {
                const found = await tmdb(`/find/${imdb}?external_source=imdb_id`);
                if (!found) return null;
                if (found.notFound) return { miss: 'find-404' };
                const list = type => (type === 'tv' ? found.tv_results : found.movie_results) || [];
                if (list(q.category)[0]) return { id: list(q.category)[0].id, type: q.category };
                if (list(other)[0]) return { id: list(other)[0].id, type: other };
                // TMDB folded the title into a series (as a season or an episode): not a title of its own there
                const season = (found.tv_season_results || [])[0];
                const episode = (found.tv_episode_results || [])[0];
                return { miss: season ? `find-season:${season.show_id}` : episode ? `find-episode:${episode.show_id}` : 'find-empty' };
            };
            // a stored id is fetched as its stored type: the same number in the other type is another title
            let tmdbId = storedId;
            let tmdbType = storedType || q.category;
            if (!tmdbId) {
                const ref = await findRef();
                if (!ref) continue;                         // not answered: stays to do
                if (ref.miss) { miss(cid, ref.miss); continue; }
                tmdbId = ref.id;
                tmdbType = ref.type;
            }
            // the season list comes with the details; ask for seasons 1..15 up front and the rest after
            // as many seasons as fit in the details request (20 appends less the 6 others: 14); the rest after
            const seasonsFor = type => (type === 'tv' && episodeSet.has(cid) ? Array.from({ length: FIRST_SEASONS }, (_, k) => k + 1) : []);
            let seasonNumbers = seasonsFor(tmdbType);
            let got = await details(tmdbType, tmdbId, seasonNumbers);
            if (got && got.notFound && storedId && !storedType) {
                // an untyped stored id (from before tmdb_type) that 404s: /find says what the IMDb id is. Only the
                // same number of the other type is taken; the catalog fills empty keys only, so a different id
                // would sit beside the old one
                const ref = await findRef();
                if (!ref) continue;
                if (!ref.miss && Number(ref.id) === Number(tmdbId) && ref.type !== tmdbType) {
                    tmdbType = ref.type;
                    seasonNumbers = seasonsFor(tmdbType);
                    got = await details(tmdbType, tmdbId, seasonNumbers);
                } else if (!ref.miss) {
                    miss(cid, `details-404-stale:${tmdbType}/${tmdbId}->${ref.type}/${ref.id}`);
                    continue;
                }
            }
            if (!got) continue;
            if (got.notFound) { miss(cid, `details-404:${tmdbType}/${tmdbId}`); continue; }
            if (tmdbType !== q.category) crossed++;
            // every season TMDB lists with episodes that the details request did not carry: those past the 14th,
            // the specials (season 0), and any that came back empty; 20 a request. A series still missing one is
            // stored as far as it goes and not checkpointed (asked again by the next run)
            if (seasonNumbers.length) {
                const listed = (Array.isArray(got.data.seasons) ? got.data.seasons : [])
                    .filter(s => s.season_number >= 0 && s.episode_count > 0).map(s => s.season_number);
                const missing = listed.filter(n => !got.seasons[String(n)]);
                for (let j = 0; j < missing.length; j += 20) {
                    const chunk = missing.slice(j, j + 20);
                    const more = await tmdb(`/tv/${tmdbId}?language=en-US&append_to_response=${chunk.map(n => `season/${n}`).join(',')}`);
                    if (more && !more.notFound) chunk.forEach(n => { const s = more[`season/${n}`]; if (s && s.episodes) got.seasons[String(n)] = T.slimSeason(s); });
                }
                got.incomplete = listed.some(n => !got.seasons[String(n)]);
            }
            const ingest = buildIngest(q.item, got.data, tmdbType, got.seasons, q.category);
            // checkpointed for its people only when TMDB sent them (the credits append can be absent)
            pending.push({ cid, incomplete: !!got.incomplete, episodes: seasonNumbers.length > 0,
                           credits: !!ingest.raw_enrichment.tmdb.credits, ingest });
            // 50 titles a call, or less when they are big (a long series with every episode's crew and guest stars
            // can be tens of MB): the gateway gets at most ~16 MB of JSON at once
            pendingBytes += JSON.stringify(pending[pending.length - 1].ingest).length;
            if (pending.length >= 50 || pendingBytes >= 16 * 1024 * 1024) { await flush(); pendingBytes = 0; }
        } catch (e) {
            if (!(e instanceof Stop)) throw e;
            stop = e.message;
            break;
        }
        if ((i + 1) % 1000 === 0) {
            console.log(`  ${i + 1}/${queue.length}  stored ${stored + pending.length}  missed ${missed}  requests ${requests}` +
                `  ${((Date.now() - t0) / 60000).toFixed(0)} min`);
        }
    }
    await flush();
    console.log(`[backfill] stored ${stored} (${crossed} under TMDB's other type), missed ${missed}` +
        `${missed ? ` (${Object.entries(missCauses).map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}, ${requests} TMDB requests, ` +
        `${((Date.now() - t0) / 60000).toFixed(1)} min${stop ? `; stopped: ${stop}` : ''}`);
    if (stop) process.exitCode = 2;
}

main().catch(e => {
    console.error(`[backfill] failed: ${e.message}`);
    process.exitCode = 1;
});
