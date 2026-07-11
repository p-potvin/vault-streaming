// src/tmdb.js - Exposes real-time TMDB Search and Trending API handlers using process.env secrets

const fs = require('fs');
const path = require('path');

// Helper function to fetch with timeout
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response;
    } catch (err) {
        clearTimeout(timeoutId);
        throw err;
    }
}

// Load environment variables from .env
let envConfig = {};
try {
    const envPaths = [
        path.join(process.cwd(), '.env'),
        path.join(path.dirname(process.execPath), '.env'),
        process.resourcesPath ? path.join(process.resourcesPath, '.env') : null,
        path.join(__dirname, '.env'),
        path.join(__dirname, '..', '.env'),
        path.join(__dirname, '..', '..', '.env')
    ].filter(Boolean);
    for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        envContent.split(/\r?\n/).forEach(line => {
            const parts = line.split('=');
            if (parts.length >= 2) {
                const key = parts[0].trim();
                const value = parts.slice(1).join('=').trim();
                if (key) {
                    if (!process.env[key]) {
                        process.env[key] = value;
                    }
                    envConfig[key] = process.env[key];
                }
            }
        });
        break;
    }
    }
} catch (e) {
    console.error('[TMDB] Failed to load .env file:', e);
}

const TMDB_BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN || envConfig.TMDB_BEARER_TOKEN;
const TMDB_API_TOKEN = process.env.TMDB_API_TOKEN || envConfig.TMDB_API_TOKEN;

let KINOCHECK_API_KEY = '';
try {
    const keyPath = 'C:\\Users\\Administrator\\Desktop\\Github Repos\\.access\\kinocheck_api.txt';
    if (fs.existsSync(keyPath)) {
        KINOCHECK_API_KEY = fs.readFileSync(keyPath, 'utf8').trim();
        console.log('[KinoCheck] Successfully loaded premium API key.');
    } else {
        console.warn('[KinoCheck] API key not found at:', keyPath);
    }
} catch (e) {
    console.error('[KinoCheck] Failed to load API key:', e);
}

// Map TMDB genre IDs to human-readable strings
const GENRE_MAP = {
    28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime",
    99: "Documentary", 18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History",
    27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance", 878: "Sci-Fi",
    10770: "TV Movie", 53: "Thriller", 10752: "War", 37: "Western",
    10759: "Action & Adventure", 10762: "Kids", 10763: "News", 10764: "Reality",
    10765: "Sci-Fi & Fantasy", 10766: "Soap", 10767: "Talk", 10768: "War & Politics"
};

