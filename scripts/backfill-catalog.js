#!/usr/bin/env node
// scripts/backfill-catalog.js — one-time TMDB backfill of the catalog's films and series (operator, Wed 18 Nov 2026),
// so the app reads them from vault-raggae instead of asking TMDB on each first view.
//
// Who: IMDb films with >= --movie-votes votes (default 600) and series with >= --tv-votes (default 1000), most voted
// first. Series with at most --max-episodes episodes (default 250, counted locally from IMDb's title.episode dump) also
// get every season's episodes: they come in the same request as the details (up to 15 seasons appended), so they cost
// next to nothing, while the long-running soaps / talk / game shows (10,000+ episodes) are skipped (operator, Wed 18
// Nov 2026). --episodes-top (default 3000, operator) keeps the N most voted of those; 0 takes all 12,963 (411k
// episodes).
//
// As much as possible per request (TMDB's append_to_response):
//   1. GET /find/{imdb id}                      -> the TMDB id (skipped when the catalog already has it)
//   2. GET /movie|tv/{id}?append_to_response=videos,translations,external_ids,keywords,release_dates|content_ratings
//      [+ season/1..season/N for the episode series: at most 20 appends a request, so a long series takes more]
// Stored like the app's own read-through (src/tmdb.js slimDetails / slimSeason), through POST /v1/catalog/ingest
// (fill-only for plain fields):
//   - raw_enrichment.tmdb["en-US"]: the details, videos (trailer ids), season list, and season_details (episodes)
//   - raw_enrichment.tmdb["fr-CA"]: the same with TMDB's French title / overview / tagline from `translations`
//     (fr-CA, else fr-FR), so a French UI needs no request either; episodes stay English (the app falls back to them)
//   - raw_enrichment.tmdb.meta: keywords, certification, origin country, popularity
//   - poster_url at w780 (1170 px tall: the 1080p poster; `python -m app.pictures catalog` in vault-raggae then keeps
//     the file), overview / release date / runtime / external_ids.tmdb when the catalog has none
//
// Bounded (REQUEST_RATE_LIMITING): one request start every --interval-ms (default 100 ms: 10/s, TMDB allows ~40/s),
// a hard --max-requests cap (default 200000) per run, a 429 waits its Retry-After (at most 3 times a run, then stops),
// no other retries. Resumable: done and missed titles are kept in %LOCALAPPDATA%\VaultWares\vault-streaming\
// (backfill-done.txt, backfill-misses.txt) and skipped by the next run. --dry-run asks only the local gateway and
// prints the plan.
//
//   node scripts/backfill-catalog.js --dry-run [--movie-votes 600] [--tv-votes 1000] [--episodes-top 1000]
//   node scripts/backfill-catalog.js --execute [--limit N] [--category movie|tv] [--max-requests 200000]

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
const MOVIE_VOTES = int('movie-votes', 600);
const TV_VOTES = int('tv-votes', 1000);
const EPISODES_TOP = parseInt(arg('episodes-top', '3000'), 10) || 0;  // 0: every series under the cap
const MAX_EPISODES = int('max-episodes', 250);
const EPISODE_DUMP = process.env.IMDB_EPISODE_DUMP || 'G:/Catalogs/Sources/films/title.episode.tsv.gz';
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;
const ONLY = arg('category', '');
const MAX_REQUESTS = int('max-requests', 200000);
const INTERVAL_MS = Math.max(25, int('interval-ms', 100));
const MAX_429 = 3;
const TOKEN = process.env.TMDB_BEARER_TOKEN;
const STATE_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'VaultWares', 'vault-streaming');
const DONE_FILE = path.join(STATE_DIR, 'backfill-done.txt');
const MISS_FILE = path.join(STATE_DIR, 'backfill-misses.txt');

// ── bounded TMDB requests ────────────────────────────────────────────────────
let requests = 0;
let lastAt = 0;
let hits429 = 0;
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
            if (++hits429 > MAX_429) throw new Stop('TMDB keeps answering 429: stopping this run');
            const after = Math.min(60, parseInt(res.headers.get('retry-after') || '10', 10) || 10);
            console.warn(`  429: waiting ${after} s (${hits429}/${MAX_429})`);
            await new Promise(r => setTimeout(r, after * 1000));
            return null;
        }
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
        const rows = await raggae.browse({ category, sort: 'votes', limit: 500, offset, minVotes });
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

