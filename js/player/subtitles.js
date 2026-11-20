// subtitles.js — the player's subtitles: what is offered, which one shows, and the CC menu.
//
// One list of choices (window._subCatalog), each with a stable id; the menu highlights the chosen id and the shown
// track is the <track> element's own TextTrack. (The previous menu marked the option whose list position equalled the
// <video>'s track index — always 0 with one track loaded — so the first entry stayed highlighted whatever was picked.)
//
// Sources, for a stream:
//   • OpenSubtitles, matched by the title's IMDb id (a series: + season + episode), never by name alone — a name
//     search for "The Odyssey" picked the 1987 film. The default is the best result in the preferred language.
//   • The AI transcript vault-raggae makes of every played stream (Moments, src/ipc/moments.ipc.js). Nothing here
//     starts a speech job: the entry says "preparing" until the transcript exists, then loads. It is the default only
//     when OpenSubtitles has nothing in the preferred language.
//   • A file the user uploads.
// For a library file: its sidecar .srt/.vtt files, its transcript if Moments made one, OpenSubtitles by name on demand.

// How high subtitles sit, as lines from the bottom of the frame. Negative values count up from the bottom, so this
// clears the player's control bar.
window.SUBTITLE_CUE_LINE = -4;

// Convert SubRip (.srt) to WebVTT format for browser <track> elements
function srtToVtt(srtText) {
    if (!srtText) return 'WEBVTT\n\n';
    let vtt = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    vtt = vtt.replace(/^﻿/, '');
    vtt = vtt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    vtt = vtt.replace(/(\d{2}:\d{2}),(\d{3})/g, '00:$1.$2');
    if (!vtt.trim().startsWith('WEBVTT')) {
        vtt = 'WEBVTT\n\n' + vtt;
    }
    return vtt;
}
window.srtToVtt = srtToVtt;

// File-loaded cues are parsed by the browser with line:auto, which puts them at the very bottom — underneath the
// controls. Re-anchor them once they exist.
function raiseTrackCues(track) {
    if (!track) return;
    const apply = () => {
        const cues = track.cues;
        if (!cues || !cues.length) return false;
        for (let i = 0; i < cues.length; i++) {
            try { cues[i].line = window.SUBTITLE_CUE_LINE; } catch (_) { /* ignore */ }
        }
        return true;
    };
    if (apply()) return;
    let tries = 0;
    const t = setInterval(() => {
        if (apply() || ++tries > 20) clearInterval(t);
    }, 150);
}

// ── Choosing the default ─────────────────────────────────────────────────────

/** The OpenSubtitles language to look for first: the Default Subtitle setting, "original" following the preferred
 *  stream language. Null when the user wants none by default. */
function preferredSubtitleLang(settings) {
    const s = settings || {};
    const pref = s.defaultSubLang || 'original';
    if (pref === 'und') return null;
    if (pref === 'original') return s.streamLang === 'fr' ? 'fr' : 'en';
    return String(pref).toLowerCase() === 'qc' ? 'fr' : String(pref).toLowerCase();
}

const CAM_RE = /\b(cam|camrip|hdcam|ts|hdts|telesync|tc|hdtc|telecine)\b/i;
const _releaseTokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * The best OpenSubtitles result for the release being played: timing follows the release, so a subtitle made for
 * the same release group / source (WEB-DL, BluRay…) beats a merely popular one. Machine translations come last,
 * hearing-impaired versions after plain ones. `results` arrive most-downloaded first.
 */