function registerTmdbHandlers(ipcMain) {
    ipcMain.handle('search-tmdb', async (event, arg) => {
        try {
            if (!TMDB_BEARER_TOKEN) {
                console.warn('[TMDB] No Bearer Token configured in .env');
                return { success: false, error: 'No Bearer Token configured in .env' };
            }

            let query = '';
            let page = 1;
            let language = 'en-US';
            if (arg && typeof arg === 'object') {
                query = arg.query || '';
                page = arg.page || 1;
                language = arg.language || 'en-US';
            } else if (typeof arg === 'string') {
                query = arg;
            }

            let url;
            if (!query) {
                // Fetch trending movies and TV shows for the day by default
                url = `https://api.themoviedb.org/3/trending/all/day?language=${language}&page=${page}`;
            } else {
                url = `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(query)}&include_adult=false&language=${language}&page=${page}`;
            }

            console.log(`[TMDB] Fetching API: ${url}`);
            const response = await fetchWithTimeout(url, {
                method: 'GET',
                headers: {
                    accept: 'application/json',
                    Authorization: `Bearer ${TMDB_BEARER_TOKEN}`
                }
            });

            if (!response.ok) {
                const errText = await response.text();
                console.error('[TMDB] Fetch failed:', response.status, errText);
                return { success: false, status: response.status, error: errText };
            }

            const data = await response.json();
            const results = (data.results || []).map(item => {
                const title = item.title || item.name || 'Untitled';
                const dateStr = item.release_date || item.first_air_date || '';
                const year = dateStr ? dateStr.substring(0, 4) : '—';
                const rating = item.vote_average ? item.vote_average.toFixed(1) : '—';
                
                // Map genre IDs
                const genres = (item.genre_ids || [])
                    .map(id => GENRE_MAP[id])
                    .filter(Boolean)
                    .slice(0, 3)
                    .join(', ') || 'General';

                const poster = item.poster_path 
                    ? `https://image.tmdb.org/t/p/w500${item.poster_path}`
                    : 'public/poster_placeholder.svg'; // Fallback to our premium asset

                return {
                    id: item.id,
                    media_type: item.media_type || 'movie',
                    title,
                    year,
                    rating,
                    genres,
                    poster,
                    overview: item.overview || 'No description available.'
                };
            });

            return { success: true, results };
        } catch (err) {
            console.error('[TMDB] Handler Error:', err);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('get-tmdb-movie', async (event, arg) => {
        try {
            let id;
            let language = 'en-US';
            if (arg && typeof arg === 'object') {
                id = arg.id;
                language = arg.language || 'en-US';
            } else {
                id = arg;
            }

            if (!TMDB_BEARER_TOKEN) {
                return {
                    success: true,
                    data: {
                        id,
                        title: "Dune: Part Two (Offline)",
                        overview: "Follow the mythic journey of Paul Atreides as he unites with Chani and the Fremen while on a path of revenge against the conspirators who destroyed his family.",
                        release_date: "2024-03-01",
                        vote_average: 8.3,
                        genres: [{ name: "Sci-Fi" }, { name: "Adventure" }],
                        videos: {
                            results: [
                                {
                                    key: "Way9DexNy3w",
                                    site: "YouTube",
                                    type: "Trailer"
                                }
                            ]
                        }
                    }
                };
            }

            const url = `https://api.themoviedb.org/3/movie/${id}?append_to_response=videos&language=${language}`;
            const response = await fetchWithTimeout(url, {
                method: 'GET',
                headers: {
                    accept: 'application/json',
                    Authorization: `Bearer ${TMDB_BEARER_TOKEN}`
                }
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();

            // Kinocheck fallback if no YouTube trailer is returned by TMDB
            if (!data.videos || !data.videos.results || data.videos.results.length === 0) {
                try {
                    console.log(`[TMDB] No YouTube trailer found in TMDB. Querying Kinocheck fallback for TMDB ID: ${id}`);
                    const kcUrl = `https://api.kinocheck.de/movies?tmdb_id=${id}`;
                    const kcRes = await fetchWithTimeout(kcUrl);
                    if (kcRes.ok) {
                        const kcData = await kcRes.json();
                        if (kcData && kcData.trailer && kcData.trailer.youtube_video_id) {
                            if (!data.videos) data.videos = { results: [] };
                            if (!data.videos.results) data.videos.results = [];
                            data.videos.results.push({
                                key: kcData.trailer.youtube_video_id,
                                site: 'YouTube',
                                type: 'Trailer'
                            });
                            console.log('[TMDB] Kinocheck fallback succeeded: found YouTube video ID:', kcData.trailer.youtube_video_id);
                        }
                    }
                } catch (kcErr) {
                    console.error('[TMDB] Kinocheck fallback fetch failed:', kcErr);
                }
            }

            return { success: true, data };
        } catch (e) {
            console.error('[TMDB] get-tmdb-movie failed, returning offline fallback:', e);
            return {
                success: true,
                data: {
                    id,
                    title: "Movie Title (Offline Fallback)",
                    overview: "A premium offline cinematic presentation. Please check your internet connection and .env file credentials for live data.",
                    release_date: "2026",
                    vote_average: 8.0,
                    genres: [{ name: "Drama" }],
                    videos: { results: [] }
                }
            };
        }
    });

    ipcMain.handle('get-tmdb-tv', async (event, arg) => {
        try {
            let id;
            let language = 'en-US';
            if (arg && typeof arg === 'object') {
                id = arg.id;
                language = arg.language || 'en-US';
            } else {
                id = arg;
            }

            if (!TMDB_BEARER_TOKEN) {
                return {
                    success: true,
                    data: {
                        id,
                        name: "Breaking Bad (Offline)",
                        overview: "A high school chemistry teacher diagnosed with inoperable lung cancer turns to manufacturing and selling methamphetamine with a former student in order to secure his family's future.",
                        first_air_date: "2008-01-20",
                        vote_average: 9.5,
                        genres: [{ name: "Drama" }, { name: "Crime" }],
                        seasons: [
                            { season_number: 1, name: "Season 1", episode_count: 7 },
                            { season_number: 2, name: "Season 2", episode_count: 13 }
                        ]
                    }
                };
            }

            const url = `https://api.themoviedb.org/3/tv/${id}?language=${language}`;
            const response = await fetchWithTimeout(url, {
                method: 'GET',
                headers: {
                    accept: 'application/json',
                    Authorization: `Bearer ${TMDB_BEARER_TOKEN}`
                }
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            return { success: true, data };
        } catch (e) {
            console.error('[TMDB] get-tmdb-tv failed, returning offline fallback:', e);
            return {
                success: true,
                data: {
                    id,
                    name: "Series Title (Offline Fallback)",
                    overview: "An elite offline episodic selection. Set up your TMDB key in .env to pull seasons and episodes in real time.",
                    first_air_date: "2026",
                    vote_average: 8.5,
                    genres: [{ name: "Adventure" }],
                    seasons: [
                        { season_number: 1, name: "Season 1", episode_count: 5 }
                    ]
                }
            };
        }
    });

    ipcMain.handle('get-tmdb-tv-season', async (event, arg) => {
        try {
            let id;
            let seasonNumber;
            let language = 'en-US';
            if (arg && typeof arg === 'object') {
                id = arg.id;
                seasonNumber = arg.seasonNumber;
                language = arg.language || 'en-US';
            } else {
                id = arg;
            }

            if (!TMDB_BEARER_TOKEN) {
                return {
                    success: true,
                    data: {
                        episodes: [
                            { episode_number: 1, name: "Pilot", overview: "Chemistry teacher Walter White learns he has terminal cancer." },
                            { episode_number: 2, name: "Cat's in the Bag...", overview: "Walt and Jesse clean up the chemical mess." }
                        ]
                    }
                };
            }

            const url = `https://api.themoviedb.org/3/tv/${id}/season/${seasonNumber}?language=${language}`;
            const response = await fetchWithTimeout(url, {
                method: 'GET',
                headers: {
                    accept: 'application/json',
                    Authorization: `Bearer ${TMDB_BEARER_TOKEN}`
                }
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            return { success: true, data };
        } catch (e) {
            console.error('[TMDB] get-tmdb-tv-season failed, returning offline fallback:', e);
            return {
                success: true,
                data: {
                    episodes: [
                        { episode_number: 1, name: "Episode 1 (Offline)", overview: "An engaging episodic installment. Ensure your network is active." },
                        { episode_number: 2, name: "Episode 2 (Offline)", overview: "The narrative deepens. Check your internet connection." }
                    ]
                }
            };
        }
    });

    // ── KinoCheck Premium API Handler ────────────────────────────────────────
    ipcMain.handle('get-kinocheck-trailer', async (event, { tmdbId, mediaType }) => {
        try {
            if (!KINOCHECK_API_KEY) {
                console.warn('[KinoCheck] No API key loaded.');
                return { success: false, error: 'No API key loaded.' };
            }
            const type = mediaType === 'tv' ? 'shows' : 'movies';
            const url = `https://api.kinocheck.com/${type}?tmdb_id=${tmdbId}&language=en`;
            console.log(`[KinoCheck] Fetching premium trailer: ${url}`);
            
            const response = await fetchWithTimeout(url, {
                headers: {
                    'X-Api-Key': KINOCHECK_API_KEY,
                    'Accept': 'application/json'
                }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP status ${response.status}`);
            }
            
            const data = await response.json();
            if (data && data.trailer && data.trailer.youtube_video_id) {
                return {
                    success: true,
                    key: data.trailer.youtube_video_id,
                    title: data.trailer.title,
                    thumbnail: data.trailer.youtube_thumbnail
                };
            }
            
            // Fallback to the videos array if main trailer object is missing
            if (data && Array.isArray(data.videos)) {
                const trailerVideo = data.videos.find(v => v.categories && v.categories.includes('Trailer') && v.youtube_video_id);
                if (trailerVideo) {
                    return {
                        success: true,
                        key: trailerVideo.youtube_video_id,
                        title: trailerVideo.title,
                        thumbnail: trailerVideo.youtube_thumbnail
                    };
                }
                
                // Final fallback: first available video
                if (data.videos.length > 0 && data.videos[0].youtube_video_id) {
                    return {
                        success: true,
                        key: data.videos[0].youtube_video_id,
                        title: data.videos[0].title,
                        thumbnail: data.videos[0].youtube_thumbnail
                    };
                }
            }
            
            return { success: false, error: 'No trailer found in KinoCheck response' };
        } catch (err) {
            console.error('[KinoCheck] Error fetching premium trailer:', err);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('discover-tmdb', async (event, { providerId, mediaType, page = 1, language = 'en-US' }) => {
        try {
            const type = mediaType === 'tv' ? 'tv' : 'movie';
            
            if (!TMDB_BEARER_TOKEN) {
                // Mock provider listings for offline/unconfigured usage
                let mockList = [];
                const netflixMock = [
                    { id: 201, media_type: type, title: "Stranger Things", year: "2016", rating: "8.6", genres: "Sci-Fi, Drama", poster: "public/poster_placeholder.svg", overview: "When a young boy vanishes, a small town uncovers a mystery involving secret experiments and terrifying supernatural forces." },
                    { id: 202, media_type: type, title: "Squid Game", year: "2021", rating: "8.1", genres: "Action, Thriller", poster: "public/poster_placeholder.svg", overview: "Hundreds of cash-strapped players accept a strange invitation to compete in children's games. Inside, a tempting prize awaits with deadly high stakes." }
                ];
                const disneyMock = [
                    { id: 301, media_type: type, title: "The Mandalorian", year: "2019", rating: "8.4", genres: "Action, Sci-Fi", poster: "public/poster_placeholder.svg", overview: "The travels of a lone bounty hunter in the outer reaches of the galaxy, far from the authority of the New Republic." },
                    { id: 302, media_type: type, title: "Loki", year: "2021", rating: "8.2", genres: "Sci-Fi, Adventure", poster: "public/poster_placeholder.svg", overview: "The mercurial villain Loki resumes his role as the God of Mischief in a new series that takes place after the events of Avengers: Endgame." }
                ];
                const appleMock = [
                    { id: 401, media_type: type, title: "Ted Lasso", year: "2020", rating: "8.5", genres: "Comedy, Drama", poster: "public/poster_placeholder.svg", overview: "US American football coach Ted Lasso heads to the UK to manage a struggling London football team in the top flight of English football." },
                    { id: 402, media_type: type, title: "Severance", year: "2022", rating: "8.7", genres: "Sci-Fi, Drama", poster: "public/poster_placeholder.svg", overview: "Mark leads a team of office workers whose memories have been surgically divided between their work and personal lives." }
                ];
                const primeMock = [
                    { id: 501, media_type: type, title: "The Boys", year: "2019", rating: "8.7", genres: "Sci-Fi, Action", poster: "public/poster_placeholder.svg", overview: "A group of vigilantes set out to take down corrupt superheroes who abuse their superpowers." },
                    { id: 502, media_type: type, title: "Reacher", year: "2022", rating: "8.1", genres: "Action, Crime", poster: "public/poster_placeholder.svg", overview: "Jack Reacher, a veteran military police investigator, is falsely accused of murder and finds himself in the middle of a deadly conspiracy." }
                ];

                if (providerId === '8' || providerId === '213') {
                    mockList = netflixMock;
                } else if (providerId === '337') {
                    mockList = disneyMock;
                } else if (providerId === '350') {
                    mockList = appleMock;
                } else if (providerId === '9') {
                    mockList = primeMock;
                } else {
                    mockList = [...netflixMock, ...disneyMock, ...appleMock, ...primeMock];
                }
                return { success: true, results: mockList };
            }

            let url;
            if (providerId === 'all') {
                url = `https://api.themoviedb.org/3/discover/${type}?sort_by=popularity.desc&language=${language}&with_original_language=en|fr|ja|ko&page=${page}`;
            } else {
                url = `https://api.themoviedb.org/3/discover/${type}?with_watch_providers=${providerId}&watch_region=CA&with_watch_monetization_types=flatrate&sort_by=popularity.desc&language=${language}&with_original_language=en|fr|ja|ko&page=${page}`;
            }
            console.log(`[TMDB] Discovering streaming provider items: ${url}`);
            
            const response = await fetchWithTimeout(url, {
                method: 'GET',
                headers: {
                    accept: 'application/json',
                    Authorization: `Bearer ${TMDB_BEARER_TOKEN}`
                }
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            
            const results = (data.results || []).map(item => {
                const title = item.title || item.name || 'Untitled';
                const dateStr = item.release_date || item.first_air_date || '';
                const year = dateStr ? dateStr.substring(0, 4) : '—';
                const rating = item.vote_average ? item.vote_average.toFixed(1) : '—';
                
                const genres = (item.genre_ids || [])
                    .map(id => GENRE_MAP[id])
                    .filter(Boolean)
                    .slice(0, 3)
                    .join(', ') || 'General';

                const poster = item.poster_path 
                    ? `https://image.tmdb.org/t/p/w500${item.poster_path}`
                    : 'public/poster_placeholder.svg';

                return {
                    id: item.id,
                    media_type: type,
                    title,
                    year,
                    rating,
                    genres,
                    poster,
                    overview: item.overview || 'No description available.'
                };
            });

            return { success: true, results };
        } catch (e) {
            console.error('[TMDB] discover-tmdb failed:', e);
            return { success: false, error: e.message };
        }
    });

    // ── OMDb API Support ──────────────────────────────────────────────────────
    const OMDB_API_KEY = '219a7856';

    ipcMain.handle('search-omdb', async (event, { query, page = 1 }) => {
        try {
            if (!query) return { success: true, results: [] };
            
            const url = `http://www.omdbapi.com/?s=${encodeURIComponent(query)}&page=${page}&apikey=${OMDB_API_KEY}`;
            console.log(`[OMDb] Searching: ${url}`);
            
            const response = await fetchWithTimeout(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            const data = await response.json();
            if (data.Response === 'False') {
                return { success: true, results: [], totalResults: 0 };
            }
            
            const results = (data.Search || []).map(item => {
                let poster = 'public/poster_placeholder.svg';
                if (item.Poster && item.Poster !== 'N/A') {
                    poster = item.Poster;
                }
                
                return {
                    id: item.imdbID,
                    imdb_id: item.imdbID,
                    media_type: item.Type === 'series' ? 'tv' : 'movie',
                    title: item.Title || 'Untitled',
                    year: item.Year || '—',
                    rating: '—',
                    genres: item.Type ? item.Type.toUpperCase() : 'General',
                    poster: poster,
                    overview: `IMDb ID: ${item.imdbID}. Use standard RD stream search to look up this title.`
                };
            });
            
            return { success: true, results, totalResults: parseInt(data.totalResults) || results.length };
        } catch (err) {
            console.error('[OMDb] Search error:', err);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('get-omdb-details', async (event, { imdbId, title, year }) => {
        try {
            let url = `http://www.omdbapi.com/?apikey=${OMDB_API_KEY}&plot=full`;
            if (imdbId) {
                url += `&i=${imdbId}`;
            } else if (title) {
                url += `&t=${encodeURIComponent(title)}`;
                if (year) url += `&y=${year}`;
            } else {
                return { success: false, error: 'Either imdbId or title must be provided' };
            }
            
            console.log(`[OMDb] Fetching details: ${url}`);
            const response = await fetchWithTimeout(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            const data = await response.json();
            if (data.Response === 'False') {
                throw new Error(data.Error || 'Movie not found in OMDb');
            }
            
            let poster = 'public/poster_placeholder.svg';
            if (data.Poster && data.Poster !== 'N/A') {
                poster = data.Poster;
            }
            
            const formatted = {
                id: data.imdbID || null,
                imdb_id: data.imdbID || null,
                title: data.Title || 'Untitled',
                year: data.Year || '—',
                rating: data.imdbRating || '—',
                genres: data.Genre || 'General',
                poster: poster,
                overview: data.Plot || 'No plot available.',
                director: data.Director || '—',
                writer: data.Writer || '—',
                actors: data.Actors || '—',
                awards: data.Awards || '—',
                runtime: data.Runtime || '—'
            };
            
            return { success: true, data: formatted };
        } catch (err) {
            console.error('[OMDb] Get details error:', err);
            return { success: false, error: err.message };
        }
    });
}

module.exports = {
    registerTmdbHandlers
};