function readSet(file) {
    try { return new Set(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)); } catch (_) { return new Set(); }
}

// ── what is stored ───────────────────────────────────────────────────────────
function frenchOf(translations) {
    const list = (translations && translations.translations) || [];
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

function buildIngest(item, data, category, seasons) {
    const en = T.slimDetails(data, category);
    if (seasons && Object.keys(seasons).length) en.season_details = seasons;
    const fr = frenchOf(data.translations);
    const frBlob = { ...en };
    delete frBlob.season_details;
    if (fr) {
        if (category === 'tv') { if (fr.name) frBlob.name = fr.name; } else if (fr.title) frBlob.title = fr.title;
        if (fr.overview) frBlob.overview = fr.overview;
        if (fr.tagline) frBlob.tagline = fr.tagline;
    }
    const keywords = data.keywords && (data.keywords.keywords || data.keywords.results);
    const ingest = T.detailsToIngest(data, en, category, 'en-US', item.catalog_id);
    ingest.poster_url = T.tmdbImage(data.poster_path, 'w780');
    ingest.raw_enrichment = {
        tmdb: {
            'en-US': en,
            'fr-CA': frBlob,
            meta: {
                keywords: Array.isArray(keywords) ? keywords.map(k => k.name).slice(0, 30) : [],
                certification: certificationOf(data, category),
                origin_country: data.origin_country || (data.production_countries || []).map(c => c.iso_3166_1),
                popularity: data.popularity || null, backfilled_at: new Date().toISOString(),
            },
        },
    };
    return ingest;
}

async function details(category, tmdbId, seasonNumbers) {
    const base = ['videos', 'translations', 'external_ids', 'keywords', category === 'tv' ? 'content_ratings' : 'release_dates'];
    const first = seasonNumbers.slice(0, 20 - base.length);
    const data = await tmdb(`/${category}/${tmdbId}?language=en-US&include_video_language=en,fr,null` +
        `&append_to_response=${[...base, ...first.map(n => `season/${n}`)].join(',')}`);
    if (!data || data.notFound) return data;
    const seasons = {};
    const take = (src, n) => { const s = src[`season/${n}`]; if (s && Array.isArray(s.episodes)) seasons[String(n)] = T.slimSeason(s); };
    first.forEach(n => take(data, n));
    for (let i = first.length; i < seasonNumbers.length; i += 20) {
        const chunk = seasonNumbers.slice(i, i + 20);
        const more = await tmdb(`/tv/${tmdbId}?language=en-US&append_to_response=${chunk.map(n => `season/${n}`).join(',')}`);
        if (more && !more.notFound) chunk.forEach(n => take(more, n));
    }
    return { data, seasons };
}

// ── run ──────────────────────────────────────────────────────────────────────
async function main() {
    const t0 = Date.now();
    if (!(await raggae.health()).available) throw new Error('vault-raggae is not reachable (127.0.0.1:8750)');
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const done = readSet(DONE_FILE);
    const misses = readSet(MISS_FILE);

    const movies = ONLY === 'tv' ? [] : await candidates('movie', MOVIE_VOTES);
    const shows = ONLY === 'movie' ? [] : await candidates('tv', TV_VOTES);
    const eps = shows.length ? await episodeCounts(new Set(shows.map(s => s.catalog_id.slice(5)))) : new Map();
    const underCap = shows.filter(s => (eps.get(s.catalog_id.slice(5)) || 0) <= MAX_EPISODES);
    const episodeSet = new Set((EPISODES_TOP ? underCap.slice(0, EPISODES_TOP) : underCap).map(s => s.catalog_id));
    const skippedLong = shows.length - underCap.length;
    const episodeTotal = [...episodeSet].reduce((a, cid) => a + (eps.get(cid.slice(5)) || 0), 0);
    let queue = [...shows.map(i => ({ item: i, category: 'tv' })), ...movies.map(i => ({ item: i, category: 'movie' }))]
        .filter(q => !done.has(q.item.catalog_id) && !misses.has(q.item.catalog_id));
    if (LIMIT) queue = queue.slice(0, LIMIT);

    const needFind = queue.filter(q => !(q.item.external_ids && q.item.external_ids.tmdb)).length;
    console.log(`[backfill] films >= ${MOVIE_VOTES} votes: ${movies.length}; series >= ${TV_VOTES}: ${shows.length};` +
        ` episodes for ${episodeSet.size} series (${episodeTotal} episodes; ${skippedLong} over ${MAX_EPISODES} episodes` +
        ` skipped); already done ${done.size}, misses ${misses.size}`);
    // episodes ride in the details request (15 seasons); a series past 15 seasons takes one more request per 20
    console.log(`[backfill] to do: ${queue.length} titles; ~${needFind + queue.length} requests (+1 per 20 seasons past` +
        ` the 15th), one per ${INTERVAL_MS} ms: ~${((needFind + queue.length) * INTERVAL_MS / 3600000).toFixed(1)} h;` +
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
    const flush = async () => {
        if (!pending.length) return;
        const batch = pending.splice(0, pending.length);
        const res = await raggae.ingest(batch.map(b => b.ingest));
        if (!res || !Array.isArray(res.items)) {
            console.warn(`  ingest of ${batch.length} titles failed; they stay to do`);
            return;
        }
        fs.appendFileSync(DONE_FILE, batch.map(b => b.cid).join('\n') + '\n');
        stored += batch.length;
    };
    for (const [i, q] of queue.entries()) {
        try {
            const imdb = q.item.catalog_id.slice(5);
            let tmdbId = q.item.external_ids && q.item.external_ids.tmdb;
            if (!tmdbId) {
                const found = await tmdb(`/find/${imdb}?external_source=imdb_id`);
                if (!found) continue;                       // not answered: stays to do
                const hit = (q.category === 'tv' ? found.tv_results : found.movie_results) || [];
                tmdbId = hit[0] && hit[0].id;
            }
            if (!tmdbId) {
                fs.appendFileSync(MISS_FILE, `${q.item.catalog_id}\n`);
                missed++;
                continue;
            }
            let seasonNumbers = [];
            if (episodeSet.has(q.item.catalog_id)) {
                // the season list comes with the details; ask for seasons 1..20 up front and the rest after
                seasonNumbers = Array.from({ length: 15 }, (_, k) => k + 1);
            }
            const got = await details(q.category, tmdbId, seasonNumbers);
            if (!got) continue;
            if (got.notFound) {
                fs.appendFileSync(MISS_FILE, `${q.item.catalog_id}\n`);
                missed++;
                continue;
            }
            // a series with more seasons than asked for up front
            if (seasonNumbers.length && got.data.number_of_seasons > seasonNumbers.length) {
                const rest = Array.from({ length: got.data.number_of_seasons - seasonNumbers.length }, (_, k) => k + 16);
                for (let j = 0; j < rest.length; j += 20) {
                    const chunk = rest.slice(j, j + 20);
                    const more = await tmdb(`/tv/${tmdbId}?language=en-US&append_to_response=${chunk.map(n => `season/${n}`).join(',')}`);
                    if (more && !more.notFound) chunk.forEach(n => { const s = more[`season/${n}`]; if (s && s.episodes) got.seasons[String(n)] = T.slimSeason(s); });
                }
            }
            pending.push({ cid: q.item.catalog_id, ingest: buildIngest(q.item, got.data, q.category, got.seasons) });
            if (pending.length >= 50) await flush();
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
    console.log(`[backfill] stored ${stored}, missed ${missed}, ${requests} TMDB requests, ` +
        `${((Date.now() - t0) / 60000).toFixed(1)} min${stop ? `; stopped: ${stop}` : ''}`);
    if (stop) process.exitCode = 2;
}

main().catch(e => {
    console.error(`[backfill] failed: ${e.message}`);
    process.exitCode = 1;
});
