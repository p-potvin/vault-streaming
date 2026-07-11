// js/player/clip.js - Core clipping functionality for video player

// ============================================================================
// CLIP STATE MANAGEMENT
// ============================================================================

window.clipState = {
    active: false,
    startTime: 0,
    endTime: 0,
    previewTime: 0,
    isDraggingStart: false,
    isDraggingEnd: false,
    markerWidth: 12,
    markerHeight: 20,
    videoDuration: 0,
    videoElement: null
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get the video player element. Tries multiple sources.
 */
function getVideoPlayer() {
    return document.getElementById('video-player') || window.clipState.videoElement;
}

// ============================================================================
// CLIP UI ELEMENT REFERENCES
// ============================================================================

let clipMarkersContainer = null;
let startMarkerEl = null;
let endMarkerEl = null;
let clipPreviewCanvas = null;
let clipPreviewCtx = null;
let clipPreviewVideo = null;
let clipDurationDisplay = null;
let clipToolbar = null;

// ============================================================================
// INITIALIZATION
// ============================================================================

function initClipSystem() {
    console.log('[Clip] Initializing clip system...');
    
    // Create marker elements
    createClipUIElements();
    
    // Setup preview video (hidden, used for frame extraction)
    setupPreviewVideo();
    
    // Get video player element
    const vp = document.getElementById('video-player');
    if (vp) {
        window.clipState.videoElement = vp;
        
        // Update marker positions on timeupdate
        vp.addEventListener('timeupdate', updateClipPreviewFrame);
        vp.addEventListener('loadedmetadata', () => {
            window.clipState.videoDuration = vp.duration;
        });
        
        // Also listen for when video is reset
        const originalLoad = vp.load.bind(vp);
        vp.load = function() {
            originalLoad();
            // Reset duration when new video loads
            window.clipState.videoDuration = 0;
        };
    } else {
        console.warn('[Clip] Video player element not found');
    }
    
    console.log('[Clip] Clip system initialized');
}

// ============================================================================
// UI ELEMENT CREATION
// ============================================================================

function createClipUIElements() {
    const seekArea = document.getElementById('seek-area');
    if (!seekArea) {
        console.warn('[Clip] seek-area not found, cannot create UI elements');
        return;
    }
    console.log('[Clip] Creating clip UI elements');
    
    // Container for clip markers (positioned relative to seek bar)
    clipMarkersContainer = document.createElement('div');
    clipMarkersContainer.id = 'clip-markers-container';
    clipMarkersContainer.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        display: none;
        z-index: 10;
    `;
    seekArea.appendChild(clipMarkersContainer);
    
    // Start marker element
    startMarkerEl = document.createElement('div');
    startMarkerEl.id = 'clip-marker-start';
    startMarkerEl.style.cssText = `
        position: absolute;
        width: 12px;
        height: 20px;
        background: var(--vault-accent);
        border-radius: 2px;
        top: -5px;
        left: 0;
        cursor: ew-resize;
        pointer-events: auto;
        border: 2px solid white;
        box-shadow: 0 0 5px rgba(0,0,0,0.5);
        transition: transform 0.1s;
    `;
    startMarkerEl.title = 'Start of clip - drag to adjust';
    clipMarkersContainer.appendChild(startMarkerEl);
    
    // End marker element
    endMarkerEl = document.createElement('div');
    endMarkerEl.id = 'clip-marker-end';
    endMarkerEl.style.cssText = `
        position: absolute;
        width: 12px;
        height: 20px;
        background: var(--vault-accent);
        border-radius: 2px;
        top: -5px;
        left: 0;
        cursor: ew-resize;
        pointer-events: auto;
        border: 2px solid white;
        box-shadow: 0 0 5px rgba(0,0,0,0.5);
        transition: transform 0.1s;
    `;
    endMarkerEl.title = 'End of clip - drag to adjust';
    clipMarkersContainer.appendChild(endMarkerEl);
    
    // Clip region highlight (semi-transparent overlay between markers)
    const clipRegionEl = document.createElement('div');
    clipRegionEl.id = 'clip-region-highlight';
    clipRegionEl.style.cssText = `
        position: absolute;
        height: 6px;
        background: rgba(245, 185, 41, 0.3);
        border-radius: 3px;
        top: 8px;
        left: 0;
        pointer-events: none;
        display: none;
    `;
    clipMarkersContainer.appendChild(clipRegionEl);
    
    // Clip preview canvas (separate from seek preview)
    clipPreviewCanvas = document.createElement('canvas');
    clipPreviewCanvas.id = 'clip-preview-canvas';
    clipPreviewCanvas.width = 240;
    clipPreviewCanvas.height = 135;
    clipPreviewCanvas.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        border: 2px solid var(--vault-accent);
        border-radius: 6px;
        box-shadow: 0 15px 40px rgba(0,0,0,0.7);
        background: #000;
        z-index: 3400;
        display: none;
        pointer-events: none;
    `;
    document.body.appendChild(clipPreviewCanvas);
    clipPreviewCtx = clipPreviewCanvas.getContext('2d');
    
    // Clip duration display (floating above seek bar)
    clipDurationDisplay = document.createElement('div');
    clipDurationDisplay.id = 'clip-duration-display';
    clipDurationDisplay.style.cssText = `
        position: absolute;
        bottom: 28px;
        left: 50%;
        transform: translateX(-50%);
        background: var(--vault-accent);
        color: #0b0813;
        padding: 4px 12px;
        border-radius: 4px;
        font-family: var(--font-mono);
        font-size: 11px;
        font-weight: 700;
        z-index: 15;
        display: none;
        pointer-events: none;
        box-shadow: 0 4px 10px rgba(0,0,0,0.3);
    `;
    clipMarkersContainer.appendChild(clipDurationDisplay);
    
    // Setup drag events
    setupMarkerDragEvents();
}

// ============================================================================
// PREVIEW VIDEO SETUP
// ============================================================================

function setupPreviewVideo() {
    clipPreviewVideo = document.createElement('video');
    clipPreviewVideo.id = 'clip-preview-video';
    clipPreviewVideo.muted = true;
    clipPreviewVideo.preload = 'metadata';
    clipPreviewVideo.style.cssText = `
        position: absolute;
        width: 1px;
        height: 1px;
        opacity: 0;
        pointer-events: none;
    `;
    document.body.appendChild(clipPreviewVideo);
    
    // When video seeks, update preview
    clipPreviewVideo.addEventListener('seeked', () => {
        if (clipPreviewCtx && clipPreviewVideo.videoWidth > 0) {
            const aspect = clipPreviewVideo.videoHeight / clipPreviewVideo.videoWidth;
            const drawWidth = clipPreviewCanvas.width;
            const drawHeight = clipPreviewCanvas.width * aspect;
            
            clipPreviewCtx.clearRect(0, 0, clipPreviewCanvas.width, clipPreviewCanvas.height);
            clipPreviewCtx.drawImage(
                clipPreviewVideo,
                0, 0, clipPreviewVideo.videoWidth, clipPreviewVideo.videoHeight,
                0, 0, drawWidth, drawHeight
            );
        }
    });
}

// ============================================================================
// DRAG EVENT HANDLERS
// ============================================================================

function setupMarkerDragEvents() {
    if (!startMarkerEl || !endMarkerEl || !clipMarkersContainer) return;
    
    let dragStartX = 0;
    let initialLeft = 0;
    
    function startDrag(marker, isStart, e) {
        e.stopPropagation();
        e.preventDefault();
        
        window.clipState.active = true;
        if (isStart) {
            window.clipState.isDraggingStart = true;
        } else {
            window.clipState.isDraggingEnd = true;
        }
        
        const rect = clipMarkersContainer.getBoundingClientRect();
        dragStartX = e.clientX;
        initialLeft = marker.offsetLeft;
        
        // Show preview
        clipPreviewCanvas.style.display = 'block';
        
        // Add drag move listeners
        const dragMove = (moveE) => {
            if ((isStart && !window.clipState.isDraggingStart) || 
                (!isStart && !window.clipState.isDraggingEnd)) {
                return;
            }
            
            const dx = moveE.clientX - dragStartX;
            const newLeft = Math.max(0, Math.min(rect.width - 12, initialLeft + dx));
            const pct = newLeft / rect.width;
            const time = pct * window.clipState.videoDuration;
            
            if (isStart) {
                // Ensure start doesn't go past end
                const endPct = window.clipState.endTime / window.clipState.videoDuration;
                const maxStartPct = endPct - 0.02; // Minimum 2% gap
                const clampedPct = Math.min(pct, maxStartPct);
                const clampedTime = clampedPct * window.clipState.videoDuration;
                
                startMarkerEl.style.left = (clampedPct * 100) + '%';
                window.clipState.startTime = clampedTime;
                window.clipState.previewTime = clampedTime;
            } else {
                // Ensure end doesn't go before start
                const startPct = window.clipState.startTime / window.clipState.videoDuration;
                const minEndPct = startPct + 0.02; // Minimum 2% gap
                const clampedPct = Math.max(pct, minEndPct);
                const clampedTime = clampedPct * window.clipState.videoDuration;
                
                endMarkerEl.style.left = (clampedPct * 100) + '%';
                window.clipState.endTime = clampedTime;
                window.clipState.previewTime = clampedTime;
            }
            
            updateClipRegionHighlight();
            updateClipDurationDisplay();
            updateClipPreviewFrame();
        };
        
        const dragEnd = () => {
            window.clipState.isDraggingStart = false;
            window.clipState.isDraggingEnd = false;
            document.removeEventListener('mousemove', dragMove);
            document.removeEventListener('mouseup', dragEnd);
        };
        
        document.addEventListener('mousemove', dragMove);
        document.addEventListener('mouseup', dragEnd);
    }
    
    startMarkerEl.addEventListener('mousedown', (e) => startDrag(startMarkerEl, true, e));
    endMarkerEl.addEventListener('mousedown', (e) => startDrag(endMarkerEl, false, e));
    
    // Touch support
    startMarkerEl.addEventListener('touchstart', (e) => startDrag(startMarkerEl, true, e.touches[0]));
    endMarkerEl.addEventListener('touchstart', (e) => startDrag(endMarkerEl, false, e.touches[0]));
}

// ============================================================================
// CLIP ACTIVATION / DEACTIVATION
// ============================================================================

function startClipMode() {
    console.log('[Clip] startClipMode called');
    
    const vp = getVideoPlayer();
    if (!vp || vp.readyState < HTMLMediaElement.HAVE_METADATA) {
        window.showToast('Wait for video to load', 'warning');
        console.warn('[Clip] Video not ready');
        return;
    }
    
    // Ensure UI elements are created
    if (!clipMarkersContainer || !startMarkerEl || !endMarkerEl) {
        console.log('[Clip] Creating UI elements on demand');
        createClipUIElements();
        setupMarkerDragEvents();
        setupPreviewVideo();
    }
    
    // Ensure video element reference is set
    if (!window.clipState.videoElement) {
        window.clipState.videoElement = vp;
    }
    
    // Pause video
    vp.pause();
    const btnPlayEl = document.getElementById('btn-playpause');
    if (btnPlayEl) {
        btnPlayEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px; height:16px; display:block;"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
    }
    
    console.log('[Clip] Video paused, setting up markers');
    
    // Set marker positions
    const currentTime = vp.currentTime;
    const duration = vp.duration;
    
    window.clipState.active = true;
    window.clipState.startTime = Math.max(0, currentTime - 30);
    window.clipState.endTime = Math.min(duration, currentTime);
    window.clipState.previewTime = currentTime;
    window.clipState.videoDuration = duration;
    
    // Position markers (check if elements exist)
    const startPct = (window.clipState.startTime / duration) * 100;
    const endPct = (window.clipState.endTime / duration) * 100;
    
    if (startMarkerEl) startMarkerEl.style.left = startPct + '%';
    if (endMarkerEl) endMarkerEl.style.left = endPct + '%';
    
    // Show UI (check if elements exist)
    if (clipMarkersContainer) clipMarkersContainer.style.display = 'block';
    if (clipPreviewCanvas) clipPreviewCanvas.style.display = 'block';
    if (clipDurationDisplay) clipDurationDisplay.style.display = 'block';
    
    if (typeof updateClipRegionHighlight === 'function') updateClipRegionHighlight();
    if (typeof updateClipDurationDisplay === 'function') updateClipDurationDisplay();
    if (typeof updateClipPreviewFrame === 'function') updateClipPreviewFrame();
    
    // Sync preview video
    if (clipPreviewVideo && vp.src) {
        clipPreviewVideo.src = vp.src;
    }
    
    // Disable other controls during clip mode
    document.body.classList.add('clip-mode-active');
    
    // Show clip mode toolbar
    showClipToolbar();
    
    console.log('[Clip] Clip mode started', {
        start: window.clipState.startTime,
        end: window.clipState.endTime
    });
    
    window.showToast(`Clip mode active (${formatClipDuration(window.clipState.endTime - window.clipState.startTime)})`, 'success');
}

function endClipMode() {
    window.clipState.active = false;
    window.clipState.isDraggingStart = false;
    window.clipState.isDraggingEnd = false;
    
    // Hide UI (check if elements exist)
    if (clipMarkersContainer) clipMarkersContainer.style.display = 'none';
    if (clipPreviewCanvas) clipPreviewCanvas.style.display = 'none';
    if (clipDurationDisplay) clipDurationDisplay.style.display = 'none';
    
    // Hide clip toolbar
    hideClipToolbar();
    
    // Enable other controls
    document.body.classList.remove('clip-mode-active');
    
    console.log('[Clip] Clip mode ended');
}

function cancelClipMode() {
    endClipMode();
    const vp = getVideoPlayer();
    if (vp) {
        vp.play().catch(() => {});
        const btnPlayEl = document.getElementById('btn-playpause');
        if (btnPlayEl) {
            btnPlayEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px; height:16px; display:block;"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
        }
    }
    window.showToast('Clip mode cancelled', 'warning');
}

// ============================================================================
// UPDATE FUNCTIONS
// ============================================================================

function updateClipMarkerPositions() {
    const vp = getVideoPlayer();
    if (!vp || !window.clipState.active) return;
    
    const duration = vp.duration;
    if (duration === 0) return;
    
    const startPct = (window.clipState.startTime / duration) * 100;
    const endPct = (window.clipState.endTime / duration) * 100;
    
    startMarkerEl.style.left = startPct + '%';
    endMarkerEl.style.left = endPct + '%';
    
    updateClipRegionHighlight();
    updateClipDurationDisplay();
}

function updateClipRegionHighlight() {
    const highlight = document.getElementById('clip-region-highlight');
    if (!highlight) return;
    
    const vp = getVideoPlayer();
    if (!vp || !vp.duration || vp.duration <= 0) return;
    
    const startPct = (window.clipState.startTime / vp.duration) * 100;
    const endPct = (window.clipState.endTime / vp.duration) * 100;
    const width = endPct - startPct;
    
    highlight.style.left = startPct + '%';
    highlight.style.width = width + '%';
    highlight.style.display = width > 1 ? 'block' : 'none';
}

function updateClipDurationDisplay() {
    if (!clipDurationDisplay) return;
    
    const duration = window.clipState.endTime - window.clipState.startTime;
    clipDurationDisplay.textContent = formatClipDuration(duration);
    
    // Position between markers
    const vp = getVideoPlayer();
    if (vp && vp.duration && vp.duration > 0) {
        const midPct = ((window.clipState.startTime + window.clipState.endTime) / (2 * vp.duration)) * 100;
        clipDurationDisplay.style.left = midPct + '%';
    }
}

function updateClipPreviewFrame() {
    if (!window.clipState.active || !clipPreviewVideo) return;
    
    const vp = getVideoPlayer();
    if (!vp || !vp.duration || vp.duration <= 0) return;
    
    // Use preview time (either from dragging or current video time)
    let targetTime = window.clipState.previewTime;
    
    // Clamp to clip boundaries
    targetTime = Math.max(window.clipState.startTime, Math.min(window.clipState.endTime, targetTime));
    
    // Update preview video position
    if (clipPreviewVideo.src && Math.abs(clipPreviewVideo.currentTime - targetTime) > 0.5) {
        clipPreviewVideo.currentTime = targetTime;
    }
    
    // Update preview canvas when ready
    if (clipPreviewVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        setTimeout(() => {
            if (clipPreviewCtx && clipPreviewVideo.videoWidth > 0) {
                const aspect = clipPreviewVideo.videoHeight / clipPreviewVideo.videoWidth;
                const drawWidth = clipPreviewCanvas.width;
                const drawHeight = clipPreviewCanvas.width * aspect;
                
                clipPreviewCtx.clearRect(0, 0, clipPreviewCanvas.width, clipPreviewCanvas.height);
                clipPreviewCtx.drawImage(
                    clipPreviewVideo,
                    0, 0, clipPreviewVideo.videoWidth, clipPreviewVideo.videoHeight,
                    0, 0, drawWidth, drawHeight
                );
            }
        }, 100);
    }
}

// ============================================================================
// CLIP MODE TOOLBAR
// ============================================================================

function showClipToolbar() {
    hideClipToolbar();
    
    clipToolbar = document.createElement('div');
    clipToolbar.id = 'clip-mode-toolbar';
    clipToolbar.style.cssText = `
        position: fixed;
        top: 56px;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 18px;
        background: rgba(11, 8, 19, 0.92);
        border: 1px solid var(--vault-accent);
        border-radius: 8px;
        box-shadow: 0 8px 30px rgba(245, 185, 41, 0.15), 0 0 0 1px rgba(245, 185, 41, 0.1);
        backdrop-filter: blur(12px);
        z-index: 10500;
        font-family: var(--font-mono);
        animation: clipToolbarIn 0.25s ease-out;
    `;
    
    // Inject animation keyframes if not already present
    if (!document.getElementById('clip-toolbar-keyframes')) {
        const style = document.createElement('style');
        style.id = 'clip-toolbar-keyframes';
        style.textContent = `
            @keyframes clipToolbarIn {
                from { opacity: 0; transform: translateX(-50%) translateY(-10px); }
                to   { opacity: 1; transform: translateX(-50%) translateY(0); }
            }
        `;
        document.head.appendChild(style);
    }
    
    // Clip mode label
    const label = document.createElement('span');
    label.style.cssText = `
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--vault-accent);
        display: flex;
        align-items: center;
        gap: 6px;
    `;
    label.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
        </svg>
        CLIP MODE
    `;
    
    // Duration indicator (updated reactively)
    const durationSpan = document.createElement('span');
    durationSpan.id = 'clip-toolbar-duration';
    durationSpan.style.cssText = `
        font-size: 11px;
        font-weight: 600;
        color: var(--vault-text);
        padding: 2px 8px;
        background: rgba(255,255,255,0.06);
        border-radius: 4px;
        min-width: 50px;
        text-align: center;
    `;
    durationSpan.textContent = formatClipDuration(window.clipState.endTime - window.clipState.startTime);
    
    // Save button
    const saveBtn = document.createElement('button');
    saveBtn.id = 'clip-toolbar-save';
    saveBtn.style.cssText = `
        background: var(--vault-accent);
        color: #0b0813;
        border: none;
        padding: 5px 14px;
        border-radius: 4px;
        font-weight: 700;
        font-size: 10px;
        font-family: var(--font-mono);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        cursor: pointer;
        transition: filter 0.15s;
        display: flex;
        align-items: center;
        gap: 5px;
    `;
    saveBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:11px;height:11px;">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Save Clip
    `;
    saveBtn.onmouseenter = () => { saveBtn.style.filter = 'brightness(1.15)'; };
    saveBtn.onmouseleave = () => { saveBtn.style.filter = ''; };
    saveBtn.onclick = () => { exportClip(); };
    
    // Cancel button
    const cancelBtn = document.createElement('button');
    cancelBtn.id = 'clip-toolbar-cancel';
    cancelBtn.style.cssText = `
        background: transparent;
        color: var(--vault-slate);
        border: 1px solid var(--vault-border);
        padding: 5px 12px;
        border-radius: 4px;
        font-weight: 600;
        font-size: 10px;
        font-family: var(--font-mono);
        text-transform: uppercase;
        cursor: pointer;
        transition: all 0.15s;
    `;
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onmouseenter = () => {
        cancelBtn.style.borderColor = 'var(--vault-slate)';
        cancelBtn.style.color = 'var(--vault-text)';
    };
    cancelBtn.onmouseleave = () => {
        cancelBtn.style.borderColor = 'var(--vault-border)';
        cancelBtn.style.color = 'var(--vault-slate)';
    };
    cancelBtn.onclick = () => { cancelClipMode(); };
    
    clipToolbar.appendChild(label);
    clipToolbar.appendChild(durationSpan);
    clipToolbar.appendChild(saveBtn);
    clipToolbar.appendChild(cancelBtn);
    
    document.body.appendChild(clipToolbar);
    
    // Start reactive duration updater
    startToolbarDurationUpdater();
}

function hideClipToolbar() {
    if (clipToolbar) {
        clipToolbar.remove();
        clipToolbar = null;
    }
    const existing = document.getElementById('clip-mode-toolbar');
    if (existing) existing.remove();
    stopToolbarDurationUpdater();
}

let _toolbarDurationTimer = null;
function startToolbarDurationUpdater() {
    stopToolbarDurationUpdater();
    _toolbarDurationTimer = setInterval(() => {
        const el = document.getElementById('clip-toolbar-duration');
        if (!el || !window.clipState.active) {
            stopToolbarDurationUpdater();
            return;
        }
        el.textContent = formatClipDuration(window.clipState.endTime - window.clipState.startTime);
    }, 200);
}
function stopToolbarDurationUpdater() {
    if (_toolbarDurationTimer) {
        clearInterval(_toolbarDurationTimer);
        _toolbarDurationTimer = null;
    }
}

// ============================================================================
// EXPORT FUNCTIONS
// ============================================================================

function getClipData() {
    return {
        startTime: window.clipState.startTime,
        endTime: window.clipState.endTime,
        duration: window.clipState.endTime - window.clipState.startTime,
        videoSource: window.clipState.videoElement ? window.clipState.videoElement.src : null
    };
}

function exportClip() {
    const clipData = getClipData();
    if (clipData.duration <= 0) {
        window.showToast('Clip duration must be greater than 0', 'error');
        return;
    }
    
    // Show editing dialog first
    showClipEditingDialog(clipData);
}

// ============================================================================
// EDITING DIALOG
// ============================================================================

function showClipEditingDialog(clipData) {
    // Check if dialog already exists
    let dialog = document.getElementById('clip-editing-dialog');
    if (dialog) {
        dialog.remove();
    }
    
    const dialogEl = document.createElement('div');
    dialogEl.id = 'clip-editing-dialog';
    dialogEl.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.85);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10500;
        backdrop-filter: blur(5px);
    `;
    
    const dialogContent = document.createElement('div');
    dialogContent.style.cssText = `
        background: var(--vault-warm-bg, #1a1a24);
        color: #161320;
        border: 1px solid var(--vault-border);
        border-radius: 8px;
        padding: 24px;
        width: 600px;
        max-width: 90vw;
        max-height: 85vh;
        overflow-y: auto;
        box-shadow: 0 30px 100px rgba(0, 0, 0, 0.85);
        font-family: var(--font-sans);
        color: var(--vault-text);
        display: flex;
        flex-direction: column;
        gap: 16px;
    `;
    
    // Header
    const header = document.createElement('div');
    header.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid var(--vault-border);
        padding-bottom: 12px;
    `;
    
    const headerTitle = document.createElement('div');
    headerTitle.style.cssText = `
        font-family: var(--font-mono);
        font-size: 12px;
        text-transform: uppercase;
        color: var(--vault-accent);
        font-weight: bold;
        display: flex;
        align-items: center;
        gap: 8px;
    `;
    headerTitle.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
        </svg>
        Edit Clip
    `;
    
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '✕';
    closeBtn.style.cssText = `
        background: transparent;
        border: none;
        color: var(--vault-slate);
        cursor: pointer;
        font-size: 18px;
        padding: 0;
        line-height: 1;
    `;
    closeBtn.onclick = () => dialogEl.remove();
    
    header.appendChild(headerTitle);
    header.appendChild(closeBtn);
    
    // Preview section
    const previewSection = document.createElement('div');
    previewSection.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 8px;
    `;
    
    const previewLabel = document.createElement('label');
    previewLabel.textContent = 'Clip Preview:';
    previewLabel.style.cssText = `font-size: 11px; text-transform: uppercase; color: var(--vault-slate); font-weight: bold;`;
    
    const previewContainer = document.createElement('div');
    previewContainer.style.cssText = `
        background: #000;
        border: 1px solid var(--vault-border);
        border-radius: 4px;
        overflow: hidden;
        position: relative;
    `;
    
    const previewVideo = document.createElement('video');
    previewVideo.src = clipData.videoSource;
    previewVideo.style.cssText = `
        width: 100%;
        max-height: 240px;
        display: block;
    `;
    previewVideo.currentTime = clipData.startTime;
    previewVideo.muted = true;
    
    // Add trim overlay to show the selected region
    const trimOverlay = document.createElement('div');
    trimOverlay.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: linear-gradient(to right, rgba(0,0,0,0.7), transparent, rgba(0,0,0,0.7));
        pointer-events: none;
    `;
    
    previewContainer.appendChild(previewVideo);
    previewContainer.appendChild(trimOverlay);
    previewSection.appendChild(previewLabel);
    previewSection.appendChild(previewContainer);
    
    // Info section
    const infoSection = document.createElement('div');
    infoSection.style.cssText = `
        display: flex;
        gap: 16px;
        font-size: 12px;
        font-family: var(--font-mono);
        color: var(--vault-slate);
        padding: 8px 0;
    `;
    
    infoSection.innerHTML = `
        <div><strong>Start:</strong> ${formatClipDuration(clipData.startTime)}</div>
        <div><strong>End:</strong> ${formatClipDuration(clipData.endTime)}</div>
        <div><strong>Duration:</strong> ${formatClipDuration(clipData.duration)}</div>
    `;
    
    // Editing options
    const editingOptions = document.createElement('div');
    editingOptions.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 12px;
        border-top: 1px solid var(--vault-border);
        padding-top: 16px;
    `;
    
    const optionsTitle = document.createElement('div');
    optionsTitle.textContent = 'Basic Editing Options:';
    optionsTitle.style.cssText = `font-size: 11px; text-transform: uppercase; color: var(--vault-slate); font-weight: bold;`;
    
    const optionsGrid = document.createElement('div');
    optionsGrid.style.cssText = `
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 8px;
    `;
    
    // Add editing option buttons
    const editingButtons = [
        { id: 'trim', name: 'Trim', icon: '✂️', action: () => adjustClipBounds(clipData) },
        { id: 'crop', name: 'Crop', icon: '🟪', action: () => showCropDialog(clipData) },
        { id: 'rotate', name: 'Rotate', icon: '🔄', action: () => rotateClip(clipData) },
        { id: 'filters', name: 'Filters', icon: '🎨', action: () => showFiltersDialog(clipData) },
        { id: 'ai-enhance', name: 'AI Enhance', icon: '✨', action: () => showAIEnhancements(clipData) },
        { id: 'speed', name: 'Speed', icon: '⚡', action: () => adjustPlaybackSpeed(clipData) }
    ];
    
    editingButtons.forEach(btn => {
        const button = document.createElement('button');
        button.style.cssText = `
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 4px;
            padding: 10px 12px;
            background: rgba(22, 19, 32, 0.06);
            border: 1px solid var(--vault-border);
            border-radius: 6px;
            cursor: pointer;
            color: #161320;
            transition: all 0.2s;
            font-family: var(--font-body);
            font-size: 11px;
            font-weight: 600;
        `;
        button.innerHTML = `<span style="font-size: 18px;">${btn.icon}</span><span>${btn.name}</span>`;
        button.onclick = btn.action;
        button.onmouseenter = () => {
            button.style.background = 'rgba(22, 19, 32, 0.12)';
        };
        button.onmouseleave = () => {
            button.style.background = 'rgba(22, 19, 32, 0.06)';
        };
        optionsGrid.appendChild(button);
    });
    
    editingOptions.appendChild(optionsTitle);
    editingOptions.appendChild(optionsGrid);
    
    // AI Enhancements section
    const aiSection = document.createElement('div');
    aiSection.style.cssText = `
        border-top: 1px solid var(--vault-border);
        padding-top: 16px;
    `;
    
    const aiTitle = document.createElement('div');
    aiTitle.textContent = 'AI Enhancements:';
    aiTitle.style.cssText = `font-size: 11px; text-transform: uppercase; color: var(--vault-slate); font-weight: bold; margin-bottom: 8px;`;
    
    const aiOptionsGrid = document.createElement('div');
    aiOptionsGrid.style.cssText = `
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 8px;
    `;
    
    const aiButtons = [
        { name: 'Upscale', description: '4K', action: () => applyAIUpscale(clipData) },
        { name: 'Stabilize', description: 'Shaky video', action: () => applyAISabilization(clipData) },
        { name: 'Denoise', description: 'Remove noise', action: () => applyAIDenoise(clipData) },
        { name: 'Color', description: 'Auto-color', action: () => applyAIColorCorrection(clipData) },
        { name: 'Frame', description: 'Interpolate', action: () => applyAIFrameInterpolation(clipData) }
    ];
    
    aiButtons.forEach(btn => {
        const button = document.createElement('button');
        button.style.cssText = `
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 4px;
            padding: 10px 12px;
            background: linear-gradient(135deg, rgba(245, 185, 41, 0.2), rgba(245, 185, 41, 0.1));
            border: 1px solid #F5B92B;
            border-radius: 6px;
            cursor: pointer;
            color: #161320;
            transition: all 0.2s;
            font-family: var(--font-body);
            font-size: 11px;
            font-weight: 600;
        `;
        button.innerHTML = `<span>${btn.name}</span><span style="font-size: 10px; opacity: 0.7;">${btn.description}</span>`;
        button.onclick = btn.action;
        button.onmouseenter = () => {
            button.style.background = 'linear-gradient(135deg, rgba(245, 185, 41, 0.3), rgba(245, 185, 41, 0.2))';
        };
        button.onmouseleave = () => {
            button.style.background = 'linear-gradient(135deg, rgba(245, 185, 41, 0.2), rgba(245, 185, 41, 0.1))';
        };
        aiOptionsGrid.appendChild(button);
    });
    
    aiSection.appendChild(aiTitle);
    aiSection.appendChild(aiOptionsGrid);
    
    // Actions
    const actionsSection = document.createElement('div');
    actionsSection.style.cssText = `
        display: flex;
        gap: 10px;
        border-top: 1px solid var(--vault-border);
        padding-top: 16px;
        justify-content: flex-end;
    `;
    
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = `
        background: rgba(22, 19, 32, 0.06);
        color: #161320;
        border: 1px solid var(--vault-border);
        padding: 10px 20px;
        border-radius: 4px;
        font-weight: 600;
        cursor: pointer;
        font-size: 12px;
        transition: all 0.2s;
        font-family: var(--font-body);
    `;
    cancelBtn.onclick = () => dialogEl.remove();
    
    const proceedBtn = document.createElement('button');
    proceedBtn.textContent = 'Continue to Export';
    proceedBtn.style.cssText = `
        background: var(--vault-accent);
        color: var(--vt-primary);
        border: none;
        padding: 10px 20px;
        border-radius: 4px;
        font-weight: 700;
        cursor: pointer;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        transition: all 0.2s;
        font-family: var(--font-body);
    `;
    proceedBtn.onclick = () => {
        dialogEl.remove();
        showClipExportDialog(clipData);
    };
    
    actionsSection.appendChild(cancelBtn);
    actionsSection.appendChild(proceedBtn);
    
    // Assemble dialog
    dialogContent.appendChild(header);
    dialogContent.appendChild(previewSection);
    dialogContent.appendChild(infoSection);
    dialogContent.appendChild(editingOptions);
    dialogContent.appendChild(aiSection);
    dialogContent.appendChild(actionsSection);
    
    dialogEl.appendChild(dialogContent);
    document.body.appendChild(dialogEl);
}

// Placeholder functions for editing options
function adjustClipBounds(clipData) {
    window.showToast('Trim mode already active - drag the markers to adjust', 'info');
}

function showCropDialog(clipData) {
    window.showToast('Crop feature - Coming soon!', 'info');
}

function rotateClip(clipData) {
    window.showToast('Rotate feature - Coming soon!', 'info');
}

function showFiltersDialog(clipData) {
    window.showToast('Filters feature - Coming soon!', 'info');
}

function adjustPlaybackSpeed(clipData) {
    window.showToast('Speed adjustment - Coming soon!', 'info');
}

function applyAIUpscale(clipData) {
    window.showToast('AI Upscale applied (simulated)', 'success');
}

function applyAISabilization(clipData) {
    window.showToast('AI Stabilization applied (simulated)', 'success');
}

function applyAIDenoise(clipData) {
    window.showToast('AI Denoise applied (simulated)', 'success');
}

function applyAIColorCorrection(clipData) {
    window.showToast('AI Color Correction applied (simulated)', 'success');
}

function applyAIFrameInterpolation(clipData) {
    window.showToast('AI Frame Interpolation applied (simulated)', 'success');
}

function showAIEnhancements(clipData) {
    window.showToast('AI Enhancements dialog - Coming soon!', 'info');
}

// ============================================================================
// EXPORT DIALOG
// ============================================================================

function showClipExportDialog(clipData) {
    // Check if dialog already exists
    let dialog = document.getElementById('clip-export-dialog');
    if (dialog) {
        dialog.remove();
    }
    
    // Create dialog overlay
    dialog = document.createElement('div');
    dialog.id = 'clip-export-dialog';
    dialog.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.85);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10500;
        backdrop-filter: blur(5px);
    `;
    
    const dialogContent = document.createElement('div');
    dialogContent.style.cssText = `
        background: var(--vault-warm-bg, #1a1a24);
        color: #161320;
        border: 1px solid var(--vault-border);
        border-radius: 8px;
        padding: 24px;
        width: 480px;
        max-width: 90vw;
        max-height: 85vh;
        overflow-y: auto;
        box-shadow: 0 30px 100px rgba(0, 0, 0, 0.85);
        font-family: var(--font-sans);
        color: var(--vault-text);
        display: flex;
        flex-direction: column;
        gap: 16px;
    `;
    
    // Header
    const header = document.createElement('div');
    header.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid var(--vault-border);
        padding-bottom: 12px;
    `;
    
    const headerTitle = document.createElement('div');
    headerTitle.style.cssText = `
        font-family: var(--font-mono);
        font-size: 12px;
        text-transform: uppercase;
        color: var(--vault-accent);
        font-weight: bold;
        display: flex;
        align-items: center;
        gap: 8px;
    `;
    headerTitle.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
        </svg>
        Export Clip
    `;
    
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '✕';
    closeBtn.style.cssText = `
        background: transparent;
        border: none;
        color: var(--vault-slate);
        cursor: pointer;
        font-size: 18px;
        padding: 0;
        line-height: 1;
    `;
    closeBtn.onclick = () => dialog.remove();
    
    header.appendChild(headerTitle);
    header.appendChild(closeBtn);
    
    // Clip info
    const clipInfo = document.createElement('div');
    clipInfo.style.cssText = `
        font-size: 12px;
        color: var(--vault-slate);
        font-family: var(--font-mono);
    `;
    clipInfo.textContent = `Duration: ${formatClipDuration(clipData.duration)} | Start: ${formatClipDuration(clipData.startTime)} | End: ${formatClipDuration(clipData.endTime)}`;
    
    // Export format selection
    const formatSection = document.createElement('div');
    formatSection.style.cssText = `display: flex; flex-direction: column; gap: 8px;`;
    
    const formatLabel = document.createElement('label');
    formatLabel.textContent = 'Export Format:';
    formatLabel.style.cssText = `font-size: 11px; text-transform: uppercase; color: var(--vault-slate); font-weight: bold;`;
    
    const formatSelect = document.createElement('select');
    formatSelect.id = 'clip-format-select';
    formatSelect.style.cssText = `
        background: var(--vt-primary);
        color: var(--vault-text);
        border: 1px solid var(--vault-border);
        padding: 8px 12px;
        border-radius: 4px;
        font-family: var(--font-body);
        font-size: 13px;
        cursor: pointer;
        outline: none;
    `;
    formatSelect.innerHTML = `
        <option value="webm">WebM (VP9) - Smallest, Good Quality</option>
        <option value="mp4">MP4 (H.264) - Universal Compatibility</option>
        <option value="gif">GIF - Animated Image (No Audio)</option>
    `;
    
    formatSection.appendChild(formatLabel);
    formatSection.appendChild(formatSelect);
    
    // Quality selection
    const qualitySection = document.createElement('div');
    qualitySection.style.cssText = `display: flex; flex-direction: column; gap: 8px;`;
    
    const qualityLabel = document.createElement('label');
    qualityLabel.textContent = 'Quality:';
    qualityLabel.style.cssText = `font-size: 11px; text-transform: uppercase; color: var(--vault-slate); font-weight: bold;`;
    
    const qualitySelect = document.createElement('select');
    qualitySelect.id = 'clip-quality-select';
    qualitySelect.style.cssText = `
        background: var(--vt-primary);
        color: var(--vault-text);
        border: 1px solid var(--vault-border);
        padding: 8px 12px;
        border-radius: 4px;
        font-family: var(--font-body);
        font-size: 13px;
        cursor: pointer;
        outline: none;
    `;
    qualitySelect.innerHTML = `
        <option value="original">Original Quality</option>
        <option value="1080p">1080p</option>
        <option value="720p">720p</option>
        <option value="480p">480p</option>
    `;
    
    qualitySection.appendChild(qualityLabel);
    qualitySection.appendChild(qualitySelect);
    
    // Export actions
    const actionsSection = document.createElement('div');
    actionsSection.style.cssText = `
        display: flex;
        gap: 10px;
        border-top: 1px solid var(--vault-border);
        padding-top: 16px;
    `;
    
    const exportBtn = document.createElement('button');
    exportBtn.id = 'clip-export-btn';
    exportBtn.textContent = 'Save to Desktop';
    exportBtn.style.cssText = `
        flex: 1;
        background: var(--vault-accent);
        color: var(--vt-primary);
        border: none;
        padding: 10px 16px;
        border-radius: 4px;
        font-weight: 700;
        cursor: pointer;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        transition: all 0.2s;
        font-family: var(--font-body);
    `;
    exportBtn.onclick = () => {
        exportClipToDesktop(clipData, formatSelect.value, qualitySelect.value);
        dialog.remove();
        endClipMode();
    };
    
    const shareBtn = document.createElement('button');
    shareBtn.textContent = 'Share...';
    shareBtn.style.cssText = `
        flex: 1;
        background: rgba(22, 19, 32, 0.06);
        color: var(--vault-text);
        border: 1px solid var(--vault-border);
        padding: 10px 16px;
        border-radius: 4px;
        font-weight: 600;
        cursor: pointer;
        font-size: 12px;
        transition: all 0.2s;
        font-family: var(--font-body);
    `;
    shareBtn.onclick = () => {
        dialog.remove();
        showShareDialog(clipData, formatSelect.value, qualitySelect.value);
    };
    
    const publishBtn = document.createElement('button');
    publishBtn.textContent = 'Publish...';
    publishBtn.style.cssText = `
        flex: 1;
        background: rgba(22, 19, 32, 0.06);
        color: var(--vault-text);
        border: 1px solid var(--vault-border);
        padding: 10px 16px;
        border-radius: 4px;
        font-weight: 600;
        cursor: pointer;
        font-size: 12px;
        transition: all 0.2s;
        font-family: var(--font-body);
    `;
    publishBtn.onclick = () => {
        dialog.remove();
        showPublishDialog(clipData, formatSelect.value, qualitySelect.value);
    };
    
    actionsSection.appendChild(exportBtn);
    actionsSection.appendChild(shareBtn);
    actionsSection.appendChild(publishBtn);
    
    // Assemble dialog
    dialogContent.appendChild(header);
    dialogContent.appendChild(clipInfo);
    dialogContent.appendChild(formatSection);
    dialogContent.appendChild(qualitySection);
    dialogContent.appendChild(actionsSection);
    
    dialog.appendChild(dialogContent);
    document.body.appendChild(dialog);
    
    // Focus on close button for ESC support
    closeBtn.focus();
}

// ============================================================================
// SAVE TO DESKTOP
// ============================================================================

function exportClipToDesktop(clipData, format, quality) {
    const vp = getVideoPlayer();
    if (!vp || !vp.src) {
        window.showToast('No video source available', 'error');
        return Promise.reject(new Error('No video source available'));
    }
    
    // Properly decode URI-encoded file paths
    let videoPath = vp.src;
    try {
        videoPath = decodeURIComponent(videoPath);
    } catch (_) {}
    videoPath = videoPath.replace(/^file:\/\/\//, '');
    
    const outputFormat = format;
    const startTime = clipData.startTime;
    const duration = clipData.duration;
    
    console.log('[Clip] Exporting clip:', { videoPath, outputFormat, startTime, duration, quality });
    window.showToast(`Exporting clip: ${formatClipDuration(duration)} (${outputFormat.toUpperCase()})...`, 'info');
    
    // Send to main process for ffmpeg processing
    if (window.electronAPI && window.electronAPI.clipVideo) {
        // Listen for progress events
        if (window.electronAPI.onClipProgress) {
            window.electronAPI.offClipProgress();
            window.electronAPI.onClipProgress((data) => {
                console.log('[Clip] Progress:', data.currentTime);
            });
        }
        
        return window.electronAPI.clipVideo({
            inputPath: videoPath,
            outputFormat: outputFormat,
            startTime: startTime,
            duration: duration,
            quality: quality
        }).then(result => {
            // Cleanup progress listener
            if (window.electronAPI.offClipProgress) window.electronAPI.offClipProgress();
            
            if (result.success) {
                const sizeMB = result.outputSize ? (result.outputSize / (1024 * 1024)).toFixed(1) : '?';
                window.showToast(`✓ Clip saved (${sizeMB} MB): ${result.outputPath}`, 'success');
                return result;
            } else {
                window.showToast(`Export failed: ${result.error}`, 'error');
                throw new Error(result.error || 'Export failed');
            }
        }).catch(err => {
            if (window.electronAPI.offClipProgress) window.electronAPI.offClipProgress();
            console.error('[Clip] Export error:', err);
            window.showToast(`Export failed: ${err.message}`, 'error');
            throw err;
        });
    } else {
        // Fallback: warn user that backend doesn't support clipping
        window.showToast('Clip export requires backend ffmpeg support. Feature not available.', 'error');
        return Promise.reject(new Error('Backend ffmpeg support required'));
    }
}

// ============================================================================
// SHARE DIALOG
// ============================================================================

function showShareDialog(clipData, format, quality) {
    // Check if dialog already exists
    let dialog = document.getElementById('clip-share-dialog');
    if (dialog) {
        dialog.remove();
    }
    
    // First, export the clip
    window.showToast('Exporting clip for sharing...', 'info');
    
    // For now, we'll export to temp and then share
    // In a real implementation, we'd export directly to the platform
    exportClipToDesktop(clipData, format, quality).then(() => {
        showShareDialogUI(clipData, format, quality);
    }).catch(err => {
        window.showToast(`Failed to prepare clip: ${err.message}`, 'error');
    });
}

function showShareDialogUI(clipData, format, quality) {
    const dialog = document.createElement('div');
    dialog.id = 'clip-share-dialog';
    dialog.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.85);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10500;
        backdrop-filter: blur(5px);
    `;
    
    const dialogContent = document.createElement('div');
    dialogContent.style.cssText = `
        background: var(--vault-warm-bg, #1a1a24);
        color: #161320;
        border: 1px solid var(--vault-border);
        border-radius: 8px;
        padding: 24px;
        width: 520px;
        max-width: 90vw;
        max-height: 85vh;
        overflow-y: auto;
        box-shadow: 0 30px 100px rgba(0, 0, 0, 0.85);
        font-family: var(--font-sans);
        color: var(--vault-text);
        display: flex;
        flex-direction: column;
        gap: 16px;
    `;
    
    // Header
    const header = document.createElement('div');
    header.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid var(--vault-border);
        padding-bottom: 12px;
    `;
    
    const headerTitle = document.createElement('div');
    headerTitle.style.cssText = `
        font-family: var(--font-mono);
        font-size: 12px;
        text-transform: uppercase;
        color: var(--vault-accent);
        font-weight: bold;
        display: flex;
        align-items: center;
        gap: 8px;
    `;
    headerTitle.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;">
            <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
            <polyline points="16,6 12,2 8,6"/>
            <line x1="12" y1="2" x2="12" y2="15"/>
        </svg>
        Share Clip
    `;
    
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '✕';
    closeBtn.style.cssText = `
        background: transparent;
        border: none;
        color: var(--vault-slate);
        cursor: pointer;
        font-size: 18px;
        padding: 0;
        line-height: 1;
    `;
    closeBtn.onclick = () => dialog.remove();
    
    header.appendChild(headerTitle);
    header.appendChild(closeBtn);
    
    // Message input
    const messageSection = document.createElement('div');
    messageSection.style.cssText = `display: flex; flex-direction: column; gap: 8px;`;
    
    const messageLabel = document.createElement('label');
    messageLabel.textContent = 'Message (Optional):';
    messageLabel.style.cssText = `font-size: 11px; text-transform: uppercase; color: var(--vault-slate); font-weight: bold;`;
    
    const messageInput = document.createElement('textarea');
    messageInput.id = 'share-message-input';
    messageInput.placeholder = 'Add a message to share with your clip...';
    messageInput.style.cssText = `
        background: var(--vt-primary);
        color: var(--vault-text);
        border: 1px solid var(--vault-border);
        padding: 10px 12px;
        border-radius: 4px;
        font-family: var(--font-body);
        font-size: 13px;
        cursor: pointer;
        outline: none;
        resize: vertical;
        min-height: 80px;
        max-height: 150px;
    `;
    
    messageSection.appendChild(messageLabel);
    messageSection.appendChild(messageInput);
    
    // Platform grid
    const platformsSection = document.createElement('div');
    platformsSection.style.cssText = `display: flex; flex-direction: column; gap: 8px;`;
    
    const platformsLabel = document.createElement('label');
    platformsLabel.textContent = 'Share to:';
    platformsLabel.style.cssText = `font-size: 11px; text-transform: uppercase; color: var(--vault-slate); font-weight: bold;`;
    
    const platformsGrid = document.createElement('div');
    platformsGrid.style.cssText = `
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
        gap: 10px;
    `;
    
    const sharePlatforms = [
        { id: 'discord', name: 'Discord', icon: '<svg viewBox="0 0 24 24" fill="currentColor" style="width:18px;height:18px;"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.4494 13.7918c-1.1216 0-2.1876-.966-2.1876-2.1876s.966-2.1876 2.1876-2.1876 2.1875.966 2.1875 2.1876-.966 2.1876-2.1875 2.1876zm7.3188 0c-1.1216 0-2.1876-.966-2.1876-2.1876s.966-2.1876 2.1876-2.1876c1.2498 0 2.3124.966 2.1876 2.1876-.1249 1.2216-1.2963 2.1876-2.1876 2.1876z"/></svg>', color: '#5865F2' },
        { id: 'slack', name: 'Slack', icon: '<svg viewBox="0 0 24 24" fill="currentColor" style="width:18px;height:18px;"><path d="M5.042 15.178c.254 0 .494-.015.725-.044.343-.044.68-.117.998-.218 1.114-.427 1.988-1.395 2.484-2.532.495-1.137.742-2.343.742-3.585 0-3.314-2.686-6-6-6C2.686 0 0 2.686 0 6c0 1.242.247 2.448.742 3.585.496 1.137 1.37 2.105 2.484 2.532.318.101.655.174.998.218.231.029.471.044.725.044zM18.958 2.822c-.254 0-.494.015-.725.044-.343.044-.68.117-.998.218-1.114.427-1.988 1.395-2.484 2.532-.495 1.137-.742 2.343-.742 3.585 0 3.314 2.686 6 6 6 3.314 0 6-2.686 6-6 0-1.242-.247-2.448-.742-3.585-.496-1.137-1.37-2.105-2.484-2.532-.318-.101-.655-.174-.998-.218-.231-.029-.471-.044-.725-.044z"/></svg>', color: '#4A154B' },
        { id: 'telegram', name: 'Telegram', icon: '<svg viewBox="0 0 24 24" fill="currentColor" style="width:18px;height:18px;"><path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981z"/></svg>', color: '#0088CC' },
        { id: 'whatsapp', name: 'WhatsApp', icon: '<svg viewBox="0 0 24 24" fill="currentColor" style="width:18px;height:18px;"><path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981z"/></svg>', color: '#25D366' },
        { id: 'messenger', name: 'Messenger', icon: '<svg viewBox="0 0 24 24" fill="currentColor" style="width:18px;height:18px;"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>', color: '#0084FF' }
    ];
    
    sharePlatforms.forEach(platform => {
        const btn = document.createElement('button');
        btn.style.cssText = `
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 6px;
            padding: 12px;
            background: rgba(22, 19, 32, 0.06);
            border: 1px solid var(--vault-border);
            border-radius: 6px;
            cursor: pointer;
            color: var(--vault-text);
            transition: all 0.2s;
            font-family: var(--font-body);
            font-size: 11px;
            font-weight: 600;
        `;
        btn.innerHTML = `${platform.icon}<span>${platform.name}</span>`;
        btn.onclick = () => {
            const message = messageInput.value.trim();
            shareToPlatform(platform.id, clipData, format, quality, message);
            dialog.remove();
        };
        btn.onmouseenter = () => {
            btn.style.background = 'rgba(22, 19, 32, 0.12)';
            btn.style.borderColor = platform.color;
        };
        btn.onmouseleave = () => {
            btn.style.background = 'rgba(22, 19, 32, 0.06)';
            btn.style.borderColor = 'var(--vault-border)';
        };
        platformsGrid.appendChild(btn);
    });
    
    platformsSection.appendChild(platformsLabel);
    platformsSection.appendChild(platformsGrid);
    
    // Assemble dialog
    dialogContent.appendChild(header);
    dialogContent.appendChild(messageSection);
    dialogContent.appendChild(platformsSection);
    
    dialog.appendChild(dialogContent);
    document.body.appendChild(dialog);
    
    // Focus on message input
    messageInput.focus();
}

function shareToPlatform(platform, clipData, format, quality, message) {
    // In a real implementation, this would use platform-specific APIs
    // For now, we'll just show a toast and copy to clipboard
    const platformNames = {
        discord: 'Discord',
        slack: 'Slack',
        telegram: 'Telegram',
        whatsapp: 'WhatsApp',
        messenger: 'Messenger'
    };
    
    // Simulate sharing
    if (window.electronAPI && window.electronAPI.shareClip) {
        window.electronAPI.shareClip({ platform, clipData, format, quality, message })
            .then(() => {
                window.showToast(`Clip shared to ${platformNames[platform] || platform}!`, 'success');
            })
            .catch(err => {
                window.showToast(`Failed to share: ${err.message}`, 'error');
            });
    } else {
        // Fallback: copy to clipboard
        const clipInfo = `Clip: ${clipData.duration}s from ${new Date(clipData.startTime * 1000).toISOString()}`;
        const fullMessage = message ? `${message}\n${clipInfo}` : clipInfo;
        navigator.clipboard.writeText(fullMessage).then(() => {
            window.showToast(`Copied to clipboard (${platformNames[platform] || platform} link simulated)`, 'success');
        }).catch(() => {
            window.showToast(`Clip ready to share on ${platformNames[platform] || platform}!`, 'success');
        });
    }
}

// ============================================================================
// PUBLISH DIALOG
// ============================================================================

function showPublishDialog(clipData, format, quality) {
    // Check if dialog already exists
    let dialog = document.getElementById('clip-publish-dialog');
    if (dialog) {
        dialog.remove();
    }
    
    // First, export the clip
    window.showToast('Exporting clip for publishing...', 'info');
    
    exportClipToDesktop(clipData, format, quality).then(() => {
        showPublishDialogUI(clipData, format, quality);
    }).catch(err => {
        window.showToast(`Failed to prepare clip: ${err.message}`, 'error');
    });
}

function showPublishDialogUI(clipData, format, quality) {
    const dialog = document.createElement('div');
    dialog.id = 'clip-publish-dialog';
    dialog.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.85);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10500;
        backdrop-filter: blur(5px);
    `;
    
    const dialogContent = document.createElement('div');
    dialogContent.style.cssText = `
        background: var(--vault-warm-bg, #1a1a24);
        color: #161320;
        border: 1px solid var(--vault-border);
        border-radius: 8px;
        padding: 24px;
        width: 520px;
        max-width: 90vw;
        max-height: 85vh;
        overflow-y: auto;
        box-shadow: 0 30px 100px rgba(0, 0, 0, 0.85);
        font-family: var(--font-sans);
        color: var(--vault-text);
        display: flex;
        flex-direction: column;
        gap: 16px;
    `;
    
    // Header
    const header = document.createElement('div');
    header.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid var(--vault-border);
        padding-bottom: 12px;
    `;
    
    const headerTitle = document.createElement('div');
    headerTitle.style.cssText = `
        font-family: var(--font-mono);
        font-size: 12px;
        text-transform: uppercase;
        color: var(--vault-accent);
        font-weight: bold;
        display: flex;
        align-items: center;
        gap: 8px;
    `;
    headerTitle.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            <line x1="12" y1="11" x2="12" y2="17"/>
            <line x1="9" y1="14" x2="15" y2="14"/>
        </svg>
        Publish Clip
    `;
    
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '✕';
    closeBtn.style.cssText = `
        background: transparent;
        border: none;
        color: var(--vault-slate);
        cursor: pointer;
        font-size: 18px;
        padding: 0;
        line-height: 1;
    `;
    closeBtn.onclick = () => dialog.remove();
    
    header.appendChild(headerTitle);
    header.appendChild(closeBtn);
    
    // Caption input
    const captionSection = document.createElement('div');
    captionSection.style.cssText = `display: flex; flex-direction: column; gap: 8px;`;
    
    const captionLabel = document.createElement('label');
    captionLabel.textContent = 'Caption:';
    captionLabel.style.cssText = `font-size: 11px; text-transform: uppercase; color: var(--vault-slate); font-weight: bold;`;
    
    const captionInput = document.createElement('textarea');
    captionInput.id = 'publish-caption-input';
    captionInput.placeholder = 'Add a caption for your clip...';
    captionInput.style.cssText = `
        background: var(--vt-primary);
        color: var(--vault-text);
        border: 1px solid var(--vault-border);
        padding: 10px 12px;
        border-radius: 4px;
        font-family: var(--font-body);
        font-size: 13px;
        cursor: pointer;
        outline: none;
        resize: vertical;
        min-height: 60px;
        max-height: 120px;
    `;
    
    captionSection.appendChild(captionLabel);
    captionSection.appendChild(captionInput);
    
    // Platform grid
    const platformsSection = document.createElement('div');
    platformsSection.style.cssText = `display: flex; flex-direction: column; gap: 8px;`;
    
    const platformsLabel = document.createElement('label');
    platformsLabel.textContent = 'Publish to:';
    platformsLabel.style.cssText = `font-size: 11px; text-transform: uppercase; color: var(--vault-slate); font-weight: bold;`;
    
    const platformsGrid = document.createElement('div');
    platformsGrid.style.cssText = `
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
        gap: 10px;
    `;
    
    const publishPlatforms = [
        { id: 'gfycat', name: 'Gfycat', icon: '<svg viewBox="0 0 24 24" style="width:18px;height:18px;"><text x="12" y="16" text-anchor="middle" fill="#FF851B" font-size="14" font-family="Arial">G</text></svg>', color: '#FF851B' },
        { id: 'redgifs', name: 'RedGIFs', icon: '<svg viewBox="0 0 24 24" style="width:18px;height:18px;"><rect x="2" y="4" width="20" height="16" rx="2" fill="#FF0000"/><text x="12" y="14" text-anchor="middle" fill="white" font-size="12" font-family="Arial">GIF</text></svg>', color: '#FF0000' },
        { id: 'giphy', name: 'Giphy', icon: '<svg viewBox="0 0 24 24" style="width:18px;height:18px;"><circle cx="12" cy="12" r="10" fill="#FF69B4"/><text x="12" y="16" text-anchor="middle" fill="white" font-size="12" font-family="Arial">G</text></svg>', color: '#FF69B4' },
        { id: 'reddit', name: 'Reddit', icon: '<svg viewBox="0 0 24 24" fill="#FF4500" style="width:18px;height:18px;"><path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12zm4.655 16.345a1.06 1.06 0 0 1-1.06 1.062 1.06 1.06 0 0 1-1.06-.717 1.06 1.06 0 0 1 .25-1.195 6.943 6.943 0 0 0 1.844.852A6.958 6.958 0 0 0 18.04 12a6.958 6.958 0 0 0-3.582-5.528c.366.445.766.855 1.195 1.218a1.06 1.06 0 0 1-1.58 1.425 1.06 1.06 0 0 1-1.06-1.062 1.06 1.06 0 0 1 1.06-1.062c.765.322 1.5.732 2.188 1.219a1.06 1.06 0 0 1-1.595 1.488c-.836-.219-1.636-.54-2.375-.937a1.06 1.06 0 0 1-.437-1.923 1.06 1.06 0 0 1 1.425-1.582c.707.319 1.378.682 2.009 1.138a6.925 6.925 0 0 1-4.446 1.783 1.06 1.06 0 0 1-1.424-.283 1.06 1.06 0 0 1-.283-1.424 1.06 1.06 0 0 1 .283-1.425 6.925 6.925 0 0 1 4.446-1.783c.63-.456 1.298-.819 1.925-1.138a1.06 1.06 0 0 1 1.582 1.424 1.06 1.06 0 0 1-1.425.437c-.739.397-1.539.718-2.376.937a1.06 1.06 0 0 1-.437 1.923 1.06 1.06 0 0 1 1.424.283c.631-.506 1.299-.933 2.009-1.282a6.958 6.958 0 0 0 3.582 5.528zM12 8.118a3.882 3.882 0 1 0 0 7.764 3.882 3.882 0 0 0 0-7.764zM12 14a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm6.406-11.845a1.44 1.44 0 1 0 0 2.88 1.44 1.44 0 0 0 0-2.88z"/></svg>', color: '#FF4500' },
        { id: 'twitter', name: 'Twitter', icon: '<svg viewBox="0 0 24 24" fill="#1DA1F2" style="width:18px;height:18px;"><path d="M24 4.557c-.883.392-1.832.656-2.828.775 1.017-.609 1.798-1.574 2.165-2.724-.951.564-2.005.974-3.127 1.195-.897-.957-2.178-1.555-3.594-1.555-3.179 0-5.515 2.966-4.797 6.045-4.091-.205-7.719-2.165-10.148-5.144-1.29 2.213-.669 5.108 1.523 6.574-.806-.026-1.566-.247-2.229-.616-.054 2.281 1.581 4.415 3.949 4.89-.693.188-1.452.232-2.224.084.626 1.956 2.444 3.379 4.6 3.419-2.07 1.623-4.678 2.348-7.29 2.04 2.179 1.397 4.768 2.212 7.548 2.212 9.142 0 14.307-7.721 13.995-14.646.962-.695 1.797-1.562 2.457-2.549z"/></svg>', color: '#1DA1F2' },
        { id: 'imgur', name: 'Imgur', icon: '<svg viewBox="0 0 24 24" fill="#1BB76E" style="width:18px;height:18px;"><path d="M12 24c6.627 0 12-5.373 12-12S18.627 0 12 0 0 5.373 0 12s5.373 12 12 12zm-6.15-15.55c.19-.19.5-.21.73-.04l4.25 4.5c.23.25.28.6.08.85l-3.2 2.9c-.2.18-.15.48.09.68l3.3 5.7c.2.34.6.54 1.05.45l4.7-2.5c.4-.2.6-.6.5-1l-3.4-5.9c-.1-.3-.4-.5-.7-.5s-.6.2-.7.5l-3.4 5.9c-.2.4 0 .8.3 1l4.7 2.5c.4.2.8.4 1.2.3l3.2-2.9c.2-.18.4-.1.6-.1l.1 0c.5 0 .8.3.8.7v.1c0 .4-.2.8-.5 1l-4.2 4.5c-.2.2-.6.2-.8 0l-4.2-4.5c-.2-.2-.2-.6 0-.8l4.2-4.5c.2-.2.2-.6.2-.8v-.1c0-.4-.3-.7-.8-.7l-.1 0c-.2 0-.4.1-.6.1l-3.2 2.9c-.2.18-.6.1-.8-.1l-4.7-2.5c-.4-.2-.8-.4-1.2-.3-1.6.4-2.9 1.6-3.6 3.1-.8 1.7-.9 3.5-.4 5.2.5 1.8 1.7 3.3 3.2 4.4 1.7 1.2 3.7 1.8 5.8 1.8 2.4 0 4.6-.7 6.5-1.9 1.9-1.3 3.3-3.2 4-5.4.6-2 .5-4.1-.2-6.1z"/></svg>', color: '#1BB76E' },
        { id: 'ifunny', name: 'iFunny', icon: '<svg viewBox="0 0 24 24" style="width:18px;height:18px;"><rect x="2" y="4" width="20" height="16" rx="2" fill="#FF69B4"/><text x="12" y="14" text-anchor="middle" fill="white" font-size="10" font-family="Arial">iFunny</text></svg>', color: '#FF69B4' }
    ];
    
    publishPlatforms.forEach(platform => {
        const btn = document.createElement('button');
        btn.style.cssText = `
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 6px;
            padding: 12px;
            background: rgba(22, 19, 32, 0.06);
            border: 1px solid var(--vault-border);
            border-radius: 6px;
            cursor: pointer;
            color: var(--vault-text);
            transition: all 0.2s;
            font-family: var(--font-body);
            font-size: 11px;
            font-weight: 600;
        `;
        btn.innerHTML = `${platform.icon}<span>${platform.name}</span>`;
        btn.onclick = () => {
            const caption = captionInput.value.trim();
            publishToPlatform(platform.id, clipData, format, quality, caption);
            dialog.remove();
        };
        btn.onmouseenter = () => {
            btn.style.background = 'rgba(22, 19, 32, 0.12)';
            btn.style.borderColor = platform.color;
        };
        btn.onmouseleave = () => {
            btn.style.background = 'rgba(22, 19, 32, 0.06)';
            btn.style.borderColor = 'var(--vault-border)';
        };
        platformsGrid.appendChild(btn);
    });
    
    platformsSection.appendChild(platformsLabel);
    platformsSection.appendChild(platformsGrid);
    
    // Assemble dialog
    dialogContent.appendChild(header);
    dialogContent.appendChild(captionSection);
    dialogContent.appendChild(platformsSection);
    
    dialog.appendChild(dialogContent);
    document.body.appendChild(dialog);
    
    // Focus on caption input
    captionInput.focus();
}

function publishToPlatform(platform, clipData, format, quality, caption) {
    const platformNames = {
        gfycat: 'Gfycat',
        redgifs: 'RedGIFs',
        giphy: 'Giphy',
        reddit: 'Reddit',
        twitter: 'Twitter',
        imgur: 'Imgur',
        ifunny: 'iFunny'
    };
    
    if (window.electronAPI && window.electronAPI.publishClip) {
        window.electronAPI.publishClip({ platform, clipData, format, quality, caption })
            .then(() => {
                window.showToast(`Clip published to ${platformNames[platform] || platform}!`, 'success');
            })
            .catch(err => {
                window.showToast(`Failed to publish: ${err.message}`, 'error');
            });
    } else {
        // Fallback
        window.showToast(`Clip ready to publish on ${platformNames[platform] || platform}!`, 'success');
    }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Format duration in seconds to HH:MM:SS or MM:SS
 * Self-contained implementation to avoid circular dependencies
 */
function formatClipDuration(seconds) {
    if (!seconds && seconds !== 0) return '';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) {
        return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

// ============================================================================
// BIND GLOBALS
// ============================================================================

window.startClipMode = startClipMode;
window.endClipMode = endClipMode;
window.cancelClipMode = cancelClipMode;
window.exportClip = exportClip;
window.getClipData = getClipData;
window.initClipSystem = initClipSystem;
