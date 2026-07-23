// trailer-cache.ipc.js — durable per-instance cache of YouTube trailers.
//
// Instead of re-resolving a trailer via KinoCheck + yt-dlp `--get-url` (whose
// googlevideo URLs expire) on every view, we download it once with yt-dlp and
// upload durable copies to file hosts, then serve those URLs. The mapping
// (youtube_id -> hosted URLs) is a JSON file in userData — "a collection of
// cached links per instance", no API/DB.
//
// All outbound host traffic goes through the app's existing proxy tunnel
// (settings.debridProxyAddress) when enabled, reusing src/realdebrid/proxy.js.
//
// Hosts:
//   - pixeldrain: PUT raw bytes, clean Range+CORS — the primary <video> stream.
//   - gofile:     multipart upload — durable backup (download page, not a stream).
//   - 1fichier:   multipart upload — durable backup (throttled free downloads).
//   - torbox:     submits the YouTube URL server-side (~10 min) — durable backfill.
//
// Keys are read at runtime from the .access store (never hardcoded/logged):
//   .access/cloud_storage_keys.txt  ->  pixeldrain= / gofile= / 1fichier=
//   .access/torbox.api.txt          ->  single-line TorBox key

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { makeProxiedRequest, uploadBufferWithProxy } = require('../realdebrid/proxy');

const ACCESS_DIR = 'C:\\Users\\Administrator\\Desktop\\Github Repos\\.access';
const cacheFile = () => path.join(app.getPath('userData'), 'trailer-cache.json');

