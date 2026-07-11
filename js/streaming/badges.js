// js/streaming/badges.js — external-link badges (IMDb, Apple TV, JustWatch, TMDB, trailer)
// Part of the streaming feature, split out of the former monolithic js/streaming.js.

function _populateExternalBadges(title, tmdbId, mediaType, trailerKey = null) {
    const badgesContainer = el('external-links-badges');
    if (!badgesContainer) return;
    badgesContainer.innerHTML = '';

    const badgeStyle = 'background: rgba(255,255,255,0.06); border: 1px solid var(--vault-border); border-radius: 4px; padding: 5px 9px; color: var(--vault-text); font-family: var(--font-mono); font-size: 10px; font-weight: bold; cursor: pointer; display: flex; align-items: center; gap: 5px; transition: all 0.2s; outline: none; outline-offset: -1px;';

    // 1. YouTube Trailer (if trailerKey is present)
    if (trailerKey) {
        const btnYT = document.createElement('button');
        btnYT.style.cssText = badgeStyle;
        btnYT.innerHTML = `${window.icons ? window.icons.play('', 'width:12px; height:12px; display:inline-block; vertical-align:middle; color:var(--vault-accent);') : ''} Watch Trailer (YouTube)`;
        btnYT.onclick = () => {
            if (window.electronAPI && window.electronAPI.openExternalURL) {
                window.electronAPI.openExternalURL(`https://www.youtube.com/watch?v=${trailerKey}`);
            }
        };
        btnYT.onmouseenter = () => { btnYT.style.borderColor = 'var(--vault-accent)'; btnYT.style.background = 'rgba(245,185,41,0.1)'; };
        btnYT.onmouseleave = () => { btnYT.style.borderColor = 'var(--vault-border)'; btnYT.style.background = 'rgba(255,255,255,0.06)'; };
        badgesContainer.appendChild(btnYT);
    }

    // 2. IMDb Page (if imdb_id is available)
    if (window._currentModalImdbId) {
        const btnIMDb = document.createElement('button');
        btnIMDb.style.cssText = badgeStyle;
        btnIMDb.innerHTML = '<img src="public/imdb_favicon.png" style="width:12px; height:12px; vertical-align:middle;" onerror="this.style.display=\'none\'" /> IMDb Rating';
        btnIMDb.onclick = () => {
            if (window.electronAPI && window.electronAPI.openExternalURL) {
                window.electronAPI.openExternalURL(`https://www.imdb.com/title/${window._currentModalImdbId}/`);
            }
        };
        btnIMDb.onmouseenter = () => { btnIMDb.style.borderColor = 'var(--vault-gold)'; btnIMDb.style.background = 'rgba(245,185,41,0.1)'; };
        btnIMDb.onmouseleave = () => { btnIMDb.style.borderColor = 'var(--vault-border)'; btnIMDb.style.background = 'rgba(255,255,255,0.06)'; };
        badgesContainer.appendChild(btnIMDb);
    }

    // 3. Apple TV Search
    const btnApple = document.createElement('button');
    btnApple.style.cssText = badgeStyle;
    btnApple.innerHTML = '<img src="public/appletv_favicon.png" style="width:12px; height:12px; vertical-align:middle;" onerror="this.style.display=\'none\'" /> Apple TV';
    btnApple.onclick = () => {
        if (window.electronAPI && window.electronAPI.openExternalURL) {
            window.electronAPI.openExternalURL(`https://tv.apple.com/search?term=${encodeURIComponent(title)}`);
        }
    };
    btnApple.onmouseenter = () => { btnApple.style.borderColor = '#fff'; btnApple.style.background = 'rgba(255,255,255,0.15)'; };
    btnApple.onmouseleave = () => { btnApple.style.borderColor = 'var(--vault-border)'; btnApple.style.background = 'rgba(255,255,255,0.06)'; };
    badgesContainer.appendChild(btnApple);

    // 4. JustWatch Search
    const btnJW = document.createElement('button');
    btnJW.style.cssText = badgeStyle;
    btnJW.innerHTML = '<img src="public/justwatch_favicon.png" style="width:12px; height:12px; vertical-align:middle;" onerror="this.style.display=\'none\'" /> JustWatch';
    btnJW.onclick = () => {
        if (window.electronAPI && window.electronAPI.openExternalURL) {
            window.electronAPI.openExternalURL(`https://www.justwatch.com/us/search?q=${encodeURIComponent(title)}`);
        }
    };
    btnJW.onmouseenter = () => { btnJW.style.borderColor = '#00e5ff'; btnJW.style.background = 'rgba(0,229,255,0.1)'; };
    btnJW.onmouseleave = () => { btnJW.style.borderColor = 'var(--vault-border)'; btnJW.style.background = 'rgba(255,255,255,0.06)'; };
    badgesContainer.appendChild(btnJW);

    // 5. TMDB Page
    const btnTMDB = document.createElement('button');
    btnTMDB.style.cssText = badgeStyle;
    btnTMDB.innerHTML = `${window.icons ? window.icons.globe('', 'width:12px; height:12px; display:inline-block; vertical-align:middle;') : ''} TMDB`;
    btnTMDB.onclick = () => {
        if (window.electronAPI && window.electronAPI.openExternalURL) {
            window.electronAPI.openExternalURL(`https://www.themoviedb.org/${mediaType}/${tmdbId}`);
        }
    };
    btnTMDB.onmouseenter = () => { btnTMDB.style.borderColor = '#01b4e4'; btnTMDB.style.background = 'rgba(1,180,228,0.1)'; };
    btnTMDB.onmouseleave = () => { btnTMDB.style.borderColor = 'var(--vault-border)'; btnTMDB.style.background = 'rgba(255,255,255,0.06)'; };
    badgesContainer.appendChild(btnTMDB);
}