function pickBestSubtitle(results, release) {
    const list = Array.isArray(results) ? results : [];
    if (!list.length) return null;
    const rel = _releaseTokens(release);
    const relGroup = (String(release || '').match(/-([A-Za-z0-9]+)(?:\.[a-z0-9]{2,4})?\s*$/) || [])[1];
    const SOURCES = ['web', 'webdl', 'webrip', 'bluray', 'bdrip', 'brrip', 'remux', 'hdtv', 'dvdrip', 'amzn', 'nf', 'dsnp', 'hmax', 'atvp'];
    const score = (r, i) => {
        const toks = _releaseTokens(r.release);
        let s = Math.log10((r.downloads || 0) + 1) * 10 - i * 0.5;
        if (relGroup && toks.includes(relGroup.toLowerCase())) s += 40;
        if (SOURCES.some(t => rel.includes(t) && toks.includes(t))) s += 15;
        if (['2160p', '1080p', '720p'].some(t => rel.includes(t) && toks.includes(t))) s += 5;
        if (r.trusted) s += 5;
        if (r.hearingImpaired) s -= 8;
        if (r.machineTranslated) s -= 60;
        // a subtitle timed for a CAM / telesync copy, unless that is what plays
        if (CAM_RE.test(String(r.release || '').replace(/[._]/g, ' ')) && !CAM_RE.test(String(release || '').replace(/[._]/g, ' '))) s -= 45;
        return s;
    };
    return list.map((r, i) => ({ r, s: score(r, i) })).sort((a, b) => b.s - a.s)[0].r;
}

// Node (tests): the pure helpers without a browser.
// (Everything below only defines functions at load time, so a stub `window` is enough there.)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { preferredSubtitleLang, pickBestSubtitle, srtToVtt };
}

// ── State ────────────────────────────────────────────────────────────────────

const OFF_ID = 'off';
window._subCatalog = [];             // [{ id, kind: 'local'|'os'|'transcript'|'upload', label, lang, path|fileId|blobUrl }]
window._selectedSubtitleId = OFF_ID;
window._subContext = null;           // what is playing: { kind: 'stream'|'file', url|path, title, tmdbId, ... }
let _subGen = 0;                     // bumps on every new playback; late answers for an older one are dropped
let _activateToken = 0;              // bumps on every pick; a slow download can't override a later pick
let _transcript = { state: 'idle' }; // the AI transcript of the current playback
let _transcriptTimer = null;
let _transcriptCheckedAt = 0;
let _searchCache = {};               // lang -> { state, results, error } for the current playback
let _openSearchLang = null;
let _userPicked = false;             // the user chose something (or Off) during this playback
let _resultsEl = null;               // #subtitle-search-results (moved under the open language row)

const t_ = (key, en, fr) => {
    const v = window.translations && window.translations[window.currentLang === 'fr' ? 'fr' : 'en'];
    return (v && v[key]) || (window.currentLang === 'fr' && fr ? fr : en);
};
const _langName = (code) => {
    const c = String(code || '').toLowerCase();
    const fr = window.currentLang === 'fr';
    const names = { en: fr ? 'Anglais' : 'English', fr: fr ? 'Français' : 'French', es: fr ? 'Espagnol' : 'Spanish',
                    de: fr ? 'Allemand' : 'German', it: fr ? 'Italien' : 'Italian', pt: fr ? 'Portugais' : 'Portuguese' };
    return names[c.split('-')[0]] || (c ? c.toUpperCase() : (fr ? 'Inconnue' : 'Unknown'));
};
const _fmtCount = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n || 0));

// ── Showing a subtitle ───────────────────────────────────────────────────────

function _disableAllTracks(vp) {
    // Off first, then removed: a removed <track> is no longer in vp.textTracks, so disabling afterwards missed it and
    // its cues kept showing (subtitles from earlier picks stacked over the new ones).
    for (let i = 0; i < vp.textTracks.length; i++) vp.textTracks[i].mode = 'disabled';
    vp.querySelectorAll('track').forEach(t => { if (t.track) t.track.mode = 'disabled'; t.remove(); });
}

function _shiftCues(track, delta) {
    if (!track || !track.cues || !delta) return;
    for (let i = 0; i < track.cues.length; i++) {
        const c = track.cues[i];
        const ns = Math.max(0, c.startTime + delta);
        c.startTime = ns;
        c.endTime = Math.max(ns + 0.1, c.endTime + delta);
    }
}

function _updateSubtitleButton(entry) {
    const btn = el('btn-subtitles');
    if (!btn) return;
    btn.classList.toggle('active', !!entry);
    const code = entry ? (entry.kind === 'transcript' ? 'AI' : String(entry.lang || 'CC').slice(0, 2).toUpperCase()) : 'CC';
    const svgIcon = window.icons ? window.icons.subtitles('', 'width:14px; height:14px; display:block; flex-shrink:0;') : '';
    btn.innerHTML = `${svgIcon}<span>${window.escapeHtml ? window.escapeHtml(code) : code}</span>`;
}

