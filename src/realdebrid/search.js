// src/realdebrid/search.js - torrent source discovery (Comet primary, Torrentio/EZTV/YTS fallbacks)
const { fetchWithTimeout, checkRealDebridCache, TMDB_BEARER_TOKEN, COMET_STREAM_BASE } = require("./client");

async function fetchCometStreams(streamType, idParam, cleanTitle) {
    if (!COMET_STREAM_BASE) return null;
    const url = `${COMET_STREAM_BASE}/stream/${streamType}/${idParam}.json`;
    try {
        console.log(`[Comet] Fetching: ${url.replace(/\/eyJ[^/]+/, '/<config>')}`);
        const res = await fetchWithTimeout(url, {}, 8000);
        if (!res.ok) {
            console.warn(`[Comet] HTTP ${res.status}`);
            return null;
        }
        const data = await res.json();
        if (!data || !Array.isArray(data.streams) || data.streams.length === 0) {
            console.log(`[Comet] No streams returned`);
            return null;
        }
        console.log(`[Comet] Found ${data.streams.length} streams`);
        return data.streams.map(s => {
            const nameStr = s.name || '';
            const descStr = s.description || s.title || '';
            const qualMatch = nameStr.match(/(4[Kk]|2160[Pp]|1080[Pp]|720[Pp]|480[Pp]|HDR10\+?|HDR|DV|DoVi)/i)
                || descStr.match(/(4[Kk]|2160[Pp]|1080[Pp]|720[Pp]|480[Pp]|HDR10\+?|HDR|DV|DoVi)/i);
            const quality = qualMatch ? qualMatch[0] : 'HD';
            const sizeMatch = descStr.match(/💾\s*([0-9.]+\s*[GgMm][Bb])/i)
                || descStr.match(/Size:\s*([0-9.]+\s*[GgMm][Bb])/i)
                || descStr.match(/([0-9.]+\s*[GgMm][Bb])/i);
            const size = sizeMatch ? sizeMatch[1] : 'Unknown Size';
            const seedsMatch = descStr.match(/👥\s*([0-9]+)/i) || descStr.match(/S:\s*([0-9]+)/i);
            const seeds = seedsMatch ? seedsMatch[1] : '—';
            const hash = (s.infoHash || s.behaviorHints?.bingeGroup?.match(/[a-fA-F0-9]{40}/)?.[0] || '').toLowerCase();
            const magnet = hash
                ? `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(cleanTitle)}&tr=udp://tracker.coppersurfer.tk:6969/announce&tr=udp://tracker.opentrackr.org:1337/announce`
                : '';
            const hasRdUrl = !!s.url;
            return {
                quality,
                type: (hasRdUrl ? '⚡ [RD+] ' : '') + 'Comet ' + nameStr.split('\n')[0].trim(),
                size,
                seeds,
                peers: '—',
                hash,
                magnet,
                desc: descStr.split('\n')[0] || nameStr,
                url: s.url || null,
                cached: hasRdUrl
            };
        });
    } catch (err) {
        console.warn(`[Comet] Fetch failed: ${err.message}`);
        return null;
    }
}

