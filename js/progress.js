// Progress Zone Controller for the Status Bar
document.addEventListener('DOMContentLoaded', () => {
    const delim = document.getElementById('status-progress-delimiter');
    const zone = document.getElementById('status-progress-zone');
    const spinner = document.getElementById('status-progress-spinner');
    const text = document.getElementById('status-progress-text');
    const barContainer = document.getElementById('status-progress-bar-container');
    const barFill = document.getElementById('status-progress-bar-fill');

    let hideTimeout = null;

    function showZone() {
        if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
        if (delim) delim.style.display = 'inline';
        if (zone) zone.style.display = 'flex';
    }

    function scheduleHide(ms = 2000) {
        if (hideTimeout) clearTimeout(hideTimeout);
        hideTimeout = setTimeout(() => {
            if (delim) delim.style.display = 'none';
            if (zone) zone.style.display = 'none';
            if (spinner) spinner.style.display = 'none';
            if (barContainer) barContainer.style.display = 'none';
            if (text) text.innerText = '';
        }, ms);
    }

    if (window.electronAPI && typeof window.electronAPI.onWebmProgress === 'function') {
        window.electronAPI.onWebmProgress((data) => {
            if (!delim || !zone || !text) return;

            showZone();

            if (data.isBatchStart || data.isBatchProgress || data.isBatchComplete) {
                // Batch Preview Generation
                if (spinner) spinner.style.display = 'none';
                if (barContainer) barContainer.style.display = 'block';

                const total = data.total || 0;
                const completed = data.completed || 0;
                const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

                if (barFill) barFill.style.width = pct + '%';

                if (data.isBatchComplete || (completed >= total && total > 0)) {
                    text.innerText = window.currentLang === 'fr'
                        ? `Aperçus synchronisés !`
                        : `Previews fully synchronized!`;
                    scheduleHide(3000);
                } else {
                    text.innerText = window.currentLang === 'fr'
                        ? `Synchronisation : ${completed}/${total} (${pct}%)`
                        : `Syncing previews: ${completed}/${total} (${pct}%)`;
                }
            } else {
                // Single Video Preview Generation
                if (barContainer) barContainer.style.display = 'none';
                
                if (data.percent < 100) {
                    if (spinner) spinner.style.display = 'inline-block';
                    const filename = data.videoPath ? data.videoPath.split(/[\\/]/).pop() : '';
                    const baseLabel = data.label || 'Generating preview...';
                    text.innerText = filename ? `${baseLabel} (${filename})` : baseLabel;
                } else {
                    if (spinner) spinner.style.display = 'none';
                    if (data.error) {
                        const filename = data.videoPath ? data.videoPath.split(/[\\/]/).pop() : '';
                        const failLabel = window.currentLang === 'fr'
                            ? `Échec de l'aperçu`
                            : `Preview failed`;
                        text.innerText = filename ? `${failLabel}: ${filename}` : `${failLabel}: ${data.error}`;
                        scheduleHide(4000);
                    } else {
                        text.innerText = window.currentLang === 'fr'
                            ? `Aperçu généré !`
                            : `Preview generated!`;
                        scheduleHide(2000);
                    }
                }
            }
        });
    }

    if (window.electronAPI && typeof window.electronAPI.onNormalizeProgress === 'function') {
        window.electronAPI.onNormalizeProgress((data) => {
            if (!delim || !zone || !text) return;
            showZone();
            if (barContainer) barContainer.style.display = 'none'; // Normalize uses spinner + text updates
            
            if (data.percent < 100) {
                if (spinner) spinner.style.display = 'inline-block';
                const baseLabel = data.label || 'Normalizing audio...';
                text.innerText = `${baseLabel} (${data.percent}%)`;
            } else {
                if (spinner) spinner.style.display = 'none';
                text.innerText = window.currentLang === 'fr' 
                    ? `Normalisation terminée !`
                    : `Normalization completed!`;
                scheduleHide(3000);
            }
        });
    }
});