function _rememberChoice(entry) {
    const m = window.activeStreamingMedia;
    if (!m) return;
    m.selectedSubtitleLabel = entry ? entry.label : '';
    m.selectedSubtitleLang = entry ? (entry.lang || '') : '';
    m.selectedSubtitleKind = entry ? entry.kind : 'off';
}

/**
 * Show one catalog entry (null / 'off' = subtitles off). An OpenSubtitles entry is downloaded first (once; the main
 * process keeps it as UTF-8 WebVTT). Resolves true when it is showing.
 */
async function activateSubtitle(entryOrId, { userPick = false } = {}) {
    const vp = el('video-player');
    if (!vp) return false;
    const entry = typeof entryOrId === 'string'
        ? window._subCatalog.find(e => e.id === entryOrId) || null
        : entryOrId;
    const token = ++_activateToken;
    if (userPick) _userPicked = true;

    if (!entry) {
        _disableAllTracks(vp);
        window._selectedSubtitleId = OFF_ID;
        _afterSelectionChange(null);
        return true;
    }

    let src = null;
    if (entry.kind === 'os') {
        if (!entry.localPath) {
            entry.loading = true;
            renderSubtitleMenu();
            window.showToast(t_('downloadingSubtitles', 'Downloading subtitles…', 'Téléchargement des sous-titres…'), 'info');
            let dl = null;
            try {
                dl = await window.electronAPI.downloadSubtitleTrack({ fileId: entry.fileId });
            } catch (e) {
                dl = { success: false, error: e.message };
            }
            entry.loading = false;
            if (!dl || !dl.success || !dl.path) {
                entry.failed = (dl && dl.error) || 'download failed';
                renderSubtitleMenu();
                window.showToast(`${t_('downloadFailed', 'Subtitle download failed', 'Échec du téléchargement des sous-titres')}: ${entry.failed}`, 'error');
                return false;
            }
            entry.localPath = dl.path;
        }
        src = window.sanitizePath(entry.localPath);
    } else if (entry.kind === 'upload') {
        src = entry.blobUrl;
    } else {
        src = window.sanitizePath(entry.path);
    }
    if (token !== _activateToken) return false;   // a later pick won

    _disableAllTracks(vp);
    const trackEl = document.createElement('track');
    trackEl.kind = 'subtitles';
    trackEl.label = entry.label;
    trackEl.srclang = (entry.lang && entry.lang !== 'und') ? entry.lang.split('-')[0] : '';
    trackEl.src = src;
    vp.appendChild(trackEl);
    const textTrack = trackEl.track;
    textTrack.mode = 'showing';
    trackEl.addEventListener('load', () => {
        _shiftCues(textTrack, window._subtitleOffset || 0);   // the saved sync delay applies to loaded files too
        raiseTrackCues(textTrack);
    }, { once: true });
    trackEl.addEventListener('error', () => {
        window.showToast(t_('subtitleLoadFailed', 'Could not read that subtitle file.', 'Impossible de lire ce fichier de sous-titres.'), 'error');
    }, { once: true });
    raiseTrackCues(textTrack);

    window._selectedSubtitleId = entry.id;
    _afterSelectionChange(entry);
    return true;
}

function _afterSelectionChange(entry, { remember = true } = {}) {
    const videoWrapper = document.querySelector('.video-wrapper');
    if (videoWrapper) videoWrapper.classList.toggle('subtitles-active', !!entry);
    const syncRow = el('subtitle-sync-row');
    if (syncRow) syncRow.style.display = entry ? '' : 'none';
    _updateSubtitleButton(entry);
    if (remember) _rememberChoice(entry);
    renderSubtitleMenu();
}

function _addToCatalog(entry) {
    const existing = window._subCatalog.find(e => e.id === entry.id);
    if (existing) return existing;
    window._subCatalog.push(entry);
    return entry;
}