function registerSearchHandlers(ipcMain) {
    ipcMain.handle('search-torrents', async (event, { movieTitle, tmdbId, mediaType, season, episode }) => {
        try {
            let imdbId = null;
            const itemMediaType = mediaType || 'movie';

            // Resolve IMDB ID if TMDB ID is available
            if (tmdbId && TMDB_BEARER_TOKEN) {
                console.log(`[Real-Debrid] Fetching IMDB ID from TMDB for TMDB ID: ${tmdbId} (${itemMediaType})`);
                try {
                    const extRes = await fetchWithTimeout(`https://api.themoviedb.org/3/${itemMediaType}/${tmdbId}/external_ids`, {
                        headers: {
                            accept: 'application/json',
                            Authorization: `Bearer ${TMDB_BEARER_TOKEN}`
                        }
                    });
                    if (extRes.ok) {
                        const extData = await extRes.json();
                        imdbId = extData.imdb_id;
                        console.log(`[Real-Debrid] Resolved IMDB ID: ${imdbId}`);
                    }
                } catch (err) {
                    console.error('[Real-Debrid] Failed to fetch external IDs from TMDB:', err);
                }
            }

            // If we have an IMDB ID, query Torrentio
            // NOTE: We query Torrentio's public API WITHOUT the debrid prefix. This is 10X more stable
            // because it bypasses Torrentio's overloaded debrid proxy server, and we resolve/unrestrict
            // the cached torrent privately on the client side using the Real-Debrid API anyway.
            const cleanTitle = movieTitle.replace(/[.]/g, '').trim();

            if (imdbId) {
                const streamType = itemMediaType === 'tv' || itemMediaType === 'series' ? 'series' : 'movie';
                const s = season || 1;
                const e = episode || 1;
                const idParam = (itemMediaType === 'tv' || itemMediaType === 'series') ? `${imdbId}:${s}:${e}` : imdbId;

                const cometList = await fetchCometStreams(streamType, idParam, cleanTitle);
                if (cometList && cometList.length > 0) {
                    const needsRdCheck = cometList.some(t => !t.cached && t.hash);
                    const finalList = needsRdCheck ? await checkRealDebridCache(cometList) : cometList;
                    return { success: true, title: cleanTitle, torrents: finalList };
                }

                const torrentioDefaultUrl = `https://torrentio.strem.fun/stream/${streamType}/${idParam}.json`;
                const torrentioCustomUrl = `https://torrentio.strem.fun/providers=yts,eztv,rarbg,1337x,thepiratebay,kickasstorrents,torrentproject,torrentgalaxy,magnetdl,horriblesubs,nyaasi,tokyotosho,anidex|limit=20/stream/${streamType}/${idParam}.json`;
                
                console.log(`[Real-Debrid] Fetching Torrentio streams for ${streamType} ${idParam}`);
                let response = null;
                let data = null;
                
                try {
                    console.log(`[Real-Debrid] Trying cached Torrentio endpoint: ${torrentioDefaultUrl}`);
                    const res = await fetchWithTimeout(torrentioDefaultUrl, {}, 3000);
                    if (res.ok) {
                        const temp = await res.json();
                        if (temp && temp.streams && temp.streams.length > 0) {
                            response = res;
                            data = temp;
                            console.log(`[Real-Debrid] Successfully hit cached Torrentio endpoint`);
                        }
                    }
                } catch (err) {
                    console.warn('[Real-Debrid] Cached Torrentio query skipped/timed out:', err.message);
                }
                
                if (!data) {
                    try {
                        console.log(`[Real-Debrid] Falling back to custom providers query: ${torrentioCustomUrl}`);
                        const res = await fetchWithTimeout(torrentioCustomUrl, {}, 5000);
                        if (res.ok) {
                            const temp = await res.json();
                            if (temp && temp.streams && temp.streams.length > 0) {
                                response = res;
                                data = temp;
                                console.log(`[Real-Debrid] Successfully fetched streams from custom providers list`);
                            }
                        }
                    } catch (err) {
                        console.warn('[Real-Debrid] Custom providers query failed/timed out:', err.message);
                    }
                }

                if (data && data.streams && data.streams.length > 0) {
                    console.log(`[Real-Debrid] Found ${data.streams.length} Torrentio streams`);
                    const torrentList = data.streams.map(t => {
                                const nameStr = t.name || '';
                                const titleStr = t.title || '';

                                // Parse Quality (e.g. 1080p, 4k, 720p)
                                const qualMatch = nameStr.match(/(4[Kk]|2160[Pp]|1080[Pp]|720[Pp]|HDR|HDR10|DV)/i) || titleStr.match(/(4[Kk]|2160[Pp]|1080[Pp]|720[Pp]|HDR|HDR10|DV)/i);
                                const quality = qualMatch ? qualMatch[0] : 'HD';

                                // Parse Size (e.g. Size: 2.5 GB or 2.5GB)
                                const sizeMatch = titleStr.match(/Size:\s*([0-9.]+\s*[GgMm][Bb])/i) || titleStr.match(/([0-9.]+\s*[GgMm][Bb])/i);
                                const size = sizeMatch ? sizeMatch[1] : 'Unknown Size';

                                // Parse Seeders and Leechers (e.g. S: 142 L: 12)
                                const seedsMatch = titleStr.match(/S:\s*([0-9]+)/i) || titleStr.match(/👤\s*([0-9]+)/i);
                                const seeds = seedsMatch ? seedsMatch[1] : '—';
                                const peersMatch = titleStr.match(/L:\s*([0-9]+)/i) || titleStr.match(/📥\s*([0-9]+)/i);
                                const peers = peersMatch ? peersMatch[1] : '—';

                                // Generate clean title/description from the stream details
                                const desc = titleStr.split('\n')[0] || nameStr;

                                const magnet = `magnet:?xt=urn:btih:${t.infoHash}&dn=${encodeURIComponent(cleanTitle)}&tr=udp://tracker.coppersurfer.tk:6969/announce&tr=udp://9.rarbg.to:2710/announce&tr=udp://tracker.opentrackr.org:1337/announce`;

                                return {
                                    quality,
                                    type: nameStr.replace('\n', ' ').trim(),
                                    size,
                                    seeds,
                                    peers,
                                    hash: t.infoHash,
                                    magnet,
                                    desc,
                                    url: t.url || null
                                };
                            });

                            const checkedList = await checkRealDebridCache(torrentList);
                            return { success: true, title: cleanTitle, torrents: checkedList };
                        }
                    }

            // Fallback to EZTV for TV series/shows
            if (itemMediaType === 'tv' || itemMediaType === 'series') {
                console.log(`[Real-Debrid] Torrentio unavailable or not found. Falling back to EZTV for series: ${cleanTitle}`);
                const eztvDomains = ['eztv.re', 'eztv.wf', 'eztv.tf', 'eztv.yt'];
                let eztvData = null;
                const imdbNumber = imdbId ? imdbId.replace('tt', '') : '';
                
                for (const domain of eztvDomains) {
                    try {
                        const url = imdbNumber 
                            ? `https://${domain}/api/get-torrents?imdb_id=${imdbNumber}`
                            : `https://${domain}/api/get-torrents?limit=10&query=${encodeURIComponent(cleanTitle)}`;
                        console.log(`[Real-Debrid] Trying EZTV mirror: ${url}`);
                        const response = await fetchWithTimeout(url, {}, 4000);
                        if (response.ok) {
                            const data = await response.json();
                            if (data && data.torrents && data.torrents.length > 0) {
                                eztvData = data.torrents;
                                console.log(`[Real-Debrid] Successfully resolved torrent listings from EZTV mirror: ${domain}`);
                                break;
                            }
                        }
                    } catch (err) {
                        console.warn(`[Real-Debrid] EZTV mirror ${domain} failed:`, err.message);
                    }
                }
                
                if (eztvData && eztvData.length > 0) {
                    const torrentList = eztvData.map(t => {
                        const magnet = t.magnet_url || `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(t.title)}&tr=udp://tracker.coppersurfer.tk:6969/announce&tr=udp://9.rarbg.to:2710/announce&tr=udp://tracker.opentrackr.org:1337/announce`;
                        return {
                            quality: t.title.includes('1080p') ? '1080p' : (t.title.includes('720p') ? '720p' : 'SD'),
                            type: 'EZTV',
                            size: t.size || 'Unknown Size',
                            seeds: t.seeds || '—',
                            peers: t.peers || '—',
                            hash: t.hash || t.magnet_url.match(/btih:([a-fA-F0-9]+)/)?.[1] || '',
                            magnet,
                            desc: t.title
                        };
                    });
                    const checkedList = await checkRealDebridCache(torrentList);
                    return { success: true, title: cleanTitle, torrents: checkedList };
                }
            }

            // Fallback to YTS with Multi-Domain ISP Bypass Rotation
            console.log(`[Real-Debrid] Torrentio unavailable or not found. Falling back to YTS for: ${cleanTitle}`);
            
            const ytsDomains = ['yts.lt', 'yts.pm', 'yts.ae', 'yts.mx'];
            let ytsData = null;
            
            for (const domain of ytsDomains) {
                try {
                    const url = `https://${domain}/api/v2/list_movies.json?query_term=${encodeURIComponent(cleanTitle)}`;
                    console.log(`[Real-Debrid] Trying YTS mirror: ${url}`);
                    const response = await fetchWithTimeout(url, {}, 4000);
                    if (response.ok) {
                        const data = await response.json();
                        if (data && data.data && data.data.movies && data.data.movies.length > 0) {
                            ytsData = data.data.movies;
                            console.log(`[Real-Debrid] Successfully resolved torrent listings from mirror: ${domain}`);
                            break;
                        }
                    }
                } catch (err) {
                    console.warn(`[Real-Debrid] YTS mirror ${domain} failed:`, err.message);
                }
            }

            const movies = ytsData || [];
            if (movies.length === 0) {
                return { success: false, error: 'No torrent matches found on any mirror.' };
            }

            const match = movies.find(m => m.title.toLowerCase().includes(cleanTitle.toLowerCase())) || movies[0];
            if (!match || !match.torrents || match.torrents.length === 0) {
                return { success: false, error: 'No torrent matches found' };
            }

            const SHA1_RE = /^[a-fA-F0-9]{40}$/;
            const torrentList = match.torrents
                .filter(t => t.hash && SHA1_RE.test(t.hash))
                .map(t => {
                    const magnet = `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(match.title)}&tr=udp://tracker.coppersurfer.tk:6969/announce&tr=udp://9.rarbg.to:2710/announce&tr=udp://tracker.opentrackr.org:1337/announce`;
                    return {
                        quality: t.quality,
                        type: 'YTS ' + (t.type || 'unknown').toUpperCase(),
                        size: t.size,
                        seeds: t.seeds || 0,
                        peers: t.peers || 0,
                        hash: t.hash.toLowerCase(),
                        magnet,
                        desc: `${match.title} (${t.quality})`
                    };
                });

            if (torrentList.length === 0) {
                console.warn('[Real-Debrid] YTS returned movie data but no valid torrent hashes.');
                return { success: false, error: 'YTS mirror returned data but no valid torrent hashes.' };
            }

            console.log(`[Real-Debrid] YTS resolved ${torrentList.length} valid torrent(s) for "${match.title}"`);
            const checkedList = await checkRealDebridCache(torrentList);
            return { success: true, title: match.title, torrents: checkedList };
        } catch (e) {
            console.error('[Real-Debrid] Search error:', e);
            return { success: false, error: e.message };
        }
    });
}

module.exports = { registerSearchHandlers };