// ── Credentials ─────────────────────────────────────────────────────────────
let _keys = null;
function loadKeys() {
    if (_keys) return _keys;
    const out = {};
    try {
        const txt = fs.readFileSync(path.join(ACCESS_DIR, 'cloud_storage_keys.txt'), 'utf8');
        for (const line of txt.split(/\r?\n/)) {
            const m = line.match(/^\s*([^=#]+?)\s*=\s*(.+?)\s*$/);
            if (m) out[m[1].toLowerCase()] = m[2];
        }
    } catch (_) { /* missing file — hosts needing keys are skipped */ }
    try { out.torbox = fs.readFileSync(path.join(ACCESS_DIR, 'torbox.api.txt'), 'utf8').trim(); } catch (_) { }
    _keys = out;
    return out;
}

// ── Cache store ─────────────────────────────────────────────────────────────
function loadCache() {
    try { return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch (_) { return {}; }
}
function saveCache(map) {
    try { fs.writeFileSync(cacheFile(), JSON.stringify(map, null, 2)); }
    catch (e) { console.error('[trailer-cache] save failed:', e.message); }
}
// Merge patch into one entry, re-reading first so concurrent host callbacks don't clobber.
function patchEntry(youtubeId, patch) {
    const c = loadCache();
    c[youtubeId] = { ...(c[youtubeId] || {}), ...patch, youtube_id: youtubeId, updated_at: Date.now() };
    saveCache(c);
    return c[youtubeId];
}

// ── multipart/form-data builder (Buffer body for uploadBufferWithProxy) ───────
function buildMultipart(fields, fileField, fileName, fileBuffer, contentType) {
    const boundary = '----vwTrailer' + Date.now().toString(16) + Math.random().toString(16).slice(2);
    const parts = [];
    for (const [k, v] of Object.entries(fields || {})) {
        if (v == null) continue;
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`));
    parts.push(fileBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    return { body: Buffer.concat(parts), boundary };
}

// ── yt-dlp download (progressive mp4, native <video>-playable) ────────────────
function ytDlpDownload(youtubeId) {
    return new Promise((resolve, reject) => {
        const out = path.join(os.tmpdir(), `vw_trailer_${youtubeId}_${Date.now()}.mp4`);
        const url = `https://www.youtube.com/watch?v=${youtubeId}`;
        const args = ['--format', '22/18/best[ext=mp4]/best', '--no-playlist', '--no-warnings',
            '--no-check-certificates', '--extractor-args', 'youtube:player_client=android,web', '-o', out, url];
        const proc = spawn('yt-dlp', args, { windowsHide: true });
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
            if (code === 0 && fs.existsSync(out)) resolve(out);
            else reject(new Error(stderr.trim().slice(-300) || `yt-dlp exited ${code}`));
        });
        proc.on('error', reject);
    });
}

// ── Uploaders (each resolves to a URL string or throws) ───────────────────────

// pixeldrain: PUT raw bytes -> { id }; stream URL is Range-capable. Requires the
// API key via HTTP Basic auth (empty user, key as password) — anonymous PUT now 401s.
async function uploadPixeldrain(buf, fileName, apiKey, proxy) {
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (apiKey) headers['Authorization'] = 'Basic ' + Buffer.from(':' + apiKey).toString('base64');
    const res = await uploadBufferWithProxy(`https://pixeldrain.com/api/file/${encodeURIComponent(fileName)}`,
        buf, { method: 'PUT', headers }, proxy);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const j = await res.json();
    if (!j || !j.id) throw new Error('no id in response');
    return `https://pixeldrain.com/api/file/${j.id}`;
}

// gofile: pick a server, multipart POST the file. Returns the download page.
async function uploadGofile(buf, fileName, apiKey, proxy) {
    const sres = await makeProxiedRequest('https://api.gofile.io/servers', {}, proxy);
    const sj = await sres.json();
    const server = sj && sj.data && sj.data.servers && sj.data.servers[0] && sj.data.servers[0].name;
    if (!server) throw new Error('no gofile server');
    const headers = { 'Content-Type': '' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const { body, boundary } = buildMultipart({}, 'file', fileName, buf, 'video/mp4');
    headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    const ures = await uploadBufferWithProxy(`https://${server}.gofile.io/contents/uploadfile`, body,
        { method: 'POST', headers }, proxy);
    if (!ures.ok) throw new Error(`HTTP ${ures.status}`);
    const j = await ures.json();
    const page = j && j.data && (j.data.downloadPage || j.data.link);
    if (!page) throw new Error('no downloadPage');
    return page;
}

// 1fichier: get an upload server, multipart POST, then end.cgi for the link.
async function uploadOneFichier(buf, fileName, apiKey, proxy) {
    if (!apiKey) throw new Error('no 1fichier key');
    // 1fichier's API validates Content-Type: application/json on its cgi endpoints.
    const gres = await makeProxiedRequest('https://api.1fichier.com/v1/upload/get_upload_server.cgi',
        { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Accept': 'application/json' } }, proxy);
    const g = await gres.json();
    if (!g || !g.url || !g.id) throw new Error('no upload server');
    const { body, boundary } = buildMultipart({}, 'file[]', fileName, buf, 'video/mp4');
    await uploadBufferWithProxy(`https://${g.url}/upload.cgi?id=${g.id}`, body,
        { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } }, proxy);
    const eres = await makeProxiedRequest(`https://${g.url}/end.cgi?xid=${g.id}`,
        { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Accept': 'application/json' } }, proxy);
    const e = await eres.json();
    const link = Array.isArray(e) ? (e[0] && e[0].download) : (e && e.links && e.links[0] && e.links[0].download);
    if (!link) throw new Error('no link from end.cgi');
    return link;
}

// TorBox: submit the YouTube URL (server-side download, ~10 min), then poll.
// Runs detached from the main pipeline; updates the cache entry when ready.
async function backfillTorbox(youtubeId, apiKey, proxy) {
    if (!apiKey) return;
    try {
        const yt = `https://www.youtube.com/watch?v=${youtubeId}`;
        const form = Buffer.from(`link=${encodeURIComponent(yt)}`);
        const cres = await uploadBufferWithProxy('https://api.torbox.app/v1/api/webdl/createwebdownload', form,
            { method: 'POST', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' } }, proxy);
        const cj = await cres.json();
        const webId = cj && cj.data && (cj.data.webdownload_id || cj.data.id || cj.data.hash);
        if (!webId) { console.warn('[trailer-cache] torbox: no web id'); return; }
        patchEntry(youtubeId, { torbox_status: 'queued', torbox_id: String(webId) });

        // Bounded poll: up to ~15 min for this one submitted job.
        for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 45000));
            const lres = await makeProxiedRequest(`https://api.torbox.app/v1/api/webdl/mylist?id=${encodeURIComponent(webId)}`,
                { headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' } }, proxy);
            const lj = await lres.json();
            const item = lj && lj.data && (Array.isArray(lj.data) ? lj.data[0] : lj.data);
            if (item && (item.download_finished || item.download_present)) {
                const fileId = item.files && item.files[0] && (item.files[0].id != null ? item.files[0].id : 0);
                const dres = await makeProxiedRequest(
                    `https://api.torbox.app/v1/api/webdl/requestdl?token=${encodeURIComponent(apiKey)}&web_id=${encodeURIComponent(webId)}&file_id=${encodeURIComponent(fileId != null ? fileId : 0)}`,
                    { headers: { 'Accept': 'application/json' } }, proxy);
                const dj = await dres.json();
                const url = dj && (dj.data && (dj.data.url || dj.data) );
                if (url && typeof url === 'string') {
                    patchEntry(youtubeId, { torbox_url: url, torbox_status: 'ready' });
                    console.log('[trailer-cache] torbox ready for', youtubeId);
                }
                return;
            }
        }
        patchEntry(youtubeId, { torbox_status: 'timeout' });
    } catch (e) {
        console.warn('[trailer-cache] torbox backfill failed:', e.message);
        patchEntry(youtubeId, { torbox_status: 'failed' });
    }
}

// ── IPC ───────────────────────────────────────────────────────────────────────
function registerTrailerCacheIpc(ipcMain) {
    // Lookup — a ready entry or null (caller falls back to the live flow).
    ipcMain.handle('trailer-cache:get', (_e, youtubeId) => {
        if (!youtubeId || typeof youtubeId !== 'string') return null;
        const entry = loadCache()[youtubeId];
        return (entry && entry.status === 'ready' && entry.primary_url) ? entry : null;
    });

    // Warm the cache for one trailer. Deduped (ready/pending = no-op), so it's safe
    // to fire-and-forget. One yt-dlp download + parallel instant uploads, then a
    // detached TorBox backfill.
    ipcMain.handle('trailer-cache:put', async (_e, { youtubeId, title, proxy } = {}) => {
        if (!youtubeId || typeof youtubeId !== 'string') return { success: false, error: 'Invalid youtubeId' };

        const existing = loadCache()[youtubeId];
        if (existing && existing.status === 'ready') return { success: true, entry: existing, cached: true };
        if (existing && existing.status === 'pending') return { success: false, pending: true };

        patchEntry(youtubeId, { title: title || '', status: 'pending', created_at: Date.now() });

        const keys = loadKeys();
        let filePath;
        try {
            filePath = await ytDlpDownload(youtubeId);
            const buf = fs.readFileSync(filePath);
            const fileName = path.basename(filePath);

            // Instant hosts in parallel; one bad host can't sink the others.
            const [px, gf, of] = await Promise.allSettled([
                uploadPixeldrain(buf, fileName, keys.pixeldrain, proxy),
                keys.gofile ? uploadGofile(buf, fileName, keys.gofile, proxy) : Promise.reject(new Error('skip')),
                keys['1fichier'] ? uploadOneFichier(buf, fileName, keys['1fichier'], proxy) : Promise.reject(new Error('skip')),
            ]);
            const pixeldrainUrl = px.status === 'fulfilled' ? px.value : null;
            const gofileUrl = gf.status === 'fulfilled' ? gf.value : null;
            const onefichierUrl = of.status === 'fulfilled' ? of.value : null;
            for (const [name, r] of [['pixeldrain', px], ['gofile', gf], ['1fichier', of]]) {
                if (r.status === 'rejected' && r.reason && r.reason.message !== 'skip') {
                    console.warn(`[trailer-cache] ${name} failed:`, r.reason.message);
                }
            }

            // pixeldrain is the only reliably streamable one → preferred primary.
            const primary = pixeldrainUrl || gofileUrl || onefichierUrl;
            const entry = patchEntry(youtubeId, {
                title: title || '',
                status: primary ? 'ready' : 'failed',
                pixeldrain_url: pixeldrainUrl,
                gofile_url: gofileUrl,
                onefichier_url: onefichierUrl,
                primary_url: primary,
                error: primary ? null : 'all instant hosts failed',
                ready_at: primary ? Date.now() : null,
            });

            // Detached durable backfill (does not need the temp file / does not block).
            if (keys.torbox) backfillTorbox(youtubeId, keys.torbox, proxy);

            if (primary) console.log('[trailer-cache] cached', youtubeId, '->', primary);
            return { success: !!primary, entry, error: primary ? undefined : 'all instant hosts failed' };
        } catch (error) {
            patchEntry(youtubeId, { status: 'failed', error: error.message });
            console.error('[trailer-cache] failed for', youtubeId, '-', error.message);
            return { success: false, error: error.message };
        } finally {
            if (filePath) { try { fs.rmSync(filePath, { force: true }); } catch (_) { } }
        }
    });
}

module.exports = { registerTrailerCacheIpc };
