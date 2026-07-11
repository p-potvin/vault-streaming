// js/settings/theme.js - theme application + theme swatch grid

function applyTheme(themeId) {
  if (window.applyVaultTheme) {
    window.applyVaultTheme(themeId);
  } else {
    document.documentElement.setAttribute('data-theme', themeId);
  }
  document.querySelectorAll('.theme-swatch').forEach(sw => {
    sw.classList.toggle('active', sw.dataset.theme === themeId);
  });
  
  // Switch body class dynamically to match the theme mode!
  const isConsole = themeId === 'vaultwares-revisited-console';
  if (isConsole) {
      document.body.classList.remove('vw-warm-shell');
      document.body.classList.add('vw-console-shell');
  } else {
      document.body.classList.remove('vw-console-shell');
      document.body.classList.add('vw-warm-shell');
  }
  
  // Update theme trigger button text dynamically
  const labelSpan = el('theme-btn-text');
  if (labelSpan) {
    const lang = window.currentLang || 'en';
    const modeKey = isConsole ? 'consoleMode' : 'warmMode';
    labelSpan.innerText = (window.translations && window.translations[lang] && window.translations[lang][modeKey]) || (isConsole ? 'Console' : 'Warm');
  }
}

function initThemeGrid() {
  const themeGridEl = el('theme-grid');
  if (!themeGridEl) return;
  themeGridEl.innerHTML = '';
  const vaultThemes = window.VAULT_THEMES || [];
  vaultThemes.forEach(theme => {
    const btn = document.createElement('button');
    btn.className = 'theme-swatch';
    btn.dataset.theme = theme.id;
    btn.title = theme.name;
    btn.innerHTML = `
      <span class="swatch-colors">
        <span class="swatch-bg" style="background:${theme.primary};"></span>
        <span class="swatch-accent-strip" style="background:${theme.accent};"></span>
      </span>
      <span class="swatch-name">${theme.name}</span>`;
    btn.addEventListener('click', () => {
      applyTheme(theme.id);
      if (window.appSettings) {
         window.appSettings.theme = theme.id;
         window.electronAPI.saveSettings(window.appSettings);
         if (window.electronAPI.setTheme) {
             window.electronAPI.setTheme(theme.id);
         }
      }
      if (el('theme-panel')) el('theme-panel').style.display = 'none';
      if (el('theme-trigger')) {
          el('theme-trigger').setAttribute('aria-expanded', 'false');
          el('theme-trigger').focus();
      }
    });
    themeGridEl.appendChild(btn);
  });
}

window.applyTheme = applyTheme;
window.initThemeGrid = initThemeGrid;
