#!/usr/bin/env node
// scripts/ingest-front-page.js — copies what the Discover page shows from TMDB into the local catalog (vault-raggae),
// so the app itself never asks TMDB for it: the trending row and, per watch region, each provider's popular titles
// (All, Netflix, Disney+, Apple TV+, Prime) for films and series.
//
// For every title: the catalog item is found by its TMDB id, or created keyed on its IMDb id (one /external_ids
// request, only for titles the catalog has not seen); TMDB's card facts (poster, backdrop, origin country…) are
// ingested; then each list is stored in order (POST /v1/catalog/lists/<key>, keys in src/front-page-keys.js).
//
// Bounded (REQUEST_RATE_LIMITING): at most --max-requests TMDB requests per run (default 1500), one every
// --interval-ms (default 250 ms, 4/s; TMDB allows ~40/s), no retries; a list whose pages did not all arrive is not
// written, so the previous copy stays. --dry-run makes no TMDB request and prints the plan.
//
//   node scripts/ingest-front-page.js [--dry-run] [--regions CA,US] [--pages 10] [--max-requests 1500]
//
// 10 pages = 200 titles a list, so Discover keeps loading past the first 60 as the page is scrolled (operator, Mon
// 23 Nov 2026). A run that hits the cap still stores the titles it looked up (not the list), so the next run goes on.
//
// Scheduled by scripts/Register-FrontPageTask.ps1 (twice a day). Stop: disable the task
// "\VaultWares\Vault Streaming Front Page" (Disable-ScheduledTask), or unregister it.

const fs = require('fs');
const path = require('path');

// ── the repo's .env first: src/raggae.js reads RAGGAE_URL and the options below read FRONT_PAGE_REGIONS at load
// (the token is never logged) ──────────────────────────
function loadEnv() {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
}
loadEnv();
const raggae = require('../src/raggae');
const keys = require('../src/front-page-keys');

// ── options ──────────────────────────────────────────────────────────────────
function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const DRY_RUN = process.argv.includes('--dry-run');
const REGIONS = String(arg('regions', process.env.FRONT_PAGE_REGIONS || 'CA,US')).split(',').map(s => s.trim().toUpperCase()).filter(r => /^[A-Z]{2}$/.test(r));
const PAGES = Math.max(1, Math.min(10, parseInt(arg('pages', '10'), 10) || 10));
const MAX_REQUESTS = Math.max(1, parseInt(arg('max-requests', '1500'), 10) || 1500);
const INTERVAL_MS = Math.max(100, parseInt(arg('interval-ms', '250'), 10) || 250);
const LANGUAGE = 'en-US';

const TOKEN = process.env.TMDB_BEARER_TOKEN;

// ── one bounded TMDB request ────────────────────────────────────────────────
let requests = 0;
let lastAt = 0;
class BudgetSpent extends Error { }

async function tmdb(route) {
    if (requests >= MAX_REQUESTS) throw new BudgetSpent(`request cap reached (${MAX_REQUESTS})`);
    const wait = lastAt + INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastAt = Date.now();
    requests++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const res = await fetch(`https://api.themoviedb.org/3${route}`, {
            headers: { accept: 'application/json', Authorization: `Bearer ${TOKEN}` }, signal: controller.signal,
        });
        if (res.status === 429) throw new BudgetSpent('TMDB answered 429 (rate limited): stopping this run');
        if (!res.ok) {
            console.warn(`  TMDB ${route.split('?')[0]} -> HTTP ${res.status}`);
            return null;
        }
        return await res.json();
    } catch (e) {
        if (e instanceof BudgetSpent) throw e;
        console.warn(`  TMDB ${route.split('?')[0]} failed: ${e.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// ── the plan ────────────────────────────────────────────────────────────────
function plan() {
    const lists = [{ key: keys.trending(), route: p => `/trending/all/day?language=${LANGUAGE}&page=${p}`, category: null }];
    for (const region of REGIONS) {
        for (const category of ['movie', 'tv']) {
            for (const provider of keys.PROVIDERS) {
                let route = `/discover/${category}?sort_by=popularity.desc&include_adult=false&language=${LANGUAGE}`;
                if (provider !== 'all') {
                    // watch_region is mandatory: without it TMDB ignores the provider filter
                    route += `&with_watch_providers=${keys.tmdbProvider(provider, region)}&watch_region=${region}&with_watch_monetization_types=flatrate`;
                } else {
                    route += `&watch_region=${region}`;
                }
                lists.push({ key: keys.discover(category, provider, region), route: p => `${route}&page=${p}`, category });
            }
        }
    }
    return lists;
}

function toIngest(hit, category, imdb) {
    const date = hit.release_date || hit.first_air_date || '';
    return {
        category,
        title: hit.title || hit.name,
        original_title: hit.original_title || hit.original_name || null,
        year: date ? parseInt(date.slice(0, 4), 10) || null : null,
        release_date: date || null,
        rating: hit.vote_average ? parseFloat(hit.vote_average.toFixed(1)) : null,
        votes: hit.vote_count || null,
        poster_url: hit.poster_path ? `https://image.tmdb.org/t/p/w500${hit.poster_path}` : null,
        overview: hit.overview || null,
        external_ids: { tmdb: hit.id, imdb: imdb || null },
        raw_enrichment: {
            tmdb: {
                meta: {
                    origin_country: hit.origin_country || [], original_language: hit.original_language || null,
                    genre_ids: hit.genre_ids || [], popularity: hit.popularity || null,
                    poster_path: hit.poster_path || null, backdrop_path: hit.backdrop_path || null,
                    listed_at: new Date().toISOString(),
                },
            },
        },
        source: 'tmdb',
    };
}

