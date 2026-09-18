/* electron-api-shim.js — recreates window.electronAPI in a plain browser.
 *
 * Mirrors preload.js one-for-one. Every `ipcRenderer.invoke(ch, ...)` becomes a
 * POST to /api/invoke, and every `ipcRenderer.on(ch, cb)` becomes a subscription
 * on the shared SSE stream. A handful of entries that were native Electron calls
 * (clipboard, external links, window fullscreen) are re-implemented with their
 * web equivalents instead of round-tripping to the server, where they would act
 * on the wrong machine.
 *
 * Loaded BEFORE the renderer's deferred scripts so window.electronAPI exists by
 * the time they run. Keep in sync with preload.js.
 */
(function () {
  'use strict';

  const CLIENT_ID = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

  // ── Buffer revival ────────────────────────────────────────────────────────
  // The bridge encodes Node Buffers as {__vwBuf: <base64>}; MediaSource wants
  // bytes, so hand back a Uint8Array.
  function revive(value) {
    if (value === null || typeof value !== 'object') return value;
    if (typeof value.__vwBuf === 'string') {
      const bin = atob(value.__vwBuf);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    if (Array.isArray(value)) return value.map(revive);
    for (const key of Object.keys(value)) value[key] = revive(value[key]);
    return value;
  }

  // ── invoke ────────────────────────────────────────────────────────────────
  async function invoke(channel, ...args) {
    const res = await fetch('/api/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vw-client': CLIENT_ID },
      body: JSON.stringify({ channel, args }),
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error(`[web] ${channel} → HTTP ${res.status}`);
    const payload = revive(await res.json());
    // An IPC handler that threw in the desktop app rejected the renderer's
    // promise; preserve that so existing try/catch blocks still fire.
    if (!payload.ok) throw new Error(payload.error);
    return payload.result;
  }

  const inv = (channel) => (...args) => invoke(channel, ...args);

  // The renderer passes whatever the <video> element is playing. In the browser
  // that is this server's /api/transcode URL, but the ASR daemon runs
  // server-side and needs the real source — handing it the transcode URL would
  // start a second, nested ffmpeg. Unwrap it back to the original.
  function withRealSource(data) {
    const out = Object.assign({}, data);
    const p = String(out.videoPath || '');
    if (p.includes('/api/transcode')) {
      try {
        const inner = new URL(p, location.href).searchParams.get('src');
        if (inner) out.videoPath = inner;
      } catch (_) { /* leave as-is */ }
    }
    return out;
  }

  // ── Push channels ─────────────────────────────────────────────────────────
  const listeners = new Map();   // channel -> Set<callback>
  let source = null;

  function ensureStream() {
    if (source) return;
    source = new EventSource(`/api/events?client=${encodeURIComponent(CLIENT_ID)}`);
    source.onerror = () => console.warn('[web] event stream interrupted; reconnecting…');
  }

  function on(channel, cb) {
    ensureStream();
    if (!listeners.has(channel)) {
      listeners.set(channel, new Set());
      source.addEventListener(channel, (ev) => {
        let data = null;
        try { data = revive(JSON.parse(ev.data)); } catch (_) { }
        for (const fn of listeners.get(channel)) {
          try { fn(data); } catch (err) { console.error(`[web] ${channel} listener threw:`, err); }
        }
      });
    }
    listeners.get(channel).add(cb);
  }

  function off(channel) {
    const set = listeners.get(channel);
    if (set) set.clear();
  }

  // ── In-DOM Web Context Menu Implementation ─────────────────────────────────
  function showWebContextMenu(item) {
    return new Promise((resolve) => {
      // Remove any existing web context menu
      const existing = document.getElementById('vw-web-context-menu');
      if (existing) existing.remove();

      let resolved = false;
      const done = (val) => {
        if (!resolved) {
          resolved = true;
          if (menuEl.parentNode) menuEl.remove();
          document.removeEventListener('click', onDocClick, true);
          document.removeEventListener('contextmenu', onDocClick, true);
          document.removeEventListener('keydown', onKeyDown, true);
          resolve(val);
        }
      };

      const onDocClick = (e) => {
        if (!menuEl.contains(e.target)) {
          done('closed');
        }
      };
      const onKeyDown = (e) => {
        if (e.key === 'Escape') {
          done('closed');
        }
      };

      // Build menu structure
      let templ = [];
      const hasAudioEnh = item.enhancements && item.enhancements.audio;
      const hasVideoEnh = item.enhancements && item.enhancements.video;
      const hasSubs = item.enhancements && item.enhancements.subtitles && item.enhancements.subtitles.length > 0;
      const hasTrans = item.enhancements && item.enhancements.translation && item.enhancements.translation.length > 0;
      const hasAnyEnhancement = item.enhancedPath || hasAudioEnh || hasVideoEnh || hasSubs || hasTrans;

      if (item.type === 'videoPlayer') {
        const isLocal = !item.isStreaming;
        const subLabel = hasSubs ? `Generate Subtitles (${item.enhancements.subtitles.join(', ').toUpperCase()})` : 'Generate Subtitles';
        const transLabel = hasTrans ? `Translate this video (${item.enhancements.translation.join(', ').toUpperCase()})` : 'Translate this video';

        const aiSubmenu = [
          { label: 'Enhance Audio 🪄', checked: !!hasAudioEnh, action: 'normalize-audio' },
          { label: subLabel, checked: !!hasSubs, action: 'generate-subtitles-prompt' },
          { label: transLabel, checked: !!hasTrans, action: 'translate-video-prompt' },
          { label: 'Enhance Video 🪄', checked: !!hasVideoEnh, action: 'enhance-video-prompt' }
        ];

        if (hasAnyEnhancement) {
          const revertItems = [];
          if (hasAudioEnh) revertItems.push({ label: 'Audio Enhancement', action: 'revert-enhancement:audio' });
          if (hasVideoEnh) revertItems.push({ label: 'Video Enhancement', action: 'revert-enhancement:video' });
          if (hasSubs) revertItems.push({ label: 'Subtitles', action: 'revert-enhancement:subtitles' });
          if (hasTrans) revertItems.push({ label: 'Translations', action: 'revert-enhancement:translation' });
          if (revertItems.length > 0) revertItems.push({ type: 'separator' });
          revertItems.push({ label: 'Everything', action: 'revert-enhancements' });

          aiSubmenu.push({ type: 'separator' });
          aiSubmenu.push({ label: 'Revert Enhancements', submenu: revertItems });
        }

        templ = [
          { label: item.isPlaying ? 'Pause' : 'Play', action: 'play-pause' },
          { label: item.isMuted ? 'Unmute' : 'Mute', action: 'mute' },
          { type: 'separator' },
          {
            label: 'Playback Speed', submenu: [
              { label: '0.5x', checked: item.speed === 0.5, action: 'speed:0.5' },
              { label: '0.75x', checked: item.speed === 0.75, action: 'speed:0.75' },
              { label: 'Normal', checked: !item.speed || item.speed === 1, action: 'speed:1' },
              { label: '1.25x', checked: item.speed === 1.25, action: 'speed:1.25' },
              { label: '1.5x', checked: item.speed === 1.5, action: 'speed:1.5' },
              { label: '2x', checked: item.speed === 2, action: 'speed:2' }
            ]
          },
          { label: 'Picture-in-Picture', action: 'pip' },
          { label: 'Fullscreen', action: 'fullscreen' },
          { type: 'separator' },
          { label: 'AI Enhancements 🪄', submenu: aiSubmenu },
          { type: 'separator' },
          {
            label: isLocal ? 'Copy Path' : 'Copy Stream URL',
            action: 'copied',
            click: () => {
              if (navigator.clipboard) navigator.clipboard.writeText(item.path || '');
            }
          },
          { type: 'separator' },
          { label: 'Properties', action: 'properties' }
        ];
      } else {
        templ = [
          { label: 'Refresh', action: 'bg-refresh' },
          { label: 'Properties', action: 'properties' }
        ];
      }

      const menuEl = document.createElement('div');
      menuEl.id = 'vw-web-context-menu';
      menuEl.style.cssText = `
        position: fixed;
        z-index: 999999;
        min-width: 180px;
        background: rgba(22, 24, 34, 0.95);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: 0 12px 36px rgba(0,0,0,0.6), 0 0 1px rgba(255,255,255,0.2);
        border-radius: 8px;
        padding: 6px 0;
        font-family: var(--font-body, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
        font-size: 13px;
        color: #f0f0f5;
        user-select: none;
      `;

      function renderItems(items, container) {
        items.forEach(it => {
          if (it.type === 'separator') {
            const sep = document.createElement('div');
            sep.style.cssText = 'height: 1px; background: rgba(255,255,255,0.08); margin: 4px 8px;';
            container.appendChild(sep);
            return;
          }

          const row = document.createElement('div');
          row.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 6px 14px;
            cursor: pointer;
            position: relative;
            transition: background 0.15s ease;
          `;
          row.onmouseenter = () => {
            row.style.background = 'rgba(176, 124, 255, 0.2)';
            if (it.submenu) {
              const sub = row.querySelector('.vw-sub-menu');
              if (sub) sub.style.display = 'block';
            }
          };
          row.onmouseleave = () => {
            row.style.background = 'transparent';
            if (it.submenu) {
              const sub = row.querySelector('.vw-sub-menu');
              if (sub) sub.style.display = 'none';
            }
          };

          const left = document.createElement('div');
          left.style.cssText = 'display: flex; align-items: center; gap: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
          if (it.checked) {
            const check = document.createElement('span');
            check.textContent = '✓ ';
            check.style.color = '#B07CFF';
            check.style.fontWeight = 'bold';
            left.appendChild(check);
          }
          const labelSpan = document.createElement('span');
          labelSpan.textContent = it.label;
          left.appendChild(labelSpan);
          row.appendChild(left);

          if (it.submenu) {
            const arrow = document.createElement('span');
            arrow.textContent = '▸';
            arrow.style.opacity = '0.6';
            row.appendChild(arrow);

            const subMenuEl = document.createElement('div');
            subMenuEl.className = 'vw-sub-menu';
            subMenuEl.style.cssText = `
              display: none;
              position: absolute;
              left: 100%;
              top: -6px;
              min-width: 180px;
              background: rgba(22, 24, 34, 0.95);
              backdrop-filter: blur(16px);
              -webkit-backdrop-filter: blur(16px);
              border: 1px solid rgba(255, 255, 255, 0.12);
              box-shadow: 0 12px 36px rgba(0,0,0,0.6);
              border-radius: 8px;
              padding: 6px 0;
            `;
            renderItems(it.submenu, subMenuEl);
            row.appendChild(subMenuEl);
          } else {
            row.onclick = (e) => {
              e.stopPropagation();
              if (it.click) it.click();
              done(it.action || 'closed');
            };
          }

          container.appendChild(row);
        });
      }

      renderItems(templ, menuEl);
      document.body.appendChild(menuEl);

      const posX = Math.max(10, Math.min((item.clientX || 100), window.innerWidth - 220));
      const posY = Math.max(10, Math.min((item.clientY || 100), window.innerHeight - 300));
      menuEl.style.left = `${posX}px`;
      menuEl.style.top = `${posY}px`;

      setTimeout(() => {
        document.addEventListener('click', onDocClick, true);
        document.addEventListener('contextmenu', onDocClick, true);
        document.addEventListener('keydown', onKeyDown, true);
      }, 50);
    });
  }

  // ── The API surface (mirrors preload.js) ──────────────────────────────────
  window.electronAPI = {
    openDirectory: inv('dialog:openDirectory'),
    scanDirectory: inv('scan-directory'),
    getCachedDirectory: inv('get-cached-directory'),
    scanSpecificFiles: inv('scan-specific-files'),
    getEverythingSize: inv('get-everything-size'),
    getTrickplaySprites: inv('get-trickplay-sprites'),
    getFileSize: inv('get-file-size'),
    openFile: inv('open-file'),
    showInFolder: inv('show-in-folder'),
    showContextMenu: (item) => showWebContextMenu(item),
    generateWebm: inv('generate-webm'),
    upscaleVideo: inv('upscale-video'),
    renameFile: inv('rename-file'),
    deleteItem: inv('delete-item'),
    getFolderSizeBackground: inv('get-folder-size-background'),
    getSettings: inv('get-settings'),
    saveSettings: inv('save-settings'),
    scheduleIdlePreviews: inv('schedule-idle-previews'),
    generateIdlePreviewBatch: inv('generate-idle-preview-batch'),
    pasteFiles: inv('paste-files'),
    zipSelection: inv('zip-selection'),
    getFileProperties: inv('get-file-properties'),
    getFolderSizeSmart: inv('get-folder-size-smart'),
    encryptFiles: inv('encrypt-files'),
    decryptFiles: inv('decrypt-files'),
    findSubtitles: (videoPath, queryTitle, skipOpenSubtitles, langs) =>
      invoke('find-subtitles', videoPath, queryTitle, skipOpenSubtitles, langs),
    downloadSubtitleTrack: inv('download-subtitle-track'),
    onWebmProgress: (cb) => on('generate-webm-progress', cb),
    offWebmProgress: () => off('generate-webm-progress'),
    normalizeAudio: (videoPath, vaultRoot, transcribe, translateTo, options = {}) =>
      invoke('normalize-audio', { videoPath, vaultRoot, transcribe, translateTo, volumeBoost: options.volumeBoost }),
    enhanceAudio: inv('enhance-audio'),
    generateSubtitles: inv('generate-subtitles'),
    translateVideo: inv('translate-video'),
    enhanceVideo: inv('enhance-video'),
    getEnhancementState: inv('get-enhancement-state'),
    onNormalizeProgress: (cb) => on('normalize-progress', cb),
    offNormalizeProgress: () => off('normalize-progress'),
    onUpscaleProgress: (cb) => on('upscale-progress', cb),
    offUpscaleProgress: () => off('upscale-progress'),

    startUpscaleStream: inv('upscale-stream-start'),
    stopUpscaleStream: inv('upscale-stream-stop'),
    onUpscaleChunk: (cb) => on('upscale-chunk', cb),
    offUpscaleChunk: () => off('upscale-chunk'),
    onUpscaleStatus: (cb) => on('upscale-status', cb),
    offUpscaleStatus: () => off('upscale-status'),

    transcodeStreamStart: inv('transcode-stream-start'),
    transcodeStreamStop: inv('transcode-stream-stop'),
    onTranscodeChunk: (cb) => on('transcode-chunk', cb),
    offTranscodeChunk: () => off('transcode-chunk'),
    onTranscodeStatus: (cb) => on('transcode-status', cb),
    offTranscodeStatus: () => off('transcode-status'),

    runASRBenchmark: (forceSimulation) => invoke('run-asr-benchmark', { forceSimulation }),
    revertEnhancements: inv('revert-enhancements'),
    revertEnhancementTarget: inv('revert-enhancement-target'),

    // TMDB / KinoCheck
    searchTMDB: (query, page = 1, language = 'en-US') => invoke('search-tmdb', { query, page, language }),
    discoverTMDB: (providerId, mediaType, page = 1, language = 'en-US', withGenres, decade, region, sort, watchRegion) =>
      invoke('discover-tmdb', { providerId, mediaType, page, language, withGenres, decade, region, sort, watchRegion }),
    getWatchRegions: inv('get-watch-regions'),
    getTMDBMovie: inv('get-tmdb-movie'),
    getTMDBTV: inv('get-tmdb-tv'),
    getTMDBTVSeason: inv('get-tmdb-tv-season'),
    getKinoCheckTrailer: inv('get-kinocheck-trailer'),

    searchOMDb: (query, page = 1) => invoke('search-omdb', { query, page }),
    getOMDbDetails: inv('get-omdb-details'),
    searchTorrents: inv('search-torrents'),
    streamRDTorrent: inv('rd-stream-torrent'),
    getTorrentStatus: inv('rd-torrent-status'),
    debridURL: inv('rd-unrestrict-url'),
    downloadDebridFile: inv('rd-download-file'),
    testDebridProxy: inv('rd-test-proxy'),
    onDownloadProgress: (cb) => on('rd-download-progress', cb),
    offDownloadProgress: () => off('rd-download-progress'),

    // Usenet
    searchUsenet: inv('search-usenet'),
    verifyUsenetHealth: inv('verify-usenet-health'),
    streamUsenetNzb: inv('stream-usenet-nzb'),
    getUsenetStatus: inv('get-usenet-status'),
    finalizeUsenetStream: inv('finalize-usenet-stream'),
    moveUsenetToDrive: inv('move-usenet-to-drive'),
    getStreamingMode: inv('get-streaming-mode'),

    // Live AI subtitles
    warmLiveSubtitles: inv('warm-live-subtitles'),
    startLiveSubtitles: (data) => invoke('start-live-subtitles', withRealSource(data)),
    stopLiveSubtitles: inv('stop-live-subtitles'),
    onLiveSubtitleCue: (cb) => on('live-subtitle-cue', cb),
    offLiveSubtitleCue: () => off('live-subtitle-cue'),
    onLiveSubtitleStatus: (cb) => on('live-subtitle-status', cb),
    offLiveSubtitleStatus: () => off('live-subtitle-status'),

    // Watch history
    setWatchProgress: inv('watch-history:set-progress'),
    getWatchProgress: inv('watch-history:get-progress'),
    getContinueWatching: inv('watch-history:continue-watching'),
    getWatchHistory: inv('watch-history:get-all'),
    markWatched: inv('watch-history:mark-watched'),
    removeWatchHistory: inv('watch-history:remove'),
    clearWatchHistory: inv('watch-history:clear'),

    enhanceImageThumbnails: inv('enhance-image-thumbnails'),
    enhanceImageRealESRGAN: inv('enhance-image-realesrgan'),
    enhanceImageMagick: (p, operation) => invoke('enhance-image-magick', { path: p, operation }),
    extractYouTubeURL: inv('extract-youtube-url'),
    onImageEnhanced: (cb) => on('image-enhanced', cb),
    offImageEnhanced: () => off('image-enhanced'),
    // No host window to hide behind in a browser tab — nothing ever fires this.
    onAppHidden: () => { },

    probeAudioTracks: inv('probe-audio-tracks'),

    getDebridStats: inv('debrid-stats-get'),
    getDebridStatsReport: inv('debrid-stats-report'),
    resetDebridStats: inv('debrid-stats-reset'),

    getCachedTrailer: inv('trailer-cache:get'),
    cacheTrailer: inv('trailer-cache:put'),

    clipVideo: inv('clipVideo'),
    cancelClip: inv('clip-cancel'),
    onClipProgress: (cb) => on('clip-progress', cb),
    offClipProgress: () => off('clip-progress'),

    exportBackup: inv('library-export-backup'),
    importBackup: inv('library-import-backup'),

    // ── Native calls with a web equivalent ──────────────────────────────────
    // These went straight to Electron in preload.js. Routing them to the server
    // would act on the host machine, so they stay in the browser.
    openExternalURL: (url) => { window.open(url, '_blank', 'noopener,noreferrer'); },
    copyToClipboard: async (text) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch (_) {
        // Clipboard API needs a secure context; plain-HTTP LAN access falls back.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } finally { ta.remove(); }
      }
    },
    setWindowFullScreen: async (on) => {
      try {
        if (on) await document.documentElement.requestFullscreen();
        else if (document.fullscreenElement) await document.exitFullscreen();
      } catch (err) {
        console.warn('[web] fullscreen request rejected:', err.message);
      }
      return !!document.fullscreenElement;
    },
  };

  window.__VW_WEB__ = { clientId: CLIENT_ID, invoke };
  console.log('[web] electronAPI shim ready — client', CLIENT_ID.slice(0, 8));
})();
