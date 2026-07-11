// js/settings/debrid-downloader.js - Real-Debrid URL downloader + secure proxy modal
// Lifted out of initSettingsListeners; invoked by js/settings/core.js.
function initDebridDownloader() {
  // ── Debrid URL Downloader & Secure Proxy Modal Event Listeners ─────────
  const btnDebridOpen = el('settings-btn-debrid-downloader');
  if (btnDebridOpen) {
    btnDebridOpen.addEventListener('click', (e) => {
        e.stopPropagation();
        el('settings-panel').style.display = 'none';
        
        const dialog = el('debrid-download-dialog');
        dialog.style.display = 'flex';
        
        // Load active proxy states from window.appSettings
        const isProxyEnabled = window.appSettings.debridProxyEnable === true;
        const proxyAddress = window.appSettings.debridProxyAddress || '';
        
        el('debrid-proxy-enable').checked = isProxyEnabled;
        el('debrid-proxy-address-input').value = proxyAddress;
        
        updateProxyWidgetStatus();
    });
  }

  const proxyEnableCheckbox = el('debrid-proxy-enable');
  const proxyAddressInput = el('debrid-proxy-address-input');
  
  function updateProxyWidgetStatus() {
      const isChecked = proxyEnableCheckbox.checked;
      const addrValue = proxyAddressInput.value.trim();
      const statusLabel = el('debrid-proxy-status');
      if (statusLabel) {
          if (isChecked) {
              if (addrValue) {
                  statusLabel.innerText = 'Active';
                  statusLabel.style.color = 'var(--vault-gold)';
                  statusLabel.style.background = 'rgba(255,215,0,0.1)';
              } else {
                  statusLabel.innerText = 'Missing Addr';
                  statusLabel.style.color = '#ff5555';
                  statusLabel.style.background = 'rgba(255,85,85,0.1)';
              }
          } else {
              statusLabel.innerText = 'Disabled';
              statusLabel.style.color = 'var(--vault-slate)';
              statusLabel.style.background = 'rgba(255,255,255,0.05)';
          }
      }
  }

  if (proxyEnableCheckbox) {
      proxyEnableCheckbox.addEventListener('change', () => {
          updateProxyWidgetStatus();
          // Auto-persist when modified directly in the downloader dialog
          window.appSettings.debridProxyEnable = proxyEnableCheckbox.checked;
          window.electronAPI.saveSettings(window.appSettings);
      });
  }

  if (proxyAddressInput) {
      proxyAddressInput.addEventListener('input', () => {
          updateProxyWidgetStatus();
          window.appSettings.debridProxyAddress = proxyAddressInput.value.trim();
          window.electronAPI.saveSettings(window.appSettings);
      });
  }

  const btnDebridTestProxy = el('btn-debrid-test-proxy');
  if (btnDebridTestProxy) {
      btnDebridTestProxy.addEventListener('click', async () => {
          const proxyAddr = proxyAddressInput.value.trim();
          if (!proxyAddr) {
              showToast(window.currentLang === 'fr' ? 'Veuillez saisir une adresse de proxy' : 'Please enter a proxy address', 'error');
              return;
          }

          btnDebridTestProxy.disabled = true;
          btnDebridTestProxy.style.opacity = '0.5';
          
          const statusLabel = el('debrid-proxy-status');
          if (statusLabel) {
              statusLabel.innerText = window.currentLang === 'fr' ? 'Essai...' : 'Testing...';
              statusLabel.style.color = 'var(--vault-gold)';
              statusLabel.style.background = 'rgba(255,215,0,0.1)';
          }

          try {
              console.log('[Debrid Downloader] Initiating proxy connectivity check for:', proxyAddr);
              const res = await window.electronAPI.testDebridProxy(proxyAddr);
              
              if (res && res.success) {
                  showToast((window.currentLang === 'fr' ? 'Connexion réussie ! Latence: ' : 'Proxy connection successful! Latency: ') + res.latency + 'ms', 'success');
                  if (statusLabel) {
                      statusLabel.innerText = 'Connected';
                      statusLabel.style.color = '#10b981';
                      statusLabel.style.background = 'rgba(16,185,129,0.1)';
                  }
              } else {
                  throw new Error(res ? res.error : 'Unknown response');
              }
          } catch (err) {
              console.error('[Debrid Downloader] Proxy connectivity check failed:', err);
              showToast((window.currentLang === 'fr' ? 'Échec de la connexion: ' : 'Connection failed: ') + err.message, 'error');
              if (statusLabel) {
                  statusLabel.innerText = 'Failed';
                  statusLabel.style.color = '#ef4444';
                  statusLabel.style.background = 'rgba(239,68,68,0.1)';
              }
          } finally {
              btnDebridTestProxy.disabled = false;
              btnDebridTestProxy.style.opacity = '1.0';
          }
      });
  }

  // Unrestrict trigger
  const btnDebridDlUnrestrict = el('btn-debrid-dl-unrestrict');
  let activeDownloadUrl = '';
  let activeFilename = '';

  if (btnDebridDlUnrestrict) {
    btnDebridDlUnrestrict.addEventListener('click', async () => {
        const linkInput = el('debrid-dl-input');
        const rawLink = linkInput ? linkInput.value.trim() : '';
        if (!rawLink) {
            showToast(window.currentLang === 'fr' ? 'Veuillez coller un lien valide' : 'Please paste a valid link', 'error');
            return;
        }

        // Show loading UI
        el('debrid-dl-output-placeholder').style.display = 'none';
        el('debrid-dl-output-content').style.display = 'none';
        el('debrid-dl-output-progress').style.display = 'none';
        el('debrid-dl-output-loading').style.display = 'block';

        const proxy = (proxyEnableCheckbox.checked && proxyAddressInput.value.trim()) || '';

        try {
            console.log('[Debrid Downloader] Sending link to unrestrict:', rawLink, 'Proxy:', proxy);
            const res = await window.electronAPI.debridURL({ link: rawLink, proxy });
            
            if (res && res.success) {
                activeDownloadUrl = res.download;
                activeFilename = res.filename;
                
                // Format file size
                const sizeInGB = res.filesize ? (res.filesize / 1e9).toFixed(2) + ' GB' : 'Unknown Size';
                
                el('debrid-dl-filename').innerText = res.filename;
                el('debrid-dl-filesize').innerText = `Size: ${sizeInGB}`;
                
                el('debrid-dl-output-loading').style.display = 'none';
                el('debrid-dl-output-content').style.display = 'block';
                
                showToast(window.currentLang === 'fr' ? 'Lien débridé avec succès' : 'Link successfully unrestricted', 'success');
            } else {
                let errMsg = 'Unknown API response error';
                if (res && res.error) {
                    if (res.error === 'infringing_file') {
                        errMsg = window.currentLang === 'fr' 
                            ? "Ce fichier a été supprimé suite à une plainte pour atteinte aux droits d'auteur (DMCA)."
                            : "This file has been removed due to a copyright infringement complaint (DMCA).";
                    } else if (res.error === 'bad_token') {
                        errMsg = window.currentLang === 'fr'
                            ? "Clé API Real-Debrid non configurée, invalide ou expirée."
                            : "Real-Debrid API key is unconfigured, invalid, or expired.";
                    } else if (res.error === 'link_not_allowed') {
                        errMsg = window.currentLang === 'fr'
                            ? "Ce lien ou hébergeur n'est pas autorisé par Real-Debrid."
                            : "This hoster link is not allowed by Real-Debrid.";
                    } else {
                        errMsg = res.error;
                    }
                }
                throw new Error(errMsg);
            }
        } catch (err) {
            console.error('[Debrid Downloader] Unrestricting failed:', err);
            el('debrid-dl-output-loading').style.display = 'none';
            el('debrid-dl-output-placeholder').style.display = 'block';
            showToast((window.currentLang === 'fr' ? 'Échec du débridage : ' : 'Unrestricting failed: ') + err.message, 'error');
        }
    });
  }

  // Copy link
  const btnDebridCopyLink = el('btn-debrid-copy-link');
  if (btnDebridCopyLink) {
      btnDebridCopyLink.addEventListener('click', () => {
          if (activeDownloadUrl) {
              window.electronAPI.copyToClipboard(activeDownloadUrl);
              showToast(window.currentLang === 'fr' ? 'Lien copié dans le presse-papiers' : 'Direct link copied to clipboard', 'success');
          }
      });
  }

  // Start download trigger
  const btnDebridStartDownload = el('btn-debrid-start-download');
  if (btnDebridStartDownload) {
    btnDebridStartDownload.addEventListener('click', async () => {
        if (!activeDownloadUrl || !activeFilename) return;

        // Reset progress displays
        el('debrid-dl-output-content').style.display = 'none';
        el('debrid-dl-output-progress').style.display = 'block';
        
        el('debrid-dl-progress-status').innerText = window.currentLang === 'fr' ? 'Connexion en cours...' : 'Connecting...';
        el('debrid-dl-progress-percent').innerText = '0%';
        el('debrid-dl-progress-bar').style.width = '0%';
        el('debrid-dl-progress-speed').innerText = '';
        el('debrid-dl-progress-bytes').innerText = '';

        const proxy = (proxyEnableCheckbox.checked && proxyAddressInput.value.trim()) || '';

        // Register download telemetry listener
        window.electronAPI.onDownloadProgress((data) => {
            if (data.status === 'Downloading') {
                el('debrid-dl-progress-status').innerText = window.currentLang === 'fr' ? 'Téléchargement...' : 'Downloading...';
                el('debrid-dl-progress-percent').innerText = `${data.progress}%`;
                el('debrid-dl-progress-bar').style.width = `${data.progress}%`;
                
                const speedMB = (data.speed / 1e6).toFixed(1);
                el('debrid-dl-progress-speed').innerText = `Speed: ${speedMB} MB/s`;
                
                const loadedMB = (data.bytesDownloaded / 1e6).toFixed(0);
                const totalMB = (data.totalBytes / 1e6).toFixed(0);
                el('debrid-dl-progress-bytes').innerText = `${loadedMB} MB / ${totalMB} MB`;
            } else if (data.status === 'Completed') {
                el('debrid-dl-progress-status').innerText = window.currentLang === 'fr' ? 'Terminé' : 'Completed';
                el('debrid-dl-progress-percent').innerText = '100%';
                el('debrid-dl-progress-bar').style.width = '100%';
                el('debrid-dl-progress-speed').innerText = 'Speed: 0 MB/s';
                
                showToast(window.currentLang === 'fr' ? 'Téléchargement terminé avec succès !' : 'File downloaded successfully to Downloads folder!', 'success');
                window.electronAPI.offDownloadProgress();
            } else if (data.status === 'Failed') {
                el('debrid-dl-progress-status').innerText = window.currentLang === 'fr' ? 'Échec' : 'Failed';
                el('debrid-dl-progress-bar').style.backgroundColor = '#ff5555';
                showToast((window.currentLang === 'fr' ? 'Erreur de téléchargement: ' : 'Download failed: ') + (data.error || 'Unknown Error'), 'error');
                window.electronAPI.offDownloadProgress();
            }
        });

        try {
            console.log('[Debrid Downloader] Starting download for:', activeFilename, 'Proxy:', proxy);
            const res = await window.electronAPI.downloadDebridFile({
                downloadUrl: activeDownloadUrl,
                filename: activeFilename,
                proxy
            });
            
            if (!res.success) {
                throw new Error(res.error);
            }
        } catch (err) {
            console.error('[Debrid Downloader] Download invocation failed:', err);
            el('debrid-dl-progress-status').innerText = 'Failed';
            showToast('Download failed: ' + err.message, 'error');
            window.electronAPI.offDownloadProgress();
        }
    });
  }
}
