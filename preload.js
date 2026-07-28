const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  scanDirectory: (dirPath) => ipcRenderer.invoke('scan-directory', dirPath),
  getCachedDirectory: (dirPath) => ipcRenderer.invoke('get-cached-directory', dirPath),
  scanSpecificFiles: (arr) => ipcRenderer.invoke('scan-specific-files', arr),
  getEverythingSize: (dirPath) => ipcRenderer.invoke('get-everything-size', dirPath),
  getTrickplaySprites: (folder) => ipcRenderer.invoke('get-trickplay-sprites', folder),
  getFileSize: (p) => ipcRenderer.invoke('get-file-size', p),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
  showContextMenu: (item) => ipcRenderer.invoke('show-context-menu', item),
  generateWebm: (p, vaultRoot) => ipcRenderer.invoke('generate-webm', p, vaultRoot),
  upscaleVideo: (p) => ipcRenderer.invoke('upscale-video', p),
  renameFile: (oldPath, newName) => ipcRenderer.invoke('rename-file', oldPath, newName),
  deleteItem: (p) => ipcRenderer.invoke('delete-item', p),
  getFolderSizeBackground: (dirPath) => ipcRenderer.invoke('get-folder-size-background', dirPath),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  setWindowFullScreen: (on) => ipcRenderer.invoke('set-window-fullscreen', !!on),
  scheduleIdlePreviews: (items) => ipcRenderer.invoke('schedule-idle-previews', items),
  generateIdlePreviewBatch: (items) => ipcRenderer.invoke('generate-idle-preview-batch', items),
  pasteFiles: (data) => ipcRenderer.invoke('paste-files', data),
  zipSelection: (data) => ipcRenderer.invoke('zip-selection', data),
  getFileProperties: (p) => ipcRenderer.invoke('get-file-properties', p),
  getFolderSizeSmart: (dirPath, fileCount) => ipcRenderer.invoke('get-folder-size-smart', dirPath, fileCount),
  encryptFiles: (data) => ipcRenderer.invoke('encrypt-files', data),
  decryptFiles: (data) => ipcRenderer.invoke('decrypt-files', data),
  findSubtitles: (videoPath, queryTitle, skipOpenSubtitles, langs) => ipcRenderer.invoke('find-subtitles', videoPath, queryTitle, skipOpenSubtitles, langs),
  downloadSubtitleTrack: (data) => ipcRenderer.invoke('download-subtitle-track', data),
  onWebmProgress: (cb) => ipcRenderer.on('generate-webm-progress', (_, data) => cb(data)),
  offWebmProgress: () => ipcRenderer.removeAllListeners('generate-webm-progress'),
  normalizeAudio: (videoPath, vaultRoot, transcribe, translateTo, options = {}) => ipcRenderer.invoke('normalize-audio', { videoPath, vaultRoot, transcribe, translateTo, volumeBoost: options.volumeBoost }),
  onNormalizeProgress: (cb) => ipcRenderer.on('normalize-progress', (_, data) => cb(data)),
  offNormalizeProgress: () => ipcRenderer.removeAllListeners('normalize-progress'),
  onUpscaleProgress: (cb) => ipcRenderer.on('upscale-progress', (_, data) => cb(data)),
  offUpscaleProgress: () => ipcRenderer.removeAllListeners('upscale-progress'),
  // Real-time RTX VSR upscale stream
  startUpscaleStream: (opts) => ipcRenderer.invoke('upscale-stream-start', opts),
  stopUpscaleStream: () => ipcRenderer.invoke('upscale-stream-stop'),
  onUpscaleChunk: (cb) => ipcRenderer.on('upscale-chunk', (_, data) => cb(data)),
  offUpscaleChunk: () => ipcRenderer.removeAllListeners('upscale-chunk'),
  onUpscaleStatus: (cb) => ipcRenderer.on('upscale-status', (_, data) => cb(data)),
  offUpscaleStatus: () => ipcRenderer.removeAllListeners('upscale-status'),
  // Real-time down-transcode (Max Stream Quality ceiling → h264_nvenc/libx264)
  transcodeStreamStart: (opts) => ipcRenderer.invoke('transcode-stream-start', opts),
  transcodeStreamStop: () => ipcRenderer.invoke('transcode-stream-stop'),
  onTranscodeChunk: (cb) => ipcRenderer.on('transcode-chunk', (_, data) => cb(data)),
  offTranscodeChunk: () => ipcRenderer.removeAllListeners('transcode-chunk'),
  onTranscodeStatus: (cb) => ipcRenderer.on('transcode-status', (_, data) => cb(data)),
  offTranscodeStatus: () => ipcRenderer.removeAllListeners('transcode-status'),
  runASRBenchmark: (forceSimulation) => ipcRenderer.invoke('run-asr-benchmark', { forceSimulation }),
  revertEnhancements: (p) => ipcRenderer.invoke('revert-enhancements', p),

  // TMDB / KinoCheck API
  searchTMDB: (query, page = 1, language = 'en-US') => ipcRenderer.invoke('search-tmdb', { query, page, language }),
  discoverTMDB: (providerId, mediaType, page = 1, language = 'en-US', withGenres, decade, region, sort) => ipcRenderer.invoke('discover-tmdb', { providerId, mediaType, page, language, withGenres, decade, region, sort }),
  getTMDBMovie: (data) => ipcRenderer.invoke('get-tmdb-movie', data),
  getTMDBTV: (data) => ipcRenderer.invoke('get-tmdb-tv', data),
  getTMDBTVSeason: (data) => ipcRenderer.invoke('get-tmdb-tv-season', data),
  getKinoCheckTrailer: (data) => ipcRenderer.invoke('get-kinocheck-trailer', data),

  searchOMDb: (query, page = 1) => ipcRenderer.invoke('search-omdb', { query, page }),
  getOMDbDetails: (data) => ipcRenderer.invoke('get-omdb-details', data),
  searchTorrents: (movieTitle) => ipcRenderer.invoke('search-torrents', movieTitle),
  streamRDTorrent: (data) => ipcRenderer.invoke('rd-stream-torrent', data),
  getTorrentStatus: (torrentId) => ipcRenderer.invoke('rd-torrent-status', torrentId),
  debridURL: (data) => ipcRenderer.invoke('rd-unrestrict-url', data),
  downloadDebridFile: (data) => ipcRenderer.invoke('rd-download-file', data),
  testDebridProxy: (proxy) => ipcRenderer.invoke('rd-test-proxy', proxy),
  onDownloadProgress: (cb) => ipcRenderer.on('rd-download-progress', (_, data) => cb(data)),
  offDownloadProgress: () => ipcRenderer.removeAllListeners('rd-download-progress'),

  // Usenet API
  searchUsenet: (data) => ipcRenderer.invoke('search-usenet', data),
  verifyUsenetHealth: (data) => ipcRenderer.invoke('verify-usenet-health', data),
  streamUsenetNzb: (data) => ipcRenderer.invoke('stream-usenet-nzb', data),
  getUsenetStatus: (nzoId) => ipcRenderer.invoke('get-usenet-status', nzoId),
  finalizeUsenetStream: (data) => ipcRenderer.invoke('finalize-usenet-stream', data),
  moveUsenetToDrive: (data) => ipcRenderer.invoke('move-usenet-to-drive', data),
  getStreamingMode: () => ipcRenderer.invoke('get-streaming-mode'),

  // Live AI subtitles (Parakeet daemon)
  warmLiveSubtitles: () => ipcRenderer.invoke('warm-live-subtitles'),
  startLiveSubtitles: (data) => ipcRenderer.invoke('start-live-subtitles', data),
  stopLiveSubtitles: () => ipcRenderer.invoke('stop-live-subtitles'),
  onLiveSubtitleCue: (cb) => ipcRenderer.on('live-subtitle-cue', (_, data) => cb(data)),
  offLiveSubtitleCue: () => ipcRenderer.removeAllListeners('live-subtitle-cue'),
  onLiveSubtitleStatus: (cb) => ipcRenderer.on('live-subtitle-status', (_, data) => cb(data)),
  offLiveSubtitleStatus: () => ipcRenderer.removeAllListeners('live-subtitle-status'),

  // Watch History API
  setWatchProgress: (data) => ipcRenderer.invoke('watch-history:set-progress', data),
  getWatchProgress: (data) => ipcRenderer.invoke('watch-history:get-progress', data),
  getContinueWatching: (opts) => ipcRenderer.invoke('watch-history:continue-watching', opts),
  getWatchHistory: (opts) => ipcRenderer.invoke('watch-history:get-all', opts),
  markWatched: (data) => ipcRenderer.invoke('watch-history:mark-watched', data),
  removeWatchHistory: (data) => ipcRenderer.invoke('watch-history:remove', data),
  clearWatchHistory: () => ipcRenderer.invoke('watch-history:clear'),
  enhanceImageThumbnails: (paths) => ipcRenderer.invoke('enhance-image-thumbnails', paths),
  enhanceImageRealESRGAN: (path) => ipcRenderer.invoke('enhance-image-realesrgan', path),
  enhanceImageMagick: (path, operation) => ipcRenderer.invoke('enhance-image-magick', { path, operation }),
  extractYouTubeURL: (videoId) => ipcRenderer.invoke('extract-youtube-url', videoId),
  onImageEnhanced: (cb) => ipcRenderer.on('image-enhanced', (_, data) => cb(data)),
  offImageEnhanced: () => ipcRenderer.removeAllListeners('image-enhanced'),
  onAppHidden: (cb) => ipcRenderer.on('app-hidden', (_, data) => cb(data)),

  // Audio-track probe (which audio streams a source carries, and their languages)
  probeAudioTracks: (data) => ipcRenderer.invoke('probe-audio-tracks', data),

  // Trailer cache (durable per-instance hosted copies of YouTube trailers)
  getCachedTrailer: (youtubeId) => ipcRenderer.invoke('trailer-cache:get', youtubeId),
  cacheTrailer: (data) => ipcRenderer.invoke('trailer-cache:put', data),

  // Video Clipping API
  clipVideo: (data) => ipcRenderer.invoke('clipVideo', data),
  cancelClip: () => ipcRenderer.invoke('clip-cancel'),
  onClipProgress: (cb) => ipcRenderer.on('clip-progress', (_, data) => cb(data)),
  offClipProgress: () => ipcRenderer.removeAllListeners('clip-progress'),

  // Library sync / backup
  exportBackup: () => ipcRenderer.invoke('library-export-backup'),
  importBackup: () => ipcRenderer.invoke('library-import-backup'),

  openExternalURL: (url) => shell.openExternal(url)
});
