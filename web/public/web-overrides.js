/* web-overrides.js — patches the renderer's few host-specific assumptions.
 *
 * Loaded AFTER every js/ script (deferred scripts run in document order), so it
 * can replace globals the renderer has already defined. Everything here exists
 * because the desktop build could touch the filesystem directly and a browser
 * tab cannot; nothing here changes app behaviour beyond that.
 */
(function () {
  'use strict';

  // sanitizePath() built file:/// URLs for local library playback, thumbnails,
  // trickplay sprites and subtitle tracks. A browser refuses file:// from an
  // http:// document, so point the same paths at the range-serving /api/media
  // route. Anything already a URL is left alone.
  const originalSanitizePath = window.sanitizePath;
  window.sanitizePath = function sanitizePath(p) {
    if (!p) return '';
    if (/^(https?|blob|data):/i.test(p)) return p;
    if (/^file:\/\//i.test(p)) {
      // Recover the OS path from a file:// URL a caller had already built.
      p = decodeURIComponent(p.replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, ''));
    }
    return '/api/media?path=' + encodeURIComponent(p.replace(/\//g, '\\'));
  };
  window.__vwOriginalSanitizePath = originalSanitizePath;

  // Release names that a browser can handle natively without server transcoding.
  window.isBrowserNative = function isBrowserNative(sourceUrl) {
    if (!sourceUrl) return false;
    let name = '';
    try {
      const u = new URL(sourceUrl, location.href);
      name = decodeURIComponent(u.searchParams.get('torrent_name') || u.pathname.split('/').pop() || '');
    } catch (_) {}
    name = name.toLowerCase();
    if (!name || !name.endsWith('.mp4')) return false;
    if (/hevc|x265|h\.?265|dovi|dolby.?vision|av1/.test(name)) return false;
    if (/truehd|atmos|dts|flac|pcm|eac3|ac3/.test(name)) return false;
    return true;
  };

  // Web client overrides startTranscodePlayback to stream directly via HTTP
  // /api/transcode instead of piping SSE MediaSource chunks over the event bridge.
  window.startTranscodePlayback = async function startTranscodePlayback(url, targetHeight, startTime, opts = {}) {
    const vp = document.getElementById('video-player');
    if (!vp) return false;
    window._transcodePlay = true;
    window._isSwitchingSource = true;
    const params = new URLSearchParams();
    params.set('src', url);
    if (targetHeight) params.set('h', targetHeight);
    if (opts && opts.audioIndex != null) params.set('audio', opts.audioIndex);
    if (startTime && startTime > 0) params.set('t', startTime);
    const transcodeUrl = '/api/transcode?' + params.toString();
    console.log('[web] starting transcode playback via', transcodeUrl);
    vp.src = transcodeUrl;
    vp.play().catch(e => console.warn('[web] auto-play prevented or pending user gesture:', e));
    setTimeout(() => { window._isSwitchingSource = false; }, 2500);
    return true;
  };

  window.stopTranscode = function stopTranscode() {
    window._transcodePlay = false;
  };

  // Remote streaming URLs point at MKV / HEVC / DTS / EAC3 remuxes that no
  // browser can decode natively. Route non-native playback streams through
  // /api/transcode. Secondary media elements (e.g. scrub preview) must not
  // spawn duplicate transcode sessions on the GPU.
  const mediaSrc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');

  function toPlayableUrl(value, elem) {
    const url = String(value == null ? '' : value);
    if (!/^https?:\/\//i.test(url)) return url;
    let parsed;
    try { parsed = new URL(url, location.href); } catch (_) { return url; }
    if (parsed.origin === location.origin) return url;
    if (/youtube\.com|googlevideo\.com|youtu\.be/i.test(parsed.hostname)) return url;
    // Non-main video elements (like scrub preview) must not spawn transcodes
    if (elem && elem.id && elem.id !== 'video-player') return '';
    if (window.isBrowserNative(url)) return url;
    return '/api/transcode?src=' + encodeURIComponent(url);
  }

  Object.defineProperty(HTMLMediaElement.prototype, 'src', {
    configurable: true,
    enumerable: mediaSrc.enumerable,
    get() { return mediaSrc.get.call(this); },
    set(value) {
      if (this.id !== 'video-player') {
        // Prevent background elements (e.g. hover scrub preview) from triggering live server transcodes
        if (value && typeof value === 'string' && value.includes('/api/transcode')) return;
        mediaSrc.set.call(this, value);
        return;
      }
      const rewritten = toPlayableUrl(value, this);
      if (rewritten !== String(value)) this._vwSourceUrl = String(value);
      else delete this._vwSourceUrl;
      mediaSrc.set.call(this, rewritten);
    },
  });

  // Native-only surfaces. They resolve to a structured refusal server-side (see
  // ipc-bridge.js), so the UI shows a message rather than hanging; this just
  // makes the reason visible when someone goes looking in the console.
  console.info(
    '[web] Host-bound features are inert in this client: native context menus, ' +
    'folder pickers, reveal-in-explorer, backup import/export.'
  );

  document.documentElement.classList.add('vw-web-client');
})();
