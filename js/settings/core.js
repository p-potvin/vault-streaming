// js/settings/core.js - settings panel wiring (open/save/dismiss) + sub-module bootstrapping
function initSettingsListeners() {
  const inputGlob = document.getElementById('pill-tag-input-glob');
  if (inputGlob) {
    inputGlob.addEventListener('keydown', (e) => {
        const input = e.target;
        if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
            e.preventDefault();
            pillTagAdd(input.value);
            input.value = '';
        } else if (e.key === 'Backspace' && input.value === '') {
            const pills = document.querySelectorAll('#pill-tag-container-glob .pill-tag');
            if (pills.length > 0) pills[pills.length - 1].remove();
        }
    });
    inputGlob.addEventListener('blur', (e) => {
        if (e.target.value.trim()) { pillTagAdd(e.target.value); e.target.value = ''; }
    });
  }

  const trigger = el('settings-trigger');
  if (trigger) {
    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const panel = el('settings-panel');
        const isOpening = panel.style.display === 'none';
        panel.style.display = isOpening ? 'flex' : 'none';
        const backdrop = el('settings-backdrop');
        if (backdrop) backdrop.style.display = isOpening ? 'block' : 'none';
        if (isOpening) {
            pillTagLoad(window.appSettings.globExclusions || []);
            el('settings-default-folder').value = window.appSettings.defaultFolder || '';
            el('settings-default-theme').value = window.appSettings.defaultTheme || 'vaultwares-revisited-console';
            el('settings-default-lang').value = window.appSettings.defaultLang || 'en';
            el('settings-default-sub-lang').value = window.appSettings.defaultSubLang || 'original';
            el('settings-sub-font-size').value = window.appSettings.subFontSize || '20px';
            el('settings-remember-position').checked = window.appSettings.rememberPosition !== false;
            el('settings-mute-previews').checked = window.appSettings.mutePreviews === true;
            el('settings-minimize-to-tray').checked = window.appSettings.minimizeToTray === true;
            if (el('settings-dev-mode')) el('settings-dev-mode').checked = window.appSettings.devMode === true;
            if (el('settings-subs-include-es')) el('settings-subs-include-es').checked = window.appSettings.subsIncludeSpanish === true;
            if (el('settings-opensubtitles-key')) {
                el('settings-opensubtitles-key').value = window.appSettings.openSubtitlesKey || '';
            }
            if (el('settings-default-home-tab')) {
                el('settings-default-home-tab').value = window.appSettings.defaultHomeTab || 'files';
            }
            if (el('settings-default-folder-photoalbums')) {
                el('settings-default-folder-photoalbums').value = window.appSettings.defaultFolderAlbums || '';
            }
            if (el('settings-default-folder-music')) {
                el('settings-default-folder-music').value = window.appSettings.defaultFolderAudio || '';
            }
            if (el('settings-default-folder-misc')) {
                el('settings-default-folder-misc').value = window.appSettings.defaultFolderMisc || '';
            }
            el('settings-stream-quality').value = window.appSettings.streamQuality || '1080p';
            el('settings-stream-lang').value = window.appSettings.streamLang || 'en';
            if (el('settings-vsr-quality')) el('settings-vsr-quality').value = window.appSettings.vsrQuality || 'HIGH';
            if (el('settings-vsr-scale')) el('settings-vsr-scale').value = window.appSettings.vsrScale || '2';
            if (el('settings-vsr-bitrate')) el('settings-vsr-bitrate').value = window.appSettings.vsrBitrate || '12M';
            if (el('settings-vsr-chroma')) el('settings-vsr-chroma').value = window.appSettings.vsrChroma || 'yuv420p';
            el('debrid-proxy-enable').checked = window.appSettings.debridProxyEnable === true;
            el('debrid-proxy-address-input').value = window.appSettings.debridProxyAddress || '';
            if (el('settings-streaming-mode')) el('settings-streaming-mode').value = window.appSettings.streamingMode || 'torrent-only';
            document.getElementById('pill-tag-input-glob').focus();
        }
    });

    // Close on backdrop or outside click without saving
    const backdrop = el('settings-backdrop');
    if (backdrop) {
        backdrop.addEventListener('click', () => {
            el('settings-panel').style.display = 'none';
            backdrop.style.display = 'none';
        });
    }

    document.addEventListener('click', (e) => {
        const panel = el('settings-panel');
        if (panel && panel.style.display === 'flex') {
            if (!panel.contains(e.target) && !trigger.contains(e.target)) {
                panel.style.display = 'none';
                const backdrop = el('settings-backdrop');
                if (backdrop) backdrop.style.display = 'none';
            }
        }
    });
  }

  // Clickable folder inputs (icon + readonly input)
  const folderInputWrappers = document.querySelectorAll('.settings-folder-input');
  folderInputWrappers.forEach(wrapper => {
      const targetId = wrapper.dataset.target;
      if (!targetId) return;
      const target = el(targetId);
      if (!target) return;
      wrapper.addEventListener('click', async () => {
          const folderPath = await window.electronAPI.openDirectory();
          if (folderPath) {
              target.value = folderPath;
          }
      });
  });

  const themeTrigger = el('theme-trigger');
  if (themeTrigger) {
    themeTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const currentTheme = document.documentElement.getAttribute('data-theme') || 'vaultwares-revisited-console';
      const nextTheme = currentTheme === 'vaultwares-revisited-console' ? 'vaultwares-revisited-warm' : 'vaultwares-revisited-console';
      applyTheme(nextTheme);
      if (window.appSettings) {
         window.appSettings.theme = nextTheme;
         window.electronAPI.saveSettings(window.appSettings);
         if (window.electronAPI.setTheme) {
             window.electronAPI.setTheme(nextTheme);
         }
      }
    });
  }

  const btnSave = el('settings-btn-save');
  if (btnSave) {
    btnSave.addEventListener('click', async () => {
        const rawInput = document.getElementById('pill-tag-input-glob');
        if (rawInput && rawInput.value.trim()) { pillTagAdd(rawInput.value); rawInput.value = ''; }
        
        // Capture old structural values before updating window.appSettings
        const oldGlobExclusions = JSON.stringify(window.appSettings.globExclusions || []);
        const oldDefaultFolder = window.appSettings.defaultFolder || '';
        
        const newGlobExclusions = pillTagGetValues();
        const newDefaultFolder = el('settings-default-folder').value.trim();
        
        const hasStructuralChange = 
            JSON.stringify(newGlobExclusions) !== oldGlobExclusions ||
            newDefaultFolder !== oldDefaultFolder;
            
        window.appSettings.globExclusions = newGlobExclusions;
        window.appSettings.defaultFolder = newDefaultFolder;
        window.appSettings.defaultTheme = el('settings-default-theme').value;
        window.appSettings.defaultLang = el('settings-default-lang').value;
        window.appSettings.defaultSubLang = el('settings-default-sub-lang').value;
        
        const subSize = el('settings-sub-font-size').value;
        window.appSettings.subFontSize = subSize;
        document.documentElement.style.setProperty('--sub-font-size', subSize);
        
        window.appSettings.rememberPosition = el('settings-remember-position').checked;
        window.appSettings.mutePreviews = el('settings-mute-previews').checked;
        window.appSettings.minimizeToTray = el('settings-minimize-to-tray').checked;
        if (el('settings-dev-mode')) window.appSettings.devMode = el('settings-dev-mode').checked;
        if (el('settings-subs-include-es')) window.appSettings.subsIncludeSpanish = el('settings-subs-include-es').checked;
        if (el('settings-opensubtitles-key')) {
            window.appSettings.openSubtitlesKey = el('settings-opensubtitles-key').value.trim();
        }
        if (el('settings-default-home-tab')) {
            window.appSettings.defaultHomeTab = el('settings-default-home-tab').value;
        }
        if (el('settings-default-folder-photoalbums')) {
            window.appSettings.defaultFolderAlbums = el('settings-default-folder-photoalbums').value.trim() || undefined;
        }
        if (el('settings-default-folder-music')) {
            window.appSettings.defaultFolderAudio = el('settings-default-folder-music').value.trim() || undefined;
        }
        if (el('settings-default-folder-misc')) {
            window.appSettings.defaultFolderMisc = el('settings-default-folder-misc').value.trim() || undefined;
        }
        window.appSettings.streamQuality = el('settings-stream-quality').value;
        window.appSettings.streamLang = el('settings-stream-lang').value;
        if (el('settings-streaming-mode')) {
            window.appSettings.streamingMode = el('settings-streaming-mode').value;
        }
        if (el('settings-vsr-quality')) window.appSettings.vsrQuality = el('settings-vsr-quality').value;
        if (el('settings-vsr-scale')) window.appSettings.vsrScale = el('settings-vsr-scale').value;
        if (el('settings-vsr-bitrate')) window.appSettings.vsrBitrate = el('settings-vsr-bitrate').value;
        if (el('settings-vsr-chroma')) window.appSettings.vsrChroma = el('settings-vsr-chroma').value;
        window.appSettings.debridProxyEnable = el('debrid-proxy-enable').checked;
        window.appSettings.debridProxyAddress = el('debrid-proxy-address-input').value.trim();
        await window.electronAPI.saveSettings(window.appSettings);
        showToast(window.currentLang === 'fr' ? 'Paramètres enregistrés' : 'Settings saved', 'success');
        el('settings-panel').style.display = 'none';
        const backdrop = el('settings-backdrop');
        if (backdrop) backdrop.style.display = 'none';
        
        if (hasStructuralChange) {
            console.log('[settings] Structural change detected (exclusions/folder). Reloading directory...');
            if (window.appSettings.defaultFolder) {
                window.loadDirectory('root/' + window.appSettings.defaultFolder.split(/[\\/]/).pop(), window.appSettings.defaultFolder, false);
            } else if (window.currentRealPath) {
                window.loadDirectory(window.currentNavPath, window.currentRealPath, false);
            }
        } else {
            console.log('[settings] Non-structural change saved. Skipping directory reload.');
        }
    });
  }

  // Dismiss settings panels
  document.addEventListener('click', (e) => {
      if ((!el('theme-panel') || !e.target.closest('#theme-panel')) && (!el('theme-trigger') || !e.target.closest('#theme-trigger'))) {
        const panel = el('theme-panel');
        if (panel && panel.style.display === 'block') {
          panel.style.display = 'none';
          if (el('theme-trigger')) el('theme-trigger').setAttribute('aria-expanded', 'false');
        }
      }
  });

  // Sub-panels were split into their own modules for maintainability.
  initBenchmarkDashboard();
  initDebridDownloader();
}

window.initSettingsListeners = initSettingsListeners;
