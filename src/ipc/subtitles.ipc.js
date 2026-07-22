// src/ipc/subtitles.ipc.js — subtitle discovery for the player.
//
// Restores the 'find-subtitles' handler that was dropped during the
// streaming-only trim while its preload binding and renderer callers stayed.
// Without it, `ipcRenderer.invoke('find-subtitles', ...)` rejects with
// "No handler registered for 'find-subtitles'", which surfaces as an unhandled
// rejection during the player's track setup.
//
//   • Local files  → scans for sidecar .srt/.vtt subtitles beside the video.
//   • Stream URLs  → returns [] gracefully (nothing local to find).
//
// OpenSubtitles remote lookup is intentionally NOT reimplemented here yet; the
// `queryTitle` / `langs` args and settings.openSubtitlesKey are reserved for it.

const fs = require('fs');
const path = require('path');

const SUB_EXTS = ['.srt', '.vtt'];

// Map a trailing language token in a sidecar filename to a label/lang code.
function parseLangToken(token) {
    if (!token) return { lang: 'und', label: 'Original' };
    const t = token.toLowerCase();
    const map = {
        en: 'English', eng: 'English',
        fr: 'French', fre: 'French', fra: 'French',
        'fr-ca': 'French (CA)',
        es: 'Spanish', spa: 'Spanish',
        de: 'German', ja: 'Japanese', ko: 'Korean'
    };
    if (map[t]) return { lang: t, label: map[t] };
    return { lang: 'und', label: 'Original' };
}

// Find sidecar subtitles ("<base>.srt", "<base>.en.srt", …) next to a video.
function findLocalSidecars(videoPath) {
    try {
        if (!videoPath || !fs.existsSync(videoPath)) return [];
        const dir = path.dirname(videoPath);
        const base = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
        const results = [];
        for (const name of fs.readdirSync(dir)) {
            const ext = path.extname(name).toLowerCase();
            if (!SUB_EXTS.includes(ext)) continue;
            const stem = path.basename(name, ext).toLowerCase();
            if (stem === base || stem.startsWith(base + '.')) {
                const token = stem === base ? '' : stem.slice(base.length + 1);
                const { lang, label } = parseLangToken(token);
                results.push({
                    label,
                    lang,
                    path: path.join(dir, name),
                    isLocal: true,
                    isOpenSubtitles: false
                });
            }
        }
        return results;
    } catch (e) {
        console.error('[subtitles] sidecar scan failed:', e.message);
        return [];
    }
}

function registerSubtitlesIpc(ipcMain) {
    // Signature mirrors the preload binding:
    //   (videoPath, queryTitle, skipOpenSubtitles, langs)
    ipcMain.handle('find-subtitles', async (_event, videoPath, _queryTitle, _skipOpenSubtitles, _langs) => {
        // Always resolve to an array — never throw — so the player's track setup
        // can't be broken by a rejected invoke.
        return findLocalSidecars(videoPath);
    });

    console.log('[subtitles] IPC handler registered (find-subtitles).');
}

module.exports = { registerSubtitlesIpc };