const _osEntry = (r) => ({
    id: `os:${r.fileId}`, kind: 'os', fileId: r.fileId, lang: r.lang, release: r.release, label: r.label,
    downloads: r.downloads, hearingImpaired: r.hearingImpaired, machineTranslated: r.machineTranslated,
    feature: r.feature, cam: r.cam,
});

// ── Loading for a playback ───────────────────────────────────────────────────

/** Forget everything about the previous playback (player closed or a new one starting). */
function resetSubtitles() {
    _subGen++;
    _activateToken++;
    clearTimeout(_transcriptTimer);
    _transcriptTimer = null;
    _transcript = { state: 'idle' };
    _transcriptCheckedAt = 0;
    _searchCache = {};
    _openSearchLang = null;
    _userPicked = false;
    window._subCatalog = [];
    window._selectedSubtitleId = OFF_ID;
    window._subContext = null;
    const vp = el('video-player');
    if (vp) _disableAllTracks(vp);
    // not a choice: closing the player must not save "Off" as this title's subtitle (the watch progress saved on
    // close keeps the last real pick)
    _afterSelectionChange(null, { remember: false });
}

/** Subtitles for a stream that just started: OpenSubtitles (by IMDb id) for the default, the AI transcript when it
 *  is ready. `prog` is the saved watch progress (a subtitle chosen last time wins). */
async function loadStreamSubtitles(url, title, prog) {
    resetSubtitles();
    const gen = _subGen;
    const m = window.activeStreamingMedia || {};
    const year = parseInt(String(m.year || '').match(/\d{4}/)?.[0] || '', 10) || null;
    window._subContext = { kind: 'stream', url, title: m.title || title, tmdbId: m.tmdbId, mediaType: m.mediaType,
                           season: m.season, episode: m.episode, year, release: m.release || '' };

    const savedKind = prog && prog.selectedSubtitleKind;
    const savedLabel = prog && prog.selectedSubtitleLabel;
    const savedLang = prog && prog.selectedSubtitleLang;
    if (savedKind === 'off') _userPicked = true;   // they turned subtitles off last time: keep it so

    // the AI transcript chosen last time: show it again when it exists (checked first, never started here)
    if (savedKind === 'transcript') {
        await checkTranscript(gen);
        if (gen !== _subGen) return;
        if (_transcript.state === 'ready') {
            if (window._selectedSubtitleId !== 'ai') await activateSubtitle('ai');
            _userPicked = true;   // a restored choice: OpenSubtitles doesn't replace it
            return;
        }
    } else {
        // the transcript is checked in the background (never started here)
        checkTranscript(gen);
    }

    const want = savedLang && savedKind === 'os' ? savedLang : preferredSubtitleLang(window.appSettings);
    if (!want || _userPicked) { renderSubtitleMenu(); return; }

    const res = await searchSubtitlesFor(want, gen);
    if (gen !== _subGen || _userPicked) return;
    const results = (res && res.results) || [];
    const saved = savedLabel ? results.find(r => r.label === savedLabel) : null;
    const best = saved || pickBestSubtitle(results, window._subContext.release);
    if (best) {
        await activateSubtitle(_addToCatalog(_osEntry(best)));
    } else if (_transcript.state === 'ready') {
        await activateSubtitle('ai');
    } else {
        renderSubtitleMenu();
    }
}

/** Subtitles for a library file: its sidecar files (the preferred language shown), plus its transcript if any. */
async function loadActiveSubtitles(videoPath) {
    resetSubtitles();
    const gen = _subGen;
    const name = (window.currentPlayingItem && window.currentPlayingItem.name) || '';
    window._subContext = { kind: 'file', path: videoPath, title: name.replace(/\.[^.]+$/, '') };
    let subs = [];
    try {
        subs = await window.electronAPI.findSubtitles(videoPath, null, true) || [];
    } catch (err) {
        console.error('[subtitles] sidecar scan failed:', err);
    }
    if (gen !== _subGen) return;
    subs.forEach((s, i) => _addToCatalog({ id: `local:${s.path || i}`, kind: 'local', path: s.path, lang: s.lang,
        label: s.label === 'Original' ? t_('subOriginalFile', 'Subtitles (file)', 'Sous-titres (fichier)') : `${s.label}` }));
    checkTranscript(gen);

    const pref = (window.appSettings && window.appSettings.defaultSubLang) || 'original';
    let best = null;
    if (pref !== 'und') {
        const local = window._subCatalog.filter(e => e.kind === 'local');
        best = pref === 'original'
            ? (local.find(e => e.lang === 'und') || local[0])
            : local.find(e => String(e.lang || '').toLowerCase().startsWith(pref.toLowerCase()));
    }
    if (best) await activateSubtitle(best);
    else renderSubtitleMenu();
}

