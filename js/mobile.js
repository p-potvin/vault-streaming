// js/mobile.js — Mobile and iOS layout enhancements, bottom navigation,
// mobile search clear button, and touch-and-hold (long-press 500ms) Quick Action Sheet.

(function () {
  'use strict';

  function isMobileViewport() {
    return (
      window.innerWidth <= 768 ||
      ('ontouchstart' in window) ||
      (navigator.maxTouchPoints > 0) ||
      /iPhone|iPad|iPod|Android|VaultStreaming-iOS/i.test(navigator.userAgent)
    );
  }

  function initMobileEnvironment() {
    const isMobile = isMobileViewport();
    if (isMobile) {
      document.body.classList.add('is-mobile');
    }
    if (/iPhone|iPad|iPod|VaultStreaming-iOS/i.test(navigator.userAgent)) {
      document.body.classList.add('is-ios-app');
    }

    // Wrap media type and providers in mobile-filter-strip if not already wrapped
    const mediaSwitch = document.getElementById('media-type-switch');
    const providers = document.getElementById('streaming-providers');
    const toolbar = document.getElementById('streaming-toolbar');

    if (toolbar && mediaSwitch && providers && !document.querySelector('.mobile-filter-strip')) {
      const filterStrip = document.createElement('div');
      filterStrip.className = 'mobile-filter-strip';
      
      // Move them inside the scrollable strip
      mediaSwitch.parentNode.insertBefore(filterStrip, mediaSwitch);
      filterStrip.appendChild(mediaSwitch);
      filterStrip.appendChild(providers);
    }

    // Add search magnifying glass and clear button
    const searchWrapper = document.querySelector('.tmdb-search-wrapper');
    const searchInput = document.getElementById('tmdb-search-input');
    if (searchWrapper && searchInput && !searchWrapper.querySelector('.mobile-search-icon')) {
      const searchIcon = document.createElement('span');
      searchIcon.className = 'mobile-search-icon';
      searchIcon.innerHTML = window.icons ? window.icons.search('', 'width:14px;height:14px;') : '🔍';
      searchWrapper.insertBefore(searchIcon, searchInput);

      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'mobile-search-clear';
      clearBtn.innerHTML = '✕';
      clearBtn.title = 'Clear search';
      clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        searchInput.value = '';
        clearBtn.style.display = 'none';
        searchInput.focus();
        if (typeof window.executeTMDBSearch === 'function') {
          window.executeTMDBSearch('');
        }
      });
      searchWrapper.appendChild(clearBtn);

      searchInput.addEventListener('input', () => {
        clearBtn.style.display = searchInput.value.trim() ? 'flex' : 'none';
      });
      if (searchInput.value.trim()) clearBtn.style.display = 'flex';
    }

    // Mount iOS Bottom Tab Navigation Bar
    mountBottomNav();
  }

  function mountBottomNav() {
    if (document.getElementById('mobile-bottom-nav')) return;

    const nav = document.createElement('nav');
    nav.id = 'mobile-bottom-nav';
    nav.setAttribute('aria-label', 'Mobile Navigation');

    const discSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>`;
    const libSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`;
    const histSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
    const setSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

    nav.innerHTML = `
      <div class="mobile-nav-item active" data-tab="discover">
        <span class="mobile-nav-icon">${discSvg}</span>
        <span>Discover</span>
      </div>
      <div class="mobile-nav-item" data-tab="library">
        <span class="mobile-nav-icon">${libSvg}</span>
        <span>Library</span>
      </div>
      <div class="mobile-nav-item" data-tab="history">
        <span class="mobile-nav-icon">${histSvg}</span>
        <span>History</span>
      </div>
      <div class="mobile-nav-item" data-tab="settings">
        <span class="mobile-nav-icon">${setSvg}</span>
        <span>Settings</span>
      </div>
    `;

    document.body.appendChild(nav);

    const items = nav.querySelectorAll('.mobile-nav-item');
    items.forEach(item => {
      item.addEventListener('click', () => {
        const tab = item.dataset.tab;
        if (tab === 'settings') {
          const trigger = document.getElementById('settings-trigger');
          if (trigger) trigger.click();
          return;
        }

        items.forEach(i => i.classList.remove('active'));
        item.classList.add('active');

        if (typeof window.switchStreamingSubtab === 'function') {
          window.switchStreamingSubtab(tab);
        }
      });
    });
  }

  // Native iOS Quick Action Sheet
  window.showQuickActionSheet = function (card, movie) {
    // Dismiss any existing action sheet
    const existing = document.getElementById('ios-quick-action-backdrop');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.id = 'ios-quick-action-backdrop';
    backdrop.className = 'ios-quick-action-sheet-backdrop';

    const title = movie.title || movie.name || 'Selected Title';
    const year = movie.year || (movie.release_date ? movie.release_date.slice(0, 4) : '');
    const genres = movie.genres || '';
    const poster = movie.poster || 'public/poster_placeholder.svg';

    window.appSettings = window.appSettings || {};
    window.appSettings.library = window.appSettings.library || [];
    const inLib = window.appSettings.library.some(m => m.id === movie.id && m.media_type === movie.media_type);

    backdrop.innerHTML = `
      <div class="ios-quick-action-sheet">
        <div class="ios-quick-action-group">
          <div class="ios-quick-action-header">
            <img src="${poster}" alt="${window.escapeHtml(title)}" onerror="this.src='public/poster_placeholder.svg'">
            <div style="min-width:0; flex:1;">
              <div class="ios-quick-action-title">${window.escapeHtml(title)}</div>
              <div class="ios-quick-action-meta">${year ? year + ' • ' : ''}${window.escapeHtml(genres)}</div>
            </div>
          </div>
          <button class="ios-quick-action-btn primary" id="action-play-now">
            <span>▶️</span>
            <span>Play Now (Instant Stream)</span>
          </button>
          <button class="ios-quick-action-btn" id="action-toggle-library">
            <span>${inLib ? '➖' : '➕'}</span>
            <span>${inLib ? 'Remove from Library' : 'Add to Library'}</span>
          </button>
          <button class="ios-quick-action-btn" id="action-view-details">
            <span>ℹ️</span>
            <span>View Details</span>
          </button>
          <button class="ios-quick-action-btn" id="action-mark-watched">
            <span>👁️</span>
            <span>Mark as Watched</span>
          </button>
        </div>
        <button class="ios-quick-action-cancel" id="action-cancel">Cancel</button>
      </div>
    `;

    document.body.appendChild(backdrop);

    const close = () => { backdrop.remove(); };
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });
    backdrop.querySelector('#action-cancel').addEventListener('click', close);

    backdrop.querySelector('#action-play-now').addEventListener('click', () => {
      close();
      if (typeof window.triggerRDStream === 'function') {
        window.triggerRDStream(title, movie.id, movie.media_type || 'movie', null, null, {
          poster: movie.poster,
          year: movie.year
        });
      }
    });

    backdrop.querySelector('#action-toggle-library').addEventListener('click', () => {
      close();
      if (typeof window.toggleLibrarySave === 'function') {
        const added = window.toggleLibrarySave(movie);
        window.showToast(added ? 'Added to Library' : 'Removed from Library', 'success');
        if (typeof window.renderLibrary === 'function' && window.currentStreamingSubtab === 'library') {
          window.renderLibrary();
        }
      }
    });

    backdrop.querySelector('#action-view-details').addEventListener('click', () => {
      close();
      if (typeof window.showMediaDetails === 'function') {
        window.showMediaDetails(movie);
      }
    });

    backdrop.querySelector('#action-mark-watched').addEventListener('click', async () => {
      close();
      try {
        if (window.electronAPI && window.electronAPI.markWatched) {
          await window.electronAPI.markWatched({
            id: movie.id,
            mediaType: movie.media_type || 'movie',
            title: title
          });
          window.showToast(`Marked "${title}" as watched`, 'success');
        }
      } catch (err) {
        console.warn('markWatched error:', err);
      }
    });
  };

  // Touch and hold listener (500ms) on movie cards
  window.attachCardTouchInteractions = function (card, movie) {
    let timer = null;
    let startX = 0;
    let startY = 0;
    let isLongPress = false;

    card.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      isLongPress = false;

      timer = setTimeout(() => {
        isLongPress = true;
        if (navigator.vibrate) navigator.vibrate(50);
        card.classList.add('card-touch-active');
        window.showQuickActionSheet(card, movie);
      }, 500);
    }, { passive: true });

    card.addEventListener('touchmove', (e) => {
      if (!timer) return;
      const dx = Math.abs(e.touches[0].clientX - startX);
      const dy = Math.abs(e.touches[0].clientY - startY);
      if (dx > 8 || dy > 8) {
        clearTimeout(timer);
        timer = null;
        card.classList.remove('card-touch-active');
      }
    }, { passive: true });

    const clearTimer = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      card.classList.remove('card-touch-active');
    };

    card.addEventListener('touchend', (e) => {
      clearTimer();
      if (isLongPress) {
        e.preventDefault();
        e.stopPropagation();
      }
    });

    card.addEventListener('touchcancel', clearTimer);

    // Support right-click on desktop as well
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      window.showQuickActionSheet(card, movie);
    });
  };

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMobileEnvironment);
  } else {
    initMobileEnvironment();
  }
})();
