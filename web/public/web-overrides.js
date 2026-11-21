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

  // Comet playback URLs point at MKV / HEVC / lossless-audio remuxes that no
  // browser can decode (measured: 3 of 181 cached sources played natively), so
  // they have to go through the server-side remux. Patching the prototype
  // accessor keeps that knowledge here — no renderer file learns it is running
  // in a browser. Other cross-origin media (YouTube trailers) plays fine and is
  // left alone.
  const COMET_PLAYBACK = /\/playback\//;
  const mediaSrc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');

  // Safari (iPhone, iPad, Mac) gets HLS (web/hls-route.js): it plays a piped MP4 with no length badly or not at all
  // (iPhone: "cannot play this format"; iPad: a few-second duration the player took for a provider error clip).
  // Other browsers keep the piped transcode, which they play fine.
  const ua = navigator.userAgent;
  const IS_APPLE_TOUCH = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const IS_SAFARI = /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|Android/.test(ua);
  const USE_HLS = (IS_APPLE_TOUCH || IS_SAFARI)
    && !!document.createElement('video').canPlayType('application/vnd.apple.mpegurl');
  window.__vwUsesHls = USE_HLS;

  function toPlayableUrl(value) {
    const url = String(value == null ? '' : value);
    if (!/^https?:\/\//i.test(url)) return url;
    let parsed;
    try { parsed = new URL(url, location.href); } catch (_) { return url; }
    if (parsed.origin === location.origin) return url;
    if (!COMET_PLAYBACK.test(parsed.pathname)) return url;
    return (USE_HLS ? '/api/hls/index.m3u8?src=' : '/api/transcode?src=') + encodeURIComponent(url);
  }

  Object.defineProperty(HTMLMediaElement.prototype, 'src', {
    configurable: true,
    enumerable: mediaSrc.enumerable,
    get() { return mediaSrc.get.call(this); },
    set(value) {
      const rewritten = toPlayableUrl(value);
      // Remembered so live subtitles can be aimed at the real source: the ASR
      // daemon runs server-side and must not re-enter the transcode route.
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

  // iPhone Safari plays a video without playsinline in its own fullscreen player, out of the app's player (its
  // controls, Up next, episodes); the app's fullscreen button still takes the video fullscreen.
  const vp = document.getElementById('video-player');
  if (vp) {
    vp.setAttribute('playsinline', '');
    vp.setAttribute('webkit-playsinline', '');
  }
  // Fullscreen on Apple devices: older iPad Safari names it webkitRequestFullscreen; the iPhone has no element
  // fullscreen at all, only the video's own (webkitEnterFullscreen), which the player's button then uses.
  if (!Element.prototype.requestFullscreen) {
    Element.prototype.requestFullscreen = function () {
      if (this.webkitRequestFullscreen) return Promise.resolve(this.webkitRequestFullscreen());
      const v = this.tagName === 'VIDEO' ? this : this.querySelector('video');
      if (v && v.webkitEnterFullscreen) { v.webkitEnterFullscreen(); return Promise.resolve(); }
      return Promise.reject(new Error('fullscreen is not available'));
    };
  }
})();
