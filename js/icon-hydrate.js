// js/icon-hydrate.js — hydrate static markup icons from the window.icons set.
//
// Usage in HTML:  <span data-icon="close"></span>
//                 <span data-icon="pip" data-icon-style="width:18px;height:18px;"></span>
//
// On load (and on demand via window.hydrateIcons(root)), every [data-icon]
// element is filled with the matching SVG string from window.icons. This keeps
// index.html free of inline SVG while still using the single icon dictionary.
(function () {
  function hydrate(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-icon]').forEach(elm => {
      const name = elm.getAttribute('data-icon');
      const fn = window.icons && window.icons[name];
      if (typeof fn !== 'function') return;
      const style = elm.getAttribute('data-icon-style') || 'width:1em;height:1em;vertical-align:middle;';
      elm.innerHTML = fn('', style);
      // Mark done (idempotent) without losing the name for debugging.
      elm.setAttribute('data-icon-hydrated', name);
      elm.removeAttribute('data-icon');
    });
  }

  window.hydrateIcons = hydrate;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => hydrate());
  } else {
    hydrate();
  }
})();