/** OpenSubtitles results in one language for what is playing (cached for this playback). */
async function searchSubtitlesFor(lang, gen = _subGen) {
    const ctx = window._subContext;
    if (!ctx) return null;
    if (_searchCache[lang] && _searchCache[lang].state !== 'error') return _searchCache[lang];
    _searchCache[lang] = { state: 'loading', results: [] };
    renderSubtitleMenu();
    let res = null;
    try {
        res = ctx.kind === 'stream'
            ? await window.electronAPI.searchSubtitles({ tmdbId: ctx.tmdbId, mediaType: ctx.mediaType, season: ctx.season,
                episode: ctx.episode, title: ctx.title, year: ctx.year, langs: [lang], limit: 15 })
            : { success: true, results: (await window.electronAPI.findSubtitles(ctx.path, ctx.title, false, lang) || [])
                .filter(s => s.isOpenSubtitles) };
    } catch (e) {
        res = { success: false, error: e.message };
    }
    if (gen !== _subGen) return null;
    _searchCache[lang] = res && res.success
        ? { state: 'done', results: res.results || [] }
        : { state: 'error', results: [], error: (res && res.error) || 'search failed' };
    renderSubtitleMenu();
    return _searchCache[lang];
}

// ── The AI transcript ────────────────────────────────────────────────────────

const TRANSCRIPT_POLL_MS = 2 * 60 * 1000;   // while it is being made; stops once ready / failed / player closed

async function checkTranscript(gen = _subGen) {
    const ctx = window._subContext;
    if (!ctx || !window.electronAPI.getSubtitleTranscript) return;
    clearTimeout(_transcriptTimer);
    _transcriptCheckedAt = Date.now();
    let res = null;
    try {
        res = await window.electronAPI.getSubtitleTranscript(ctx.kind === 'stream'
            ? { tmdbId: ctx.tmdbId, mediaType: ctx.mediaType, season: ctx.season, episode: ctx.episode, videoPath: ctx.url }
            : { videoPath: ctx.path });
    } catch (e) {
        res = { state: 'unavailable', error: e.message };
    }
    if (gen !== _subGen || !res) return;
    const wasReady = _transcript.state === 'ready';
    _transcript = res;
    if (res.state === 'ready') {
        const entry = _addToCatalog({ id: 'ai', kind: 'transcript', path: res.path, lang: res.lang,
            label: `${t_('aiTranscript', 'AI transcript', 'Transcription IA')} (${_langName(res.lang)})` });
        entry.path = res.path;
        if (!wasReady) {
            // OpenSubtitles first: the transcript shows by itself only when nothing else is showing and the user
            // hasn't chosen (Off included).
            const nothingShowing = window._selectedSubtitleId === OFF_ID;
            const searching = Object.values(_searchCache).some(s => s.state === 'loading');
            if (nothingShowing && !_userPicked && !searching && preferredSubtitleLang(window.appSettings)) {
                await activateSubtitle(entry);
                window.showToast(t_('aiTranscriptReady', 'AI transcript ready — showing it.', 'Transcription IA prête — affichée.'), 'success');
            } else if (ctx.kind === 'stream') {
                window.showToast(t_('aiTranscriptAvailable', 'AI transcript ready in the subtitles menu.', 'Transcription IA prête dans le menu des sous-titres.'), 'info');
            }
        }
    } else if (ctx.kind === 'stream' && !['failed', 'unavailable'].includes(res.state)) {
        // queued / reading / none yet (Moments takes the stream after two minutes of playback)
        _transcriptTimer = setTimeout(() => checkTranscript(gen), TRANSCRIPT_POLL_MS);
    }
    renderSubtitleMenu();
}