// ── run ─────────────────────────────────────────────────────────────────────
async function main() {
    const t0 = Date.now();
    const lists = plan();
    console.log(`[front-page] ${new Date().toString().slice(0, 21)}  regions ${REGIONS.join(',')}  ${lists.length} lists x ${PAGES} pages` +
        `  cap ${MAX_REQUESTS} requests, one per ${INTERVAL_MS} ms${DRY_RUN ? '  (dry run)' : ''}`);
    if (DRY_RUN) {
        const pageCalls = lists.length * PAGES;
        console.log(`  list pages: ${pageCalls} requests, plus one /external_ids per title the catalog does not know yet` +
            ` (at most ${pageCalls * 20} titles, far fewer after the first run); the run stops at ${MAX_REQUESTS}`);
        for (const l of lists) console.log(`  ${l.key}`);
        return;
    }
    if (!TOKEN) throw new Error('TMDB_BEARER_TOKEN is not set (.env)');
    const health = await raggae.health();
    if (!health.available) throw new Error('vault-raggae is not reachable (127.0.0.1:8750)');

    const known = new Map(); // "movie:603" -> catalog_id
    let created = 0;
    let written = 0;
    let stopped = null;
    for (const list of lists) {
        if (stopped) break;
        const hits = [];
        let complete = true;
        try {
            for (let page = 1; page <= PAGES; page++) {
                const data = await tmdb(list.route(page));
                if (!data || !Array.isArray(data.results)) { complete = false; break; }
                hits.push(...data.results);
            }
        } catch (e) {
            if (!(e instanceof BudgetSpent)) throw e;
            stopped = e.message;
            complete = false;
        }
        if (!complete) {
            console.warn(`  ${list.key}: incomplete, the stored list is kept`);
            continue;
        }

        const ids = [];
        const batch = [];
        for (const hit of hits) {
            const category = list.category || (hit.media_type === 'tv' ? 'tv' : hit.media_type === 'movie' ? 'movie' : null);
            if (!category || !hit.id || !(hit.title || hit.name)) continue;
            const k = `${category}:${hit.id}`;
            let cid = known.get(k);
            if (!cid) {
                const item = await raggae.byExternal('tmdb', category, hit.id);
                cid = item && item.catalog_id;
            }
            let imdb = null;
            if (!cid) {
                try {
                    const ext = await tmdb(`/${category}/${hit.id}/external_ids`);
                    imdb = ext && ext.imdb_id;
                } catch (e) {
                    if (!(e instanceof BudgetSpent)) throw e;
                    stopped = e.message;
                    break;
                }
            }
            batch.push({ k, item: { ...toIngest(hit, category, imdb), ...(cid ? { catalog_id: cid } : {}) } });
        }
        // stopped mid-list: the titles looked up so far are still stored (their /external_ids are not asked again
        // next run), but not the list, which would be short
        const partial = !!stopped;
        let ingestFailed = false;
        for (let i = 0; i < batch.length; i += 100) {
            const chunk = batch.slice(i, i + 100);
            const res = await raggae.ingest(chunk.map(b => b.item));
            if (!res || !Array.isArray(res.items)) { ingestFailed = true; continue; }
            const saved = res.items;
            chunk.forEach((b, j) => {
                const s = saved[j];
                if (s && s.catalog_id) {
                    known.set(b.k, s.catalog_id);
                    if (s.created) created++;
                }
            });
        }
        if (partial) {
            console.warn(`  ${list.key}: incomplete (${batch.length} titles stored), the stored list is kept`);
            break;
        }
        for (const b of batch) {
            const cid = known.get(b.k);
            if (cid && !ids.includes(cid)) ids.push(cid);
        }
        if (ingestFailed) {
            // a list missing the titles of a failed batch would replace a complete one: keep the stored copy
            console.warn(`  ${list.key}: the catalog did not store every title, the stored list is kept`);
            continue;
        }
        const out = await raggae.setList(list.key, ids);
        if (out) written++;
        console.log(`  ${list.key}: ${out ? out.count : 'NOT stored'} titles`);
    }
    console.log(`[front-page] ${written}/${lists.length} lists stored, ${created} new catalog items, ${requests} TMDB requests,` +
        ` ${((Date.now() - t0) / 1000).toFixed(0)} s${stopped ? `; stopped: ${stopped}` : ''}`);
    if (stopped) process.exitCode = 2;
}

main().catch(e => {
    console.error(`[front-page] failed: ${e.message}`);
    process.exitCode = 1;
});
