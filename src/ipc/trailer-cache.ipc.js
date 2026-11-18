// trailer-cache.ipc.js — the renderer's door to the local trailer cache (src/trailers.js).
//
// Replaces the former file-host mirror (pixeldrain / gofile / 1fichier / TorBox uploads), which was never wired into
// the UI: trailers now live on the local disk (G: by default) and are fetched from YouTube once.

const trailers = require('../trailers');

function registerTrailerCacheIpc(ipcMain) {
    // Key + local file for a title; the first call downloads it (deduped), later calls are a disk lookup.
    ipcMain.handle('trailer:get', async (_e, args = {}) => {
        try {
            return await trailers.getTrailer(args);
        } catch (e) {
            console.error('[Trailer] get failed:', e.message);
            return { success: false, error: e.message };
        }
    });

    // The local file for a known YouTube id (downloads it the first time).
    ipcMain.handle('trailer-cache:get', async (_e, youtubeId) => {
        try {
            return await trailers.ensureFile(youtubeId);
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('trailer-cache:stats', () => trailers.stats());
}

module.exports = { registerTrailerCacheIpc };