function _transcriptStatusText() {
    const s = _transcript.state;
    if (s === 'ready') return null;
    if (s === 'reading' || s === 'starting') {
        return _transcript.progress != null
            ? `${t_('aiTranscriptPreparing', 'Preparing…', 'En préparation…')} ${_transcript.progress}%`
            : t_('aiTranscriptPreparing', 'Preparing…', 'En préparation…');
    }
    if (s === 'queued') return t_('aiTranscriptQueued', 'Queued', 'En file d’attente');
    if (s === 'failed') return t_('aiTranscriptFailed', 'Failed', 'Échec');
    if (s === 'unavailable') return t_('aiTranscriptUnavailable', 'Unavailable', 'Indisponible');
    if (s === 'idle') return '…';
    // none: Moments starts after two minutes of playback (streams); a library file without one has none
    return window._subContext && window._subContext.kind === 'stream'
        ? t_('aiTranscriptSoon', 'Starts after 2 min of playback', 'Commence après 2 min de lecture')
        : t_('aiTranscriptNone', 'None for this file', 'Aucune pour ce fichier');
}

// ── The menu ─────────────────────────────────────────────────────────────────

function _row(cls, html, onClick, { active = false, disabled = false, title = '' } = {}) {
    const d = document.createElement('div');
    d.className = `${cls}${active ? ' active' : ''}${disabled ? ' disabled' : ''}`;
    d.innerHTML = html;
    if (title) d.title = title;
    if (active) d.setAttribute('aria-current', 'true');
    d.setAttribute('role', 'menuitemradio');
    d.setAttribute('aria-checked', active ? 'true' : 'false');
    if (!disabled && onClick) {
        d.tabIndex = 0;
        d.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
        d.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } });
    }
    return d;
}

const _esc = (s) => (window.escapeHtml ? window.escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s));

function _osMetaLine(r) {
    const bits = [`⬇ ${_fmtCount(r.downloads)}`];
    if (r.hearingImpaired) bits.push(t_('subHearingImpaired', 'SDH', 'SME'));
    if (r.machineTranslated) bits.push(t_('subMachineTranslated', 'machine-translated', 'traduction automatique'));
    if (r.cam) bits.push('CAM');
    if (r.feature) bits.push(r.feature);
    return bits.map(_esc).join(' · ');
}

/** Rebuild the CC menu from the state above. Cheap; called after every change. */
function renderSubtitleMenu() {
    const menu = el('subtitles-menu');
    if (!menu) return;
    const sel = window._selectedSubtitleId;

    // Off
    const offRow = el('subtitle-off-row');
    if (offRow) {
        offRow.replaceChildren(_row('subtitle-option', _esc(t_('subOff', 'Off', 'Désactivés')),
            () => { activateSubtitle(null, { userPick: true }); menu.style.display = 'none'; }, { active: sel === OFF_ID }));
    }

    // The AI transcript (always listed, with its state until it is ready)
    const aiRow = el('subtitle-ai-row');
    if (aiRow) {
        const ai = window._subCatalog.find(e => e.id === 'ai');
        const status = _transcriptStatusText();
        const label = ai ? ai.label : t_('aiTranscript', 'AI transcript', 'Transcription IA');
        aiRow.replaceChildren(_row('subtitle-option subtitle-ai-option',
            `<span class="subtitle-option-title">✦ ${_esc(label)}</span>${status ? `<span class="subtitle-option-meta">${_esc(status)}</span>` : ''}`,
            ai ? () => { activateSubtitle(ai, { userPick: true }); menu.style.display = 'none'; } : null,
            { active: sel === 'ai', disabled: !ai,
              title: t_('aiTranscriptHint', 'Made from the audio by vault-raggae for everything you play; loads once ready.',
                        'Faite à partir de l’audio par vault-raggae pour tout ce qui joue; se charge une fois prête.') }));
    }

    // Loaded / chosen subtitles (files beside the video, picked OpenSubtitles results, uploads)
    const list = el('subtitle-tracks-list');
    if (list) {
        list.replaceChildren(...window._subCatalog.filter(e => e.kind !== 'transcript').map(e => _row('subtitle-option',
            `<span class="subtitle-option-title">${_esc(e.kind === 'os' ? `${_langName(e.lang)} — ${e.release || e.label}` : e.label)}</span>` +
            (e.kind === 'os' ? `<span class="subtitle-option-meta">${_osMetaLine(e)}</span>` : '') +
            (e.loading ? `<span class="subtitle-option-meta">${_esc(t_('downloadingSubtitles', 'Downloading…', 'Téléchargement…'))}</span>` : ''),
            () => { activateSubtitle(e, { userPick: true }); menu.style.display = 'none'; },
            { active: sel === e.id, title: e.release || e.label })));
    }

    // OpenSubtitles search: a language opens its top results to choose from
    const quick = el('subtitle-search-langs');
    if (quick) {
        const langs = ['en', 'fr'].concat(window.appSettings && window.appSettings.subsIncludeSpanish ? ['es'] : []);
        quick.replaceChildren(...langs.map(lang => {
            const open = _openSearchLang === lang;
            const c = _searchCache[lang];
            const count = c && c.state === 'done' ? ` <span class="subtitle-quick-lang-code">${c.results.length}</span>` : '';
            const row = _row('subtitle-quick-lang', `<span>${_esc(_langName(lang))}</span><span>${count}<span class="subtitle-quick-lang-caret">${open ? '▾' : '▸'}</span></span>`,
                () => {
                    _openSearchLang = open ? null : lang;
                    if (!open) searchSubtitlesFor(lang);
                    renderSubtitleMenu();
                }, { active: open });
            row.dataset.lang = lang;
            return row;
        }));
    }
    // kept by reference: it is moved inside the language list, which the next render rebuilds
    const results = _resultsEl || (_resultsEl = el('subtitle-search-results'));
    if (results) {
        // the results sit right under the language they belong to
        const openRow = quick && _openSearchLang ? quick.querySelector(`.subtitle-quick-lang[data-lang="${_openSearchLang}"]`) : null;
        if (openRow) openRow.after(results);
        else if (quick) quick.after(results);
        const c = _openSearchLang ? _searchCache[_openSearchLang] : null;
        const rows = [];
        if (c && c.state === 'loading') {
            rows.push(_row('subtitle-result-status', _esc(t_('subSearching', 'Searching OpenSubtitles…', 'Recherche sur OpenSubtitles…')), null, { disabled: true }));
        } else if (c && c.state === 'error') {
            rows.push(_row('subtitle-result-status', _esc(c.error), () => { delete _searchCache[_openSearchLang]; searchSubtitlesFor(_openSearchLang); }, {}));
        } else if (c && c.state === 'done' && !c.results.length) {
            rows.push(_row('subtitle-result-status', _esc(t_('subNoResults', 'No subtitles in this language.', 'Aucun sous-titre dans cette langue.')), null, { disabled: true }));
        } else if (c && c.state === 'done') {
            c.results.slice(0, 10).forEach(r => {
                const id = `os:${r.fileId}`;
                rows.push(_row('subtitle-option subtitle-result',
                    `<span class="subtitle-option-title">${_esc(r.release || r.label)}</span><span class="subtitle-option-meta">${_osMetaLine(r)}</span>`,
                    () => { activateSubtitle(_addToCatalog(_osEntry(r)), { userPick: true }); menu.style.display = 'none'; },
                    { active: sel === id, title: r.release || r.label }));
            });
        }
        results.replaceChildren(...rows);
        results.style.display = rows.length ? '' : 'none';
    }
}

// ── Sync offset (±0.25 s) ────────────────────────────────────────────────────
// Shifts every cue on the showing track and remembers the offset (settings) for the next file.
window._subtitleOffset = (window.appSettings && Number(window.appSettings.subtitleOffset)) || 0;

function updateSubtitleOffsetLabel() {
    const lbl = el('subtitle-offset-value');
    if (lbl) {
        const o = window._subtitleOffset || 0;
        lbl.textContent = `${o >= 0 ? '+' : ''}${o.toFixed(2)}s`;
    }
}

function adjustSubtitleOffset(delta) {
    window._subtitleOffset = Math.round(((window._subtitleOffset || 0) + delta) * 100) / 100;
    const vp = el('video-player');
    if (vp && vp.textTracks) {
        for (const track of vp.textTracks) {
            if (track.mode === 'showing') _shiftCues(track, delta);
        }
    }
    if (window.appSettings) {
        window.appSettings.subtitleOffset = window._subtitleOffset;
        window.electronAPI.saveSettings(window.appSettings);
    }
    updateSubtitleOffsetLabel();
}

// ── Listeners ────────────────────────────────────────────────────────────────

function initSubtitleListeners() {
    el('btn-subtitles').addEventListener('click', (e) => {
        e.stopPropagation();
        const sm = el('speed-menu'); if (sm) sm.style.display = 'none';
        const menu = el('subtitles-menu');
        const opening = menu.style.display === 'none' || !menu.style.display;
        menu.style.display = opening ? 'block' : 'none';
        if (opening) {
            // a transcript still being made: look again when the menu opens (at most every 15 s)
            if (_transcript.state !== 'ready' && Date.now() - _transcriptCheckedAt > 15000) checkTranscript();
            renderSubtitleMenu();
        }
    });
    // clicks inside the menu never close it by themselves (rows close it after a pick)
    el('subtitles-menu').addEventListener('click', (e) => e.stopPropagation());

    el('opt-upload-subtitle').addEventListener('click', (e) => {
        e.stopPropagation();
        el('subtitles-menu').style.display = 'none';
        el('subtitle-file-input').click();
    });

    updateSubtitleOffsetLabel();
    const offMinus = el('subtitle-offset-minus');
    const offPlus = el('subtitle-offset-plus');
    if (offMinus) offMinus.addEventListener('click', (e) => { e.stopPropagation(); adjustSubtitleOffset(-0.25); });
    if (offPlus) offPlus.addEventListener('click', (e) => { e.stopPropagation(); adjustSubtitleOffset(0.25); });
    const syncRow = el('subtitle-sync-row');
    if (syncRow) syncRow.style.display = 'none';

    el('subtitle-file-input').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function () {
            let content = String(reader.result || '');
            if (!/^\s*WEBVTT/.test(content)) content = srtToVtt(content);
            const blobUrl = URL.createObjectURL(new Blob([content], { type: 'text/vtt' }));
            const entry = _addToCatalog({ id: `upload:${file.name}:${Date.now()}`, kind: 'upload', blobUrl, lang: 'und', label: file.name });
            activateSubtitle(entry, { userPick: true });
            window.showToast(t_('subtitlesLoaded', 'Subtitles loaded: ', 'Sous-titres chargés : ') + file.name, 'success');
            e.target.value = '';
        };
        reader.readAsText(file);
    });

    renderSubtitleMenu();
}

// Apply raiseTrackCues() to every track automatically, including tracks added later.
window.attachCueLifting = function attachCueLifting(video) {
    if (!video || !video.textTracks || video._cueLiftingAttached) return;
    video._cueLiftingAttached = true;
    const tracks = video.textTracks;
    const hook = (track) => {
        if (!track) return;
        raiseTrackCues(track);
        track.addEventListener('cuechange', () => raiseTrackCues(track));
    };
    for (let i = 0; i < tracks.length; i++) hook(tracks[i]);
    tracks.addEventListener('addtrack', (e) => hook(e.track));
};

// Bind to globals
window.raiseTrackCues = raiseTrackCues;
window.activateSubtitle = activateSubtitle;
window.renderSubtitleMenu = renderSubtitleMenu;
window.refreshSubtitlesList = renderSubtitleMenu;   // older callers
window.resetSubtitles = resetSubtitles;
window.loadStreamSubtitles = loadStreamSubtitles;
window.loadActiveSubtitles = loadActiveSubtitles;
window.initSubtitleListeners = initSubtitleListeners;
window.adjustSubtitleOffset = adjustSubtitleOffset;
window.preferredSubtitleLang = preferredSubtitleLang;
window.pickBestSubtitle = pickBestSubtitle;
